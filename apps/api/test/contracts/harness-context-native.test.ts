import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { HarnessRequestSchema, type HarnessRequest } from '@along/contracts';

const binaryPath = process.env.HARNESS_BINARY;
const policy = {
  revision: 'r2a/1',
  completion_cap: 37,
  model_window_tokens: null,
  input_meter: 'unavailable',
  meter_revision: 'unavailable/1',
  reserve_tokens: 0,
  model_binding: { model: 'fixture', adapter_revision: 'openai-chat/v1' },
};

// A real native pipe counterpart, not a replacement harness or model transport.
async function nativeCase(options: {
  model: (
    request: Extract<HarnessRequest, { type: 'model' | 'model_next' }>,
    index: number,
  ) => unknown;
  measure?: (request: Extract<HarnessRequest, { type: 'measure_context' }>) => unknown;
  start?: Record<string, unknown>;
  handle?: (
    request: Extract<HarnessRequest, { type: 'reserve' | 'invoke' | 'context_source' }>,
  ) => unknown;
  route?: (
    request: Extract<
      HarnessRequest,
      { type: 'route_probe' | 'route_decide' | 'render_route_result' }
    >,
  ) => unknown;
  reject?: (request: HarnessRequest) => string | null;
  cancel?: (request: HarnessRequest) => boolean;
  expectedExit?: number;
}) {
  if (!binaryPath)
    throw new Error('R2-A native requires HARNESS_BINARY from the current production build');
  const child = Bun.spawn([binaryPath], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      LD_LIBRARY_PATH: process.env.HARNESS_LIBRARY_PATH ?? process.env.LD_LIBRARY_PATH,
    },
  });
  const requests: HarnessRequest[] = [];
  const send = (frame: unknown) => child.stdin.write(JSON.stringify(frame) + '\n');
  send({
    protocol: 'harness/v5',
    type: 'start',
    routing_policy: { revision: 'r2b/1', mode: 'off' },
    eligible_phase: 'disabled',
    context_policy: policy,
    messages: [
      { message_id: randomUUID(), role: 'user', content: 'Keep the complete frozen input.' },
    ],
    tools: [],
    budget: { max_iterations: 4, max_tokens: 1000 },
    snapshot: null,
    observations: [],
    approval: null,
    ...options.start,
  });
  let pending = '';
  let modelCount = 0;
  const decoder = new TextDecoder();
  try {
    for await (const chunk of child.stdout) {
      pending += decoder.decode(chunk, { stream: true });
      for (;;) {
        const newline = pending.indexOf('\n');
        if (newline < 0) break;
        const request = HarnessRequestSchema.parse(JSON.parse(pending.slice(0, newline)));
        pending = pending.slice(newline + 1);
        requests.push(request);
        if (options.cancel?.(request)) {
          send({
            protocol: 'harness/v5',
            type: 'cancel',
            reason: 'controlled accepted cancellation',
          });
          continue;
        }
        const rejected = options.reject?.(request);
        if (rejected) {
          send({
            protocol: 'harness/v5',
            type: 'reply',
            reply_to: request.request_ref,
            error: { code: rejected, message: 'controlled protocol boundary failure' },
          });
          continue;
        }
        let value: unknown;
        if (request.type === 'measure_context')
          value = options.measure?.(request) ?? {
            wire_bytes: 1024,
            http_bytes: 2048,
            input_meter: {
              quality: 'unavailable',
              input_tokens: null,
              meter_revision: 'fixture/v1',
            },
            output_ceiling: 37,
            limit_reason: null,
          };
        else if (request.type === 'model' || request.type === 'model_next')
          value = options.model(request, modelCount++);
        else if (request.type === 'snapshot') value = { checkpoint_ref: randomUUID() };
        else if (
          request.type === 'route_probe' ||
          request.type === 'route_decide' ||
          request.type === 'render_route_result'
        )
          value = options.route?.(request);
        else if (
          request.type === 'reserve' ||
          request.type === 'invoke' ||
          request.type === 'context_source'
        )
          value = options.handle?.(request);
        else value = { accepted: true };
        send({ protocol: 'harness/v5', type: 'reply', reply_to: request.request_ref, value });
      }
    }
    expect(await child.exited, await new Response(child.stderr).text()).toBe(
      options.expectedExit ?? 0,
    );
    return requests;
  } finally {
    child.stdin.end();
    child.kill();
  }
}

test('R2-A measures independently capped output before making one provider request', async () => {
  const requests = await nativeCase({
    model: () => ({
      type: 'failed',
      error: { code: 'HARNESS_CONTEXT_LIMIT', message: 'length' },
      usage: { total_tokens: 11 },
    }),
  });
  expect(requests.map((r) => r.type)).toEqual(['measure_context', 'model', 'finish']);
  expect(requests[0]).toMatchObject({ remaining_tokens: 1000 });
  expect(requests[1]).toMatchObject({ max_output_tokens: 37 });
  expect(requests.find((r) => r.type === 'model')!.messages).toEqual(
    requests.find((r) => r.type === 'measure_context')!.messages,
  );
  expect(requests.at(-1)).toMatchObject({
    outcome: 'failed',
    error: { code: 'HARNESS_CONTEXT_LIMIT' },
    usage: { iterations: 1, tokens: 11 },
  });
}, 30_000);

test('R2-A infeasible trusted budget makes no model request', async () => {
  const requests = await nativeCase({
    measure: () => ({
      wire_bytes: 1024,
      http_bytes: 2048,
      input_meter: { quality: 'verified', input_tokens: 1000, meter_revision: 'fixture/v1' },
      output_ceiling: 0,
      limit_reason: 'budget',
    }),
    model: () => {
      throw new Error('infeasible candidate reached model');
    },
  });
  expect(requests.map((r) => r.type)).toEqual(['measure_context', 'finish']);
  expect(requests.at(-1)).toMatchObject({
    error: { code: 'BUDGET_EXCEEDED' },
    usage: { iterations: 0, tokens: 0 },
  });
}, 30_000);

test('R2-A accepted stream delta survives failed model_next and missing usage stays unknown', async () => {
  const requests = await nativeCase({
    model: (_, index) =>
      index === 0
        ? { type: 'delta', delta: '已接受的进度' }
        : {
            type: 'failed',
            error: { code: 'HARNESS_MODEL_FAILED', message: 'connection interrupted' },
            usage: null,
          },
  });
  expect(requests.map((r) => r.type)).toEqual([
    'measure_context',
    'model',
    'answer',
    'model_next',
    'finish',
  ]);
  expect(requests[2]).toMatchObject({ delta: '已接受的进度' });
  expect(requests[3]).toMatchObject({ model_ref: requests[1]!.request_ref });
  expect(requests.at(-1)).toMatchObject({
    outcome: 'failed',
    usage: { iterations: 1, tokens: null },
  });
}, 30_000);

test('R2-A unknown usage on an earlier request is not replaced with a last-known balance', async () => {
  const messageId = randomUUID();
  const requests = await nativeCase({
    start: {
      messages: [{ message_id: messageId, role: 'user', content: 'Keep the original input.' }],
      snapshot: {
        version: 2,
        message_refs: [messageId],
        tool_refs: [],
        next_call_no: 1,
        usage: { iterations: 2, tokens: null },
        waiting: null,
      },
    },
    model: () => ({
      type: 'failed',
      error: { code: 'HARNESS_MODEL_FAILED', message: 'interrupted' },
      usage: { total_tokens: 3 },
    }),
  });
  expect(requests[0]).toMatchObject({ remaining_tokens: null });
  expect(requests[1]).toMatchObject({ remaining_tokens: null });
  expect(requests.at(-1)).toMatchObject({ usage: { iterations: 3, tokens: null } });
}, 30_000);

test('R2-A six large reads project oldest real pairs only after complete new observations were visible', async () => {
  const ids: string[] = [];
  const payloads = new Map<string, unknown>();
  const content = '界'.repeat(66000);
  const requests = await nativeCase({
    start: {
      workspace: {
        workspace_id: 'documents',
        label: 'All six sources are writable',
        readable_paths: Array.from({ length: 6 }, (_, index) => `${index}.txt`),
        writable_paths: Array.from({ length: 6 }, (_, index) => `${index}.txt`),
      },
      budget: { max_iterations: 12, max_tokens: 1000 },
      tools: ['workspace_read', 'read_run_observation'].map((name) => ({
        name,
        description: 'Read accepted data.',
        parameters: {},
        risk: 'low',
      })),
    },
    model: (_, index) =>
      index < 6
        ? {
            type: 'complete',
            reply: {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: `provider-${index}`,
                    type: 'function',
                    function: {
                      name: 'workspace_read',
                      arguments: JSON.stringify({ path: `${index}.txt` }),
                    },
                  },
                ],
              },
              usage: { total_tokens: 1 },
            },
          }
        : index === 6
          ? { type: 'delta', delta: 'done' }
          : {
              type: 'complete',
              reply: { message: { content: 'done', tool_calls: [] }, usage: { total_tokens: 1 } },
            },
    handle: (request) => {
      if (request.type === 'reserve') {
        const invocationId = randomUUID();
        ids.push(invocationId);
        return { invocation_id: invocationId };
      }
      if (request.type === 'invoke') {
        const result = {
          kind: 'read',
          path: request.args.path,
          version: 'a'.repeat(64),
          byte_length: Buffer.byteLength(content),
          content,
        };
        payloads.set(request.invocation_id, result);
        return { status: 'ok', result, invocationId: request.invocation_id, replayed: false };
      }
      const index = ids.indexOf(request.invocation_id);
      return {
        view: 'projected',
        invocation_id: request.invocation_id,
        tool_id: 'workspace_read',
        outcome: 'ok',
        source: {
          result_version: 1,
          omitted: true,
          kind: 'read',
          path: `${index}.txt`,
          version: 'a'.repeat(64),
          byte_length: Buffer.byteLength(content),
          content_total: 66000,
        },
      };
    },
  });
  const models = requests.filter((r) => r.type === 'model');
  expect(models).toHaveLength(7);
  const sources = requests.filter((r) => r.type === 'context_source');
  expect(sources.length).toBeGreaterThan(0);
  expect(sources.map((r) => r.invocation_id)).toEqual(ids.slice(0, sources.length));
  for (let index = 1; index < models.length; index++) {
    const messages = models[index]!.messages;
    const tool = messages
      .filter((m) => m.role === 'tool')
      .find((m) => m.tool_call_id === `provider-${index - 1}`)!;
    expect(JSON.parse(tool.content).result.content).toBe(content);
    for (let position = 0; position < messages.length; position++) {
      const message = messages[position]!;
      if (message.role === 'tool')
        expect(messages[position - 1]).toMatchObject({
          role: 'assistant',
          tool_calls: [{ id: message.tool_call_id }],
        });
      if ('tool_calls' in message)
        expect(messages[position + 1]).toMatchObject({
          role: 'tool',
          tool_call_id: message.tool_calls[0]!.id,
        });
    }
    expect(Buffer.byteLength(JSON.stringify(models[index]))).toBeLessThanOrEqual(1048576);
  }
  expect(payloads.size).toBe(6);
  const checkpoint = requests.find((r) => r.type === 'snapshot');
  expect(checkpoint!.context.tool_refs).toEqual(ids);
  expect(checkpoint!.context.next_call_no).toBe(7);
  expect(checkpoint!.context.version).toBe(2);
  expect(payloads.get(ids[0]!)).toMatchObject({ content });
  expect(requests.at(-1)).toMatchObject({ usage: { iterations: 7, tokens: 7 } });
}, 30_000);

test('R2-A protected complete new observation that cannot fit is never erased before visibility', async () => {
  const invocationId = randomUUID();
  const requests = await nativeCase({
    start: {
      messages: [{ message_id: randomUUID(), role: 'user', content: 'x'.repeat(860000) }],
      tools: ['workspace_read', 'read_run_observation'].map((name) => ({
        name,
        description: 'Read accepted data.',
        parameters: {},
        risk: 'low',
      })),
    },
    model: () => ({
      type: 'complete',
      reply: {
        message: {
          content: null,
          tool_calls: [
            {
              id: 'provider-only',
              type: 'function',
              function: { name: 'workspace_read', arguments: '{}' },
            },
          ],
        },
        usage: { total_tokens: 1 },
      },
    }),
    handle: (request) =>
      request.type === 'reserve'
        ? { invocation_id: invocationId }
        : {
            status: 'ok',
            result: {
              kind: 'read',
              path: 'source.txt',
              version: 'a'.repeat(64),
              byte_length: 198000,
              content: 'a'.repeat(198000),
            },
            invocationId,
            replayed: false,
          },
  });
  expect(requests.filter((r) => r.type === 'model')).toHaveLength(1);
  expect(requests.filter((r) => r.type === 'context_source')).toHaveLength(0);
  expect(requests.at(-1)).toMatchObject({
    error: { code: 'HARNESS_CONTEXT_LIMIT' },
    usage: { iterations: 1, tokens: 1 },
  });
}, 30_000);

test('R2-A old Run without retrieval keeps its only full observation and fails rather than dropping it', async () => {
  const messageId = randomUUID();
  const invocationId = randomUUID();
  const requests = await nativeCase({
    start: {
      messages: [{ message_id: messageId, role: 'user', content: 'x'.repeat(660000) }],
      tools: [
        { name: 'workspace_read', description: 'Original allowlist.', parameters: {}, risk: 'low' },
      ],
      snapshot: {
        version: 2,
        message_refs: [messageId],
        tool_refs: [invocationId],
        next_call_no: 2,
        usage: { iterations: 1, tokens: 1 },
        waiting: null,
      },
      observations: [
        {
          view: 'full',
          invocation_id: invocationId,
          tool_id: 'workspace_read',
          result: {
            status: 'ok',
            result: {
              kind: 'read',
              path: 'source.txt',
              version: 'a'.repeat(64),
              byte_length: 100000,
              content: '"'.repeat(100000),
            },
          },
        },
      ],
    },
    model: () => {
      throw new Error('unretrievable observation was illegally omitted');
    },
  });
  expect(requests.map((r) => r.type)).toEqual(['finish']);
  expect(requests[0]).toMatchObject({
    error: { code: 'HARNESS_CONTEXT_LIMIT' },
    usage: { iterations: 1, tokens: 1 },
  });
}, 30_000);

test('R2-A window boundary remeasures changed O without an extra model request', async () => {
  const requests = await nativeCase({
    start: { context_policy: { ...policy, model_window_tokens: 100, reserve_tokens: 5 } },
    measure: () => ({
      wire_bytes: 1024,
      http_bytes: 2048,
      input_meter: { quality: 'verified', input_tokens: 85, meter_revision: 'fixture/v1' },
      output_ceiling: 10,
      limit_reason: null,
    }),
    model: () => ({
      type: 'failed',
      error: { code: 'HARNESS_MODEL_FAILED', message: 'end' },
      usage: { total_tokens: 95 },
    }),
  });
  expect(requests.map((r) => r.type)).toEqual([
    'measure_context',
    'measure_context',
    'model',
    'finish',
  ]);
  expect(
    requests.filter((r) => r.type === 'measure_context').map((r) => r.max_output_tokens),
  ).toEqual([37, 10]);
  expect(requests.find((r) => r.type === 'model')!.max_output_tokens).toBe(10);
  expect(requests.at(-1)).toMatchObject({ usage: { iterations: 1, tokens: 95 } });
}, 30_000);

test('R2-A bounded approval recovery keeps every source reference and original waiting identity', async () => {
  const messageId = randomUUID();
  const approvalId = randomUUID();
  const refs = Array.from({ length: 7 }, () => randomUUID());
  const observations = refs.slice(0, 6).map((id, index) => ({
    view: 'projected',
    invocation_id: id,
    tool_id: 'workspace_read',
    outcome: 'ok',
    source: {
      kind: 'read',
      result_version: 1,
      omitted: true,
      path: `${index}.txt`,
      version: 'a'.repeat(64),
      byte_length: 200000,
      content_total: 200000,
    },
  }));
  const pendingId = refs[6]!;
  const receipt = {
    view: 'full',
    invocation_id: pendingId,
    tool_id: 'workspace_propose_replace',
    result: {
      status: 'ok',
      result: {
        kind: 'document_approval',
        approval: {
          kind: 'document_replace',
          approval_id: approvalId,
          run_id: randomUUID(),
          conversation_id: randomUUID(),
          workspace_id: 'documents',
          relative_path: 'target.txt',
          base_read_invocation_id: refs[0],
          base_version: 'a'.repeat(64),
          new_version: 'b'.repeat(64),
          exact_new_content: 'approved target',
          presentation_version: 'document_replace.v1',
          presentation_hash: 'c'.repeat(64),
          preview: { before: 'before', after: 'after', body: 'preview' },
          replaces_approval_id: null,
        },
      },
    },
  };
  const requests = await nativeCase({
    start: {
      messages: [
        { message_id: messageId, role: 'user', content: 'Continue exactly the original approval.' },
      ],
      tools: [
        {
          name: 'read_run_observation',
          description: 'Read prior observations.',
          parameters: {},
          risk: 'low',
        },
      ],
      budget: { max_iterations: 12, max_tokens: 1000 },
      observations: [...observations, receipt],
      snapshot: {
        version: 2,
        message_refs: [messageId],
        tool_refs: refs,
        next_call_no: 8,
        usage: { iterations: 7, tokens: 7 },
        waiting: { invocation_id: pendingId, approval_id: approvalId },
      },
      approval: {
        kind: 'document',
        approval_id: approvalId,
        status: 'approved',
        apply_invocation_id: null,
      },
    },
    handle: (request) => {
      if (request.type !== 'context_source') throw new Error('recovery repeated a tool action');
      return {
        view: 'full',
        invocation_id: request.invocation_id,
        tool_id: 'workspace_read',
        result: {
          status: 'ok',
          result: {
            kind: 'read',
            path: `${refs.findIndex((id) => id === request.invocation_id)}.txt`,
            version: 'a'.repeat(64),
            byte_length: 200000,
            content: 'x'.repeat(200000),
          },
        },
      };
    },
    model: (_, index) =>
      index === 0
        ? { type: 'delta', delta: 'accepted' }
        : {
            type: 'complete',
            reply: { message: { content: 'accepted', tool_calls: [] }, usage: { total_tokens: 1 } },
          },
  });
  const checkpoint = requests.find((r) => r.type === 'snapshot')!;
  expect(checkpoint.context).toMatchObject({
    version: 2,
    tool_refs: refs,
    next_call_no: 8,
    message_refs: [messageId],
    usage: { iterations: 8, tokens: 8 },
    waiting: null,
  });
  const model = requests.find((r) => r.type === 'model')!;
  expect(model.remaining_tokens).toBe(993);
  expect(JSON.stringify(model.messages)).toContain(approvalId);
  expect(JSON.stringify(model.messages)).toContain(pendingId);
  expect(requests.filter((r) => r.type === 'reserve' || r.type === 'invoke')).toEqual([]);
}, 30_000);

test('R2-A a full 64-reference snapshot rejects a new tool call before reservation or effects', async () => {
  const messageId = randomUUID();
  const refs = Array.from({ length: 64 }, () => randomUUID());
  const requests = await nativeCase({
    start: {
      messages: [
        { message_id: messageId, role: 'user', content: 'Keep every accepted reference.' },
      ],
      tools: [
        { name: 'workspace_read', description: 'Read original data.', parameters: {}, risk: 'low' },
      ],
      budget: { max_iterations: 100, max_tokens: 1000 },
      observations: refs.map((id, index) => ({
        view: 'full',
        invocation_id: id,
        tool_id: 'workspace_read',
        result: {
          status: 'ok',
          result: {
            kind: 'read',
            path: `${index}.txt`,
            version: 'a'.repeat(64),
            byte_length: 1,
            content: 'x',
          },
        },
      })),
      snapshot: {
        version: 2,
        message_refs: [messageId],
        tool_refs: refs,
        next_call_no: 65,
        usage: { iterations: 64, tokens: 64 },
        waiting: null,
      },
    },
    model: () => ({
      type: 'complete',
      reply: {
        message: {
          content: null,
          tool_calls: [
            {
              id: 'provider-65',
              type: 'function',
              function: { name: 'workspace_read', arguments: '{"path":"new.txt"}' },
            },
          ],
        },
        usage: { total_tokens: 1 },
      },
    }),
    handle: () => {
      throw new Error('capacity exhaustion reached a new tool action');
    },
  });
  expect(requests.map((request) => request.type)).toEqual(['measure_context', 'model', 'finish']);
  expect(requests.at(-1)).toMatchObject({
    outcome: 'failed',
    error: { code: 'HARNESS_CONTEXT_LIMIT' },
    usage: { iterations: 65, tokens: 65 },
  });
}, 30_000);

const routeIntents = ['task_list_bounded', 'prefs_timezone_read', 'brief_cards_read'] as const;
type RouteIntent = (typeof routeIntents)[number];
const routeTools = {
  task_list_bounded: 'list_tasks',
  prefs_timezone_read: 'get_user_prefs',
  brief_cards_read: 'read_brief_cards',
};
function routingPolicy(mode: 'shadow' | 'enforce' = 'enforce') {
  return {
    revision: 'r2b/1',
    mode,
    bundle_sha256: 'a'.repeat(64),
    encoding_sha256: 'b'.repeat(64),
    candidate_intents: [...routeIntents],
    direct_intents: mode === 'shadow' ? [] : [...routeIntents],
    competition: [...routeIntents, 'other_query'],
    thresholds: Object.fromEntries(
      routeIntents.map((intent) => [intent, { tau_intent: 0.8, tau_gap: 0.1 }]),
    ),
    deadline_ms: 1000,
    max_inflight: 2,
    guard_revision: 'guard/1',
    parser_revision: 'parser/1',
    handler_revision: 'handler/1',
    renderer_revision: 'renderer/1',
    scorer_revision: 'scorer/1',
  };
}
async function routingCase(options: {
  intent?: RouteIntent;
  embedding?: boolean;
  mode?: 'shadow' | 'enforce';
  scores?: { intent: string; score: number; exclusion_score: number | null }[];
  reason?: string;
  status?: 'ok' | 'denied' | 'failed' | 'unknown';
  start?: Record<string, unknown>;
  rejectAt?: HarnessRequest['type'];
  malformedBinding?: boolean;
  eligible?: boolean;
  resumed?: boolean;
  cancelAt?: HarnessRequest['type'];
  directDisabled?: boolean;
  cancelEmbedding?: boolean;
  protocolError?: boolean;
}) {
  const intent = options.intent ?? 'prefs_timezone_read';
  const tool = routeTools[intent];
  const id = randomUUID(),
    decisionRef = randomUUID(),
    factsRef = randomUUID(),
    messageId = randomUUID();
  const args =
    intent === 'task_list_bounded'
      ? { limit: 20 }
      : intent === 'brief_cards_read'
        ? { date: '2026-10-31' }
        : {};
  const policy = routingPolicy(options.mode);
  if (options.directDisabled) policy.direct_intents = [];
  return nativeCase({
    start: {
      routing_policy: policy,
      eligible_phase: 'fresh_first_step',
      messages: [
        { message_id: messageId, role: 'user', content: 'Keep the complete frozen input.' },
      ],
      ...(options.resumed
        ? {
            snapshot: {
              version: 2,
              message_refs: [messageId],
              tool_refs: [],
              next_call_no: 1,
              usage: { iterations: 1, tokens: null },
              waiting: null,
            },
          }
        : {}),
      tools: [
        { name: tool, description: 'Original read-only capability', parameters: {}, risk: 'low' },
      ],
      ...options.start,
    },
    expectedExit: options.malformedBinding || options.protocolError ? 2 : 0,
    reject: (request) => (request.type === options.rejectAt ? 'CONTROLLED_FAILURE' : null),
    cancel: (request) =>
      request.type === options.cancelAt ||
      !!(
        options.cancelEmbedding &&
        request.type === 'route_probe' &&
        request.stage === 'embedding'
      ),
    model: () => ({
      type: 'failed',
      error: { code: 'MODEL_FALLBACK_OBSERVED', message: 'controlled model request' },
      usage: { total_tokens: 7 },
    }),
    route: (request) => {
      if (request.type === 'route_probe') {
        if (request.stage === 'facts') {
          expect(request.facts_ref).toBeNull();
          return {
            facts_ref: factsRef,
            input_sha256: 'c'.repeat(64),
            bundle_sha256: policy.bundle_sha256,
            eligible: options.eligible ?? true,
            reason: options.eligible === false ? 'CONTEXT_UNKNOWN' : null,
            rule_intent: options.embedding || options.eligible === false ? null : intent,
            candidates: [{ intent, tool_id: tool, args, sources: [] }],
          };
        }
        expect(request.facts_ref).toBe(factsRef);
        return {
          facts_ref: options.malformedBinding ? randomUUID() : factsRef,
          input_sha256: 'c'.repeat(64),
          bundle_sha256: policy.bundle_sha256,
          reason: options.reason ?? null,
          scores:
            options.scores ??
            policy.competition.map((candidate) => ({
              intent: candidate,
              score: candidate === intent ? 0.92 : 0.3,
              exclusion_score: 0.1,
            })),
        };
      }
      if (request.type === 'route_decide') {
        expect(request.facts_ref).toBe(factsRef);
        return request.decision === 'direct'
          ? { decision_ref: decisionRef, decision: 'direct', intent, tool_id: tool, args }
          : {
              decision_ref: decisionRef,
              decision: 'fallback',
              intent: null,
              tool_id: null,
              args: null,
            };
      }
      expect(request).toMatchObject({
        type: 'render_route_result',
        decision_ref: decisionRef,
        invocation_ref: id,
        template_revision: policy.renderer_revision,
      });
      return { rendered: true };
    },
    handle: (request) => {
      if (request.type === 'reserve') {
        expect(request).toMatchObject({ call_key: 'harness/1', tool_id: tool, args });
        return { invocation_id: id };
      }
      if (request.type !== 'invoke') throw new Error('direct must not retrieve context');
      expect(request).toMatchObject({ invocation_id: id, tool_id: tool, args });
      const status = options.status ?? 'ok';
      if (status !== 'ok')
        return {
          status,
          invocationId: id,
          replayed: false,
          error: { code: 'READ_FAILED', message: 'actual gateway failure' },
        };
      const result =
        intent === 'task_list_bounded'
          ? { kind: 'list_tasks', tasks: [], has_more: false }
          : intent === 'prefs_timezone_read'
            ? {
                kind: 'prefs',
                timezone_id: null,
                alias_version: 'fixture',
                quiet_hours: null,
                locale: null,
              }
            : { kind: 'brief', brief_id: 'fixture', date: '2026-10-31', cards: [] };
      return { status, invocationId: id, replayed: false, result };
    },
  });
}
for (const intent of routeIntents) {
  test(`R2-B rule direct ${intent} invokes original tool and renders after snapshot with zero model usage`, async () => {
    const requests = await routingCase({ intent });
    expect(requests.map((request) => request.type)).toEqual([
      'route_probe',
      'route_decide',
      'reserve',
      'invoke',
      'snapshot',
      'render_route_result',
      'finish',
    ]);
    expect(requests.at(-1)).toMatchObject({ outcome: 'done', usage: { iterations: 0, tokens: 0 } });
    expect(requests.find((request) => request.type === 'snapshot')).toMatchObject({
      context: { version: 2, next_call_no: 2, usage: { iterations: 0, tokens: 0 } },
    });
  }, 30_000);
}
test('R2-B embedding direct probes once and never fabricates provider calls or native answer', async () => {
  const requests = await routingCase({ embedding: true });
  expect(requests.map((request) => request.type)).toEqual([
    'route_probe',
    'route_probe',
    'route_decide',
    'reserve',
    'invoke',
    'snapshot',
    'render_route_result',
    'finish',
  ]);
  expect(requests.at(-1)).toMatchObject({ outcome: 'done', usage: { iterations: 0, tokens: 0 } });
}, 30_000);
for (const refusal of [
  'tie',
  'veto',
  'no_exclusion',
  'absolute',
  'gap',
  'outside',
  'encoder_refusal',
] as const) {
  test(`R2-B ${refusal} records one fallback then uses the unchanged model path`, async () => {
    const scores = routingPolicy().competition.map((intent) => ({
      intent,
      score: intent === 'prefs_timezone_read' ? 0.92 : 0.3,
      exclusion_score: 0.1 as number | null,
    }));
    if (refusal === 'tie') scores[0]!.score = 0.92;
    if (refusal === 'veto') scores[1]!.exclusion_score = 0.92;
    if (refusal === 'no_exclusion') scores[1]!.exclusion_score = null;
    if (refusal === 'absolute') scores[1]!.score = 0.79;
    if (refusal === 'gap') scores[0]!.score = 0.85;
    if (refusal === 'outside') scores[3]!.score = 0.99;
    const requests = await routingCase({
      embedding: true,
      scores,
      reason: refusal === 'encoder_refusal' ? 'ENCODER_UNAVAILABLE' : undefined,
    });
    expect(requests.map((request) => request.type)).toEqual([
      'route_probe',
      'route_probe',
      'route_decide',
      'measure_context',
      'model',
      'finish',
    ]);
    expect(requests[2]).toMatchObject({ decision: 'fallback' });
    expect(requests.at(-1)).toMatchObject({ usage: { iterations: 1, tokens: 7 } });
  }, 30_000);
}
for (const embedding of [false, true]) {
  test(`R2-B shadow ${embedding ? 'embedding' : 'rule'} never reserves a tool`, async () => {
    const requests = await routingCase({ mode: 'shadow', embedding });
    expect(requests.filter((request) => request.type === 'route_decide')).toHaveLength(1);
    expect(requests.find((request) => request.type === 'route_decide')).toMatchObject({
      decision: 'fallback',
    });
    expect(
      requests.some(
        (request) => request.type === 'reserve' || request.type === 'render_route_result',
      ),
    ).toBe(false);
    expect(requests.some((request) => request.type === 'model')).toBe(true);
  }, 30_000);
}
for (const start of [
  { routing_policy: null },
  { routing_policy: { revision: 'r2b/1', mode: 'off' } },
  { eligible_phase: 'disabled' },
]) {
  test(`R2-B off, old or disabled phase never probes: ${JSON.stringify(start)}`, async () => {
    const requests = await routingCase({ start });
    expect(requests.map((request) => request.type)).toEqual(['measure_context', 'model', 'finish']);
  }, 30_000);
}
for (const rejectAt of ['reserve', 'invoke', 'snapshot', 'render_route_result'] as const) {
  test(`R2-B accepted direct ${rejectAt} failure cannot switch to model or a second slot`, async () => {
    const requests = await routingCase({ rejectAt });
    expect(requests.filter((request) => request.type === 'reserve').length).toBeLessThanOrEqual(1);
    expect(requests.some((request) => request.type === 'model' || request.type === 'answer')).toBe(
      false,
    );
    expect(requests.at(-1)).toMatchObject({
      outcome: 'failed',
      error: { code: 'CONTROLLED_FAILURE' },
      usage: { iterations: 0, tokens: 0 },
    });
  }, 30_000);
}
for (const status of ['denied', 'failed', 'unknown'] as const) {
  test(`R2-B accepted direct ${status} retains original failure without rendering or fallback`, async () => {
    const requests = await routingCase({ status });
    expect(
      requests.some(
        (request) => request.type === 'model' || request.type === 'render_route_result',
      ),
    ).toBe(false);
    expect(requests.filter((request) => request.type === 'reserve')).toHaveLength(1);
    expect(requests.at(-1)).toMatchObject({
      outcome: 'failed',
      error: {
        code: status === 'unknown' ? 'TOOL_EFFECT_UNKNOWN' : 'READ_FAILED',
      },
    });
    expect(requests.some((request) => request.type === 'snapshot')).toBe(status !== 'unknown');
  }, 30_000);
}
test('R2-B corrupted embedding reference stops rather than disguising it as refusal', async () => {
  const requests = await routingCase({ embedding: true, malformedBinding: true });
  expect(requests.map((request) => request.type)).toEqual(['route_probe', 'route_probe']);
}, 30_000);
test('R2-B ineligible facts record fallback without probing embedding', async () => {
  const requests = await routingCase({ eligible: false });
  expect(requests.map((request) => request.type)).toEqual([
    'route_probe',
    'route_decide',
    'measure_context',
    'model',
    'finish',
  ]);
}, 30_000);
test('R2-B enforce operator subset does not execute a disabled intent', async () => {
  const requests = await routingCase({ directDisabled: true });
  expect(requests.find((request) => request.type === 'route_decide')).toMatchObject({
    decision: 'fallback',
    candidate_intent: null,
  });
  expect(requests.some((request) => request.type === 'reserve')).toBe(false);
}, 30_000);
test('R2-B a restored snapshot never probes even if fresh phase is mistakenly supplied', async () => {
  const requests = await routingCase({ resumed: true });
  expect(requests.map((request) => request.type)).toEqual(['measure_context', 'model', 'finish']);
  expect(requests.at(-1)).toMatchObject({ usage: { iterations: 2, tokens: null } });
}, 30_000);
for (const cancelAt of [
  'route_probe',
  'route_decide',
  'reserve',
  'invoke',
  'snapshot',
  'render_route_result',
] as const) {
  test(`R2-B accepted cancellation at ${cancelAt} stops without later actions or terminal replay`, async () => {
    const requests = await routingCase({ cancelAt });
    expect(requests.at(-1)?.type).toBe(cancelAt);
    expect(requests.some((request) => request.type === 'model' || request.type === 'finish')).toBe(
      false,
    );
  }, 30_000);
}
test('R2-B cancellation while embedding is outstanding cannot accept late scores', async () => {
  const requests = await routingCase({ embedding: true, cancelEmbedding: true });
  expect(requests.map((request) => request.type)).toEqual(['route_probe', 'route_probe']);
}, 30_000);
for (const rejectAt of ['route_probe', 'route_decide'] as const) {
  test(`R2-B ${rejectAt} authority failure stops rather than treating DB or qualification errors as a miss`, async () => {
    const requests = await routingCase({ rejectAt });
    expect(requests.some((request) => request.type === 'model' || request.type === 'reserve')).toBe(
      false,
    );
    expect(requests.at(-1)).toMatchObject({
      outcome: 'failed',
      error: { code: 'CONTROLLED_FAILURE' },
    });
  }, 30_000);
}
for (const malformed of ['incomplete', 'duplicate', 'nonfinite'] as const) {
  test(`R2-B ${malformed} competition evidence is a protocol error, not a fallback`, async () => {
    const scores = routingPolicy().competition.map((intent) => ({
      intent,
      score: intent === 'prefs_timezone_read' ? 0.92 : 0.3,
      exclusion_score: 0.1,
    }));
    if (malformed === 'incomplete') scores.pop();
    if (malformed === 'duplicate') scores.push(scores[0]!);
    if (malformed === 'nonfinite') scores[0]!.score = Infinity;
    const requests = await routingCase({ embedding: true, scores, protocolError: true });
    expect(requests.map((request) => request.type)).toEqual(['route_probe', 'route_probe']);
  }, 30_000);
}
