import { configureTestModel, controlledModelDeps } from '../helpers/model-selection.js';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { z } from 'zod';
import {
  HarnessModelMessageSchema,
  HarnessToolResultSchema,
  type HarnessModelReply,
} from '@along/contracts';
import { ThreadEventSchema, type ThreadEvent } from '@along/stream-protocol';
import { handleRequest } from '../../src/http/app.js';
import { startConversationRun, executeRun } from '../../src/modules/conversations/service.js';
import type { ConversationDeps } from '../../src/modules/conversations/contracts.js';
import { createContextPolicy } from '../../src/modules/conversations/context-policy.js';
import { createHarnessModelTransport } from '../../src/modules/model-providers/harness-model.js';
import type { HarnessServices } from '../../src/modules/conversations/harness-process.js';
import { seedAdmittedSession as seedSession } from '../integration/setup.js';
import { invokeTool, reserveToolInvocation } from '../../src/modules/tools/gateway.js';
import type { ToolContext } from '../../src/modules/tools/contracts.js';
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

const ModelBody = z.object({ messages: z.array(HarnessModelMessageSchema) });
const Observation = z.object({
  view: z.literal('full'),
  invocation_id: z.string().uuid(),
  tool_id: z.string(),
  result: HarnessToolResultSchema,
});
type Scenario = { partial: boolean; requests: number; denialSeen: boolean; receipt: string | null };
const scenarios = new Map<string, Scenario>();
const providerErrors: unknown[] = [];
let database: IntegrationDatabase;
let deps: ConversationDeps;
let apiServer: Server;
let modelServer: Server;
let base = '';
const sourceArgs = () => ({
  source_invocation_id: randomUUID(),
  field: 'content',
  offset: 0,
  limit: 10,
});
const settingArgs = { timezone_id: 'America/New_York' };

function reply(name: string, args: unknown): HarnessModelReply {
  return {
    message: {
      content: null,
      tool_calls: [
        {
          id: randomUUID(),
          type: 'function',
          function: { name, arguments: JSON.stringify(args) },
        },
      ],
    },
    usage: { total_tokens: 5 },
  };
}
function goal(value: Scenario) {
  return {
    status: value.partial ? 'partial' : 'blocked',
    outcomes: [
      ...(value.partial
        ? [{ description: '已保存上海默认时区', status: 'achieved', receipt_refs: [value.receipt] }]
        : []),
      { description: '权限拒绝后未执行其他动作', status: 'blocked', receipt_refs: [] },
    ],
    clarification: null,
    answer: '调用未获授权；没有继续修改默认时区，保留已接受事实。',
  };
}

beforeAll(async () => {
  const binaryPath = process.env.HARNESS_BINARY;
  const libraryPath = process.env.HARNESS_LIBRARY_PATH;
  if (!binaryPath || !libraryPath || !process.env.BETTER_AUTH_SECRET)
    throw new Error(
      'Requires official HARNESS_BINARY/HARNESS_LIBRARY_PATH, DATABASE_URL and BETTER_AUTH_SECRET',
    );
  database = await createIntegrationDatabase();
  modelServer = createServer((req, res) => {
    void (async () => {
      const body = ModelBody.parse(await jsonBody(req));
      const marker = body.messages.find((message) => message.content.includes('hardDeniedCase:'));
      const id = /hardDeniedCase:([\w-]+)/.exec(marker?.content ?? '')?.[1];
      const value = id ? scenarios.get(id) : undefined;
      if (!value) throw new Error('missing denial scenario');
      const index = value.requests++;
      const observation = findModelObservation(body.messages, Observation);
      if (value.partial && index === 0) {
        sendModelSse(res, reply('set_user_timezone', { timezone_id: 'Asia/Shanghai' }));
        return;
      }
      const step = index - (value.partial ? 1 : 0);
      if (step === 0) {
        if (value.partial) {
          if (observation?.result.status !== 'ok') throw new Error('missing saved setting receipt');
          value.receipt = observation.invocation_id;
        }
        sendModelSse(res, reply('read_run_observation', sourceArgs()));
        return;
      }
      // Find the hard denial, not the earlier successful setting observation.
      value.denialSeen ||=
        findModelObservation(
          body.messages,
          Observation.refine(
            (item) =>
              item.result.status === 'denied' && item.result.error.code === 'TOOL_FORBIDDEN',
          ),
        ) !== undefined;
      sendModelSse(
        res,
        step === 1 ? reply('set_user_timezone', settingArgs) : reply('finish_goal', goal(value)),
      );
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
    contextPolicy: createContextPolicy({ completionCap: 1024, model: 'hard-denial-controlled' }),
    model: createHarnessModelTransport({
      baseUrl: `${modelBase}/v1`,
      model: 'hard-denial-controlled',
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
}, 30_000);

afterAll(async () => {
  for (const server of [apiServer, modelServer]) {
    if (!server?.listening) continue;
    const closed = once(server, 'close');
    server.closeAllConnections();
    server.close();
    await closed;
  }
  await database?.close();
  expect(providerErrors).toEqual([]);
}, 30_000);

async function fresh(): Promise<ToolContext> {
  const session = await seedSession(database.pool, { timezoneId: 'Asia/Shanghai' });
  await configureTestModel(database.pool, session.userId, 'hard-denial-controlled');
  const run = await startConversationRun(
    deps,
    session.userId,
    randomUUID(),
    {
      execution: 'harness',
      authorization_revision: 'delegation/1',
      raw_text: '保存默认时区',
    },
    randomUUID(),
  );
  if (!run.context) throw new Error('missing fresh Run');
  return {
    ...run.context,
    allowlist: ['set_user_timezone', 'get_user_prefs', 'read_run_observation'],
  };
}
async function reserve(ctx: ToolContext, callKey: string, toolId: string, args: unknown) {
  return {
    ...(await reserveToolInvocation(database.pool, ctx, { callKey, toolId, args })),
    toolId,
    args,
  };
}
async function timezone(ownerId: string) {
  return (await database.pool.query('SELECT timezone_id FROM users WHERE id=$1', [ownerId])).rows[0]
    ?.timezone_id;
}

for (const code of ['TOOL_FORBIDDEN', 'TOOL_DENIED']) {
  test(`PG gateway ${code} prevents new reservations and execution of already-reserved settings`, async () => {
    const ctx = await fresh();
    const pending = await reserve(ctx, 'before-denial', 'set_user_timezone', settingArgs);
    const forbidden = await reserve(
      ctx,
      'denied-source',
      code === 'TOOL_FORBIDDEN' ? 'read_run_observation' : 'get_user_prefs',
      code === 'TOOL_FORBIDDEN' ? sourceArgs() : {},
    );
    const outcome = await invokeTool(
      database.pool,
      code === 'TOOL_DENIED'
        ? { ...ctx, allowlist: ['set_user_timezone', 'read_run_observation'] }
        : ctx,
      forbidden,
    );
    expect(outcome).toMatchObject({ status: 'denied', error: { code } });
    const accepted = await database.pool.query(
      'SELECT state,accepted_result FROM tool_invocations WHERE invocation_id=$1',
      [forbidden.invocationId],
    );
    expect(accepted.rows[0]).toMatchObject({
      state: 'completed',
      accepted_result: { status: 'denied', error: { code } },
    });
    const reservation = await Promise.allSettled([
      reserve(ctx, 'after-denial', 'set_user_timezone', settingArgs),
    ]);
    const attempt = await invokeTool(database.pool, ctx, pending);
    // These assertions expose actual business effects, not an incidental code branch.
    expect(await timezone(ctx.ownerId)).toBe('Asia/Shanghai');
    expect(attempt).toMatchObject({ status: 'denied', error: { code: 'TOOL_FORBIDDEN' } });
    expect(reservation[0]?.status).toBe('rejected');
    expect(
      (
        await database.pool.query('SELECT state FROM tool_invocations WHERE invocation_id=$1', [
          pending.invocationId,
        ])
      ).rows[0],
    ).toEqual({ state: 'reserved' });
    expect(
      (
        await database.pool.query(
          "SELECT count(*)::int AS n FROM tool_invocations WHERE run_id=$1 AND call_key='after-denial'",
          [ctx.runId],
        )
      ).rows[0]?.n,
    ).toBe(0);
  });
}

for (const code of ['UNKNOWN_TIMEZONE', 'TZDB_UNAVAILABLE']) {
  test(`PG ${code} rule denial preserves previous timezone and allows read-only feedback without substituting a setting`, async () => {
    const initial = await fresh();
    const ctx: ToolContext =
      code === 'TZDB_UNAVAILABLE'
        ? {
            ...initial,
            timeContext: {
              available: false,
              ruleset_id: 'unavailable',
              tzdb_version: 'unavailable',
              missing: [],
            },
          }
        : initial;
    const unsupported = await reserve(ctx, 'unsupported', 'set_user_timezone', {
      timezone_id: 'Atlantis/Mars',
    });
    expect(await invokeTool(database.pool, ctx, unsupported)).toMatchObject({
      status: 'denied',
      error: { code },
    });
    const read = await reserve(ctx, 'feedback', 'get_user_prefs', {});
    expect(await invokeTool(database.pool, ctx, read)).toMatchObject({
      status: 'ok',
      result: { kind: 'prefs', timezone_id: 'Asia/Shanghai' },
    });
    expect(await timezone(ctx.ownerId)).toBe('Asia/Shanghai');
  });
}

for (const mode of ['local', 'http']) {
  for (const partial of [false, true]) {
    test(`${mode} native/PG hard denial blocks later setting and terminates once as ${partial ? 'partial' : 'blocked'}`, async () => {
      const session = await seedSession(database.pool, { timezoneId: 'Asia/Shanghai' });
      await configureTestModel(database.pool, session.userId, 'hard-denial-controlled');
      const id = randomUUID();
      const value: Scenario = { partial, requests: 0, denialSeen: false, receipt: null };
      scenarios.set(id, value);
      const input = {
        execution: 'harness' as const,
        authorization_revision: 'delegation/1' as const,
        raw_text: `hardDeniedCase:${id} ${partial ? '先保存上海。' : ''}读取外部调用；若权限拒绝不得再设置纽约。`,
        idempotency_key: randomUUID(),
      };
      let events;
      if (mode === 'http') {
        const response = await fetch(`${base}/api/v1/conversations/messages`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            cookie: `better-auth.session_token=${session.token}`,
            'x-csrf-token': session.csrfToken,
          },
          body: JSON.stringify(input),
        });
        expect(response.status).toBe(200);
        events = frames(await response.text());
      } else {
        const run = await startConversationRun(
          deps,
          session.userId,
          randomUUID(),
          input,
          randomUUID(),
        );
        if (!run.context) throw new Error('missing local context');
        const emitted: ThreadEvent[] = [];
        await executeRun(deps, run.context, async (event) => {
          emitted.push(ThreadEventSchema.parse(event));
          return true;
        });
        events = emitted;
      }
      const runId = started(events).run_id;
      expect(value.denialSeen).toBe(true);
      expect(await timezone(session.userId)).toBe('Asia/Shanghai');
      const ledger = await database.pool.query(
        'SELECT tool_id,state,accepted_result FROM tool_invocations WHERE run_id=$1 ORDER BY call_key',
        [runId],
      );
      expect(ledger.rows.map((row) => row.tool_id)).toEqual(
        partial ? ['set_user_timezone', 'read_run_observation'] : ['read_run_observation'],
      );
      expect(ledger.rows.at(-1)).toMatchObject({
        state: 'completed',
        accepted_result: { status: 'denied', error: { code: 'TOOL_FORBIDDEN' } },
      });
      const terminal = await database.pool.query(
        'SELECT status,goal_result FROM agent_runs WHERE id=$1',
        [runId],
      );
      expect(terminal.rows[0]).toMatchObject({ status: 'done', goal_result: goal(value) });
      expect(
        (await database.pool.query('SELECT status FROM run_attempts WHERE run_id=$1', [runId]))
          .rows,
      ).toEqual([{ status: 'done' }]);
      expect(
        events.filter((event) =>
          ['thread.completed', 'thread.failed', 'thread.cancelled'].includes(event.type),
        ),
      ).toHaveLength(1);
    }, 30_000);
  }
}
