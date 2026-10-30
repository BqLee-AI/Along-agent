import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, open, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import {
  HARNESS_PROTOCOL_VERSION,
  HarnessModelReplySchema,
  HarnessRequestSchema,
  HarnessStartSchema,
  type HarnessRequest,
  type RunView,
} from '@along/contracts';
import type { ToolOutcome } from '../../src/modules/tools/contracts.js';
import { cancelConversationRun } from '../../src/modules/conversations/service.js';
import { runNativeHarness } from '../../src/modules/conversations/harness-process.js';
import { createContextPolicy } from '../../src/modules/conversations/context-policy.js';
import { measureHarnessContext } from '../../src/modules/conversations/harness-context.js';
import {
  digestInvocationArgs,
  executeNonTransactionalInvocation,
  reserveInvocation,
} from '../../src/modules/tools/invocations.js';
import { createIntegrationDatabase, type IntegrationDatabase } from '../integration/setup.js';
import { appendFileEffect } from '../integration/tool-invocations-file-effect.js';
import {
  args,
  fileLines,
  runChild,
  seedContext,
  toolId,
} from '../integration/tool-invocations-probe.js';

let database: IntegrationDatabase;
let directory: string;
let binaryPath: string;
const contextPolicy = createContextPolicy({ completionCap: 32, model: 'core-native-protocol' });

beforeAll(async () => {
  binaryPath = process.env.HARNESS_BINARY ?? '';
  if (!binaryPath || process.platform !== 'linux') {
    throw new Error(
      'D8 Core/native requires Linux and HARNESS_BINARY from the current production build',
    );
  }
  database = await createIntegrationDatabase();
  directory = await mkdtemp(join(tmpdir(), 'along-core-native-'));
});
afterAll(async () => {
  try {
    await database?.close();
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
  }
});

// This is a protocol-observation journal, NOT a product checkpoint or terminal.
// A snapshot UUID acknowledges only the exact context already written + fsynced.
async function saveObservation(path: string, request: HarnessRequest): Promise<unknown> {
  const checkpointRef = request.type === 'snapshot' ? randomUUID() : null;
  const file = await open(path, 'a');
  try {
    await file.writeFile(`${JSON.stringify({ checkpoint_ref: checkpointRef, request })}\n`);
    await file.sync();
  } finally {
    await file.close();
  }
  return checkpointRef ? { checkpoint_ref: checkpointRef } : { accepted: true };
}
const savedObservation = z
  .object({
    checkpoint_ref: z.string().uuid().nullable(),
    request: HarnessRequestSchema,
  })
  .strict();

// The probe stays a genuine non_transactional Core capability. It is never
// registered in the production five-tool gateway or disguised as local/read_only.
test('D8.unknown-core-native', async () => {
  const ctx = await seedContext(database.pool);
  const path = join(directory, `${ctx.runId}.effect.jsonl`);
  const journal = join(directory, `${ctx.runId}.protocol.jsonl`);
  const messageId = randomUUID();
  const requests: HarnessRequest[] = [];
  const outcomes: ToolOutcome[] = [];
  let invocationId = '';
  let effectBefore = Buffer.alloc(0);
  let modelCalls = 0;
  let pendingModel: z.infer<typeof HarnessModelReplySchema> | undefined;
  let pendingModelRef: string | undefined;
  const start = HarnessStartSchema.parse({
    protocol: HARNESS_PROTOCOL_VERSION,
    type: 'start',
    context_policy: contextPolicy,
    messages: [{ message_id: messageId, role: 'user', content: 'Run the fsync probe once.' }],
    tools: [
      { name: toolId, description: 'Test-only append and fsync.', parameters: {}, risk: 'low' },
    ],
    budget: { max_iterations: 4, max_tokens: 100 },
    snapshot: null,
    observations: [],
    approval: null,
  });
  await runNativeHarness({
    services: {
      binaryPath,
      libraryPath: process.env.HARNESS_LIBRARY_PATH,
      maxIterations: 4,
      maxTokens: 100,
      contextPolicy,
      model: async function* () {
        throw new Error('model transport is handled at the protocol counterpart');
      },
    },
    start,
    signal: new AbortController().signal,
    handleRequest: async (request) => {
      requests.push(request);
      switch (request.type) {
        case 'measure_context':
          return measureHarnessContext(request, start.tools, contextPolicy);
        case 'model':
          modelCalls++;
          pendingModel = HarnessModelReplySchema.parse({
            message:
              modelCalls === 1
                ? {
                    content: null,
                    tool_calls: [
                      {
                        id: 'provider-not-invocation',
                        type: 'function',
                        function: {
                          name: toolId,
                          arguments: JSON.stringify(args),
                        },
                      },
                    ],
                  }
                : { content: 'The probe returned a result.', tool_calls: [] },
            usage: { total_tokens: 5 },
          });
          pendingModelRef = pendingModel.message.content ? request.request_ref : undefined;
          return pendingModel.message.content
            ? { type: 'delta', delta: pendingModel.message.content }
            : { type: 'complete', reply: pendingModel };
        case 'model_next': {
          if (!pendingModel || request.model_ref !== pendingModelRef)
            throw new Error('unexpected model continuation');
          const reply = pendingModel;
          pendingModel = undefined;
          pendingModelRef = undefined;
          return { type: 'complete', reply };
        }
        case 'reserve': {
          const reserved = await reserveInvocation(database.pool, ctx, {
            callKey: request.call_key,
            toolId: request.tool_id,
            args: request.args,
            executionKind: 'non_transactional',
          });
          invocationId = reserved.invocationId;
          return { invocation_id: invocationId };
        }
        case 'invoke': {
          // Worker enters execute only AFTER reserved -> unknown COMMIT. Its
          // effected IPC fires AFTER append + fsync; runChild then SIGKILLs and
          // waits for actual signal exit, before opening this independent pool.
          if (outcomes.length === 0) {
            await runChild(database, ctx, request.invocation_id, path, 'effected', true);
            effectBefore = await readFile(path);
          }
          const fresh = database.connect();
          try {
            const actual = await executeNonTransactionalInvocation(
              fresh,
              ctx,
              {
                invocationId: request.invocation_id,
                toolId: request.tool_id,
                args: request.args,
              },
              { execute: (binding) => appendFileEffect(path, binding) },
            );
            outcomes.push(actual);
            return actual;
          } finally {
            await fresh.end();
          }
        }
        case 'snapshot':
        case 'finish':
        case 'answer':
          return saveObservation(journal, request);
        case 'suspend':
          throw new Error('unknown invocation cannot suspend for approval');
      }
    },
  });
  expect(outcomes).toHaveLength(1);
  expect(outcomes[0]).toMatchObject({
    status: 'unknown',
    invocationId,
    replayed: true,
    error: { code: 'TOOL_EFFECT_UNKNOWN' },
  });
  expect(
    requests
      .filter((request) => ['model', 'reserve', 'invoke'].includes(request.type))
      .map((request) => request.type),
  ).toEqual(['model', 'reserve', 'invoke']);
  expect(requests.filter((request) => ['answer', 'suspend'].includes(request.type))).toEqual([]);
  const saved = (await fileLines(journal)).map((line) => savedObservation.parse(JSON.parse(line)));
  expect(requests.filter((request) => request.type === 'snapshot')).toEqual([]);
  expect(saved.map((entry) => entry.request.type)).toEqual(['finish']);
  expect(saved.filter((entry) => entry.request.type === 'finish')).toEqual([
    {
      checkpoint_ref: null,
      request: expect.objectContaining({
        type: 'finish',
        outcome: 'failed',
        error: { code: 'TOOL_EFFECT_UNKNOWN', message: expect.any(String) },
      }),
    },
  ]);
  expect((await fileLines(path)).map((line) => JSON.parse(line))).toEqual([
    {
      invocationId,
      argsHash: digestInvocationArgs(args).argsHash,
      evidenceRef: `file-line:${invocationId}:${digestInvocationArgs(args).argsHash}`,
    },
  ]);
  expect(await readFile(path)).toEqual(effectBefore);
  const fresh = database.connect();
  try {
    const replay = await executeNonTransactionalInvocation(
      fresh,
      { ...ctx, requestId: randomUUID() },
      {
        invocationId,
        toolId,
        args,
      },
      { execute: (binding) => appendFileEffect(path, binding) },
    );
    expect(replay).toEqual(outcomes[0]);
    expect(await readFile(path)).toEqual(effectBefore);
    expect(
      (
        await fresh.query(
          'SELECT invocation_id,state,accepted_result,execution_kind FROM tool_invocations WHERE run_id=$1',
          [ctx.runId],
        )
      ).rows,
    ).toEqual([
      {
        invocation_id: invocationId,
        state: 'unknown',
        accepted_result: null,
        execution_kind: 'non_transactional',
      },
    ]);
    expect(
      (await fresh.query('SELECT id,status FROM agent_runs WHERE id=$1', [ctx.runId])).rows,
    ).toEqual([{ id: ctx.runId, status: 'running' }]);
    expect(
      (await fresh.query('SELECT id,status FROM run_attempts WHERE run_id=$1', [ctx.runId])).rows,
    ).toEqual([{ id: ctx.attemptId, status: 'running' }]);
    expect(
      (await fresh.query('SELECT id FROM run_checkpoints WHERE attempt_id=$1', [ctx.attemptId]))
        .rows,
    ).toEqual([]);
  } finally {
    await fresh.end();
  }
}, 30_000);

// Public cancellation commits between the actual reserve and returning its UUID
// to native. The late native invoke reaches Core directly, without a fixture
// authorization guard. Removing Core's reserved&&!canExecute gate must fsync.
test('D8.cancelled-core-native', async () => {
  const ctx = await seedContext(database.pool);
  const path = join(directory, `${ctx.runId}.cancelled.effect.jsonl`);
  const journal = join(directory, `${ctx.runId}.cancelled.protocol.jsonl`);
  const cancellationKey = randomUUID();
  const requests: HarnessRequest[] = [];
  const outcomes: ToolOutcome[] = [];
  const reservations: string[] = [];
  const cancelled: RunView[] = [];
  let modelCalls = 0;
  let pendingModel: z.infer<typeof HarnessModelReplySchema> | undefined;
  let pendingModelRef: string | undefined;
  await runNativeHarness({
    services: {
      binaryPath,
      libraryPath: process.env.HARNESS_LIBRARY_PATH,
      maxIterations: 4,
      maxTokens: 100,
      contextPolicy,
      model: async function* () {
        throw new Error('model transport is handled at the protocol counterpart');
      },
    },
    start: HarnessStartSchema.parse({
      protocol: HARNESS_PROTOCOL_VERSION,
      type: 'start',
      context_policy: contextPolicy,
      messages: [{ message_id: randomUUID(), role: 'user', content: 'Run the fsync probe once.' }],
      tools: [
        { name: toolId, description: 'Test-only append and fsync.', parameters: {}, risk: 'low' },
      ],
      budget: { max_iterations: 4, max_tokens: 100 },
      snapshot: null,
      observations: [],
      approval: null,
    }),
    signal: new AbortController().signal,
    handleRequest: async (request) => {
      requests.push(request);
      switch (request.type) {
        case 'measure_context':
          return measureHarnessContext(
            request,
            [
              {
                name: toolId,
                description: 'Test-only append and fsync.',
                parameters: {},
                risk: 'low',
              },
            ],
            contextPolicy,
          );
        case 'model':
          modelCalls++;
          // A buggy Core that executes after cancel gets a LEGAL second model
          // answer, not a fixture exception masking its forbidden file effect.
          pendingModel = HarnessModelReplySchema.parse({
            message:
              modelCalls === 1
                ? {
                    content: null,
                    tool_calls: [
                      {
                        id: 'provider-not-invocation',
                        type: 'function',
                        function: {
                          name: toolId,
                          arguments: JSON.stringify(args),
                        },
                      },
                    ],
                  }
                : { content: 'The probe returned a result.', tool_calls: [] },
            usage: { total_tokens: 5 },
          });
          pendingModelRef = pendingModel.message.content ? request.request_ref : undefined;
          return pendingModel.message.content
            ? { type: 'delta', delta: pendingModel.message.content }
            : { type: 'complete', reply: pendingModel };
        case 'model_next': {
          if (!pendingModel || request.model_ref !== pendingModelRef)
            throw new Error('unexpected model continuation');
          const reply = pendingModel;
          pendingModel = undefined;
          pendingModelRef = undefined;
          return { type: 'complete', reply };
        }
        case 'reserve': {
          const reserved = await reserveInvocation(database.pool, ctx, {
            callKey: request.call_key,
            toolId: request.tool_id,
            args: request.args,
            executionKind: 'non_transactional',
          });
          reservations.push(reserved.invocationId);
          cancelled.push(
            await cancelConversationRun(
              { pool: database.pool, timeContext: ctx.timeContext },
              ctx.ownerId,
              ctx.conversationId,
              ctx.runId,
              randomUUID(),
              { idempotency_key: cancellationKey, reason: 'user_cancelled' },
            ),
          );
          return { invocation_id: reserved.invocationId };
        }
        case 'invoke': {
          const actual = await executeNonTransactionalInvocation(
            database.pool,
            ctx,
            {
              invocationId: request.invocation_id,
              toolId: request.tool_id,
              args: request.args,
            },
            { execute: (binding) => appendFileEffect(path, binding) },
          );
          outcomes.push(actual);
          return actual;
        }
        case 'snapshot':
        case 'finish':
        case 'answer':
          return saveObservation(journal, request);
        case 'suspend':
          throw new Error('cancelled probe cannot suspend for approval');
      }
    },
  });
  // Deliberately FIRST: the mutation must fail on an actual unauthorized effect,
  // not on an unexpected second model call, native answer, or a fixture guard.
  expect(await fileLines(path)).toEqual([]);
  expect(reservations).toHaveLength(1);
  const invocationId = reservations[0]!;
  expect(outcomes).toHaveLength(1);
  expect(outcomes[0]).toMatchObject({
    status: 'denied',
    invocationId,
    replayed: false,
    error: { code: 'TOOL_FORBIDDEN' },
  });
  expect(cancelled).toHaveLength(1);
  expect(cancelled[0]).toMatchObject({
    run_id: ctx.runId,
    status: 'cancelled',
    attempt_id: ctx.attemptId,
  });
  expect(modelCalls).toBe(1);
  expect(
    requests
      .filter((request) => ['model', 'reserve', 'invoke'].includes(request.type))
      .map((request) => request.type),
  ).toEqual(['model', 'reserve', 'invoke']);
  expect(requests.filter((request) => ['answer', 'suspend'].includes(request.type))).toEqual([]);
  const saved = (await fileLines(journal)).map((line) => savedObservation.parse(JSON.parse(line)));
  const snapshot = saved.find((entry) => entry.request.type === 'snapshot');
  if (snapshot) {
    expect(snapshot).toMatchObject({
      checkpoint_ref: expect.any(String),
      request: {
        type: 'snapshot',
        context: { tool_refs: [invocationId], next_call_no: 2 },
      },
    });
  }
  expect(saved.filter((entry) => entry.request.type === 'finish')).toEqual([
    {
      checkpoint_ref: null,
      request: expect.objectContaining({
        type: 'finish',
        outcome: 'failed',
        error: { code: 'TOOL_FORBIDDEN', message: expect.any(String) },
      }),
    },
  ]);
  expect(
    (await database.pool.query('SELECT id,status FROM agent_runs WHERE id=$1', [ctx.runId])).rows,
  ).toEqual([{ id: ctx.runId, status: 'cancelled' }]);
  expect(
    (await database.pool.query('SELECT id,status FROM run_attempts WHERE run_id=$1', [ctx.runId]))
      .rows,
  ).toEqual([{ id: ctx.attemptId, status: 'failed' }]);
  expect(
    (
      await database.pool.query(
        'SELECT idempotency_key,run_id,reason FROM harness_cancellations WHERE run_id=$1',
        [ctx.runId],
      )
    ).rows,
  ).toEqual([{ idempotency_key: cancellationKey, run_id: ctx.runId, reason: 'user_cancelled' }]);
  expect(
    (
      await database.pool.query(
        'SELECT invocation_id,state,accepted_result,execution_kind FROM tool_invocations WHERE run_id=$1',
        [ctx.runId],
      )
    ).rows,
  ).toEqual([
    {
      invocation_id: invocationId,
      state: 'reserved',
      accepted_result: null,
      execution_kind: 'non_transactional',
    },
  ]);
  expect(
    (
      await database.pool.query(
        'SELECT kind FROM run_checkpoints WHERE attempt_id=$1 ORDER BY event_seq',
        [ctx.attemptId],
      )
    ).rows,
  ).toEqual([{ kind: 'thread.cancelled' }]);
  expect(
    (
      await database.pool.query(
        'SELECT record_kind,decision,error_code FROM tool_calls WHERE invocation_id=$1',
        [invocationId],
      )
    ).rows,
  ).toEqual([{ record_kind: 'denied', decision: 'deny', error_code: 'TOOL_FORBIDDEN' }]);
}, 30_000);

test('native terminates boundedly when valid bootstrap observations cannot fit serialized model history', async () => {
  const messageId = randomUUID();
  const observations = Array.from({ length: 4 }, () => ({
    view: 'full',
    invocation_id: randomUUID(),
    tool_id: 'workspace_read',
    result: {
      status: 'ok',
      result: {
        kind: 'read',
        path: 'brief.txt',
        version: 'a'.repeat(64),
        byte_length: 120000,
        content: '\\'.repeat(120000),
      },
    },
  }));
  const start = HarnessStartSchema.parse({
    protocol: HARNESS_PROTOCOL_VERSION,
    type: 'start',
    context_policy: contextPolicy,
    messages: [{ message_id: messageId, role: 'user', content: 'Use accepted read observations.' }],
    tools: [
      {
        name: 'workspace_read',
        description: 'Read the managed text.',
        parameters: {},
        risk: 'low',
      },
    ],
    workspace: {
      workspace_id: 'managed',
      label: 'Managed',
      readable_paths: ['brief.txt'],
      writable_paths: [],
    },
    budget: { max_iterations: 12, max_tokens: 1000 },
    snapshot: {
      version: 2,
      message_refs: [messageId],
      tool_refs: observations.map((item) => item.invocation_id),
      next_call_no: 5,
      usage: { iterations: 4, tokens: 4 },
      waiting: null,
    },
    observations,
    approval: null,
  });
  expect(Buffer.byteLength(JSON.stringify(start), 'utf8')).toBeLessThan(1024 * 1024);
  const requests: HarnessRequest[] = [];
  await runNativeHarness({
    services: {
      binaryPath,
      libraryPath: process.env.HARNESS_LIBRARY_PATH,
      maxIterations: 12,
      maxTokens: 1000,
      contextPolicy,
      model: async function* () {
        throw new Error('oversized context must not call model transport');
      },
    },
    start,
    signal: new AbortController().signal,
    handleRequest: async (request) => {
      requests.push(request);
      expect(request).toMatchObject({
        type: 'finish',
        outcome: 'failed',
        error: { code: 'HARNESS_CONTEXT_LIMIT' },
      });
      return { accepted: true };
    },
  });
  expect(requests).toHaveLength(1);
});
