import { httpStatusForError } from '@along/contracts';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { EnvelopeSchema, HarnessApprovalDecisionSchema } from '@along/contracts';
import type { ThreadEvent } from '@along/stream-protocol';
import { ApplicationError } from '../../src/platform/errors.js';
import { executeRun } from '../../src/agent/run/execute-turn.js';
import { parseResult, resultSchema } from '../../src/agent/tools/result-schema.js';
import {
  createHarnessConsumer,
  findModelObservation,
  pending,
  started,
} from '../helpers/harness-consumer.js';
import type {
  ConsumerMode,
  ConsumerStream,
  HarnessActor,
  HarnessConsumer,
} from '../helpers/harness-consumer.js';

let fixture: HarnessConsumer;
beforeAll(async () => {
  fixture = await createHarnessConsumer();
}, 30_000);
afterAll(async () => {
  await fixture?.close();
  expect(fixture?.providerErrors ?? []).toEqual([]);
}, 30_000);

async function typedFailure(work: Promise<unknown>, status: number, code: string) {
  try {
    await work;
  } catch (error) {
    expect(error).toBeInstanceOf(ApplicationError);
    if (!(error instanceof ApplicationError)) throw error;
    expect(httpStatusForError(error.code)).toBe(status);
    expect(error.errorCode).toBe(code);
    return error;
  }
  throw new Error(`expected ${status} ${code} before execution`);
}

async function approval(mode: ConsumerMode) {
  const actor = await fixture.actor(mode);
  const id = randomUUID();
  const body = await actor.createMessage(fixture.input(id, 'create'));
  const stream = await actor.message(body);
  const initial = await stream.events;
  const run = started(initial);
  const approvalId = pending(initial);
  expect(initial.some((event) => event.type === 'thread.completed')).toBe(false);
  expect(initial.some((event) => event.type === 'thread.failed')).toBe(false);
  const waiting = await actor.view(run.conversation_id, run.run_id);
  expect(waiting).toMatchObject({
    run_id: run.run_id,
    execution: 'harness',
    status: 'suspended_approval',
    attempt_no: 1,
    can_resume: false,
  });
  if (!waiting.waiting) throw new Error('missing persisted native waiting checkpoint');
  expect(waiting.waiting.approval_id).toBe(approvalId);
  expect((await fixture.facts(actor.ownerId)).tasks).toEqual([]);
  const resume = { checkpoint_id: waiting.waiting.checkpoint_id, idempotency_key: randomUUID() };
  const frozen = await fixture.facts(actor.ownerId);
  await typedFailure(actor.resume(run.conversation_id, run.run_id, resume), 409, 'STATE_CONFLICT');
  await typedFailure(
    actor.resume(run.conversation_id, run.run_id, {
      ...resume,
      checkpoint_id: randomUUID(),
      idempotency_key: randomUUID(),
    }),
    409,
    'STATE_CONFLICT',
  );
  expect(await fixture.facts(actor.ownerId)).toEqual(frozen);
  expect(fixture.transcripts.get(id)).toHaveLength(1);

  const confirmed = await actor.confirm(approvalId);
  expect(confirmed).toMatchObject({
    approval_id: approvalId,
    status: 'consumed',
    duplicate: false,
  });
  expect((await actor.view(run.conversation_id, run.run_id)).can_resume).toBe(true);
  const gate = fixture.gate(id);
  let resumed: ThreadEvent[];
  try {
    // Keep the successor's actual model request open so both requests overlap
    // independently of provider speed; only one may create/execute an attempt.
    const replies = await Promise.allSettled([
      actor.resume(run.conversation_id, run.run_id, resume),
      actor.resume(run.conversation_id, run.run_id, resume),
    ]);
    const accepted: ConsumerStream[] = [];
    for (const reply of replies) {
      if (reply.status === 'fulfilled') accepted.push(reply.value);
      else {
        expect(reply.reason).toBeInstanceOf(ApplicationError);
        if (!(reply.reason instanceof ApplicationError)) throw reply.reason;
        expect(httpStatusForError(reply.reason.code)).toBe(409);
        expect(reply.reason.errorCode).toBe('STATE_CONFLICT');
      }
    }
    expect(accepted).toHaveLength(1);
    await gate.started.promise;
    const running = await actor.view(run.conversation_id, run.run_id);
    expect(running).toMatchObject({
      run_id: run.run_id,
      status: 'running',
      attempt_no: 2,
      waiting: null,
      can_resume: false,
    });
    expect(running.attempt_id).not.toBe(waiting.attempt_id);
    const successorFacts = await fixture.facts(actor.ownerId);
    await typedFailure(
      actor.resume(run.conversation_id, run.run_id, {
        ...resume,
        idempotency_key: randomUUID(),
      }),
      409,
      'STATE_CONFLICT',
    );
    // The old real local execution context cannot re-enter the successor.
    // HTTP has no caller-supplied attempt authority; DTO tests cover that boundary.
    if (stream.context) {
      const stale = await typedFailure(
        executeRun(fixture.deps, stream.context, async () => {
          throw new Error('old attempt emitted an event');
        }),
        409,
        'STATE_CONFLICT',
      );
      expect(stale.details).toEqual({ reason: 'STALE_ATTEMPT' });
    }
    expect(await fixture.facts(actor.ownerId)).toEqual(successorFacts);
    gate.release.resolve();
    resumed = await accepted[0]!.events;
  } finally {
    gate.release.resolve();
  }
  expect(resumed.some((event) => event.type === 'thread.started')).toBe(false);
  expect(resumed.filter((event) => event.type === 'thread.completed')).toHaveLength(1);
  expect(resumed.some((event) => event.type === 'thread.failed')).toBe(false);
  expect(
    resumed
      .filter((event) => event.type === 'message.delta')
      .map((event) => event.payload.delta)
      .join(''),
  ).toBe(`记录结果 task:${confirmed.task_id}`);
  const finalView = await actor.view(run.conversation_id, run.run_id);
  expect(finalView).toMatchObject({
    run_id: run.run_id,
    status: 'done',
    attempt_no: 2,
    waiting: null,
    can_resume: false,
  });

  const transcript = structuredClone(fixture.transcripts.get(id));
  expect(transcript).toHaveLength(2);
  expect(findModelObservation(transcript![1]!, HarnessApprovalDecisionSchema)).toEqual({
    kind: 'task',
    approval_id: approvalId,
    status: 'consumed',
    task_id: confirmed.task_id,
    successor_id: null,
  });
  const observation = findModelObservation(
    transcript![1]!,
    z.object({
      invocation_id: z.string().uuid(),
      tool_id: z.string(),
      result: resultSchema,
    }),
  );
  if (!observation) throw new Error('native omitted accepted original tool observation');
  expect(observation.invocation_id).toBe(waiting.waiting.invocation_id);
  expect(observation.tool_id).toBe('propose_task');
  expect(observation.result).toMatchObject({
    status: 'ok',
    result: { kind: 'approval', approval: { approvalId } },
  });
  expect(
    (
      await fixture.database.pool.query(
        `SELECT id,source_approval_id,state,state_version,wall_time,timezone_id,original_note,
      fire_at_utc FROM tasks WHERE owner_id=$1`,
        [actor.ownerId],
      )
    ).rows,
  ).toEqual([
    {
      id: confirmed.task_id,
      source_approval_id: approvalId,
      state: 'saved',
      state_version: 1,
      wall_time: '2027-11-02 09:20',
      timezone_id: 'Asia/Shanghai',
      original_note: `native-${id}`,
      fire_at_utc: new Date('2027-11-02T01:20:00Z'),
    },
  ]);
  expect(
    (
      await fixture.database.pool.query(
        'SELECT id,state,consumed_task_id FROM approvals WHERE owner_id=$1',
        [actor.ownerId],
      )
    ).rows,
  ).toEqual([{ id: approvalId, state: 'consumed', consumed_task_id: confirmed.task_id }]);
  expect(
    (
      await fixture.database.pool.query(
        'SELECT task_id,type,state_version FROM task_events WHERE owner_id=$1',
        [actor.ownerId],
      )
    ).rows,
  ).toEqual([{ task_id: confirmed.task_id, type: 'created', state_version: 1 }]);
  expect(
    (
      await fixture.database.pool.query(
        'SELECT task_id,status,expected_state_version FROM outbox WHERE owner_id=$1',
        [actor.ownerId],
      )
    ).rows,
  ).toEqual([{ task_id: confirmed.task_id, status: 'pending', expected_state_version: 1 }]);
  expect(
    (
      await fixture.database.pool.query(
        'SELECT invocation_id,call_key,state,approval_id FROM tool_invocations WHERE run_id=$1',
        [run.run_id],
      )
    ).rows,
  ).toEqual([
    {
      invocation_id: waiting.waiting.invocation_id,
      call_key: 'harness/1',
      state: 'completed',
      approval_id: approvalId,
    },
  ]);
  expect(
    (
      await fixture.database.pool.query(
        'SELECT attempt_no,status FROM run_attempts WHERE run_id=$1 ORDER BY attempt_no',
        [run.run_id],
      )
    ).rows,
  ).toEqual([
    { attempt_no: 1, status: 'done' },
    { attempt_no: 2, status: 'done' },
  ]);
  expect(
    (
      await fixture.database.pool.query('SELECT id,status FROM agent_runs WHERE owner_id=$1', [
        actor.ownerId,
      ])
    ).rows,
  ).toEqual([{ id: run.run_id, status: 'done' }]);
  expect(
    (
      await fixture.database.pool.query(
        'SELECT run_id,checkpoint_id,attempt_id FROM harness_resumes WHERE owner_id=$1',
        [actor.ownerId],
      )
    ).rows,
  ).toEqual([
    {
      run_id: run.run_id,
      checkpoint_id: waiting.waiting.checkpoint_id,
      attempt_id: finalView.attempt_id,
    },
  ]);
  const finalFacts = await fixture.facts(actor.ownerId);
  await typedFailure(
    actor.resume(run.conversation_id, run.run_id, {
      ...resume,
      idempotency_key: randomUUID(),
    }),
    409,
    'STATE_CONFLICT',
  );
  expect(await (await actor.resume(run.conversation_id, run.run_id, resume)).events).toEqual(
    resumed,
  );
  expect(await fixture.facts(actor.ownerId)).toEqual(finalFacts);
  expect(fixture.transcripts.get(id)).toEqual(transcript);
}

async function rejected(mode: ConsumerMode) {
  const actor = await fixture.actor(mode);
  const id = randomUUID();
  const body = await actor.createMessage(fixture.input(id, 'create'));
  const initial = await (await actor.message(body)).events;
  const run = started(initial);
  const approvalId = pending(initial);
  const waiting = await actor.view(run.conversation_id, run.run_id);
  if (!waiting.waiting) throw new Error('missing native wait');
  expect(await actor.reject(approvalId)).toMatchObject({
    approval_id: approvalId,
    status: 'rejected',
    duplicate: false,
  });
  const resumed = await (
    await actor.resume(run.conversation_id, run.run_id, {
      checkpoint_id: waiting.waiting.checkpoint_id,
      idempotency_key: randomUUID(),
    })
  ).events;
  expect(resumed).toHaveLength(1);
  expect(resumed[0]).toMatchObject({
    type: 'thread.failed',
    payload: { error: { code: 'APPROVAL_rejected' } },
  });
  expect(await actor.view(run.conversation_id, run.run_id)).toMatchObject({
    status: 'failed',
    attempt_no: 2,
    waiting: null,
  });
  expect(fixture.transcripts.get(id)).toHaveLength(1);
  expect(
    (
      await fixture.database.pool.query(
        'SELECT id,state,consumed_task_id FROM approvals WHERE owner_id=$1',
        [actor.ownerId],
      )
    ).rows,
  ).toEqual([{ id: approvalId, state: 'rejected', consumed_task_id: null }]);
  expect(
    (
      await fixture.database.pool.query(
        'SELECT invocation_id,call_key,approval_id FROM tool_invocations WHERE run_id=$1',
        [run.run_id],
      )
    ).rows,
  ).toEqual([
    {
      invocation_id: waiting.waiting.invocation_id,
      call_key: 'harness/1',
      approval_id: approvalId,
    },
  ]);
  const facts = await fixture.facts(actor.ownerId);
  expect(facts.tasks).toEqual([]);
  expect(facts.task_events).toEqual([]);
  expect(facts.outbox).toEqual([]);
  expect(
    (
      await fixture.database.pool.query(
        "SELECT content FROM messages WHERE owner_id=$1 AND role='assistant'",
        [actor.ownerId],
      )
    ).rows,
  ).toEqual([]);
  expect(resumed).toEqual(
    (await actor.history(run.conversation_id)).filter(
      (event) =>
        event.type === 'thread.failed' ||
        event.type === 'thread.completed' ||
        event.type === 'thread.cancelled',
    ),
  );
}

async function cancelHeld(actor: HarnessActor) {
  const id = randomUUID();
  const gate = fixture.gate(id);
  const body = await actor.createMessage(fixture.input(id, 'hold'));
  const stream = await actor.message(body);
  await gate.started.promise;
  const rows = await fixture.database.pool.query<{ id: string; conversation_id: string }>(
    "SELECT id,conversation_id FROM agent_runs WHERE owner_id=$1 AND status='running'",
    [actor.ownerId],
  );
  expect(rows.rows).toHaveLength(1);
  const run = rows.rows[0]!;
  const cancel = { idempotency_key: randomUUID(), reason: '理'.repeat(198) + '😀' };
  const cancelled = await actor.cancel(run.conversation_id, run.id, cancel);
  expect(cancelled.status).toBe('cancelled');
  expect(await gate.closed.promise).toBe(true);
  const events = await stream.events;
  expect(events.filter((event) => event.type === 'thread.cancelled')).toHaveLength(1);
  expect(events.find((event) => event.type === 'thread.cancelled')).toMatchObject({
    payload: { reason: cancel.reason },
  });
  expect(
    events.some(
      (event) =>
        event.type === 'thread.completed' ||
        event.type === 'thread.failed' ||
        event.type === 'message.delta',
    ),
  ).toBe(false);
  expect(await actor.view(run.conversation_id, run.id)).toEqual(cancelled);
  expect(
    (
      await fixture.database.pool.query(
        'SELECT run_id,reason,idempotency_key FROM harness_cancellations WHERE run_id=$1',
        [run.id],
      )
    ).rows,
  ).toEqual([{ run_id: run.id, reason: cancel.reason, idempotency_key: cancel.idempotency_key }]);
  expect(
    (
      await fixture.database.pool.query(
        'SELECT attempt_no,status FROM run_attempts WHERE run_id=$1',
        [run.id],
      )
    ).rows,
  ).toEqual([{ attempt_no: 1, status: 'failed' }]);
  expect(
    (
      await fixture.database.pool.query(
        'SELECT invocation_id FROM tool_invocations WHERE run_id=$1',
        [run.id],
      )
    ).rows,
  ).toEqual([]);
  expect(fixture.transcripts.get(id)).toHaveLength(1);
  return { id, run, body, cancel, cancelled, events };
}

async function cancelled(mode: ConsumerMode) {
  const actor = await fixture.actor(mode);
  const result = await cancelHeld(actor);
  const facts = await fixture.facts(actor.ownerId);
  expect(facts.tasks).toEqual([]);
  expect(facts.approvals).toEqual([]);
  expect(facts.outbox).toEqual([]);
  expect(await actor.cancel(result.run.conversation_id, result.run.id, result.cancel)).toEqual(
    result.cancelled,
  );
  expect(await actor.history(result.run.conversation_id)).toEqual(result.events);
  expect(await fixture.facts(actor.ownerId)).toEqual(facts);
}

async function replay(mode: ConsumerMode) {
  const actor = await fixture.actor(mode);
  const id = randomUUID();
  const body = await actor.createMessage(fixture.input(id, 'create'));
  const initial = await (await actor.message(body)).events;
  const run = started(initial);
  const waiting = await actor.view(run.conversation_id, run.run_id);
  if (!waiting.waiting) throw new Error('missing replay waiting point');
  await actor.confirm(pending(initial));
  const resume = { checkpoint_id: waiting.waiting.checkpoint_id, idempotency_key: randomUUID() };
  const resumed = await (await actor.resume(run.conversation_id, run.run_id, resume)).events;
  const completed = await actor.view(run.conversation_id, run.run_id);
  expect(completed.status).toBe('done');
  const stopped = await cancelHeld(actor);
  const facts = await fixture.facts(actor.ownerId);
  const transcript = structuredClone([...fixture.transcripts]);
  const completedEvents = [...initial, ...resumed];
  for (let repeat = 0; repeat < 2; repeat++) {
    expect(await (await actor.message(body)).events).toEqual(completedEvents);
    expect(await (await actor.resume(run.conversation_id, run.run_id, resume)).events).toEqual(
      resumed,
    );
    expect(await actor.cancel(stopped.run.conversation_id, stopped.run.id, stopped.cancel)).toEqual(
      stopped.cancelled,
    );
    expect(await (await actor.message(stopped.body)).events).toEqual(stopped.events);
    expect(await actor.view(run.conversation_id, run.run_id)).toEqual(completed);
    expect(await actor.view(stopped.run.conversation_id, stopped.run.id)).toEqual(
      stopped.cancelled,
    );
    expect(await actor.history(run.conversation_id)).toEqual(completedEvents);
    expect(await actor.history(stopped.run.conversation_id)).toEqual(stopped.events);
  }
  expect(await fixture.facts(actor.ownerId)).toEqual(facts);
  expect([...fixture.transcripts]).toEqual(transcript);
}

async function dto(mode: ConsumerMode) {
  const actor = await fixture.actor(mode);
  const withoutConversation = fixture.input(randomUUID(), 'create');
  const body = await actor.createMessage(withoutConversation);
  const original = await fixture.facts(actor.ownerId);
  const transcript = structuredClone([...fixture.transcripts]);
  for (const authority of [
    'owner_id',
    'run_id',
    'attempt_id',
    'tools_allowlist',
    'execution_kind',
    'protocol',
    'snapshot',
  ]) {
    await typedFailure(
      actor.message({ ...body, [authority]: randomUUID() }),
      400,
      'VALIDATION_ERROR',
    );
  }
  for (const invalid of [
    withoutConversation,
    { ...body, execution: 'native' },
    { ...body, execution: null },
    { ...body, conversation_id: 'not-a-uuid' },
    { ...body, idempotency_key: 'not-a-uuid' },
  ])
    await typedFailure(actor.message(invalid), 400, 'VALIDATION_ERROR');
  const cid = randomUUID();
  const rid = randomUUID();
  for (const invalid of [
    { checkpoint_id: 'not-a-uuid', idempotency_key: randomUUID() },
    { checkpoint_id: randomUUID(), idempotency_key: 'not-a-uuid' },
    { checkpoint_id: randomUUID(), idempotency_key: randomUUID(), attempt_id: randomUUID() },
    { checkpoint_id: randomUUID(), idempotency_key: randomUUID(), owner_id: actor.ownerId },
  ])
    await typedFailure(actor.resume(cid, rid, invalid), 400, 'VALIDATION_ERROR');
  for (const invalid of [
    { idempotency_key: randomUUID(), reason: 'x'.repeat(201) },
    { idempotency_key: 'not-a-uuid' },
    { idempotency_key: randomUUID(), owner_id: actor.ownerId },
    { idempotency_key: randomUUID(), attempt_id: randomUUID() },
  ])
    await typedFailure(actor.cancel(cid, rid, invalid), 400, 'VALIDATION_ERROR');
  if (mode === 'http') {
    for (const input of [body, withoutConversation]) {
      const forbidden = await fixture.request(
        actor,
        '/api/v1/conversations/messages',
        input,
        false,
      );
      expect(forbidden.status).toBe(403);
      expect(forbidden.headers.get('content-type')).not.toContain('text/event-stream');
      const envelope = EnvelopeSchema.parse(await forbidden.json());
      expect(envelope.error).toMatchObject({
        code: 'FORBIDDEN',
        details: { reason: 'CSRF_MISMATCH' },
      });
    }
  }
  expect(await fixture.facts(actor.ownerId)).toEqual(original);
  expect([...fixture.transcripts]).toEqual(transcript);
}

async function toolDenied(mode: ConsumerMode) {
  const actor = await fixture.actor(mode);
  const id = randomUUID();
  const body = await actor.createMessage(fixture.input(id, 'denied'));
  const events = await (await actor.message(body)).events;
  const run = started(events);
  expect(events.filter((event) => event.type === 'thread.failed')).toHaveLength(1);
  expect(events.at(-1)).toMatchObject({
    type: 'thread.failed',
    payload: { error: { code: 'TOOL_FORBIDDEN' } },
  });
  expect(
    events.some(
      (event) =>
        event.type === 'message.delta' ||
        event.type === 'thread.completed' ||
        event.type === 'approval_required',
    ),
  ).toBe(false);
  expect(await actor.view(run.conversation_id, run.run_id)).toMatchObject({
    status: 'failed',
    attempt_no: 1,
    waiting: null,
  });
  const invocations = await fixture.database.pool.query<{
    invocation_id: string;
    tool_id: string;
    call_key: string;
    state: string;
    outcome_kind: string;
    accepted_result: unknown;
  }>(
    'SELECT invocation_id,tool_id,call_key,state,outcome_kind,accepted_result FROM tool_invocations WHERE run_id=$1',
    [run.run_id],
  );
  expect(invocations.rows).toHaveLength(1);
  expect(invocations.rows[0]).toMatchObject({
    tool_id: 'get_user_prefs',
    call_key: 'harness/1',
    state: 'completed',
    outcome_kind: 'denied',
  });
  expect(parseResult(invocations.rows[0]!.accepted_result)).toEqual({
    status: 'denied',
    error: { code: 'TOOL_FORBIDDEN', message: 'tool invocation rejected' },
  });
  expect(
    (
      await fixture.database.pool.query(
        'SELECT invocation_id,record_kind,decision,error_code,outcome_kind FROM tool_calls WHERE run_id=$1',
        [run.run_id],
      )
    ).rows,
  ).toEqual([
    {
      invocation_id: invocations.rows[0]!.invocation_id,
      record_kind: 'accepted',
      decision: 'deny',
      error_code: 'TOOL_FORBIDDEN',
      outcome_kind: 'denied',
    },
  ]);
  const facts = await fixture.facts(actor.ownerId);
  expect(facts.approvals).toEqual([]);
  expect(facts.tasks).toEqual([]);
  expect(facts.task_events).toEqual([]);
  expect(facts.outbox).toEqual([]);
  expect(fixture.transcripts.get(id)).toHaveLength(1);
}

// Exact top-level IDs are consumed from this execution's Bun JUnit report.
test('D8.approval.local', () => approval('local'), 30_000);
test('D8.approval.http', () => approval('http'), 30_000);
test('D8.rejected.local', () => rejected('local'), 30_000);
test('D8.rejected.http', () => rejected('http'), 30_000);
test('D8.cancel.local', () => cancelled('local'), 30_000);
test('D8.cancel.http', () => cancelled('http'), 30_000);
test('D8.replay.local', () => replay('local'), 30_000);
test('D8.replay.http', () => replay('http'), 30_000);
test('D8.dto.local', () => dto('local'), 30_000);
test('D8.dto.http', () => dto('http'), 30_000);
test('D8.tool-denied.local', () => toolDenied('local'), 30_000);
test('D8.tool-denied.http', () => toolDenied('http'), 30_000);
