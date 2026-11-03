import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { z } from 'zod';
import {
  EnvelopeSchema,
  GoalResultSchema,
  HarnessModelMessageSchema,
  HarnessToolResultSchema,
  RunViewSchema,
  TrustedExecutionContextSchema,
  type GoalResult,
  type HarnessModelReply,
  type RunView,
} from '@along/contracts';
import {
  DELEGATION_THREAD_PROTOCOL_VERSION,
  ThreadEventSchema,
  THREAD_PROTOCOL_VERSION,
  type ThreadEvent,
} from '@along/stream-protocol';
import { handleRequest } from '../../src/http/app.js';
import {
  cancelConversationRun,
  executeRun,
  getConversationDetail,
  getRunView,
  startConversationRun,
} from '../../src/modules/conversations/service.js';
import type { ConversationDeps, RunContext } from '../../src/modules/conversations/contracts.js';
import { createContextPolicy } from '../../src/modules/conversations/context-policy.js';
import { createHarnessModelTransport } from '../../src/modules/conversations/harness-model.js';
import { seedAdmittedSession as seedSession } from '../integration/setup.js';
import type { SeededSession } from '../../src/modules/identity/seed.js';
import { interruptedGoalResult } from '../../src/modules/conversations/goal-result.js';
import type { ToolContext } from '../../src/modules/tools/contracts.js';
import {
  readInvocationSnapshots,
  readRunInvocationStates,
} from '../../src/modules/tools/invocations.js';
import { readRunTimezoneSettings } from '../../src/modules/tools/query.js';
import { loadTimeContext } from '../../src/modules/time/context.js';
import { createIntegrationDatabase, type IntegrationDatabase } from '../integration/setup.js';
import {
  findModelObservation,
  frames,
  jsonBody,
  listen,
  sendModelSse,
  started,
} from '../helpers/harness-consumer.js';

type Mode = 'local' | 'http';
type Actor = { mode: Mode; session: SeededSession };
type Kind =
  | 'save'
  | 'clear'
  | 'read'
  | 'once'
  | 'forged'
  | 'omit'
  | 'interrupt'
  | 'revoke'
  | 'legacy'
  | 'unsupported'
  | 'control-correction'
  | 'control-exhausted';
const ModelBodySchema = z.object({
  stream: z.literal(true),
  stream_options: z.object({ include_usage: z.literal(true) }),
  parallel_tool_calls: z.literal(false),
  messages: z.array(HarnessModelMessageSchema),
  tools: z.array(
    z.object({
      type: z.literal('function'),
      function: z.object({ name: z.string() }).passthrough(),
    }),
  ),
});
type ModelBody = z.infer<typeof ModelBodySchema>;
const ObservationSchema = z.object({
  view: z.literal('full'),
  invocation_id: z.string().uuid(),
  tool_id: z.string(),
  result: HarnessToolResultSchema,
});
type Observation = z.infer<typeof ObservationSchema>;
const SettingSchema = z
  .object({
    kind: z.literal('timezone_setting'),
    timezone_id: z.string().nullable(),
    previous_timezone_id: z.string().nullable(),
    alias_version: z.string(),
  })
  .strict();
interface Scenario {
  id: string;
  kind: Kind;
  transcript: ModelBody[];
  observations: Observation[];
  held: PromiseWithResolvers<void>;
  closed: PromiseWithResolvers<boolean>;
  released: PromiseWithResolvers<void>;
}

let database: IntegrationDatabase;
let deps: ConversationDeps;
let apiServer: Server;
let modelServer: Server;
let base = '';
const scenarios = new Map<string, Scenario>();
const providerErrors: unknown[] = [];
const executions = new Set<Promise<unknown>>();

function scenario(kind: Kind): Scenario {
  const value = {
    id: randomUUID(),
    kind,
    transcript: [],
    observations: [],
    held: Promise.withResolvers<void>(),
    closed: Promise.withResolvers<boolean>(),
    released: Promise.withResolvers<void>(),
  };
  scenarios.set(value.id, value);
  return value;
}
function reply(name: string, args: unknown): HarnessModelReply {
  return {
    message: {
      content: null,
      tool_calls: [
        {
          id: `provider-${randomUUID()}`,
          type: 'function',
          function: { name, arguments: JSON.stringify(args) },
        },
      ],
    },
    usage: { total_tokens: 8 },
  };
}
function goal(description: string, answer: string, refs: string[] = []): GoalResult {
  return GoalResultSchema.parse({
    status: 'completed',
    outcomes: [{ description, status: 'achieved', receipt_refs: refs }],
    clarification: null,
    answer,
  });
}
async function serveModel(res: ServerResponse, body: ModelBody): Promise<void> {
  const original = body.messages.findLast(
    (message) => message.role === 'user' && message.content.includes('timezoneCase:'),
  );
  const id = /timezoneCase:([\w-]+)/.exec(original?.content ?? '')?.[1];
  const value = id ? scenarios.get(id) : undefined;
  if (!value) throw new Error('missing timezone scenario marker');
  const index = value.transcript.length;
  value.transcript.push(body);
  const observation = findModelObservation(body.messages, ObservationSchema);
  if (observation) value.observations.push(observation);
  if (value.kind === 'legacy') {
    sendModelSse(res, {
      message: { content: '本次仅回答，不修改默认时区。', tool_calls: [] },
      usage: { total_tokens: 8 },
    });
    return;
  }
  if (value.kind === 'once') {
    sendModelSse(
      res,
      reply(
        'finish_goal',
        goal('仅本次使用纽约时间，不保存偏好', '本次按纽约时间理解；没有更改默认时区。'),
      ),
    );
    return;
  }
  if (value.kind === 'control-correction' || value.kind === 'control-exhausted') {
    if (index === 0) {
      sendModelSse(res, reply('get_user_prefs', {}));
      return;
    }
    if (index === 1) {
      sendModelSse(res, reply('set_user_timezone', { timezone_id: 'Unsupported/Zone' }));
      return;
    }
    const denied = findModelObservation(
      body.messages,
      ObservationSchema.refine((item) => item.result.status === 'denied'),
    );
    if (
      !denied ||
      denied.result.status !== 'denied' ||
      denied.result.error.code !== 'UNKNOWN_TIMEZONE'
    )
      throw new Error('expected the real accepted rule denial');
    const blocked = {
      status: 'blocked',
      outcomes: [
        {
          description: 'Unsupported value was not saved',
          status: 'blocked',
          receipt_refs: [] as string[],
        },
      ],
      clarification: null,
      answer: '规则不支持所请求的值，未保存，原默认未变。',
    };
    if (index === 2 || value.kind === 'control-exhausted') {
      sendModelSse(
        res,
        reply('finish_goal', {
          ...blocked,
          outcomes: [{ ...blocked.outcomes[0], receipt_refs: [denied.invocation_id] }],
        }),
      );
      return;
    }
    const rejected = body.messages.findLast(
      (message) => message.role === 'tool' && message.content.includes('INVALID_GOAL_RESULT'),
    );
    expect(rejected).toBeDefined();
    expect(JSON.parse(rejected!.content)).toMatchObject({
      accepted: false,
      code: 'INVALID_GOAL_RESULT',
    });
    sendModelSse(
      res,
      index === 3
        ? reply('set_user_timezone', { timezone_id: 'Asia/Shanghai' })
        : reply('finish_goal', blocked),
    );
    return;
  }
  if (index === 0) {
    sendModelSse(
      res,
      value.kind === 'read'
        ? reply('get_user_prefs', {})
        : reply('set_user_timezone', {
            timezone_id:
              value.kind === 'clear'
                ? null
                : value.kind === 'unsupported'
                  ? 'Atlantis/Mars'
                  : '纽约时间',
          }),
    );
    return;
  }
  if (value.kind === 'unsupported') {
    if (
      !observation ||
      observation.result.status !== 'denied' ||
      observation.result.error.code !== 'UNKNOWN_TIMEZONE'
    )
      throw new Error(
        'native must expose the actual unsupported-timezone denial before goal completion',
      );
    sendModelSse(
      res,
      reply('finish_goal', {
        status: 'blocked',
        outcomes: [
          {
            description: '当前规则不支持该时区，原默认值未更改',
            status: 'blocked',
            receipt_refs: [],
          },
        ],
        clarification: null,
        answer: '本版本不支持 Atlantis/Mars，未保存，仍保留上海默认时区。',
      }),
    );
    return;
  }
  if (!observation || observation.result.status !== 'ok')
    throw new Error('native omitted the actual accepted tool observation');
  if (value.kind === 'interrupt') {
    // The gate is the actual second provider request, AFTER committed setting
    // acceptance; no sleeps or timing guesses establish interruption ordering.
    res.once('close', () => value.closed.resolve(!res.writableEnded && res.destroyed));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(': waiting for explicit cancellation\n\n', () => value.held.resolve());
    return;
  }
  if (value.kind === 'revoke') {
    // A real accepted receipt has reached the second model request. The test
    // disables the owner before releasing this attempted subsequent effect.
    value.held.resolve();
    await value.released.promise;
    sendModelSse(res, reply('set_user_timezone', { timezone_id: 'Asia/Shanghai' }));
    return;
  }
  let result: GoalResult;
  if (value.kind === 'read') {
    if (observation.result.result.kind !== 'prefs') throw new Error('expected real prefs payload');
    const timezone = observation.result.result.timezone_id;
    result = goal('读取当前保存的默认时区', `当前默认时区：${timezone ?? '未设置'}。`, [
      observation.invocation_id,
    ]);
  } else {
    const setting = SettingSchema.parse(observation.result.result);
    result = goal(
      setting.timezone_id === null ? '清除本人默认时区' : '保存本人默认时区',
      setting.timezone_id === null
        ? '已清除默认时区。'
        : `已保存默认时区：${setting.timezone_id}。`,
      value.kind === 'omit' ? [] : [observation.invocation_id],
    );
    if (value.kind === 'forged') result.outcomes[0]!.receipt_refs.push(randomUUID());
  }
  sendModelSse(res, reply('finish_goal', result));
}

beforeAll(async () => {
  const binaryPath = process.env.HARNESS_BINARY;
  const libraryPath = process.env.HARNESS_LIBRARY_PATH;
  if (
    !binaryPath ||
    !libraryPath ||
    !process.env.BETTER_AUTH_SECRET ||
    process.platform !== 'linux'
  )
    throw new Error(
      'Timezone delegation contracts require official Linux HARNESS_BINARY/HARNESS_LIBRARY_PATH, DATABASE_URL and BETTER_AUTH_SECRET',
    );
  database = await createIntegrationDatabase();
  modelServer = createServer((req, res) => {
    void (async () => serveModel(res, ModelBodySchema.parse(await jsonBody(req))))().catch(
      (error: unknown) => {
        providerErrors.push(error);
        if (!res.headersSent) res.writeHead(500);
        res.end();
      },
    );
  });
  const modelBase = await listen(modelServer);
  deps = {
    pool: database.pool,
    timeContext: loadTimeContext('fixture-v1'),
    harness: {
      binaryPath,
      libraryPath,
      maxIterations: 8,
      maxTokens: 8000,
      contextPolicy: createContextPolicy({
        completionCap: 1024,
        model: 'timezone-controlled-provider',
      }),
      model: createHarnessModelTransport({
        baseUrl: `${modelBase}/v1`,
        model: 'timezone-controlled-provider',
      }),
    },
  };
  apiServer = createServer((req, res) => {
    void handleRequest(req, res, {
      pool: database.pool,
      timeContext: deps.timeContext,
      harness: deps.harness,
    }).catch(() => res.destroy());
  });
  base = await listen(apiServer);
}, 30_000);

afterAll(async () => {
  try {
    if (database) {
      const active = await database.pool.query<{
        owner_id: string;
        conversation_id: string;
        id: string;
      }>("SELECT owner_id,conversation_id,id FROM agent_runs WHERE status='running'");
      for (const run of active.rows)
        await cancelConversationRun(deps, run.owner_id, run.conversation_id, run.id, randomUUID(), {
          idempotency_key: randomUUID(),
          reason: 'fixture_cleanup',
        });
      await Promise.allSettled([...executions]);
    }
  } finally {
    for (const server of [apiServer, modelServer]) {
      if (!server?.listening) continue;
      const closed = once(server, 'close');
      server.closeAllConnections();
      server.close();
      await closed;
    }
    await database?.close();
  }
  expect(providerErrors).toEqual([]);
}, 30_000);

async function actor(mode: Mode): Promise<Actor> {
  return { mode, session: await seedSession(database.pool, { timezoneId: 'Asia/Shanghai' }) };
}
function input(value: Scenario, overrides: Record<string, unknown> = {}) {
  const descriptions: Record<Kind, string> = {
    save: '请把我的默认时区保存为纽约时间。',
    clear: '请清除我保存的默认时区。',
    read: '我保存的默认时区是什么？',
    once: '只这次按纽约时间理解，不要保存默认时区。',
    forged: '保存纽约时间为默认时区，然后报告真实收据。',
    omit: '保存纽约时间为默认时区，然后报告真实结果。',
    interrupt: '先保存纽约时间为默认时区，再回答当前设置。',
    revoke: '先保存纽约默认时区，然后再改为上海时间。',
    legacy: '请仅回答，不修改任何默认时区。',
    unsupported: '请保存 Atlantis/Mars 默认时区；不支持则保留原值并如实报告。',
    'control-correction': '请保存我指定的默认时区，不支持就保留原值并如实说明。',
    'control-exhausted': '请保存我指定的默认时区，不支持就保留原值并如实说明。',
  };
  return {
    execution: 'harness',
    ...(value.kind === 'legacy' ? {} : { authorization_revision: 'delegation/1' }),
    raw_text: `timezoneCase:${value.id} ${descriptions[value.kind]}`,
    idempotency_key: randomUUID(),
    ...overrides,
  };
}
function track<T>(work: Promise<T>): Promise<T> {
  executions.add(work);
  void work.finally(() => executions.delete(work)).catch(() => {});
  return work;
}
function request(who: Actor, path: string, body?: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      cookie: `better-auth.session_token=${who.session.token}`,
      'x-csrf-token': who.session.csrfToken,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function successful(response: Response): Promise<unknown> {
  expect(response.status).toBe(200);
  const envelope = EnvelopeSchema.parse(await response.json());
  expect(envelope.error).toBeNull();
  expect(envelope.code).toBe(0);
  return envelope.data;
}
async function message(
  who: Actor,
  body: unknown,
): Promise<{ context: RunContext | null; events: Promise<ThreadEvent[]> }> {
  if (who.mode === 'http') {
    const response = await request(who, '/api/v1/conversations/messages', body);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    return { context: null, events: track(response.text().then(frames)) };
  }
  const start = await startConversationRun(deps, who.session.userId, randomUUID(), body, null);
  if (start.replay) return { context: null, events: Promise.resolve(start.replay) };
  const context = start.context;
  if (!context) throw new Error('missing accepted local execution context');
  const events: ThreadEvent[] = [];
  return {
    context,
    events: track(
      executeRun(deps, context, async (event) => {
        events.push(ThreadEventSchema.parse(event));
        return true;
      }).then(() => events),
    ),
  };
}
async function view(who: Actor, cid: string, rid: string): Promise<RunView> {
  return who.mode === 'local'
    ? getRunView(deps, who.session.userId, cid, rid)
    : RunViewSchema.parse(
        await successful(await request(who, `/api/v1/conversations/${cid}/runs/${rid}`)),
      );
}
async function history(who: Actor, cid: string): Promise<ThreadEvent[]> {
  if (who.mode === 'local')
    return (await getConversationDetail(deps, who.session.userId, cid, {})).events;
  return z
    .object({ events: z.array(ThreadEventSchema) })
    .parse(await successful(await request(who, `/api/v1/conversations/${cid}`))).events;
}
async function cancel(who: Actor, cid: string, rid: string, body: unknown): Promise<RunView> {
  return who.mode === 'local'
    ? cancelConversationRun(deps, who.session.userId, cid, rid, randomUUID(), body)
    : RunViewSchema.parse(
        await successful(
          await request(who, `/api/v1/conversations/${cid}/runs/${rid}/actions/cancel`, body),
        ),
      );
}
async function preferences(who: Actor) {
  return (
    await database.pool.query<{ timezone_id: string | null; updated_at: Date }>(
      'SELECT timezone_id,updated_at FROM users WHERE id=$1',
      [who.session.userId],
    )
  ).rows[0]!;
}
async function facts(who: Actor) {
  const result: Record<string, unknown[]> = {};
  result.users = (
    await database.pool.query('SELECT to_jsonb(u) AS fact FROM users u WHERE id=$1', [
      who.session.userId,
    ])
  ).rows.map((row) => row.fact);
  for (const table of [
    'conversations',
    'messages',
    'agent_runs',
    'run_attempts',
    'run_checkpoints',
    'conversation_idempotency',
    'tool_invocations',
    'tool_calls',
    'harness_cancellations',
    'approvals',
    'tasks',
    'task_events',
    'outbox',
  ]) {
    result[table] = (
      await database.pool.query(
        `SELECT to_jsonb(t) AS fact FROM ${table} t WHERE owner_id=$1 ORDER BY to_jsonb(t)::text`,
        [who.session.userId],
      )
    ).rows.map((row) => row.fact);
  }
  return result;
}
async function invocations(rid: string) {
  return (
    await database.pool.query<{
      invocation_id: string;
      tool_id: string;
      state: string;
      accepted_result: unknown;
      result_version: number;
      outcome_kind: string;
      call_key: string;
    }>(
      'SELECT invocation_id,tool_id,state,accepted_result,result_version,outcome_kind,call_key FROM tool_invocations WHERE run_id=$1 ORDER BY call_key',
      [rid],
    )
  ).rows;
}
function trusted(body: ModelBody) {
  const context = findModelObservation(
    body.messages.filter((item) => item.role === 'system'),
    TrustedExecutionContextSchema,
  );
  if (!context) throw new Error('trusted execution facts missing from system layer');
  expect(
    findModelObservation(
      body.messages.filter((item) => item.role !== 'system'),
      TrustedExecutionContextSchema,
    ),
  ).toBeUndefined();
  return context;
}
async function final(who: Actor, events: ThreadEvent[], status: 'done' | 'failed' | 'cancelled') {
  const run = started(events);
  const projection = await view(who, run.conversation_id, run.run_id);
  expect(projection).toMatchObject({
    status,
    authorization_revision: 'delegation/1',
    execution_lifecycle: 'request-bound',
    waiting: null,
    can_resume: false,
  });
  const result = GoalResultSchema.parse(projection.goal_result);
  const terminals = events.filter((event) =>
    ['thread.completed', 'thread.failed', 'thread.cancelled'].includes(event.type),
  );
  expect(terminals).toHaveLength(1);
  expect(terminals[0]?.type).toBe(
    status === 'done'
      ? 'thread.completed'
      : status === 'failed'
        ? 'thread.failed'
        : 'thread.cancelled',
  );
  expect(terminals[0]).toMatchObject({
    protocol_version: DELEGATION_THREAD_PROTOCOL_VERSION,
    payload: { goal_result: result },
  });
  expect(events.find((event) => event.type === 'thread.started')).toMatchObject({
    protocol_version: DELEGATION_THREAD_PROTOCOL_VERSION,
    payload: { authorization_revision: 'delegation/1', execution_lifecycle: 'request-bound' },
  });
  expect(events.some((event) => event.type === 'approval_required')).toBe(false);
  const persisted = (
    await database.pool.query<{ goal_result: unknown; status: string }>(
      'SELECT goal_result,status FROM agent_runs WHERE id=$1',
      [run.run_id],
    )
  ).rows[0]!;
  expect(persisted).toEqual({ goal_result: result, status });
  expect(
    (
      await database.pool.query<{ content: string }>(
        "SELECT content FROM messages WHERE conversation_id=$1 AND owner_id=$2 AND role='assistant' ORDER BY created_at,id",
        [run.conversation_id, who.session.userId],
      )
    ).rows.at(-1)?.content,
  ).toBe(result.answer);
  expect(await history(who, run.conversation_id)).toEqual(events);
  return { run, projection, result };
}
async function noUnrelatedEffects(who: Actor) {
  for (const table of ['approvals', 'tasks', 'task_events', 'outbox'])
    expect(
      (await database.pool.query(`SELECT 1 FROM ${table} WHERE owner_id=$1`, [who.session.userId]))
        .rows,
    ).toEqual([]);
}

for (const mode of ['local', 'http'] as const) {
  for (const kind of ['control-correction', 'control-exhausted'] as const) {
    test(`D8.timezone-${mode}-${kind}`, async () => {
      const who = await actor(mode);
      const before = await preferences(who);
      const value = scenario(kind);
      const events = await (await message(who, input(value))).events;
      const completed = await final(who, events, kind === 'control-correction' ? 'done' : 'failed');
      const rows = await invocations(completed.run.run_id);
      expect(rows.map((row) => row.tool_id)).toEqual(['get_user_prefs', 'set_user_timezone']);
      expect(rows[1]).toMatchObject({
        state: 'completed',
        accepted_result: { status: 'denied', error: { code: 'UNKNOWN_TIMEZONE' } },
      });
      expect(await preferences(who)).toEqual(before);
      expect(completed.result.status).toBe('blocked');
      expect(completed.result.outcomes.flatMap((outcome) => outcome.receipt_refs)).toEqual([]);
      expect(
        events.filter((event) =>
          ['thread.completed', 'thread.failed', 'thread.cancelled'].includes(event.type),
        ),
      ).toHaveLength(1);
      if (kind === 'control-correction') {
        expect(value.transcript).toHaveLength(5);
      } else {
        expect(events.find((event) => event.type === 'thread.failed')).toMatchObject({
          payload: { error: { code: 'BUDGET_EXCEEDED' } },
        });
        expect(value.transcript).toHaveLength(8);
      }
      const frozen = await facts(who);
      expect(await history(who, completed.run.conversation_id)).toEqual(events);
      expect(await facts(who)).toEqual(frozen);
      await noUnrelatedEffects(who);
    }, 30_000);
  }

  test(`D8.timezone-${mode}-unsupported`, async () => {
    const who = await actor(mode);
    const before = await preferences(who);
    const value = scenario('unsupported');
    const completed = await final(who, await (await message(who, input(value))).events, 'done');
    expect(completed.result.status).toBe('blocked');
    expect(completed.result.outcomes).toMatchObject([{ status: 'blocked', receipt_refs: [] }]);
    expect(await preferences(who)).toEqual(before);
    const rows = await invocations(completed.run.run_id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: 'completed', outcome_kind: 'denied' });
    expect(HarnessToolResultSchema.parse(rows[0]!.accepted_result)).toMatchObject({
      status: 'denied',
      error: { code: 'UNKNOWN_TIMEZONE' },
    });
    await noUnrelatedEffects(who);
  }, 30_000);

  test(`D8.timezone-${mode}-save-clear`, async () => {
    const who = await actor(mode);
    const save = scenario('save');
    const body = input(save);
    const opened = await message(who, body);
    if (opened.context) expect(opened.context.authorizationRevision).toBe('delegation/1');
    const savedEvents = await opened.events;
    const saved = await final(who, savedEvents, 'done');
    expect(saved.result.status).toBe('completed');
    expect((await preferences(who)).timezone_id).toBe('America/New_York');
    const rows = await invocations(saved.run.run_id);
    expect(rows).toHaveLength(1);
    const receipt = rows[0]!;
    expect(receipt).toMatchObject({
      tool_id: 'set_user_timezone',
      state: 'completed',
      outcome_kind: 'success',
      result_version: 1,
      call_key: 'harness/1',
    });
    const accepted = HarnessToolResultSchema.parse(receipt.accepted_result);
    if (accepted.status !== 'ok')
      throw new Error('saved preference lacks an accepted success receipt');
    expect(SettingSchema.parse(accepted.result)).toEqual({
      kind: 'timezone_setting',
      timezone_id: 'America/New_York',
      previous_timezone_id: 'Asia/Shanghai',
      alias_version: 'ALIAS_TABLE_V1',
    });
    expect(saved.result.outcomes[0]!.receipt_refs).toEqual([receipt.invocation_id]);
    expect(save.observations[0]?.invocation_id).toBe(receipt.invocation_id);
    expect(save.transcript).toHaveLength(2);
    const frozen = await facts(who);
    for (let repeat = 0; repeat < 2; repeat++) {
      expect(await (await message(who, body)).events).toEqual(savedEvents);
      expect(await view(who, saved.run.conversation_id, saved.run.run_id)).toEqual(
        saved.projection,
      );
      expect(await history(who, saved.run.conversation_id)).toEqual(savedEvents);
    }
    expect(await facts(who)).toEqual(frozen);
    expect(save.transcript).toHaveLength(2);
    const read = scenario('read');
    const readEvents = await (await message(who, input(read))).events;
    const readResult = await final(who, readEvents, 'done');
    expect(readResult.run.conversation_id).not.toBe(saved.run.conversation_id);
    expect(trusted(read.transcript[0]!).timezone).toMatchObject({
      timezone_id: 'America/New_York',
      source: 'preference',
      reference: who.session.userId,
    });
    expect(readResult.result.answer).toBe('当前默认时区：America/New_York。');
    const clear = scenario('clear');
    const clearResult = await final(who, await (await message(who, input(clear))).events, 'done');
    const clearRows = await invocations(clearResult.run.run_id);
    expect(clearRows).toHaveLength(1);
    expect(clearRows[0]!.accepted_result).toMatchObject({
      status: 'ok',
      result: {
        kind: 'timezone_setting',
        timezone_id: null,
        previous_timezone_id: 'America/New_York',
      },
    });
    expect(clearResult.result.outcomes[0]!.receipt_refs).toEqual([clearRows[0]!.invocation_id]);
    expect((await preferences(who)).timezone_id).toBeNull();
    const afterClear = scenario('read');
    const afterClearResult = await final(
      who,
      await (
        await message(who, input(afterClear))
      ).events,
      'done',
    );
    expect(trusted(afterClear.transcript[0]!).timezone).toBeNull();
    expect(afterClearResult.result.answer).toBe('当前默认时区：未设置。');
    await noUnrelatedEffects(who);
  }, 30_000);

  test(`D8.timezone-${mode}-single-use-context`, async () => {
    const who = await actor(mode);
    const before = await preferences(who);
    const value = scenario('once');
    const events = await (
      await message(who, input(value, { confirmed_timezone: 'America/New_York' }))
    ).events;
    const completed = await final(who, events, 'done');
    expect(await preferences(who)).toEqual(before);
    expect(await invocations(completed.run.run_id)).toEqual([]);
    expect(completed.result.outcomes[0]!.receipt_refs).toEqual([]);
    const body = value.transcript[0]!;
    const context = trusted(body);
    expect(context).toMatchObject({
      authorization_revision: 'delegation/1',
      execution_lifecycle: 'request-bound',
      timezone: { timezone_id: 'America/New_York', source: 'explicit' },
      time_capabilities: { elapsed_revision: 'elapsed/1' },
      workspaces: [],
    });
    const persisted = (
      await database.pool.query<{
        input_message_id: string;
        frozen_context: { trustedExecutionContext: unknown };
      }>('SELECT input_message_id,frozen_context FROM agent_runs WHERE id=$1', [
        completed.run.run_id,
      ])
    ).rows[0]!;
    expect(context.input_message_id).toBe(persisted.input_message_id);
    expect(context.timezone?.reference).toBe(persisted.input_message_id);
    expect(persisted.frozen_context.trustedExecutionContext).toEqual(context);
    await noUnrelatedEffects(who);
  }, 30_000);

  test(`D8.timezone-${mode}-forged-receipt`, async () => {
    for (const kind of ['forged', 'omit'] as const) {
      const who = await actor(mode);
      const value = scenario(kind);
      const events = await (await message(who, input(value))).events;
      const failed = await final(who, events, 'failed');
      const rows = await invocations(failed.run.run_id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        tool_id: 'set_user_timezone',
        state: 'completed',
        outcome_kind: 'success',
      });
      expect((await preferences(who)).timezone_id).toBe('America/New_York');
      expect(failed.result.status).toBe('partial');
      expect(
        failed.result.outcomes.find((outcome) => outcome.status === 'achieved')?.receipt_refs,
      ).toEqual([rows[0]!.invocation_id]);
      expect(failed.result.outcomes.some((outcome) => outcome.status === 'not_done')).toBe(true);
      expect(failed.result.outcomes.flatMap((outcome) => outcome.receipt_refs)).toEqual([
        rows[0]!.invocation_id,
      ]);
      expect(events.some((event) => event.type === 'thread.completed')).toBe(false);
      const frozen = await facts(who);
      expect(await history(who, failed.run.conversation_id)).toEqual(events);
      expect(await facts(who)).toEqual(frozen);
      await noUnrelatedEffects(who);
    }
  }, 30_000);

  test(`D8.timezone-${mode}-cancel-accepted`, async () => {
    const who = await actor(mode);
    const value = scenario('interrupt');
    const body = input(value);
    const stream = await message(who, body);
    await value.held.promise;
    const running = (
      await database.pool.query<{ id: string; conversation_id: string }>(
        "SELECT id,conversation_id FROM agent_runs WHERE owner_id=$1 AND status='running'",
        [who.session.userId],
      )
    ).rows;
    expect(running).toHaveLength(1);
    const run = running[0]!;
    const rows = await invocations(run.id);
    expect(rows).toHaveLength(1);
    expect(value.observations[0]?.invocation_id).toBe(rows[0]!.invocation_id);
    expect((await preferences(who)).timezone_id).toBe('America/New_York');
    const cancellation = {
      idempotency_key: randomUUID(),
      reason: '停止剩余步骤，不撤销已保存偏好',
    };
    const stopped = await cancel(who, run.conversation_id, run.id, cancellation);
    expect(stopped.status).toBe('cancelled');
    expect(await value.closed.promise).toBe(true);
    const events = await stream.events;
    const completed = await final(who, events, 'cancelled');
    expect(completed.result.status).toBe('cancelled');
    expect(
      completed.result.outcomes.find((outcome) => outcome.status === 'achieved')?.receipt_refs,
    ).toEqual([rows[0]!.invocation_id]);
    expect(completed.result.outcomes.some((outcome) => outcome.status === 'not_done')).toBe(true);
    expect((await preferences(who)).timezone_id).toBe('America/New_York');
    const frozen = await facts(who);
    expect(await cancel(who, run.conversation_id, run.id, cancellation)).toEqual(stopped);
    expect(await (await message(who, body)).events).toEqual(events);
    expect(await view(who, run.conversation_id, run.id)).toEqual(stopped);
    expect(await facts(who)).toEqual(frozen);
    expect(value.transcript).toHaveLength(2);
    await noUnrelatedEffects(who);
  }, 30_000);

  test(`D8.timezone-${mode}-revoke-accepted`, async () => {
    const who = await actor(mode);
    const other = await actor(mode);
    const value = scenario('revoke');
    const body = input(value);
    const stream = await message(who, body);
    await value.held.promise;
    const runs = (
      await database.pool.query<{
        id: string;
        conversation_id: string;
        tools_allowlist: string[];
        frozen_context: Pick<
          ToolContext,
          'confirmedTimezone' | 'anchorReceivedAtUtc' | 'receivedAtUtc' | 'foldChoice'
        >;
      }>(
        "SELECT id,conversation_id,tools_allowlist,frozen_context FROM agent_runs WHERE owner_id=$1 AND status='running'",
        [who.session.userId],
      )
    ).rows;
    expect(runs).toHaveLength(1);
    const run = runs[0]!;
    const attempts = (
      await database.pool.query<{ id: string; status: string; ended_at: Date | null }>(
        'SELECT id,status,ended_at FROM run_attempts WHERE run_id=$1',
        [run.id],
      )
    ).rows;
    expect(attempts).toHaveLength(1);
    const context: ToolContext = stream.context ?? {
      ...run.frozen_context,
      ownerId: who.session.userId,
      conversationId: run.conversation_id,
      runId: run.id,
      attemptId: attempts[0]!.id,
      requestId: randomUUID(),
      allowlist: run.tools_allowlist,
      authorizationRevision: 'delegation/1',
      timeContext: deps.timeContext,
    };
    const receipts = await invocations(run.id);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      tool_id: 'set_user_timezone',
      state: 'completed',
      outcome_kind: 'success',
      result_version: 1,
      accepted_result: {
        status: 'ok',
        result: {
          kind: 'timezone_setting',
          timezone_id: 'America/New_York',
          previous_timezone_id: 'Asia/Shanghai',
        },
      },
    });
    expect(value.observations[0]?.invocation_id).toBe(receipts[0]!.invocation_id);
    const acceptedPreference = await preferences(who);
    expect(acceptedPreference.timezone_id).toBe('America/New_York');
    let events: ThreadEvent[] = [];
    try {
      await database.pool.query("UPDATE users SET status='disabled' WHERE id=$1", [
        who.session.userId,
      ]);
      value.released.resolve();
      events = await stream.events;
      const persisted = (
        await database.pool.query<{ status: string; ended_at: Date | null; goal_result: unknown }>(
          'SELECT status,ended_at,goal_result FROM agent_runs WHERE id=$1',
          [run.id],
        )
      ).rows[0]!;
      // This is the R1 Red: previously terminal accounting re-authorized the
      // disabled owner, rolled back, and silently left this Run running.
      expect(persisted.status).toBe('failed');
      expect(persisted.ended_at).not.toBeNull();
      const result = GoalResultSchema.parse(persisted.goal_result);
      expect(result.status).toBe('partial');
      expect(result.outcomes.find((item) => item.status === 'achieved')?.receipt_refs).toEqual([
        receipts[0]!.invocation_id,
      ]);
      expect(result.outcomes.some((item) => item.status === 'not_done')).toBe(true);
      expect(result.outcomes.flatMap((item) => item.receipt_refs)).toEqual([
        receipts[0]!.invocation_id,
      ]);
      expect(
        events.filter((event) =>
          ['thread.completed', 'thread.failed', 'thread.cancelled'].includes(event.type),
        ),
      ).toEqual([]);
      expect(events.some((event) => event.type === 'message.delta')).toBe(false);
      expect(
        (
          await database.pool.query(
            `SELECT c.kind,c.payload->'payload' AS payload FROM run_checkpoints c
             JOIN run_attempts a ON a.id=c.attempt_id
             WHERE a.run_id=$1 AND c.kind IN ('thread.completed','thread.failed','thread.cancelled')`,
            [run.id],
          )
        ).rows,
      ).toMatchObject([{ kind: 'thread.failed', payload: { goal_result: result } }]);
      expect(
        (
          await database.pool.query<{ status: string; ended_at: Date | null }>(
            'SELECT status,ended_at FROM run_attempts WHERE run_id=$1',
            [run.id],
          )
        ).rows,
      ).toEqual([{ status: 'failed', ended_at: expect.any(Date) }]);
      expect(await preferences(who)).toEqual(acceptedPreference);
      expect(await invocations(run.id)).toEqual(receipts);
      const client = await database.pool.connect();
      try {
        for (const binding of [
          context,
          { ...context, ownerId: other.session.userId },
          { ...context, conversationId: randomUUID() },
          { ...context, runId: randomUUID() },
        ]) {
          await expect(readRunTimezoneSettings(client, binding)).rejects.toMatchObject({
            httpStatus: 403,
          });
          await expect(readRunInvocationStates(client, binding)).rejects.toMatchObject({
            httpStatus: 403,
          });
          await expect(
            readInvocationSnapshots(client, binding, [receipts[0]!.invocation_id]),
          ).rejects.toMatchObject({ httpStatus: 403 });
        }
        for (const binding of [
          { ...context, ownerId: other.session.userId },
          { ...context, conversationId: randomUUID() },
          { ...context, runId: randomUUID() },
        ])
          await expect(interruptedGoalResult(client, binding, 'failed')).rejects.toMatchObject({
            httpStatus: 403,
          });
      } finally {
        client.release();
      }
      await expect(
        getRunView(deps, who.session.userId, run.conversation_id, run.id),
      ).rejects.toMatchObject({ httpStatus: 403 });
      for (const path of [
        `/api/v1/conversations/${run.conversation_id}/runs/${run.id}`,
        `/api/v1/conversations/${run.conversation_id}`,
      ])
        expect((await request(who, path)).status).toBe(401);
    } finally {
      value.released.resolve();
      // Fixture-only reset also lets existing teardown clean up a Red Run.
      await database.pool.query("UPDATE users SET status='active' WHERE id=$1", [
        who.session.userId,
      ]);
    }
    // Only an authorized historical read may disclose the durable GoalResult.
    // The revoked live stream intentionally contains just the earlier prefix.
    const durableEvents = await history(who, run.conversation_id);
    expect(durableEvents.slice(0, events.length)).toEqual(events);
    const failed = await final(who, durableEvents, 'failed');
    const frozen = await facts(who);
    for (let repeat = 0; repeat < 2; repeat++) {
      expect(await history(who, run.conversation_id)).toEqual(durableEvents);
      expect(await view(who, run.conversation_id, run.id)).toEqual(failed.projection);
      expect(await (await message(who, body)).events).toEqual(durableEvents);
    }
    expect(await facts(who)).toEqual(frozen);
    expect(value.transcript).toHaveLength(2);
    await noUnrelatedEffects(who);
  }, 30_000);

  test(`D8.timezone-${mode}-legacy-profile`, async () => {
    const who = await actor(mode);
    const before = await preferences(who);
    const value = scenario('legacy');
    const stream = await message(who, input(value));
    if (stream.context) {
      expect(stream.context.authorizationRevision).toBeUndefined();
      expect(stream.context.trustedExecutionContext).toBeUndefined();
      expect(stream.context.allowlist).not.toContain('set_user_timezone');
    }
    const events = await stream.events;
    const run = started(events);
    const projection = await view(who, run.conversation_id, run.run_id);
    expect(projection.status).toBe('done');
    expect(projection.authorization_revision).toBeUndefined();
    expect(projection.goal_result).toBeUndefined();
    expect(events.every((event) => event.protocol_version === THREAD_PROTOCOL_VERSION)).toBe(true);
    expect(
      findModelObservation(value.transcript[0]!.messages, TrustedExecutionContextSchema),
    ).toBeUndefined();
    const names = value.transcript[0]!.tools.map((tool) => tool.function.name);
    expect(names).not.toContain('set_user_timezone');
    expect(names).not.toContain('finish_goal');
    expect(await preferences(who)).toEqual(before);
    expect(await invocations(run.run_id)).toEqual([]);
    const persisted = (
      await database.pool.query<{ frozen_context: Record<string, unknown> }>(
        'SELECT frozen_context FROM agent_runs WHERE id=$1',
        [run.run_id],
      )
    ).rows[0]!;
    expect(persisted.frozen_context.authorization_revision).toBeUndefined();
    expect(persisted.frozen_context.trustedExecutionContext).toBeUndefined();
    await noUnrelatedEffects(who);
  }, 30_000);
}
