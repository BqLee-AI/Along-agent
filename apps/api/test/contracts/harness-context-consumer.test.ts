import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import {
  DocumentApprovalActionResultSchema,
  DocumentApprovalDetailSchema,
  EnvelopeSchema,
  HarnessApprovalDecisionSchema,
  HarnessModelMessageSchema,
  HarnessObservationSchema,
  HarnessSnapshotSchema,
  workspaceResultSchema,
  HarnessToolResultSchema,
  type HarnessModelReply,
  type WorkspaceResult,
} from '@along/contracts';
import { createContextPolicy } from '../../src/modules/conversations/context-policy.js';
import { createHarnessModelTransport } from '../../src/modules/conversations/harness-model.js';
import {
  configureWorkspaceRegistry,
  type WorkspaceRegistration,
} from '../../src/modules/workspaces/service.js';
import {
  createHarnessConsumer,
  jsonBody,
  listen,
  pending,
  sendModelSse,
  started,
  type ConsumerMode,
  type HarnessConsumer,
} from '../helpers/harness-consumer.js';

type ModelMessage = z.infer<typeof HarnessModelMessageSchema>;
const RequestBody = z.object({
  messages: z.array(HarnessModelMessageSchema),
  stream: z.literal(true),
  parallel_tool_calls: z.literal(false),
  max_tokens: z.number().int().positive(),
});
const LiveObservation = z.object({
  invocationId: z.string().uuid(),
  status: z.literal('ok'),
  result: workspaceResultSchema,
});
interface Scenario {
  id: string;
  root: string;
  step: number;
  originals: string[];
  current: string;
  replacement: string;
  initial: string;
  sourceId: string;
  results: Map<string, WorkspaceResult>;
  projections: Set<string>;
  requests: ModelMessage[][];
  requestBytes: number[];
}
let fixture: HarnessConsumer;
let provider: Server;
const scenarios = new Map<string, Scenario>();
const registrations: WorkspaceRegistration[] = [];
const providerErrors: unknown[] = [];

function decoded(messages: readonly ModelMessage[]): unknown[] {
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
        // A data prefix can contain braces before the complete JSON value.
      }
    }
  }
  return result;
}

function nextReply(messages: ModelMessage[], scenario: Scenario): HarnessModelReply {
  const data = decoded(messages);
  for (const value of data) {
    const observation = HarnessObservationSchema.safeParse(value);
    if (observation.success) {
      const item = observation.data;
      if (item.view === 'projected') scenario.projections.add(item.invocation_id);
      if (item.view === 'full' && item.result.status === 'ok') {
        const parsed = workspaceResultSchema.safeParse(item.result.result);
        if (parsed.success) scenario.results.set(item.invocation_id, parsed.data);
      }
    }
    const live = LiveObservation.safeParse(value);
    if (live.success) scenario.results.set(live.data.invocationId, live.data.result);
  }
  const step = scenario.step++;
  let name: string;
  let args: Record<string, unknown>;
  if (step < 6) {
    if (step > 0)
      expect(
        [...scenario.results.values()].some(
          (item) => item.kind === 'read' && item.path === `source-${step - 1}.txt`,
        ),
      ).toBe(true);
    name = 'workspace_read';
    args = { path: `source-${step}.txt` };
  } else if (step === 6) {
    const source = [...scenario.results].find(
      ([, item]) => item.kind === 'read' && item.path === 'source-0.txt',
    );
    if (!source) throw new Error('missing original accepted source');
    scenario.sourceId = source[0];
    expect([...scenario.results.values()].filter((item) => item.kind === 'read')).toHaveLength(6);
    name = 'workspace_read';
    args = { path: 'source-0.txt' };
  } else if (step === 7) {
    expect(
      [...scenario.results.values()].some(
        (item) => item.kind === 'read' && item.content === scenario.current,
      ),
    ).toBe(true);
    name = 'workspace_read';
    args = { path: 'missing.txt' };
  } else if (step === 8) {
    expect(
      [...scenario.results.values()].some(
        (item) => item.kind === 'operation_error' && item.path === 'missing.txt',
      ),
    ).toBe(true);
    expect(scenario.projections.has(scenario.sourceId)).toBe(true);
    name = 'read_run_observation';
    args = { source_invocation_id: scenario.sourceId, field: 'content', offset: 0, limit: 128 };
  } else if (step === 9) {
    const slice = [...scenario.results.values()].find((item) => item.kind === 'context_slice');
    expect(slice).toMatchObject({
      kind: 'context_slice',
      source_invocation_id: scenario.sourceId,
      source_tool_id: 'workspace_read',
      source_result_version: 1,
      source_kind: 'read',
      path: 'source-0.txt',
      version: createHash('sha256').update(scenario.originals[0]!).digest('hex'),
      byte_length: 200000,
      offset: 0,
      end: 128,
      total: 200000,
      has_more: true,
      content: scenario.originals[0]!.slice(0, 128),
    });
    name = 'workspace_read';
    args = { path: 'brief.md' };
  } else if (step === 10) {
    const target = [...scenario.results].find(
      ([, item]) => item.kind === 'read' && item.path === 'brief.md',
    );
    if (!target) throw new Error('missing full replacement baseline');
    const slice = [...scenario.results.values()].find((item) => item.kind === 'context_slice');
    const current = [...scenario.results.values()].find(
      (item) => item.kind === 'read' && item.content === scenario.current,
    );
    if (
      !slice ||
      slice.kind !== 'context_slice' ||
      !('content' in slice) ||
      !current ||
      current.kind !== 'read'
    )
      throw new Error('missing old and current date evidence');
    scenario.replacement = `Accepted: ${slice.content!.split('\n')[0]}; current: ${current.content.split('\n')[0]}`;
    name = 'workspace_propose_replace';
    args = { read_invocation_id: target[0], old_text: 'PENDING', new_text: scenario.replacement };
  } else if (step === 11) {
    const decision = data
      .map((value) => HarnessApprovalDecisionSchema.safeParse(value))
      .find((value) => value.success);
    if (
      !decision?.success ||
      decision.data.kind !== 'document' ||
      decision.data.status !== 'approved'
    )
      throw new Error('missing explicit approved decision');
    name = 'workspace_apply_replace';
    args = { approval_id: decision.data.approval_id };
  } else if (step === 12) {
    expect([...scenario.results.values()].filter((item) => item.kind === 'applied')).toHaveLength(
      1,
    );
    name = 'workspace_read';
    args = { path: 'brief.md' };
  } else if (step === 13) {
    expect(
      [...scenario.results.values()].some(
        (item) =>
          item.kind === 'read' &&
          item.path === 'brief.md' &&
          item.content === scenario.initial.replace('PENDING', scenario.replacement),
      ),
    ).toBe(true);
    return {
      message: { content: scenario.replacement, tool_calls: [] },
      usage: { total_tokens: 5 },
    };
  } else {
    throw new Error('unexpected extra model request');
  }
  return {
    message: {
      content: null,
      tool_calls: [
        { id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } },
      ],
    },
    usage: { total_tokens: 5 },
  };
}

beforeAll(async () => {
  fixture = await createHarnessConsumer();
  provider = createServer((req, res) => {
    void (async () => {
      const raw = await jsonBody(req);
      const body = RequestBody.parse(raw);
      for (const [index, message] of body.messages.entries()) {
        if (message.role === 'tool') {
          const previous = body.messages[index - 1];
          if (!previous || !('tool_calls' in previous)) throw new Error('orphan tool result');
          expect(previous.tool_calls[0]!.id).toBe(message.tool_call_id);
        }
        if ('tool_calls' in message) {
          const next = body.messages[index + 1];
          if (!next || next.role !== 'tool') throw new Error('orphan assistant function call');
          expect(next.tool_call_id).toBe(message.tool_calls[0]!.id);
        }
      }
      const marker = /contextCase:([\w-]+)/.exec(
        body.messages.find((message) => message.content.includes('contextCase:'))?.content ?? '',
      );
      const scenario = marker ? scenarios.get(marker[1]!) : undefined;
      if (!scenario) throw new Error('missing context consumer scenario');
      scenario.requests.push(body.messages);
      scenario.requestBytes.push(Buffer.byteLength(JSON.stringify(raw), 'utf8'));
      // Change current storage only after all six original reads were accepted.
      if (scenario.step === 6)
        await writeFile(join(scenario.root, 'source-0.txt'), scenario.current);
      sendModelSse(res, nextReply(body.messages, scenario));
    })().catch((error: unknown) => {
      providerErrors.push(error);
      if (!res.headersSent) res.writeHead(500);
      res.end('context provider rejected invalid evidence');
    });
  });
  const base = await listen(provider);
  if (!fixture.deps.harness) throw new Error('native fixture unavailable');
  fixture.deps.harness = {
    ...fixture.deps.harness,
    maxIterations: 24,
    maxTokens: 64000,
    contextPolicy: createContextPolicy({ completionCap: 1024, model: 'context-consumer' }),
  };
  fixture.model = createHarnessModelTransport({ baseUrl: `${base}/v1`, model: 'context-consumer' });
}, 30_000);

afterAll(async () => {
  try {
    await fixture?.close();
  } finally {
    if (provider?.listening) {
      const closed = once(provider, 'close');
      provider.closeAllConnections();
      provider.close();
      await closed;
    }
    await configureWorkspaceRegistry([]);
    await Promise.all(
      [...scenarios.values()].map((scenario) =>
        rm(scenario.root, { recursive: true, force: true }),
      ),
    );
  }
  expect(providerErrors).toEqual([]);
  expect(fixture?.providerErrors ?? []).toEqual([]);
}, 30_000);

async function contextConsumer(mode: ConsumerMode): Promise<void> {
  const actor = await fixture.actor(mode);
  const root = await mkdtemp(join(tmpdir(), 'along-context-consumer-'));
  const originals = Array.from({ length: 6 }, (_, index) => {
    const date = `Decision 2027-06-${18 + index}: source ${index}\n`;
    return date + 'x'.repeat(200000 - Buffer.byteLength(date));
  });
  const currentDate =
    mode === 'local'
      ? 'Decision 2027-07-29: updated source\n'
      : 'Decision 2027-08-30: updated source\n';
  const scenario: Scenario = {
    id: randomUUID(),
    root,
    step: 0,
    originals,
    current: currentDate + 'y'.repeat(200000 - Buffer.byteLength(currentDate)),
    replacement: '',
    initial: '\uFEFFHeading\r\nPENDING\r\nUntouched\r\n',
    sourceId: '',
    results: new Map(),
    projections: new Set(),
    requests: [],
    requestBytes: [],
  };
  scenarios.set(scenario.id, scenario);
  const workspaceId = randomUUID();
  const paths = originals.map((_, index) => `source-${index}.txt`);
  await Promise.all(
    originals.map((content, index) =>
      writeFile(join(root, paths[index]!), content, { mode: 0o600 }),
    ),
  );
  await writeFile(join(root, 'brief.md'), scenario.initial, { mode: 0o600 });
  registrations.push({
    workspace_id: workspaceId,
    label: 'Context evidence',
    owner_id: actor.ownerId,
    root,
    readable_paths: [...paths, 'brief.md', 'missing.txt'],
    writable_paths: ['brief.md'],
  });
  await configureWorkspaceRegistry(registrations);
  const body = {
    execution: 'harness',
    workspace_id: workspaceId,
    raw_text: `contextCase:${scenario.id} Compare all six dated sources and a failed read. Recheck the original accepted source after it changes. Preview the current date and original evidence in brief.md; save only after approval, then read back.`,
    idempotency_key: randomUUID(),
  };
  const events = await (await actor.message(body)).events;
  expect(
    events.filter((event) => event.type === 'thread.failed' || event.type === 'thread.completed'),
  ).toEqual([]);
  const run = started(events);
  const approvalId = pending(events);
  expect(scenario.requests).toHaveLength(11);
  const waiting = await actor.view(run.conversation_id, run.run_id);
  expect(waiting).toMatchObject({ status: 'suspended_approval', attempt_no: 1, can_resume: false });
  if (!waiting.waiting) throw new Error('missing original approval wait');
  const acceptedBefore = (
    await fixture.database.pool.query<{
      invocation_id: string;
      tool_id: string;
      accepted_result: unknown;
    }>(
      'SELECT invocation_id,tool_id,accepted_result FROM tool_invocations WHERE run_id=$1 ORDER BY call_key',
      [run.run_id],
    )
  ).rows;
  const reads = acceptedBefore.filter((row) => row.tool_id === 'workspace_read');
  const originalReads = reads.filter((row) => {
    const accepted = HarnessToolResultSchema.parse(row.accepted_result);
    return (
      accepted.status === 'ok' &&
      accepted.result.kind === 'read' &&
      originals.includes(accepted.result.content)
    );
  });
  expect(originalReads).toHaveLength(6);
  for (const read of originalReads) {
    expect(read.accepted_result).toMatchObject({
      status: 'ok',
      result: { kind: 'read', byte_length: 200000 },
    });
    expect(Buffer.byteLength(JSON.stringify(read.accepted_result))).toBeLessThanOrEqual(240000);
  }
  expect(acceptedBefore.filter((row) => row.tool_id === 'workspace_apply_replace')).toEqual([]);
  expect(
    originals.reduce((bytes, content) => bytes + Buffer.byteLength(content), 0),
  ).toBeGreaterThan(1048576);
  expect(scenario.projections.has(scenario.sourceId)).toBe(true);
  const source = acceptedBefore.find((row) => row.invocation_id === scenario.sourceId);
  expect(source?.accepted_result).toMatchObject({
    status: 'ok',
    result: { kind: 'read', content: originals[0], byte_length: 200000 },
  });
  const slice = acceptedBefore.find((row) => row.tool_id === 'read_run_observation');
  expect(slice?.invocation_id).not.toBe(scenario.sourceId);
  expect(slice?.accepted_result).toMatchObject({
    status: 'ok',
    result: {
      kind: 'context_slice',
      source_invocation_id: scenario.sourceId,
      content: originals[0]!.slice(0, 128),
    },
  });
  const snapshotRows = async () =>
    (
      await fixture.database.pool.query<{ payload: unknown }>(
        `SELECT c.payload FROM run_checkpoints c JOIN run_attempts a ON a.id=c.attempt_id WHERE a.run_id=$1 AND c.kind='harness_snapshot' ORDER BY c.event_seq`,
        [run.run_id],
      )
    ).rows.map((row) => HarnessSnapshotSchema.parse(row.payload));
  const snapshotsBefore = await snapshotRows();
  const refs = acceptedBefore.map((row) => row.invocation_id);
  expect(new Set(snapshotsBefore.at(-1)!.tool_refs)).toEqual(new Set(refs));
  expect(await readFile(join(root, 'brief.md'), 'utf8')).toBe(scenario.initial);
  const detailResponse = await fixture.request(actor, `/api/v1/document-approvals/${approvalId}`);
  expect(detailResponse.status).toBe(200);
  const detail = DocumentApprovalDetailSchema.parse(
    EnvelopeSchema.parse(await detailResponse.json()).data,
  );
  expect(detail.effect.status).toBe('not_started');
  expect(detail.exact_new_content).toBe(scenario.initial.replace('PENDING', scenario.replacement));
  expect(detail.exact_new_content).toContain(currentDate.trim());
  expect(detail.exact_new_content).toContain('Decision 2027-06-18');
  const confirmedResponse = await fixture.request(
    actor,
    `/api/v1/document-approvals/${approvalId}/actions/confirm`,
    {
      presentation_hash: detail.presentation_hash,
      seen_content: detail.preview.body,
      idempotency_key: randomUUID(),
    },
  );
  expect(confirmedResponse.status).toBe(200);
  expect(
    DocumentApprovalActionResultSchema.parse(
      EnvelopeSchema.parse(await confirmedResponse.json()).data,
    ),
  ).toMatchObject({ status: 'approved', duplicate: false });
  expect(await readFile(join(root, 'brief.md'), 'utf8')).toBe(scenario.initial);
  expect(scenario.requests).toHaveLength(11);
  const resumed = await (
    await actor.resume(run.conversation_id, run.run_id, {
      checkpoint_id: waiting.waiting.checkpoint_id,
      idempotency_key: randomUUID(),
    })
  ).events;
  expect(resumed.filter((event) => event.type === 'thread.failed')).toEqual([]);
  expect(resumed.filter((event) => event.type === 'thread.completed')).toHaveLength(1);
  expect(await actor.view(run.conversation_id, run.run_id)).toMatchObject({
    run_id: run.run_id,
    status: 'done',
    attempt_no: 2,
  });
  expect(await readFile(join(root, 'brief.md'), 'utf8')).toBe(
    scenario.initial.replace('PENDING', scenario.replacement),
  );
  expect(scenario.requests).toHaveLength(14);
  expect(scenario.requestBytes.every((bytes) => bytes <= 1048576)).toBe(true);
  const acceptedAfter = (
    await fixture.database.pool.query<{
      invocation_id: string;
      tool_id: string;
      accepted_result: unknown;
    }>(
      'SELECT invocation_id,tool_id,accepted_result FROM tool_invocations WHERE run_id=$1 ORDER BY call_key',
      [run.run_id],
    )
  ).rows;
  expect(acceptedAfter.filter((row) => refs.includes(row.invocation_id))).toEqual(acceptedBefore);
  expect(acceptedAfter.filter((row) => row.tool_id === 'workspace_apply_replace')).toHaveLength(1);
  const freshReads = acceptedAfter.filter(
    (row) => row.tool_id === 'workspace_read' && !refs.includes(row.invocation_id),
  );
  expect(freshReads).toHaveLength(1);
  expect(freshReads[0]!.accepted_result).toMatchObject({
    status: 'ok',
    result: {
      kind: 'read',
      path: 'brief.md',
      content: scenario.initial.replace('PENDING', scenario.replacement),
    },
  });
  const finalSnapshots = await snapshotRows();
  expect(new Set(finalSnapshots.at(-1)!.tool_refs)).toEqual(
    new Set(acceptedAfter.map((row) => row.invocation_id)),
  );
  for (const snapshot of finalSnapshots) {
    expect(snapshot.message_refs).toEqual(snapshotsBefore[0]!.message_refs);
  }
  const frozen = await fixture.facts(actor.ownerId);
  await actor.history(run.conversation_id);
  await (
    await actor.message(body)
  ).events;
  expect(await fixture.facts(actor.ownerId)).toEqual(frozen);
  expect(scenario.requests).toHaveLength(14);
}

for (const mode of ['local', 'http'] as const) {
  test(`D8.context.${mode}`, () => contextConsumer(mode), 60_000);
}
