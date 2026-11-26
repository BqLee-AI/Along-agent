import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  HarnessApprovalDecisionSchema,
  HarnessToolResultSchema,
  type HarnessModelReply,
  type HarnessRequest,
} from '@along/contracts';
import type { ThreadEvent, ThreadStartedEvent } from '@along/stream-protocol';
import {
  createHarnessConsumer,
  findModelObservation,
  pending,
  started,
  type ConsumerMode,
  type HarnessActor,
  type HarnessConsumer,
} from '../helpers/harness-consumer.js';

// Evidence boundary: deterministic model steps, real native process/authority,
// real propose_task, HTTP/local consumers and isolated PostgreSQL approvals.
// This does not evaluate a real provider's natural-language understanding.
let fixture: HarnessConsumer;
type ModelRequest = Extract<HarnessRequest, { type: 'model' }>;
type ModelStep = (request: ModelRequest) => HarnessModelReply;
let steps: ModelStep[] = [];
let modelCalls = 0;
let lastClock = Date.parse('2026-11-01T00:00:00Z');
const observationSchema = z.object({
  invocation_id: z.string().uuid(),
  tool_id: z.literal('propose_task'),
  result: HarnessToolResultSchema,
});
type Observation = z.infer<typeof observationSchema>;
type ProposalArgs = {
  raw_time_text: string;
  note: string;
  occurrence: 'once';
  timezone_hint?: string;
};

interface MessageInput {
  execution: 'harness';
  raw_text: string;
  idempotency_key: string;
  conversation_id: string;
  confirmed_timezone?: string;
}

interface ApprovalSnapshot {
  id: string;
  state: string;
  wall_time: string;
  fire_at_utc: Date;
  timezone_id: string;
  fold: number;
  presentation_hash: string;
  original_text: string;
  expires_at: Date;
}

interface Proposal {
  events: ThreadEvent[];
  run: ThreadStartedEvent['payload'];
  approvalId: string;
  saved: ApprovalSnapshot;
}

beforeAll(async () => {
  fixture = await createHarnessConsumer();
  // The fixture already owns a private schema and puts it before pg_catalog.
  // Shadow only its admission clock; never rewrite immutable Run/tool facts.
  await fixture.database.pool.query(`
    CREATE TABLE reminder_contract_clock (at timestamptz NOT NULL);
    INSERT INTO reminder_contract_clock VALUES ('2026-11-01T00:00:00Z');
    CREATE FUNCTION clock_timestamp() RETURNS timestamptz LANGUAGE sql AS
      'SELECT at FROM reminder_contract_clock';
  `);
  const harness = fixture.deps.harness;
  if (!harness) throw new Error('real native harness is required');
  fixture.model = async function* (request, tools) {
    modelCalls++;
    expect(tools.some((tool) => tool.name === 'propose_task')).toBe(true);
    const step = steps.shift();
    if (!step) throw new Error('unexpected native model request');
    const reply = step(request);
    if (reply.message.content) yield { type: 'delta', delta: reply.message.content };
    yield { type: 'complete', reply };
  };
}, 30_000);

afterAll(async () => {
  if (fixture) await fixture.close();
}, 30_000);

function arrange(...next: ModelStep[]) {
  expect(steps).toHaveLength(0);
  steps = next;
}

function answer(content: string): HarnessModelReply {
  return { message: { content, tool_calls: [] }, usage: { total_tokens: 5 } };
}

function propose(args: ProposalArgs, inspect?: (request: ModelRequest) => void): ModelStep {
  return (request) => {
    inspect?.(request);
    return {
      message: {
        content: null,
        tool_calls: [
          {
            id: 'fixture-provider-call',
            type: 'function',
            function: { name: 'propose_task', arguments: JSON.stringify(args) },
          },
        ],
      },
      usage: { total_tokens: 5 },
    };
  };
}

function body(
  conversation_id: string,
  raw_text: string,
  extra: Pick<MessageInput, 'confirmed_timezone'> = {},
): MessageInput {
  return {
    conversation_id,
    execution: 'harness',
    raw_text,
    idempotency_key: randomUUID(),
    ...extra,
  };
}

function args(raw_time_text: string, note = '喝水'): ProposalArgs {
  return { raw_time_text, note, occurrence: 'once' };
}

async function at(time: string) {
  // Every newly accepted message in this file has a strictly later clock;
  // predecessor selection is not left to random UUID ordering on equal times.
  expect(Date.parse(time)).toBeGreaterThan(lastClock);
  lastClock = Date.parse(time);
  await fixture.database.pool.query('UPDATE reminder_contract_clock SET at=$1', [time]);
}

function text(events: ThreadEvent[]) {
  return events
    .filter((event) => event.type === 'message.delta')
    .map((event) => event.payload.delta)
    .join('');
}

function healthy(events: ThreadEvent[]) {
  expect(steps).toHaveLength(0);
  expect(events.filter((event) => event.type === 'thread.failed')).toEqual([]);
  expect(events.some((event) => event.type === 'thread.cancelled')).toBe(false);
}

async function frozen(runId: string) {
  const result = await fixture.database.pool.query(
    'SELECT frozen_context FROM agent_runs WHERE id=$1',
    [runId],
  );
  expect(result.rows).toHaveLength(1);
  return result.rows[0].frozen_context;
}

async function approval(approvalId: string) {
  const result = await fixture.database.pool.query<ApprovalSnapshot>(
    `SELECT id,state,wall_time,fire_at_utc,timezone_id,fold,presentation_hash,
      original_text,expires_at FROM approvals WHERE id=$1`,
    [approvalId],
  );
  expect(result.rows).toHaveLength(1);
  return result.rows[0];
}

async function noTasks(actor: HarnessActor) {
  for (const table of ['tasks', 'task_events', 'outbox']) {
    const result = await fixture.database.pool.query(
      `SELECT count(*)::int AS n FROM ${table} WHERE owner_id=$1`,
      [actor.ownerId],
    );
    expect(result.rows[0].n).toBe(0);
  }
}

async function noCommitments(actor: HarnessActor) {
  await noTasks(actor);
  const result = await fixture.database.pool.query(
    'SELECT count(*)::int AS n FROM approvals WHERE owner_id=$1',
    [actor.ownerId],
  );
  expect(result.rows[0].n).toBe(0);
}

async function proposed(
  actor: HarnessActor,
  input: MessageInput,
  toolArgs: ProposalArgs,
  wallTime: string,
  fireAtUtc: string,
): Promise<Proposal> {
  arrange(propose(toolArgs));
  const events = await (await actor.message(input)).events;
  healthy(events);
  const run = started(events);
  const approvalId = pending(events);
  expect(events.filter((event) => event.type === 'approval_required')).toHaveLength(1);
  expect(events.some((event) => event.type === 'thread.completed')).toBe(false);
  expect(
    events.filter((event) => event.type === 'card.proposed').map((event) => event.payload),
  ).toEqual([
    expect.objectContaining({
      wall_time: wallTime,
      timezone_id: 'Asia/Shanghai',
      original_text: toolArgs.note,
    }),
  ]);
  const saved = await approval(approvalId);
  expect(saved).toMatchObject({
    id: approvalId,
    state: 'pending',
    wall_time: wallTime,
    fire_at_utc: new Date(fireAtUtc),
    timezone_id: 'Asia/Shanghai',
    fold: 0,
  });
  const required = events.find((event) => event.type === 'approval_required');
  expect(required?.payload.presentation_hash).toBe(saved.presentation_hash);
  expect((await actor.view(run.conversation_id, run.run_id)).status).toBe('suspended_approval');
  await noTasks(actor);
  return { events, run, approvalId, saved };
}

async function clarified(
  actor: HarnessActor,
  input: MessageInput,
  toolArgs: ProposalArgs,
  reason: string,
  inspect?: (request: ModelRequest) => void,
) {
  let accepted: Observation | undefined;
  let clarificationText = '';
  arrange(propose(toolArgs, inspect), (request) => {
    const live = findModelObservation(
      request.messages,
      z.object({
        invocationId: z.string().uuid(),
        status: z.literal('ok'),
        result: z.unknown(),
      }),
    );
    accepted = live
      ? {
          invocation_id: live.invocationId,
          tool_id: 'propose_task',
          result: HarnessToolResultSchema.parse({ status: live.status, result: live.result }),
        }
      : undefined;
    if (!accepted || accepted.result.status !== 'ok' || accepted.result.result.kind !== 'clarify') {
      throw new Error('native did not deliver the actual proposal clarification');
    }
    expect(accepted.result.result.reason).toBe(reason);
    clarificationText = accepted.result.result.text;
    return answer(clarificationText);
  });
  const events = await (await actor.message(input)).events;
  healthy(events);
  const run = started(events);
  expect(events.some((event) => event.type === 'approval_required')).toBe(false);
  expect(events.some((event) => event.type === 'card.proposed')).toBe(false);
  expect(events.filter((event) => event.type === 'thread.completed')).toHaveLength(1);
  expect(clarificationText.length).toBeGreaterThan(0);
  expect(text(events)).toBe(clarificationText);
  expect((await actor.view(run.conversation_id, run.run_id)).status).toBe('done');
  const persisted = await fixture.database.pool.query(
    'SELECT invocation_id,accepted_result FROM tool_invocations WHERE run_id=$1',
    [run.run_id],
  );
  expect(persisted.rows).toEqual([
    {
      invocation_id: accepted!.invocation_id,
      accepted_result: accepted!.result,
    },
  ]);
  return { events, run };
}

function recovery(approvalId: string, status: 'consumed' | 'rejected'): ModelStep {
  return (request) => {
    const decision = findModelObservation(request.messages, HarnessApprovalDecisionSchema);
    expect(decision).toMatchObject({ kind: 'task', approval_id: approvalId, status });
    const original = findModelObservation(request.messages, observationSchema);
    expect(original?.result).toMatchObject({
      status: 'ok',
      result: { kind: 'approval', approval: { approvalId } },
    });
    return answer(status === 'consumed' ? '提醒已保存。' : '提醒已取消创建。');
  };
}

async function rejectAndRecover(actor: HarnessActor, proposal: Proposal) {
  const { run, approvalId } = proposal;
  const waiting = (await actor.view(run.conversation_id, run.run_id)).waiting;
  if (!waiting) throw new Error('missing native approval checkpoint');
  await actor.reject(approvalId);
  const events = await (
    await actor.resume(run.conversation_id, run.run_id, {
      checkpoint_id: waiting.checkpoint_id,
      idempotency_key: randomUUID(),
    })
  ).events;
  expect(events).toContainEqual(
    expect.objectContaining({
      type: 'thread.failed',
      payload: expect.objectContaining({
        error: expect.objectContaining({ code: 'APPROVAL_rejected' }),
      }),
    }),
  );
  expect((await actor.view(run.conversation_id, run.run_id)).status).toBe('failed');
}

for (const mode of ['local', 'http'] as const satisfies readonly ConsumerMode[]) {
  describe(`D92 reminder date native consumer ${mode}`, () => {
    // Keep all accepted messages monotonic, including across consumer modes.
    const date = (day: number) =>
      `2026-11-${String(day + (mode === 'http' ? 12 : 0)).padStart(2, '0')}`;
    const utc = (day: number, clock: string) => `${date(day)}T${clock}Z`;

    test('an old conversation resolves new explicit today and tomorrow from each new turn', async () => {
      const actor = await fixture.actor(mode);
      await at(utc(3, '02:00:00'));
      arrange(() => answer('请提供提醒内容。'));
      const conversationId = await actor.createConversation();
      const oldEvents = await (await actor.message(body(conversationId, '查看提醒'))).events;
      healthy(oldEvents);
      const old = started(oldEvents);
      const oldFrozen = await frozen(old.run_id);

      await at(utc(4, '02:00:00'));
      const today = await proposed(
        actor,
        body(old.conversation_id, '今天15:20提醒我喝水', {
          confirmed_timezone: 'Asia/Shanghai',
        }),
        args('今天15:20'),
        `${date(4)} 15:20`,
        utc(4, '07:20:00'),
      );
      await rejectAndRecover(actor, today);
      await at(utc(5, '02:00:00'));
      const tomorrow = await proposed(
        actor,
        body(old.conversation_id, '明天15:20提醒我买水'),
        args('明天15:20', '买水'),
        `${date(6)} 15:20`,
        utc(6, '07:20:00'),
      );
      expect(await frozen(old.run_id)).toEqual(oldFrozen);
      expect((await frozen(today.run.run_id)).anchorReceivedAtUtc).toBe(utc(4, '02:00:00'));
      expect((await frozen(tomorrow.run.run_id)).anchorReceivedAtUtc).toBe(utc(5, '02:00:00'));
    }, 30_000);

    test('a real missing-timezone result followed by a same-day 120-second reply retains the original date', async () => {
      const actor = await fixture.actor(mode);
      await at(utc(6, '02:00:00'));
      const first = await clarified(
        actor,
        body(await actor.createConversation(), '今天15:20提醒我喝水'),
        args('今天15:20'),
        'TIMEZONE_MISSING',
      );
      await noCommitments(actor);
      const originalFrozen = await frozen(first.run.run_id);
      await at(utc(6, '02:02:00'));
      const reply = await proposed(
        actor,
        body(first.run.conversation_id, '北京时间'),
        args('今天15:20'),
        `${date(6)} 15:20`,
        utc(6, '07:20:00'),
      );
      expect(await frozen(first.run.run_id)).toEqual(originalFrozen);
      expect(await frozen(reply.run.run_id)).toMatchObject({
        anchorReceivedAtUtc: utc(6, '02:00:00'),
        receivedAtUtc: utc(6, '02:02:00'),
        reminderDateSource: { kind: 'clarification', sourceRunId: first.run.run_id },
      });
    }, 30_000);

    test('a real local-midnight crossing in only 20 seconds requires a date and creates no approval', async () => {
      const actor = await fixture.actor(mode);
      await at(utc(7, '15:59:50'));
      const first = await clarified(
        actor,
        body(await actor.createConversation(), '明天15:20提醒我喝水'),
        args('明天15:20'),
        'TIMEZONE_MISSING',
      );
      await noCommitments(actor);
      const originalFrozen = await frozen(first.run.run_id);
      await at(utc(7, '16:00:10'));
      const reply = await clarified(
        actor,
        body(first.run.conversation_id, 'Asia/Shanghai'),
        args('明天15:20'),
        'DATE_CHANGED',
      );
      await noCommitments(actor);
      expect(await frozen(first.run.run_id)).toEqual(originalFrozen);
      expect(await frozen(reply.run.run_id)).toMatchObject({
        anchorReceivedAtUtc: utc(7, '15:59:50'),
        receivedAtUtc: utc(7, '16:00:10'),
      });
    }, 30_000);

    test('a model cannot carry a historical date into a new user request missing its date', async () => {
      const actor = await fixture.actor(mode);
      const historicalDate = `${date(9)} 15:20`;
      const historicalText = `${historicalDate}提醒我喝水`;
      await at(utc(9, '02:00:00'));
      const old = await proposed(
        actor,
        body(await actor.createConversation(), historicalText, {
          confirmed_timezone: 'Asia/Shanghai',
        }),
        args(historicalDate),
        historicalDate,
        utc(9, '07:20:00'),
      );
      await rejectAndRecover(actor, old);
      const before = await fixture.facts(actor.ownerId);
      await at(utc(10, '02:00:00'));
      await clarified(
        actor,
        body(old.run.conversation_id, '15:20提醒我喝水'),
        args(historicalDate),
        'DATE_MISSING',
        (request) => {
          // Prove the hostile fixture step had access to that actual old input.
          expect(request.messages.some((message) => message.content.includes(historicalText))).toBe(
            true,
          );
          expect(
            request.messages.some((message) => message.content.includes('15:20提醒我喝水')),
          ).toBe(true);
        },
      );
      expect((await fixture.facts(actor.ownerId)).approvals).toEqual(before.approvals);
      await noTasks(actor);
    }, 30_000);

    test('approval recovery and message/resume replay after midnight retain the original frozen proposal', async () => {
      const actor = await fixture.actor(mode);
      const input = body(await actor.createConversation(), '明天15:20提醒我喝水', {
        confirmed_timezone: 'Asia/Shanghai',
      });
      await at(utc(11, '15:59:50'));
      const original = await proposed(
        actor,
        input,
        args('明天15:20'),
        `${date(12)} 15:20`,
        utc(12, '07:20:00'),
      );
      const originalFrozen = await frozen(original.run.run_id);
      const waiting = (await actor.view(original.run.conversation_id, original.run.run_id)).waiting;
      if (!waiting) throw new Error('missing native approval recovery checkpoint');
      await at(utc(11, '15:59:55'));
      const confirmed = await actor.confirm(original.approvalId);
      expect(confirmed.status).toBe('consumed');
      await at(utc(11, '16:00:10'));
      const resume = { checkpoint_id: waiting.checkpoint_id, idempotency_key: randomUUID() };
      arrange(recovery(original.approvalId, 'consumed'));
      const resumed = await (
        await actor.resume(original.run.conversation_id, original.run.run_id, resume)
      ).events;
      healthy(resumed);
      expect(text(resumed)).toBe('提醒已保存。');
      expect(resumed.filter((event) => event.type === 'thread.completed')).toHaveLength(1);
      expect(resumed.some((event) => event.type === 'approval_required')).toBe(false);
      expect((await actor.view(original.run.conversation_id, original.run.run_id)).status).toBe(
        'done',
      );
      expect(await frozen(original.run.run_id)).toEqual(originalFrozen);
      expect(await approval(original.approvalId)).toEqual({ ...original.saved, state: 'consumed' });
      const tasks = await fixture.database.pool.query(
        'SELECT id,source_approval_id,wall_time,fire_at_utc,timezone_id,original_note FROM tasks WHERE owner_id=$1',
        [actor.ownerId],
      );
      expect(tasks.rows).toEqual([
        {
          id: confirmed.task_id,
          source_approval_id: original.approvalId,
          wall_time: `${date(12)} 15:20`,
          fire_at_utc: new Date(utc(12, '07:20:00')),
          timezone_id: 'Asia/Shanghai',
          original_note: '喝水',
        },
      ]);
      const durable = await fixture.facts(actor.ownerId);
      const calls = modelCalls;
      await at(utc(12, '02:00:00'));
      const allEvents = [...original.events, ...resumed];
      expect(await (await actor.message(input)).events).toEqual(allEvents);
      expect(
        await (
          await actor.resume(original.run.conversation_id, original.run.run_id, resume)
        ).events,
      ).toEqual(resumed);
      expect(await actor.history(original.run.conversation_id)).toEqual(allEvents);
      expect(await fixture.facts(actor.ownerId)).toEqual(durable);
      expect(modelCalls).toBe(calls);
      expect(steps).toHaveLength(0);
    }, 30_000);
  });
}
