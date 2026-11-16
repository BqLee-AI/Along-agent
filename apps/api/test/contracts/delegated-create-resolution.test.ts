import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import {
  GoalResultSchema,
  HarnessModelMessageSchema,
  TrustedExecutionContextSchema,
  workspaceResultSchema,
  type HarnessModelReply,
} from '@along/contracts';
import { createContextPolicy } from '../../src/modules/conversations/context-policy.js';
import { createHarnessModelTransport } from '../../src/modules/model-providers/harness-model.js';
import { configureWorkspaceRegistry } from '../../src/modules/workspaces/service.js';
import type { WorkspaceRegistration } from '../../src/modules/workspaces/service.js';
import {
  createHarnessConsumer,
  findModelObservation,
  jsonBody,
  listen,
  sendModelSse,
  started,
} from '../helpers/harness-consumer.js';
import type { ConsumerMode, HarnessConsumer } from '../helpers/harness-consumer.js';

const ModelBody = z.object({
  messages: z.array(HarnessModelMessageSchema),
  parallel_tool_calls: z.literal(false),
  stream: z.literal(true),
  stream_options: z.object({ include_usage: z.literal(true) }),
});
type ModelMessage = z.infer<typeof HarnessModelMessageSchema>;
const Observation = z.object({
  invocation_id: z.string().uuid(),
  result: z.object({ status: z.literal('ok'), result: workspaceResultSchema }),
});
const quote = 'Create a report with an available name if the first name already exists.';
const content = 'Controlled report\nSecond line\n';
const original = 'Existing file must not change.\n';
const hidden = 'Unregistered and private.\n';
interface Scenario {
  id: string;
  workspaceId: string;
  root: string;
  requests: ModelMessage[][];
  callIds: string[];
}
const scenarios = new Map<string, Scenario>();
const registrations: WorkspaceRegistration[] = [];
const errors: unknown[] = [];
let fixture: HarnessConsumer;
let modelServer: Server;

function call(scenario: Scenario, name: string, args: unknown): HarnessModelReply {
  const id = `controlled-${randomUUID()}`;
  scenario.callIds.push(id);
  return {
    message: {
      content: null,
      tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
    },
    usage: { total_tokens: 8 },
  };
}

function result(messages: ModelMessage[], kind: string) {
  const found = findModelObservation(
    messages,
    Observation.refine((item) => item.result.result.kind === kind),
  );
  if (!found) throw new Error(`Missing actual ${kind} observation`);
  return found;
}

function feedback(messages: ModelMessage[], id: string) {
  const index = messages.findIndex(
    (message) => message.role === 'tool' && message.tool_call_id === id,
  );
  if (index < 1) throw new Error(`Missing paired feedback for ${id}`);
  const previous = messages[index - 1]!;
  const message = messages[index]!;
  if (previous.role !== 'assistant' || !('tool_calls' in previous) || message.role !== 'tool')
    throw new Error('Feedback is not paired with an assistant call');
  expect(previous.tool_calls).toEqual([
    expect.objectContaining({ id, function: expect.objectContaining({ name: 'finish_goal' }) }),
  ]);
  return JSON.parse(message.content) as unknown;
}

function respond(scenario: Scenario, messages: ModelMessage[]): HarnessModelReply {
  const step = scenario.requests.length - 1;
  const workspace_id = scenario.workspaceId;
  if (step === 0) return call(scenario, 'workspace_list', { workspace_id, path: 'output' });
  const listed = result(messages, 'list');
  expect(listed.result.result).toMatchObject({
    kind: 'list',
    workspace_id,
    path: 'output',
    visibility: 'authorized_paths_only',
    entries: [],
    failures: [],
  });
  if (step === 1)
    return call(scenario, 'workspace_create', {
      workspace_id,
      output_directory: 'output',
      filename: 'report.txt',
      content,
    });
  const collision = result(messages, 'create_conflict');
  expect(collision.result.result).toMatchObject({
    path: 'output/report.txt',
    reason: 'already_exists',
    zero_write: true,
  });
  if (step === 2)
    return call(scenario, 'workspace_create', {
      workspace_id,
      output_directory: 'output',
      filename: 'report-2.txt',
      content,
    });
  const created = result(messages, 'create_applied');
  expect(created.result.result).toMatchObject({
    path: 'output/report-2.txt',
    byte_length: Buffer.byteLength(content),
  });
  if (step === 3)
    return call(scenario, 'workspace_read', { workspace_id, path: 'output/report-2.txt' });
  const read = result(messages, 'read');
  expect(read.result.result).toMatchObject({
    path: 'output/report-2.txt',
    content,
    byte_length: Buffer.byteLength(content),
  });
  if (created.result.result.kind !== 'create_applied' || read.result.result.kind !== 'read')
    throw new Error('Missing creation or independent read');
  expect(read.result.result.version).toBe(created.result.result.version);
  expect(new Set([collision.invocation_id, created.invocation_id, read.invocation_id]).size).toBe(
    3,
  );
  const trusted = findModelObservation(
    messages.filter((message) => message.role === 'system'),
    TrustedExecutionContextSchema,
  );
  if (!trusted || trusted.create_resolution_revision !== 'create-resolution/2')
    throw new Error('Missing trusted resolution context');
  const resolution = {
    source_message_id: trusted.input_message_id,
    source_quote: quote,
    zero_write_invocation_ids: [collision.invocation_id],
    created_invocation_id: created.invocation_id,
    read_invocation_id: read.invocation_id,
  };
  const goal = {
    status: 'completed',
    outcomes: [
      {
        description: 'Created and independently read the report under an available name',
        status: 'achieved',
        receipt_refs: [collision.invocation_id, created.invocation_id, read.invocation_id],
        create_resolution: resolution,
      },
    ],
    clarification: null,
    answer: 'Created and verified output/report-2.txt; the existing report was preserved.',
  };
  if (step === 4)
    return call(scenario, 'finish_goal', {
      ...goal,
      outcomes: [
        {
          ...goal.outcomes[0],
          create_resolution: { ...resolution, zero_write_invocation_ids: [] },
        },
      ],
    });
  expect(feedback(messages, scenario.callIds[4]!)).toMatchObject({
    accepted: false,
    code: 'INVALID_GOAL_RESULT',
    message: expect.stringContaining('Follow the finish_goal schema'),
  });
  if (step === 5)
    return call(scenario, 'finish_goal', {
      ...goal,
      outcomes: [
        {
          ...goal.outcomes[0],
          create_resolution: {
            ...resolution,
            source_quote: 'This quote is not in the user message.',
          },
        },
      ],
    });
  if (step !== 6) throw new Error(`Unexpected model step ${step}`);
  expect(feedback(messages, scenario.callIds[5]!)).toMatchObject({
    accepted: false,
    code: 'INVALID_GOAL_RESULT',
    message: 'invalid create resolution source',
  });
  return call(scenario, 'finish_goal', goal);
}

beforeAll(async () => {
  if (process.platform !== 'linux')
    throw new Error('This contract requires the official Linux native harness');
  fixture = await createHarnessConsumer();
  modelServer = createServer((req, res) => {
    void (async () => {
      const body = ModelBody.parse(await jsonBody(req));
      const marker = /createResolutionCase:([\w-]+)/.exec(
        body.messages.find((message) => message.content.includes('createResolutionCase:'))
          ?.content ?? '',
      );
      const scenario = marker ? scenarios.get(marker[1]!) : undefined;
      if (!scenario) throw new Error('Missing controlled scenario');
      scenario.requests.push(body.messages);
      sendModelSse(res, respond(scenario, body.messages));
    })().catch((error: unknown) => {
      errors.push(error);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  const base = await listen(modelServer);
  if (!fixture.deps.harness) throw new Error('Native harness unavailable');
  fixture.deps.harness = {
    ...fixture.deps.harness,
    maxIterations: 24,
    maxTokens: 64000,
    contextPolicy: createContextPolicy({
      completionCap: 1024,
      model: 'controlled-create-resolution',
    }),
  };
  fixture.model = createHarnessModelTransport({
    baseUrl: `${base}/v1`,
    model: 'controlled-create-resolution',
  });
}, 30_000);

afterAll(async () => {
  try {
    await fixture?.close();
  } finally {
    if (modelServer?.listening) {
      const closed = once(modelServer, 'close');
      modelServer.closeAllConnections();
      modelServer.close();
      await closed;
    }
    await configureWorkspaceRegistry([]);
    await Promise.all(
      [...scenarios.values()].map((scenario) =>
        rm(scenario.root, { recursive: true, force: true }),
      ),
    );
  }
  expect(errors).toEqual([]);
  expect(fixture?.providerErrors ?? []).toEqual([]);
}, 30_000);

for (const mode of ['local', 'http'] as const satisfies readonly ConsumerMode[]) {
  test(`delegated create resolution preserves zero-write collision and corrects native and server rejections (${mode})`, async () => {
    const actor = await fixture.actor(mode);
    const root = await mkdtemp(join(tmpdir(), 'along-create-resolution-'));
    const scenario: Scenario = {
      id: randomUUID(),
      workspaceId: randomUUID(),
      root,
      requests: [],
      callIds: [],
    };
    scenarios.set(scenario.id, scenario);
    await mkdir(join(root, 'output'), { mode: 0o700 });
    await writeFile(join(root, 'output/report.txt'), original, { mode: 0o600 });
    await writeFile(join(root, 'output/private.txt'), hidden, { mode: 0o600 });
    registrations.push({
      workspace_id: scenario.workspaceId,
      label: 'Output only',
      owner_id: actor.ownerId,
      root,
      readable_paths: [],
      writable_paths: [],
      output_directories: ['output'],
    });
    expect(await configureWorkspaceRegistry(registrations)).toMatchObject({
      state: 'loaded',
      rejected: 0,
    });
    const events = await (
      await actor.message({
        execution: 'harness',
        authorization_revision: 'delegation/1',
        raw_text: `createResolutionCase:${scenario.id} ${quote}`,
        idempotency_key: randomUUID(),
      })
    ).events;
    const run = started(events);
    const terminals = events.filter((event) =>
      ['thread.completed', 'thread.failed', 'thread.cancelled'].includes(event.type),
    );
    expect(terminals).toHaveLength(1);
    expect(terminals[0]?.type).toBe('thread.completed');
    expect(scenario.requests).toHaveLength(7);
    const messages = scenario.requests[6]!;
    const collision = result(messages, 'create_conflict');
    const created = result(messages, 'create_applied');
    const read = result(messages, 'read');
    const view = await actor.view(run.conversation_id, run.run_id);
    const goal = GoalResultSchema.parse(view.goal_result);
    expect(goal).toMatchObject({
      status: 'completed',
      outcomes: [
        {
          status: 'achieved',
          receipt_refs: [collision.invocation_id, created.invocation_id, read.invocation_id],
          create_resolution: {
            source_quote: quote,
            zero_write_invocation_ids: [collision.invocation_id],
            created_invocation_id: created.invocation_id,
            read_invocation_id: read.invocation_id,
          },
        },
      ],
    });
    expect(view).toMatchObject({
      status: 'done',
      document_effects: expect.arrayContaining([
        expect.objectContaining({
          operation: 'create',
          path: 'output/report.txt',
          invocation_id: collision.invocation_id,
          status: 'conflict',
        }),
        expect.objectContaining({
          operation: 'create',
          path: 'output/report-2.txt',
          invocation_id: created.invocation_id,
          read_invocation_id: read.invocation_id,
          status: 'verified',
        }),
      ]),
    });
    expect(await readFile(join(root, 'output/report.txt'), 'utf8')).toBe(original);
    expect(await readFile(join(root, 'output/private.txt'), 'utf8')).toBe(hidden);
    expect(await readFile(join(root, 'output/report-2.txt'), 'utf8')).toBe(content);
    const persisted = await fixture.database.pool.query<{ status: string; goal_result: unknown }>(
      'SELECT status,goal_result FROM agent_runs WHERE owner_id=$1 AND id=$2',
      [actor.ownerId, run.run_id],
    );
    expect(persisted.rows).toEqual([{ status: 'done', goal_result: goal }]);
    const checkpoints = await fixture.database.pool.query<{ kind: string }>(
      `SELECT c.kind FROM run_checkpoints c JOIN run_attempts a ON a.id=c.attempt_id WHERE a.run_id=$1 AND c.kind IN ('thread.completed','thread.failed','thread.cancelled')`,
      [run.run_id],
    );
    expect(checkpoints.rows).toEqual([{ kind: 'thread.completed' }]);
    const invocations = await fixture.database.pool.query<{ tool_id: string; state: string }>(
      'SELECT tool_id,state FROM tool_invocations WHERE run_id=$1 ORDER BY call_key',
      [run.run_id],
    );
    expect(invocations.rows).toEqual([
      { tool_id: 'workspace_list', state: 'completed' },
      { tool_id: 'workspace_create', state: 'completed' },
      { tool_id: 'workspace_create', state: 'completed' },
      { tool_id: 'workspace_read', state: 'completed' },
    ]);
  }, 60_000);
}
