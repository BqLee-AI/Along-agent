import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import {
  DocumentApprovalActionResultSchema,
  DocumentApprovalDetailSchema,
  DocumentApprovalReceiptSchema,
  EnvelopeSchema,
  HarnessApprovalDecisionSchema,
  HarnessModelMessageSchema,
  workspaceResultSchema,
} from '@along/contracts';
import type { HarnessModelReply, WorkspaceResult } from '@along/contracts';
import { createLocalFixtureModelTransport } from '../helpers/local-fixture-model.js';
import { createContextPolicy } from '../../src/features/conversations/public.js';
import { configureWorkspaceRegistry } from '../../src/features/workspaces/public.js';
import type { WorkspaceRegistration } from '../../src/features/workspaces/public.js';
import {
  createHarnessConsumer,
  jsonBody,
  listen,
  pending,
  started,
  sendModelSse,
} from '../helpers/harness-consumer.js';
import type { ConsumerMode, HarnessActor, HarnessConsumer } from '../helpers/harness-consumer.js';

type ModelMessage = z.infer<typeof HarnessModelMessageSchema>;
type Proposal = {
  kind: 'document_approval';
  approval: z.infer<typeof DocumentApprovalReceiptSchema>;
};
interface Observation {
  invocationId: string;
  result: WorkspaceResult | Proposal;
  index: number;
}
interface Scenario {
  id: string;
  workspaceId: string;
  root: string;
  source: string;
  initial: string;
  requests: ModelMessage[][];
  omitReadBack: boolean;
  delegated?: boolean;
  create?: boolean;
  noWorkspace?: boolean;
  conflict?: boolean;
  conflictInjected?: boolean;
  fullRewrite?: boolean;
  invalidLiteral?: boolean;
  omitGoalReadRefOnce?: boolean;
  splitGoalReadRef?: boolean;
  offeredTools?: string[][];
}
const ModelBody = z.object({
  messages: z.array(HarnessModelMessageSchema),
  stream: z.literal(true),
  stream_options: z.object({ include_usage: z.literal(true) }),
  parallel_tool_calls: z.boolean().optional(),
  tools: z.array(z.object({ function: z.object({ name: z.string() }) })).optional(),
});
const ToolObservation = z.object({
  invocation_id: z.string().uuid(),
  result: z.object({ status: z.literal('ok'), result: z.unknown() }),
});
const LiveOutcome = z.object({
  invocationId: z.string().uuid(),
  status: z.literal('ok'),
  result: z.unknown(),
});
const ProposalSchema = z.object({
  kind: z.literal('document_approval'),
  approval: DocumentApprovalReceiptSchema,
});
const ModelObservation = ToolObservation.or(LiveOutcome);
const WorkspaceObservationPayload = workspaceResultSchema.or(ProposalSchema);
const scenarios = new Map<string, Scenario>();
const registrations: WorkspaceRegistration[] = [];
const modelErrors: unknown[] = [];
let fixture: HarnessConsumer;
let modelServer: Server;

function values(messages: readonly ModelMessage[]): unknown[] {
  const result: unknown[] = [];
  for (const message of messages) {
    for (
      let offset = message.content.indexOf('{');
      offset >= 0;
      offset = message.content.indexOf('{', offset + 1)
    ) {
      try {
        result.push(JSON.parse(message.content.slice(offset)));
        break;
      } catch {
        // Prose may contain brace examples before the actual JSON observation.
      }
    }
  }
  return result;
}

function latest<T>(items: readonly T[], predicate: (value: T) => boolean): T | undefined {
  for (let index = items.length - 1; index >= 0; index--) {
    const value = items[index]!;
    if (predicate(value)) return value;
  }
  return undefined;
}

function observations(data: readonly unknown[]): Observation[] {
  const result: Observation[] = [];
  for (const [index, value] of data.entries()) {
    const envelope = ModelObservation.safeParse(value);
    if (!envelope.success) continue;
    const current = envelope.data;
    let invocationId: string;
    let raw: unknown;
    if ('invocation_id' in current) {
      invocationId = current.invocation_id;
      raw = current.result.result;
    } else {
      invocationId = current.invocationId;
      raw = current.result;
    }
    const payload = WorkspaceObservationPayload.safeParse(raw);
    if (payload.success) result.push({ invocationId, result: payload.data, index });
  }
  return result;
}

function tool(name: string, args: Record<string, unknown>): HarnessModelReply {
  return {
    message: {
      content: '正在依据已读取资料核对文档；保存前会请求批准。',
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

function modelReply(messages: ModelMessage[], scenario: Scenario): HarnessModelReply {
  const data = values(messages);
  const accepted = observations(data);
  if (!latest(accepted, (value) => value.result.kind === 'list')) {
    return tool('workspace_list', { path: '' });
  }
  const search = latest(accepted, (value) => value.result.kind === 'search');
  if (!search || search.result.kind !== 'search') {
    return tool('workspace_grep', { path: 'sources', literal: 'Decision' });
  }
  const sourcePath = search.result.matches[0]?.path;
  if (!sourcePath) throw new Error('real MCP search did not expose the authorized source');
  const source = latest(
    accepted,
    (value) => value.result.kind === 'read' && value.result.path === sourcePath,
  );
  if (!source || source.result.kind !== 'read') {
    return tool('workspace_read', { path: sourcePath });
  }
  const target = latest(
    accepted,
    (value) => value.result.kind === 'read' && value.result.path === 'brief.md',
  );
  if (!target || target.result.kind !== 'read') {
    return tool('workspace_read', { path: 'brief.md' });
  }
  const replacement = `Summary: ${source.result.content.trim()}`;
  const proposal = latest(accepted, (value) => value.result.kind === 'document_approval');
  if (!proposal || proposal.result.kind !== 'document_approval') {
    return tool('workspace_propose_replace', {
      read_invocation_id: target.invocationId,
      old_text: 'PENDING',
      new_text: replacement,
    });
  }
  const approval = proposal.result.approval;
  const decision = latest(data, (value) => {
    const parsed = HarnessApprovalDecisionSchema.safeParse(value);
    return (
      parsed.success &&
      parsed.data.kind === 'document' &&
      parsed.data.approval_id === approval.approval_id
    );
  });
  if (!decision) throw new Error('native omitted the trusted document authorization decision');
  const authorized = HarnessApprovalDecisionSchema.parse(decision);
  if (authorized.kind !== 'document' || authorized.status !== 'approved') {
    throw new Error('fixture did not receive approved document authorization');
  }
  const apply = latest(
    accepted,
    (value) =>
      (value.result.kind === 'applied' || value.result.kind === 'conflict') &&
      value.result.approval_id === approval.approval_id,
  );
  if (!apply) return tool('workspace_apply_replace', { approval_id: approval.approval_id });
  if (apply.result.kind === 'conflict') {
    if (target.index < apply.index) return tool('workspace_read', { path: 'brief.md' });
    return tool('workspace_propose_replace', {
      read_invocation_id: target.invocationId,
      old_text: 'PENDING',
      new_text: replacement,
    });
  }
  if (apply.result.kind !== 'applied') throw new Error('unexpected apply observation');
  if (scenario.omitReadBack) {
    return {
      message: { content: 'Finished.', tool_calls: [] },
      usage: { total_tokens: 5 },
    };
  }
  if (target.index < apply.index) return tool('workspace_read', { path: 'brief.md' });
  if (
    target.result.version !== apply.result.version ||
    !target.result.content.includes(replacement)
  ) {
    throw new Error('independent real MCP read did not verify the applied file');
  }
  if (source.result.content !== scenario.source) throw new Error('MCP returned stale source bytes');
  return {
    message: { content: `Read back ${target.result.version}`, tool_calls: [] },
    usage: { total_tokens: 5 },
  };
}

async function delegatedReply(
  messages: ModelMessage[],
  scenario: Scenario,
): Promise<HarnessModelReply> {
  const accepted = observations(values(messages));
  if (scenario.noWorkspace) {
    return tool('finish_goal', {
      status: 'completed',
      outcomes: [
        { description: 'No workspace was available', status: 'achieved', receipt_refs: [] },
      ],
      clarification: null,
      answer: 'No managed workspace is available.',
    });
  }
  const workspace_id = scenario.workspaceId;
  if (scenario.create) {
    const created = latest(accepted, (value) => value.result.kind === 'create_applied');
    if (!created)
      return tool('workspace_create', {
        workspace_id,
        output_directory: '',
        filename: 'created.txt',
        content: 'Created through native and MCP.\n',
      });
    const fresh = latest(
      accepted,
      (value) => value.index > created.index && value.result.kind === 'read',
    );
    if (!fresh) return tool('workspace_read', { workspace_id, path: 'created.txt' });
    return tool('finish_goal', {
      status: 'completed',
      outcomes: [
        {
          description: 'Created and independently verified the file',
          status: 'achieved',
          receipt_refs: [created.invocationId, fresh.invocationId],
        },
      ],
      clarification: null,
      answer: 'Created and verified the file.',
    });
  }
  if (!latest(accepted, (value) => value.result.kind === 'list')) {
    return tool('workspace_list', { workspace_id, path: '' });
  }
  const search = latest(accepted, (value) => value.result.kind === 'search');
  if (!search || search.result.kind !== 'search') {
    return tool('workspace_grep', { workspace_id, path: 'sources', literal: 'Decision' });
  }
  const sourcePath = search.result.matches[0]?.path;
  if (!sourcePath) throw new Error('real MCP search did not expose the authorized source');
  const source = latest(
    accepted,
    (value) => value.result.kind === 'read' && value.result.path === sourcePath,
  );
  if (!source || source.result.kind !== 'read')
    return tool('workspace_read', { workspace_id, path: sourcePath });
  const target = latest(
    accepted,
    (value) => value.result.kind === 'read' && value.result.path === 'brief.md',
  );
  if (!target || target.result.kind !== 'read')
    return tool('workspace_read', { workspace_id, path: 'brief.md' });
  const operationError = latest(accepted, (value) => value.result.kind === 'operation_error');
  if (operationError) {
    return tool('finish_goal', {
      status: 'blocked',
      outcomes: [
        {
          description: 'The requested edit could not be compiled',
          status: 'blocked',
          receipt_refs: [],
        },
      ],
      clarification: null,
      answer: 'The file was not changed.',
    });
  }
  const edit = latest(
    accepted,
    (value) => value.result.kind === 'edit_applied' || value.result.kind === 'edit_conflict',
  );
  if (edit?.result.kind === 'edit_conflict' && target.index < edit.index) {
    return tool('workspace_read', { workspace_id, path: 'brief.md' });
  }
  if (!edit || edit.result.kind === 'edit_conflict') {
    if (scenario.conflict && !scenario.conflictInjected) {
      scenario.conflictInjected = true;
      await writeFile(join(scenario.root, 'brief.md'), `External header\r\n${scenario.initial}`);
    }
    return tool('workspace_replace', {
      read_invocation_id: target.invocationId,
      change: scenario.fullRewrite
        ? { kind: 'full', new_content: `Rewritten: ${source.result.content.trim()}\r\n` }
        : {
            kind: 'literal',
            old_text: scenario.invalidLiteral ? 'ABSENT' : 'PENDING',
            new_text: `Summary: ${source.result.content.trim()}`,
          },
    });
  }
  if (edit.result.kind !== 'edit_applied') throw new Error('unexpected delegated edit');
  if (!scenario.omitReadBack && target.index < edit.index) {
    return tool('workspace_read', { workspace_id, path: 'brief.md' });
  }
  if (scenario.splitGoalReadRef) {
    return tool('finish_goal', {
      status: 'completed',
      outcomes: [
        {
          description: 'The document was saved',
          status: 'achieved',
          receipt_refs: [edit.invocationId],
        },
        {
          description: 'The saved document was independently verified',
          status: 'achieved',
          receipt_refs: [target.invocationId],
        },
      ],
      clarification: null,
      answer: 'Saved and verified the document.',
    });
  }
  return tool('finish_goal', {
    status: 'completed',
    outcomes: [
      {
        description: 'The document was saved and independently verified',
        status: 'achieved',
        receipt_refs:
          scenario.omitReadBack ||
          (scenario.omitGoalReadRefOnce &&
            !messages.some((message) =>
              message.content.includes('goal omits the fresh document read'),
            ))
            ? [edit.invocationId]
            : [edit.invocationId, target.invocationId],
      },
    ],
    clarification: null,
    answer: 'Saved the document.',
  });
}

beforeAll(async () => {
  fixture = await createHarnessConsumer();
  modelServer = createServer((req, res) => {
    void (async () => {
      const body = ModelBody.parse(await jsonBody(req));
      const original = body.messages.find((value) => value.content.includes('workspaceCase:'));
      const marker = /workspaceCase:([\w-]+)/.exec(original?.content ?? '');
      const scenario = marker ? scenarios.get(marker[1]!) : undefined;
      if (!scenario) throw new Error('missing workspace fixture identity');
      scenario.requests.push(body.messages);
      scenario.offeredTools ??= [];
      scenario.offeredTools.push((body.tools ?? []).map((entry) => entry.function.name));
      if (body.parallel_tool_calls === false) {
        sendModelSse(
          res,
          scenario.delegated
            ? await delegatedReply(body.messages, scenario)
            : modelReply(body.messages, scenario),
        );
      } else {
        // This provider defaults to parallel proposals, as the real file task
        // endpoint did. Native must negotiate sequential calls, not discard one.
        const parallel = tool('workspace_list', { path: '' });
        parallel.message.tool_calls.push(
          ...tool('workspace_read', { path: 'brief.md' }).message.tool_calls,
        );
        sendModelSse(res, parallel);
      }
    })().catch((error: unknown) => {
      modelErrors.push(error);
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({ error: { message: 'workspace fixture rejected invalid observation' } }),
      );
    });
  });
  const base = await listen(modelServer);
  if (!fixture.deps.harness) throw new Error('production native fixture unavailable');
  fixture.deps.harness = {
    ...fixture.deps.harness,
    maxIterations: 24,
    maxTokens: 64000,
    contextPolicy: createContextPolicy({
      completionCap: 1024,
      model: 'controlled-workspace-consumer',
    }),
  };
  fixture.model = createLocalFixtureModelTransport({
    baseUrl: `${base}/v1`,
    model: 'controlled-workspace-consumer',
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
      [...scenarios.values()].map((value) => rm(value.root, { recursive: true, force: true })),
    );
  }
  expect(modelErrors).toEqual([]);
  expect(fixture?.providerErrors ?? []).toEqual([]);
}, 30_000);

async function setup(mode: ConsumerMode, conflict: boolean) {
  const actor = await fixture.actor(mode);
  const root = await mkdtemp(join(tmpdir(), 'along-d8-workspace-'));
  await mkdir(join(root, 'sources'), { mode: 0o700 });
  const scenario: Scenario = {
    id: randomUUID(),
    workspaceId: randomUUID(),
    root,
    source: conflict
      ? 'Decision 2027-06-19: use revision C.\r\n'
      : 'Decision 2027-06-18: use revision B.\r\n',
    initial: '\uFEFFHeading\r\nPENDING\r\n  Untouched  \r\n',
    requests: [],
    omitReadBack: false,
  };
  scenarios.set(scenario.id, scenario);
  await writeFile(join(root, 'sources/deadline.md'), scenario.source, { mode: 0o600 });
  await writeFile(join(root, 'brief.md'), scenario.initial, { mode: 0o600 });
  registrations.push({
    workspace_id: scenario.workspaceId,
    label: 'Managed brief',
    owner_id: actor.ownerId,
    root,
    readable_paths: ['brief.md', 'sources/deadline.md'],
    writable_paths: ['brief.md'],
    output_directories: [''],
  });
  await configureWorkspaceRegistry(registrations);
  const body = {
    conversation_id: await actor.createConversation(),
    execution: 'harness',
    workspace_id: scenario.workspaceId,
    raw_text: `workspaceCase:${scenario.id} Read project evidence and replace the PENDING section in brief.md; ask approval before saving and independently read it back.`,
    idempotency_key: randomUUID(),
  };
  return { actor, scenario, body };
}

async function data(response: Response): Promise<unknown> {
  const envelope = EnvelopeSchema.parse(await response.json());
  if (!response.ok || envelope.error || envelope.code !== 0) {
    throw new Error(
      `document HTTP ${response.status}:${envelope.error?.code ?? 'invalid_envelope'}`,
    );
  }
  return envelope.data;
}
async function detail(actor: HarnessActor, id: string) {
  return DocumentApprovalDetailSchema.parse(
    await data(await fixture.request(actor, `/api/v1/document-approvals/${id}`)),
  );
}
async function confirm(actor: HarnessActor, id: string) {
  const frozen = await detail(actor, id);
  const body = {
    presentation_hash: frozen.presentation_hash,
    seen_content: frozen.preview.body,
    idempotency_key: randomUUID(),
  };
  const result = DocumentApprovalActionResultSchema.parse(
    await data(
      await fixture.request(actor, `/api/v1/document-approvals/${id}/actions/confirm`, body),
    ),
  );
  expect(result).toMatchObject({ approval_id: id, status: 'approved', duplicate: false });
  return frozen;
}
async function documentFacts(ownerId: string) {
  const facts = await fixture.facts(ownerId);
  for (const table of ['document_approvals', 'document_approval_decisions']) {
    facts[table] = (
      await fixture.database.pool.query<{ fact: unknown }>(
        `SELECT to_jsonb(t) AS fact FROM ${table} t WHERE owner_id=$1 ORDER BY to_jsonb(t)::text`,
        [ownerId],
      )
    ).rows.map((row) => row.fact);
  }
  return facts;
}

async function savesDocument(mode: ConsumerMode, conflict: boolean) {
  const { actor, scenario, body } = await setup(mode, conflict);
  const initial = await (await actor.message(body)).events;
  expect(
    initial.filter((event) => event.type === 'thread.failed' || event.type === 'thread.completed'),
  ).toEqual([]);
  const run = started(initial);
  const approvalId = pending(initial);
  const waiting = await actor.view(run.conversation_id, run.run_id);
  expect(waiting).toMatchObject({
    status: 'suspended_approval',
    attempt_no: 1,
    can_resume: false,
    workspace: { workspace_id: scenario.workspaceId },
  });
  expect(waiting.waiting).toMatchObject({ approval_id: approvalId, approval_kind: 'document' });
  const preview = await confirm(actor, approvalId);
  expect(preview.exact_new_content).toBe(
    scenario.initial.replace('PENDING', `Summary: ${scenario.source.trim()}`),
  );
  expect(await readFile(join(scenario.root, 'brief.md'), 'utf8')).toBe(scenario.initial);
  expect((await detail(actor, approvalId)).effect.status).toBe('not_started');
  if (!waiting.waiting) throw new Error('missing document checkpoint');
  let expected = scenario.initial;
  if (conflict) {
    expected = `External header\r\n${expected}`;
    await writeFile(join(scenario.root, 'brief.md'), expected);
  }
  let events = await (
    await actor.resume(run.conversation_id, run.run_id, {
      checkpoint_id: waiting.waiting.checkpoint_id,
      idempotency_key: randomUUID(),
    })
  ).events;
  let leafApproval = approvalId;
  if (conflict) {
    const successor = pending(events);
    expect(successor).not.toBe(approvalId);
    const original = await detail(actor, approvalId);
    expect(original.effect).toMatchObject({ status: 'conflict', successor_approval_id: successor });
    const next = await detail(actor, successor);
    expect(next.replaces_approval_id).toBe(approvalId);
    expect(next.exact_new_content).toBe(
      expected.replace('PENDING', `Summary: ${scenario.source.trim()}`),
    );
    expect(await readFile(join(scenario.root, 'brief.md'), 'utf8')).toBe(expected);
    await confirm(actor, successor);
    const nextWaiting = await actor.view(run.conversation_id, run.run_id);
    if (!nextWaiting.waiting) throw new Error('missing successor checkpoint');
    expect(nextWaiting).toMatchObject({
      run_id: run.run_id,
      attempt_no: 2,
      status: 'suspended_approval',
    });
    events = await (
      await actor.resume(run.conversation_id, run.run_id, {
        checkpoint_id: nextWaiting.waiting.checkpoint_id,
        idempotency_key: randomUUID(),
      })
    ).events;
    leafApproval = successor;
  }
  expected = expected.replace('PENDING', `Summary: ${scenario.source.trim()}`);
  expect(await readFile(join(scenario.root, 'brief.md'))).toEqual(Buffer.from(expected));
  expect(await readFile(join(scenario.root, 'sources/deadline.md'), 'utf8')).toBe(scenario.source);
  expect(events.some((event) => event.type === 'thread.failed')).toBe(false);
  expect(events.filter((event) => event.type === 'thread.completed')).toHaveLength(1);
  expect(await actor.view(run.conversation_id, run.run_id)).toMatchObject({
    status: 'done',
    attempt_no: conflict ? 3 : 2,
    can_resume: false,
  });
  const verified = await detail(actor, leafApproval);
  expect(verified.effect).toMatchObject({
    status: 'verified',
    apply_invocation_id: expect.any(String),
    read_invocation_id: expect.any(String),
  });
  expect(verified.effect.read_invocation_id).not.toBe(verified.effect.apply_invocation_id);
  expect(scenario.offeredTools?.every((names) => !names.includes('workspace_replace'))).toBe(true);
  if (!conflict) expect(scenario.requests).toHaveLength(8);
  const frozen = await documentFacts(actor.ownerId);
  expect(frozen.tasks).toEqual([]);
  expect(frozen.outbox).toEqual([]);
  const requestCount = scenario.requests.length;
  await (
    await actor.message(body)
  ).events;
  expect(await documentFacts(actor.ownerId)).toEqual(frozen);
  expect(await readFile(join(scenario.root, 'brief.md'))).toEqual(Buffer.from(expected));
  expect(scenario.requests.length).toBe(requestCount);
}

for (const mode of ['local', 'http'] as const) {
  test(`D8.workspace.${mode}`, () => savesDocument(mode, false), 30_000);
  test(`D8.workspace-conflict.${mode}`, () => savesDocument(mode, true), 30_000);
}

test('D8.workspace-no-reread.http', async () => {
  const { actor, scenario, body } = await setup('http', false);
  scenario.omitReadBack = true;
  const initial = await (await actor.message(body)).events;
  expect(
    initial.filter((event) => event.type === 'thread.failed' || event.type === 'thread.completed'),
  ).toEqual([]);
  const run = started(initial);
  const approvalId = pending(initial);
  const preview = await confirm(actor, approvalId);
  const waiting = await actor.view(run.conversation_id, run.run_id);
  if (!waiting.waiting) throw new Error('missing document checkpoint');
  const events = await (
    await actor.resume(run.conversation_id, run.run_id, {
      checkpoint_id: waiting.waiting.checkpoint_id,
      idempotency_key: randomUUID(),
    })
  ).events;
  expect(events.filter((event) => event.type === 'thread.failed')).toHaveLength(1);
  expect(events.filter((event) => event.type === 'thread.completed')).toHaveLength(0);
  expect(await actor.view(run.conversation_id, run.run_id)).toMatchObject({
    status: 'failed',
    can_resume: false,
  });
  expect(await readFile(join(scenario.root, 'brief.md'))).toEqual(
    Buffer.from(preview.exact_new_content),
  );
  expect(await readFile(join(scenario.root, 'sources/deadline.md'), 'utf8')).toBe(scenario.source);
  const applied = await detail(actor, approvalId);
  expect(applied.effect.status).toBe('applied');
  expect(typeof applied.effect.apply_invocation_id).toBe('string');
  expect(applied.effect.read_invocation_id).toBeNull();
  const accepted = observations(values(scenario.requests.at(-1) ?? []));
  const writes = accepted.filter((value) => value.result.kind === 'applied');
  expect(writes).toHaveLength(1);
  expect(applied.effect.apply_invocation_id).toBe(writes[0]!.invocationId);
  expect(
    accepted.filter(
      (value) =>
        value.index > writes[0]!.index &&
        value.result.kind === 'read' &&
        value.result.path === 'brief.md',
    ),
  ).toHaveLength(0);
  const rows = (
    await fixture.database.pool.query(
      `SELECT state FROM tool_invocations WHERE owner_id=$1 AND tool_id='workspace_apply_replace'`,
      [actor.ownerId],
    )
  ).rows;
  expect(rows).toEqual([{ state: 'completed' }]);
}, 30_000);

test('D8.workspace-unknown.http', async () => {
  const { actor, scenario, body } = await setup('http', false);
  const initial = await (await actor.message(body)).events;
  expect(
    initial.filter((event) => event.type === 'thread.failed' || event.type === 'thread.completed'),
  ).toEqual([]);
  const run = started(initial);
  const approvalId = pending(initial);
  await confirm(actor, approvalId);
  const waiting = await actor.view(run.conversation_id, run.run_id);
  if (!waiting.waiting) throw new Error('missing document checkpoint');
  const name = `r1_unknown_${randomUUID().replaceAll('-', '')}`;
  await fixture.database.pool
    .query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.owner_id='${actor.ownerId}'::uuid AND NEW.tool_id='workspace_apply_replace' AND NEW.state='completed' THEN
        RAISE EXCEPTION 'fixture_reject_acceptance';
      END IF;
      RETURN NEW;
    END; $$;
    CREATE TRIGGER ${name} BEFORE UPDATE ON tool_invocations FOR EACH ROW EXECUTE FUNCTION ${name}()`);
  try {
    const events = await (
      await actor.resume(run.conversation_id, run.run_id, {
        checkpoint_id: waiting.waiting.checkpoint_id,
        idempotency_key: randomUUID(),
      })
    ).events;
    expect(events.find((event) => event.type === 'thread.failed')).toMatchObject({
      payload: { error: { code: 'TOOL_EFFECT_UNKNOWN' } },
    });
    expect(events.some((event) => event.type === 'thread.completed')).toBe(false);
    expect(await actor.view(run.conversation_id, run.run_id)).toMatchObject({
      status: 'failed',
      can_resume: false,
    });
    const expected = Buffer.from(
      scenario.initial.replace('PENDING', `Summary: ${scenario.source.trim()}`),
    );
    expect(await readFile(join(scenario.root, 'brief.md'))).toEqual(expected);
    expect((await detail(actor, approvalId)).effect.status).toBe('unknown');
    const rows = (
      await fixture.database.pool.query(
        `SELECT invocation_id,state,accepted_result FROM tool_invocations WHERE owner_id=$1 AND tool_id='workspace_apply_replace'`,
        [actor.ownerId],
      )
    ).rows;
    expect(rows).toEqual([
      { invocation_id: expect.any(String), state: 'unknown', accepted_result: null },
    ]);
    const before = await documentFacts(actor.ownerId);
    const count = scenario.requests.length;
    await (
      await actor.message(body)
    ).events;
    expect(await documentFacts(actor.ownerId)).toEqual(before);
    expect(scenario.requests.length).toBe(count);
    expect(await readFile(join(scenario.root, 'brief.md'))).toEqual(expected);
  } finally {
    await fixture.database.pool.query(
      `DROP TRIGGER ${name} ON tool_invocations; DROP FUNCTION ${name}()`,
    );
  }
}, 30_000);

async function setupDelegated(mode: ConsumerMode) {
  const { actor, scenario, body } = await setup(mode, false);
  scenario.delegated = true;
  return {
    actor,
    scenario,
    body: {
      conversation_id: body.conversation_id,
      execution: 'harness',
      authorization_revision: 'delegation/1',
      raw_text: `workspaceCase:${scenario.id} Find the decision and update the existing brief, preserving other bytes; independently read it back.`,
      idempotency_key: randomUUID(),
    },
  };
}

for (const mode of ['local', 'http'] as const) {
  test(`D8.delegated-create.${mode}`, async () => {
    const { actor, scenario, body } = await setupDelegated(mode);
    scenario.create = true;
    const events = await (await actor.message(body)).events;
    expect(events.some((event) => event.type === 'thread.failed')).toBe(false);
    expect(events.filter((event) => event.type === 'thread.completed')).toHaveLength(1);
    expect(await readFile(join(scenario.root, 'created.txt'), 'utf8')).toBe(
      'Created through native and MCP.\n',
    );
    const accepted = observations(values(scenario.requests.at(-1) ?? []));
    const created = accepted.find((value) => value.result.kind === 'create_applied');
    const fresh = accepted.find(
      (value) => created && value.index > created.index && value.result.kind === 'read',
    );
    expect(created).toBeDefined();
    expect(fresh?.result).toMatchObject({
      kind: 'read',
      path: 'created.txt',
      content: 'Created through native and MCP.\n',
    });
    expect(fresh?.invocationId).not.toBe(created?.invocationId);
    const run = started(events);
    expect(await actor.view(run.conversation_id, run.run_id)).toMatchObject({
      status: 'done',
      document_effects: expect.arrayContaining([
        expect.objectContaining({
          operation: 'create',
          path: 'created.txt',
          invocation_id: created?.invocationId,
          read_invocation_id: fresh?.invocationId,
          status: 'verified',
        }),
      ]),
    });
    expect((await documentFacts(actor.ownerId)).document_approvals).toEqual([]);
  }, 30_000);
}

async function delegatedSave(mode: ConsumerMode, conflict: boolean, fullRewrite = false) {
  const { actor, scenario, body } = await setupDelegated(mode);
  scenario.conflict = conflict;
  scenario.fullRewrite = fullRewrite;
  if (fullRewrite)
    body.raw_text = `workspaceCase:${scenario.id} Fully rewrite brief.md using the decision, then independently read it back.`;
  const events = await (await actor.message(body)).events;
  const run = started(events);
  expect(events.some((event) => event.type === 'thread.failed')).toBe(false);
  expect(events.filter((event) => event.type === 'thread.completed')).toHaveLength(1);
  const expected = fullRewrite
    ? `Rewritten: ${scenario.source.trim()}\r\n`
    : `${conflict ? 'External header\r\n' : ''}${scenario.initial}`.replace(
        'PENDING',
        `Summary: ${scenario.source.trim()}`,
      );
  expect(await readFile(join(scenario.root, 'brief.md'))).toEqual(Buffer.from(expected));
  expect(await readFile(join(scenario.root, 'sources/deadline.md'), 'utf8')).toBe(scenario.source);
  const accepted = observations(values(scenario.requests.at(-1) ?? []));
  for (const kind of ['list', 'search', 'read'] as const) {
    expect(
      accepted.some(
        (value) => value.result.kind === kind && value.result.workspace_id === scenario.workspaceId,
      ),
    ).toBe(true);
  }
  const applied = accepted.filter((value) => value.result.kind === 'edit_applied');
  const conflicts = accepted.filter((value) => value.result.kind === 'edit_conflict');
  expect(applied).toHaveLength(1);
  expect(conflicts).toHaveLength(conflict ? 1 : 0);
  if (conflict)
    expect(conflicts[0]!.result).toMatchObject({ reason: 'version_changed', zero_write: true });
  const fresh = latest(
    accepted,
    (value) =>
      value.index > applied[0]!.index &&
      value.result.kind === 'read' &&
      value.result.path === 'brief.md',
  );
  expect(fresh?.result).toMatchObject({ workspace_id: scenario.workspaceId, content: expected });
  expect(fresh?.invocationId).not.toBe(applied[0]!.invocationId);
  if (applied[0]!.result.kind !== 'edit_applied' || fresh?.result.kind !== 'read') {
    throw new Error('missing accepted edit or independent read');
  }
  expect(fresh.result.version).toBe(applied[0]!.result.version);
  expect(fresh.result.byte_length).toBe(Buffer.byteLength(expected));
  const view = await actor.view(run.conversation_id, run.run_id);
  expect(view).toMatchObject({
    status: 'done',
    workspaces: [expect.objectContaining({ workspace_id: scenario.workspaceId })],
    document_effects: expect.arrayContaining([
      expect.objectContaining({
        workspace_id: scenario.workspaceId,
        path: 'brief.md',
        invocation_id: applied[0]!.invocationId,
        read_invocation_id: fresh!.invocationId,
        status: 'verified',
      }),
    ]),
  });
  expect(scenario.offeredTools?.[0]).toContain('workspace_replace');
  const facts = await documentFacts(actor.ownerId);
  expect(facts.document_approvals).toEqual([]);
  expect(facts.document_approval_decisions).toEqual([]);
  const requests = scenario.requests.length;
  await (
    await actor.message(body)
  ).events;
  expect(await documentFacts(actor.ownerId)).toEqual(facts);
  expect(scenario.requests).toHaveLength(requests);
  expect(await readFile(join(scenario.root, 'brief.md'))).toEqual(Buffer.from(expected));
}

for (const mode of ['local', 'http'] as const) {
  test(`D8.delegated-workspace.${mode}`, () => delegatedSave(mode, false), 60_000);
  test(`D8.delegated-workspace-conflict.${mode}`, () => delegatedSave(mode, true), 60_000);
  test(`D8.delegated-workspace-full.${mode}`, () => delegatedSave(mode, false, true), 60_000);
  test(`D8.delegated-workspace-goal-correction.${mode}`, async () => {
    const { actor, scenario, body } = await setupDelegated(mode);
    scenario.omitGoalReadRefOnce = true;
    const events = await (await actor.message(body)).events;
    const run = started(events);
    expect(events.some((event) => event.type === 'thread.completed')).toBe(true);
    expect(
      scenario.requests
        .at(-1)
        ?.some((message) => message.content.includes('goal omits the fresh document read')),
    ).toBe(true);
    const accepted = observations(values(scenario.requests.at(-1) ?? []));
    expect(accepted.filter((value) => value.result.kind === 'edit_applied')).toHaveLength(1);
    expect(await actor.view(run.conversation_id, run.run_id)).toMatchObject({
      status: 'done',
      document_effects: expect.arrayContaining([
        expect.objectContaining({ path: 'brief.md', status: 'verified' }),
      ]),
    });
    expect(await readFile(join(scenario.root, 'brief.md'), 'utf8')).toBe(
      scenario.initial.replace('PENDING', `Summary: ${scenario.source.trim()}`),
    );
  }, 60_000);
  test(`D8.delegated-workspace-split-read-evidence.${mode}`, async () => {
    const { actor, scenario, body } = await setupDelegated(mode);
    scenario.splitGoalReadRef = true;
    const events = await (await actor.message(body)).events;
    const run = started(events);
    expect(events.some((event) => event.type === 'thread.completed')).toBe(true);
    const view = await actor.view(run.conversation_id, run.run_id);
    expect(view).toMatchObject({
      status: 'done',
      goal_result: { status: 'completed' },
      document_effects: expect.arrayContaining([
        expect.objectContaining({ path: 'brief.md', status: 'verified' }),
      ]),
    });
    const accepted = observations(values(scenario.requests.at(-1) ?? []));
    expect(accepted.filter((value) => value.result.kind === 'edit_applied')).toHaveLength(1);
    expect(await readFile(join(scenario.root, 'brief.md'), 'utf8')).toBe(
      scenario.initial.replace('PENDING', `Summary: ${scenario.source.trim()}`),
    );
  }, 60_000);
  test(`D8.delegated-workspace-invalid-literal.${mode}`, async () => {
    const { actor, scenario, body } = await setupDelegated(mode);
    scenario.invalidLiteral = true;
    const events = await (await actor.message(body)).events;
    const run = started(events);
    const accepted = observations(values(scenario.requests.at(-1) ?? []));
    expect(
      accepted.some(
        (value) =>
          value.result.kind === 'operation_error' && value.result.reason === 'literal_not_found',
      ),
    ).toBe(true);
    expect(await readFile(join(scenario.root, 'brief.md'), 'utf8')).toBe(scenario.initial);
    expect((await actor.view(run.conversation_id, run.run_id)).goal_result?.status).toBe('blocked');
    expect((await documentFacts(actor.ownerId)).document_approvals).toEqual([]);
  }, 60_000);
  test(`D8.delegated-workspace-empty.${mode}`, async () => {
    const { actor, scenario, body } = await setupDelegated(mode);
    scenario.noWorkspace = true;
    await configureWorkspaceRegistry(
      registrations.filter((item) => item.workspace_id !== scenario.workspaceId),
    );
    const events = await (await actor.message(body)).events;
    const run = started(events);
    expect(events.some((event) => event.type === 'thread.completed')).toBe(true);
    expect(await actor.view(run.conversation_id, run.run_id)).toMatchObject({
      status: 'done',
      workspaces: [],
    });
    expect(scenario.offeredTools?.[0]?.some((name) => name.startsWith('workspace_'))).toBe(false);
    expect(await readFile(join(scenario.root, 'brief.md'), 'utf8')).toBe(scenario.initial);
  }, 60_000);
}

test('D8.delegated-workspace-no-reread.http', async () => {
  const { actor, scenario, body } = await setupDelegated('http');
  scenario.omitReadBack = true;
  const events = await (await actor.message(body)).events;
  const run = started(events);
  expect(events.some((event) => event.type === 'thread.completed')).toBe(false);
  const view = await actor.view(run.conversation_id, run.run_id);
  expect(view.document_effects).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ path: 'brief.md', status: 'applied', read_invocation_id: null }),
    ]),
  );
  expect(await readFile(join(scenario.root, 'brief.md'), 'utf8')).toBe(
    scenario.initial.replace('PENDING', `Summary: ${scenario.source.trim()}`),
  );
  const accepted = observations(values(scenario.requests.at(-1) ?? []));
  const applied = latest(accepted, (value) => value.result.kind === 'edit_applied');
  expect(applied).toBeDefined();
  expect(
    accepted.some(
      (value) =>
        value.index > applied!.index &&
        value.result.kind === 'read' &&
        value.result.path === 'brief.md',
    ),
  ).toBe(false);
}, 60_000);

test('D8.delegated-workspace-unknown.http', async () => {
  const { actor, scenario, body } = await setupDelegated('http');
  const name = `delegated_unknown_${randomUUID().replaceAll('-', '')}`;
  await fixture.database.pool
    .query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.owner_id='${actor.ownerId}'::uuid AND NEW.tool_id='workspace_replace' AND NEW.state='completed' THEN
        RAISE EXCEPTION 'fixture_reject_acceptance';
      END IF;
      RETURN NEW;
    END; $$;
    CREATE TRIGGER ${name} BEFORE UPDATE ON tool_invocations FOR EACH ROW EXECUTE FUNCTION ${name}()`);
  try {
    const events = await (await actor.message(body)).events;
    const run = started(events);
    expect(events.find((event) => event.type === 'thread.failed')).toMatchObject({
      payload: { error: { code: 'TOOL_EFFECT_UNKNOWN' } },
    });
    expect(events.some((event) => event.type === 'thread.completed')).toBe(false);
    expect(await readFile(join(scenario.root, 'brief.md'), 'utf8')).toBe(
      scenario.initial.replace('PENDING', `Summary: ${scenario.source.trim()}`),
    );
    const rows = (
      await fixture.database.pool.query(
        `SELECT state,accepted_result FROM tool_invocations WHERE owner_id=$1 AND tool_id='workspace_replace'`,
        [actor.ownerId],
      )
    ).rows;
    expect(rows).toEqual([{ state: 'unknown', accepted_result: null }]);
    const view = await actor.view(run.conversation_id, run.run_id);
    expect(view.can_resume).toBe(false);
    expect(view.document_effects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          workspace_id: scenario.workspaceId,
          path: 'brief.md',
          status: 'unknown',
        }),
      ]),
    );
    const facts = await documentFacts(actor.ownerId);
    expect(facts.document_approvals).toEqual([]);
    const requests = scenario.requests.length;
    await (
      await actor.message(body)
    ).events;
    expect(await documentFacts(actor.ownerId)).toEqual(facts);
    expect(scenario.requests).toHaveLength(requests);
  } finally {
    await fixture.database.pool.query(
      `DROP TRIGGER ${name} ON tool_invocations; DROP FUNCTION ${name}()`,
    );
  }
}, 60_000);
