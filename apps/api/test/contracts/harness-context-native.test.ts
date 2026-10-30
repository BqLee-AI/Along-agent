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
    protocol: 'harness/v4',
    type: 'start',
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
          request.type === 'reserve' ||
          request.type === 'invoke' ||
          request.type === 'context_source'
        )
          value = options.handle?.(request);
        else value = { accepted: true };
        send({ protocol: 'harness/v4', type: 'reply', reply_to: request.request_ref, value });
      }
    }
    expect(await child.exited, await new Response(child.stderr).text()).toBe(0);
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
