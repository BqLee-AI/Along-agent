import {
  listReminderClarifications,
  readReminderTimeErrors,
} from '../../src/agent/tools/reminders/reminder-source.js';
import { configureTestModel, controlledModelDeps } from '../helpers/model-selection.js';
import { createFixtureConversation } from '../helpers/bot-conversation.js';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { z } from 'zod';
import {
  EnvelopeSchema,
  HarnessModelMessageSchema,
  HarnessToolResultSchema,
  RunViewSchema,
  type HarnessModelReply,
} from '@along/contracts';
import { ThreadEventSchema, type ThreadEvent } from '@along/stream-protocol';
import { handleRequest } from '../helpers/http-app.js';
import { executeRun } from '../../src/agent/run/execute-turn.js';
import { getRunView } from '../../src/agent/run/run-actions.js';
import { startConversationRun } from '../../src/agent/run/admit-message.js';
import { acceptReminderDate } from '../../src/features/conversations/run/reminder-date-continuation.js';
import type { ConversationDeps } from '../../src/agent/execution/contracts.js';
import { createContextPolicy } from '../../src/features/conversations/public.js';
import { createLocalFixtureModelTransport } from '../helpers/local-fixture-model.js';
import type { HarnessServices } from '../../src/agent/execution/contracts.js';
import { loadTimeContext } from '../../src/features/time/context.js';
import {
  createIntegrationDatabase,
  seedAdmittedSession as seedSession,
  type IntegrationDatabase,
} from '../integration/setup.js';
import { frames, jsonBody, listen, sendModelSse, started } from '../helpers/harness-consumer.js';

const Body = z.object({ messages: z.array(HarnessModelMessageSchema) });
const Observation = z.object({
  view: z.literal('full'),
  invocation_id: z.string().uuid(),
  tool_id: z.string(),
  result: HarnessToolResultSchema,
});
const cases = new Map<
  string,
  {
    observations: Map<string, z.infer<typeof Observation>>;
    calls: number;
    singleTime?: string;
  }
>();
let database: IntegrationDatabase;
let deps: ConversationDeps;
let modelServer: Server;
let apiServer: Server;
let base = '';
const providerErrors: unknown[] = [];
const time1 = '2027年11月4日15:00提醒我核对报告';
const time2 = '2027年11月5日16:00提醒我提交报告';
function reply(name: string, args: unknown): HarnessModelReply {
  return {
    message: {
      content: null,
      tool_calls: [
        { id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } },
      ],
    },
    usage: { total_tokens: 8 },
  };
}
beforeAll(async () => {
  const binaryPath = process.env.HARNESS_BINARY,
    libraryPath = process.env.HARNESS_LIBRARY_PATH;
  if (!binaryPath || !libraryPath || !process.env.BETTER_AUTH_SECRET)
    throw new Error('Official native and signed HTTP fixtures are required');
  database = await createIntegrationDatabase();
  modelServer = createServer((req, res) => {
    void (async () => {
      const body = Body.parse(await jsonBody(req));
      const user = body.messages.findLast(
        (message) => message.role === 'user' && message.content.includes('directCase:'),
      );
      const id = /directCase:([\w-]+)/.exec(user?.content ?? '')?.[1];
      const value = id ? cases.get(id) : undefined;
      if (!value) throw new Error('missing direct reminder scenario');
      value.calls++;
      for (const message of body.messages) {
        const start = message.content.indexOf('{');
        if (start < 0) continue;
        try {
          const parsed = Observation.safeParse(JSON.parse(message.content.slice(start)));
          if (parsed.success) value.observations.set(parsed.data.invocation_id, parsed.data);
        } catch {
          /* Native explanatory text is not an observation. */
        }
      }
      if (value.singleTime) {
        const observations = [...value.observations.values()];
        const creation = observations.find(
          (item) => item.result.status === 'ok' && item.result.result.kind === 'task_created',
        );
        const timeError = observations.find(
          (item) => item.result.status === 'ok' && item.result.result.kind === 'time_error',
        );
        sendModelSse(
          res,
          creation || timeError
            ? reply('finish_goal', {
                status: creation ? 'completed' : 'blocked',
                outcomes: [
                  {
                    description: '记录所委托的核对报告提醒',
                    status: creation ? 'achieved' : 'blocked',
                    receipt_refs: creation ? [creation.invocation_id] : [],
                  },
                ],
                clarification: creation
                  ? null
                  : { kind: 'time', question: '请选择第一次或第二次01:30。' },
                answer: creation
                  ? '提醒已记录。创建回执不代表排期或通知。'
                  : '该墙上时间有两次，请选择。',
              })
            : reply('create_reminder', {
                raw_time_text: value.singleTime,
                note: '核对报告',
                occurrence: 'once',
              }),
        );
        return;
      }
      const creations = [...value.observations.values()].filter(
        (item) => item.result.status === 'ok' && item.result.result.kind === 'task_created',
      );
      if (creations.length < 2) {
        const index = creations.length;
        sendModelSse(
          res,
          reply('create_reminder', {
            raw_time_text: index ? time2 : time1,
            note: index ? '提交报告' : '核对报告',
            occurrence: 'once',
          }),
        );
      } else {
        sendModelSse(
          res,
          reply('finish_goal', {
            status: 'completed',
            outcomes: creations.map((item) => ({
              description: '记录所委托的提醒',
              status: 'achieved',
              receipt_refs: [item.invocation_id],
            })),
            clarification: null,
            answer: '两条提醒已记录，调度和通知以各自后续回执为准。',
          }),
        );
      }
    })().catch((error: unknown) => {
      providerErrors.push(error);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  const modelBase = await listen(modelServer);
  const harness: HarnessServices = {
    binaryPath,
    libraryPath,
    maxIterations: 8,
    maxTokens: 8000,
    contextPolicy: createContextPolicy({
      completionCap: 1024,
      model: 'direct-controlled-provider',
    }),
    model: createLocalFixtureModelTransport({
      baseUrl: `${modelBase}/v1`,
      model: 'direct-controlled-provider',
    }),
  };
  deps = {
    pool: database.pool,
    timeContext: loadTimeContext('fixture-v1'),
    harness,
  };
  controlledModelDeps(deps);
  apiServer = createServer((req, res) => {
    void handleRequest(req, res, {
      pool: database.pool,
      timeContext: deps.timeContext,
      harness: deps.harness,
      modelTransport: deps.modelTransport,
    }).catch(() => res.destroy());
  });
  base = await listen(apiServer);
}, 30000);
afterAll(async () => {
  for (const server of [apiServer, modelServer])
    if (server?.listening) {
      const closed = once(server, 'close');
      server.closeAllConnections();
      server.close();
      await closed;
    }
  await database?.close();
  expect(providerErrors).toEqual([]);
}, 30000);
for (const mode of ['local', 'http'] as const) {
  test(`${mode}: official native creates independent reminders with frozen receipts, inbound replay and read-only recovery`, async () => {
    const session = await seedSession(database.pool, { timezoneId: 'Asia/Shanghai' });
    await configureTestModel(database.pool, session.userId, 'direct-controlled-provider');
    const id = randomUUID();
    const value = { observations: new Map<string, z.infer<typeof Observation>>(), calls: 0 };
    cases.set(id, value);
    const body = {
      conversation_id: await createFixtureConversation(database.pool, session.userId),
      execution: 'harness',
      authorization_revision: 'delegation/1',
      raw_text: `directCase:${id} ${time1}；${time2}。`,
      idempotency_key: randomUUID(),
    };
    const request = (path: string, data?: unknown) =>
      fetch(`${base}${path}`, {
        method: data === undefined ? 'GET' : 'POST',
        headers: {
          cookie: `better-auth.session_token=${session.token}`,
          'x-csrf-token': session.csrfToken,
          ...(data === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      });
    async function send(): Promise<ThreadEvent[]> {
      if (mode === 'http') {
        const response = await request('/api/v1/conversations/messages', body);
        expect(response.status).toBe(200);
        return frames(await response.text());
      }
      const result = await startConversationRun(deps, session.userId, randomUUID(), body, null);
      if (result.replay) return result.replay;
      const events: ThreadEvent[] = [];
      await executeRun(deps, result.context!, async (event) => {
        events.push(ThreadEventSchema.parse(event));
        return true;
      });
      return events;
    }
    const events = await send();
    expect(events.filter((event) => event.type === 'thread.completed')).toHaveLength(1);
    expect(events.some((event) => event.type === 'approval_required')).toBe(false);
    const binding = started(events);
    const view =
      mode === 'local'
        ? await getRunView(deps, session.userId, binding.conversation_id, binding.run_id)
        : RunViewSchema.parse(
            EnvelopeSchema.parse(
              await (
                await request(
                  `/api/v1/conversations/${binding.conversation_id}/runs/${binding.run_id}`,
                )
              ).json(),
            ).data,
          );
    expect(view).toMatchObject({
      status: 'done',
      execution_lifecycle: 'request-bound',
      authorization_revision: 'delegation/1',
      goal_result: { status: 'completed' },
    });
    const refs = view.goal_result!.outcomes.flatMap((item) => item.receipt_refs);
    const tasks = await database.pool.query(
      'SELECT id,source_approval_id,source_invocation_id,state,timezone_id,wall_time FROM tasks WHERE owner_id=$1 ORDER BY wall_time',
      [session.userId],
    );
    expect(tasks.rows).toMatchObject([
      {
        source_approval_id: null,
        source_invocation_id: refs[0],
        state: 'saved',
        timezone_id: 'Asia/Shanghai',
        wall_time: '2027-11-04 15:00',
      },
      {
        source_approval_id: null,
        source_invocation_id: refs[1],
        state: 'saved',
        timezone_id: 'Asia/Shanghai',
        wall_time: '2027-11-05 16:00',
      },
    ]);
    expect(
      (
        await database.pool.query('SELECT count(*)::int n FROM approvals WHERE owner_id=$1', [
          session.userId,
        ])
      ).rows[0].n,
    ).toBe(0);
    const before = await database.pool.query(
      'SELECT to_jsonb(t) fact FROM tasks t WHERE owner_id=$1 ORDER BY id',
      [session.userId],
    );
    const requests = value.calls;
    expect(started(await send()).run_id).toBe(binding.run_id);
    await request(`/api/v1/conversations/${binding.conversation_id}`);
    expect(value.calls).toBe(requests);
    expect(
      (
        await database.pool.query(
          'SELECT to_jsonb(t) fact FROM tasks t WHERE owner_id=$1 ORDER BY id',
          [session.userId],
        )
      ).rows,
    ).toEqual(before.rows);
    expect(
      (
        await database.pool.query(
          'SELECT type,count(*)::int n FROM task_events WHERE owner_id=$1 GROUP BY type',
          [session.userId],
        )
      ).rows,
    ).toEqual([{ type: 'created', n: 2 }]);
    expect(
      (
        await database.pool.query('SELECT count(*)::int n FROM outbox WHERE owner_id=$1', [
          session.userId,
        ])
      ).rows[0].n,
    ).toBe(2);
  }, 30000);
}

for (const mode of ['local', 'http'] as const) {
  test(`${mode}: a direct DST clarification exposes real candidates and creates only the explicitly selected fold`, async () => {
    const session = await seedSession(database.pool, { timezoneId: 'America/New_York' });
    await configureTestModel(database.pool, session.userId, 'direct-controlled-provider');
    const id = randomUUID();
    const singleTime = '2027年11月7日01:30提醒我核对报告';
    const value = {
      observations: new Map<string, z.infer<typeof Observation>>(),
      calls: 0,
      singleTime,
    };
    cases.set(id, value);
    const original = `directCase:${id} ${singleTime}`;
    const conversationId = await createFixtureConversation(database.pool, session.userId);
    async function send(extra: Record<string, unknown> = {}) {
      const body = {
        conversation_id: conversationId,
        execution: 'harness',
        authorization_revision: 'delegation/1',
        raw_text: original,
        idempotency_key: randomUUID(),
        ...extra,
      };
      if (mode === 'http') {
        const response = await fetch(`${base}/api/v1/conversations/messages`, {
          method: 'POST',
          headers: {
            cookie: `better-auth.session_token=${session.token}`,
            'x-csrf-token': session.csrfToken,
            'content-type': 'application/json',
          },
          body: JSON.stringify(body),
        });
        expect(response.status).toBe(200);
        return frames(await response.text());
      }
      const admitted = await startConversationRun(deps, session.userId, randomUUID(), body, null);
      const events: ThreadEvent[] = [];
      await executeRun(deps, admitted.context!, async (event) => {
        events.push(event);
        return true;
      });
      return events;
    }
    const first = started(await send());
    const blocked = await getRunView(deps, session.userId, first.conversation_id, first.run_id);
    expect(blocked.goal_result).toMatchObject({
      status: 'blocked',
      clarification: { kind: 'time' },
    });
    expect(blocked.reminder_time_errors).toMatchObject([
      {
        error: {
          code: 'AMBIGUOUS_LOCAL_TIME',
          details: {
            candidates: [
              { fold_choice: 'first', fire_at_utc: '2027-11-07T05:30:00Z' },
              { fold_choice: 'second', fire_at_utc: '2027-11-07T06:30:00Z' },
            ],
          },
        },
      },
    ]);
    expect(
      (
        await database.pool.query('SELECT count(*)::int n FROM tasks WHERE owner_id=$1', [
          session.userId,
        ])
      ).rows[0].n,
    ).toBe(0);
    value.observations.clear();
    const sourceClient = await database.pool.connect();
    try {
      for (const changed of [
        { text: `${original}，改成别的事项`, confirmedTimezone: 'America/New_York' },
        { text: original, confirmedTimezone: 'Asia/Shanghai' },
      ]) {
        const source = await acceptReminderDate(
          sourceClient,
          {
            ownerId: session.userId,
            conversationId: first.conversation_id,
            inputMessageId: randomUUID(),
            receivedAtUtc: '2026-11-03T03:00:00Z',
            foldChoice: 'second',
            clarificationOfRunId: first.run_id,
            directCreation: true,
            ...changed,
          },
          { listReminderClarifications, readReminderTimeErrors },
        );
        expect(source.source.kind).toBe('unresolved');
      }
    } finally {
      sourceClient.release();
    }
    const second = started(
      await send({
        clarification_of_run_id: first.run_id,
        confirmed_timezone: 'America/New_York',
        fold_choice: 'second',
      }),
    );
    const completed = await getRunView(deps, session.userId, second.conversation_id, second.run_id);
    expect(completed.goal_result?.status).toBe('completed');
    expect(
      (
        await database.pool.query(
          'SELECT fold,fire_at_utc,source_approval_id FROM tasks WHERE owner_id=$1',
          [session.userId],
        )
      ).rows,
    ).toEqual([
      { fold: 1, fire_at_utc: new Date('2027-11-07T06:30:00Z'), source_approval_id: null },
    ]);
  }, 30000);
}
