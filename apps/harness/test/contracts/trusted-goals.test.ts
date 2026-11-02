import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';

type Request = { protocol: string; type: string; request_ref: string; [key: string]: unknown };
type Model = {
  content: string | null;
  tool_calls: unknown[];
  usage?: { total_tokens: number } | null;
};
const inputId = randomUUID();
const trusted = {
  version: 1,
  authorization_revision: 'delegation/1',
  execution_lifecycle: 'request-bound',
  input_message_id: inputId,
  received_at_utc: '2026-11-02T12:00:00Z',
  request_anchor_utc: '2026-11-02T12:00:00Z',
  continuation: null,
  timezone: { timezone_id: 'America/New_York', source: 'preference', reference: inputId },
  time_capabilities: { elapsed_revision: null, wall_rules: null },
  workspaces: [],
};
const policy = {
  revision: 'r2a/1',
  completion_cap: 256,
  model_window_tokens: null,
  input_meter: 'unavailable',
  meter_revision: 'unavailable/1',
  reserve_tokens: 0,
  model_binding: { model: 'controlled-native', adapter_revision: 'openai-chat/v1' },
};
const timezoneTool = {
  name: 'set_user_timezone',
  description: 'Save or clear the personal default timezone.',
  parameters: {
    type: 'object',
    properties: { timezone_id: { type: ['string', 'null'] } },
    required: ['timezone_id'],
    additionalProperties: false,
  },
  risk: 'low',
};
const observationTool = {
  name: 'read_run_observation',
  description: 'Read a page from an accepted invocation in this Run.',
  parameters: {
    type: 'object',
    properties: {
      source_invocation_id: { type: 'string', format: 'uuid' },
      field: { type: 'string', enum: ['content', 'entries', 'matches', 'failures'] },
      offset: { type: 'integer', minimum: 0 },
      limit: { type: 'integer', minimum: 1 },
    },
    required: ['source_invocation_id', 'field', 'offset', 'limit'],
    additionalProperties: false,
  },
  risk: 'low',
};
const call = (name: string, args: unknown): Model => ({
  content: null,
  tool_calls: [
    {
      id: `provider-${randomUUID()}`,
      type: 'function',
      function: { name, arguments: JSON.stringify(args) },
    },
  ],
});
const goal = (refs: string[] = []) => ({
  status: 'completed',
  outcomes: [{ description: 'Requested result', status: 'achieved', receipt_refs: refs }],
  clarification: null,
  answer: '已完成所要求的操作。',
});

// Raw frames intentionally bypass shared start/result schemas: these cases exercise
// the compiled native consumer, not a TypeScript preflight rejection or fake harness.
async function nativeCase(options: {
  start?: Record<string, unknown>;
  model?: (request: Request, index: number) => Model;
  invoke?: (request: Request) => unknown;
  cancel?: (request: Request) => boolean;
  expectedExit?: number;
}) {
  const binary = process.env.HARNESS_BINARY;
  if (!binary) throw new Error('Requires HARNESS_BINARY from the current production native build');
  const child = Bun.spawn([binary], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      LD_LIBRARY_PATH: process.env.HARNESS_LIBRARY_PATH ?? process.env.LD_LIBRARY_PATH,
    },
  });
  const requests: Request[] = [];
  const send = (value: unknown) => child.stdin.write(`${JSON.stringify(value)}\n`);
  const start = {
    protocol: 'harness/v6',
    type: 'start',
    trusted_context: trusted,
    routing_policy: { revision: 'r2b/1', mode: 'off' },
    eligible_phase: 'disabled',
    context_policy: policy,
    messages: [{ message_id: inputId, role: 'user', content: '保存上海时区，然后清除默认时区。' }],
    tools: [timezoneTool],
    budget: { max_iterations: 6, max_tokens: 1000 },
    snapshot: null,
    observations: [],
    approval: null,
    ...options.start,
  };
  send(start);
  let pending = '';
  let index = 0;
  let terminal: unknown;
  const decoder = new TextDecoder();
  try {
    for await (const chunk of child.stdout) {
      pending += decoder.decode(chunk, { stream: true });
      for (;;) {
        const newline = pending.indexOf('\n');
        if (newline < 0) break;
        const request = JSON.parse(pending.slice(0, newline)) as Request;
        pending = pending.slice(newline + 1);
        expect(request.protocol).toBe('harness/v6');
        requests.push(request);
        if (options.cancel?.(request)) {
          send({
            protocol: 'harness/v6',
            type: 'cancel',
            reason: 'already committed cancellation',
          });
          continue;
        }
        let value: unknown;
        switch (request.type) {
          case 'measure_context':
            value = {
              wire_bytes: 1024,
              http_bytes: 2048,
              input_meter: {
                quality: 'unavailable',
                input_tokens: null,
                meter_revision: 'unavailable/1',
              },
              output_ceiling: 256,
              limit_reason: null,
            };
            break;
          case 'model': {
            if (!options.model) throw new Error('Unexpected model request');
            const response = options.model(request, index++);
            terminal = {
              type: 'complete',
              reply: {
                message: { content: response.content, tool_calls: response.tool_calls },
                usage: response.usage === undefined ? { total_tokens: 5 } : response.usage,
              },
            };
            value = response.content ? { type: 'delta', delta: response.content } : terminal;
            break;
          }
          case 'model_next':
            value = terminal;
            break;
          case 'snapshot':
            value = { checkpoint_ref: randomUUID() };
            break;
          case 'reserve':
            value = { invocation_id: randomUUID() };
            break;
          case 'invoke':
            value = options.invoke?.(request) ?? {
              status: 'ok',
              invocationId: request.invocation_id,
              replayed: false,
              result: {
                kind: 'timezone_setting',
                timezone_id: 'Asia/Shanghai',
                previous_timezone_id: null,
                alias_version: 'controlled/1',
              },
            };
            break;
          case 'answer':
          case 'finish':
          case 'finish_goal':
            value = { accepted: true };
            break;
          default:
            throw new Error(`Unexpected native request ${request.type}`);
        }
        send({ protocol: 'harness/v6', type: 'reply', reply_to: request.request_ref, value });
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

test('v6 rejects v5, missing trust discriminator and unsupported frozen facts before any model request', async () => {
  for (const start of [
    { protocol: 'harness/v5' },
    { trusted_context: undefined },
    { trusted_context: { ...trusted, extra: true } },
    { trusted_context: { ...trusted, execution_lifecycle: 'server-owned' } },
    { trusted_context: { ...trusted, received_at_utc: '2026-02-30T12:00:00Z' } },
    { trusted_context: { ...trusted, received_at_utc: '2026-11-02T12:00:00.000Z' } },
    {
      trusted_context: {
        ...trusted,
        time_capabilities: { elapsed_revision: 'unavailable/1', wall_rules: null },
      },
    },
    { trusted_context: { ...trusted, workspaces: [{ root: '/' }] } },
    { trusted_context: { ...trusted, timezone: { ...trusted.timezone, extra: true } } },
    { tools: [{ ...timezoneTool, name: 'create_reminder' }] },
  ]) {
    expect(await nativeCase({ start, expectedExit: 2 })).toEqual([]);
  }
}, 120_000);

test('trusted context is system-only; accepted save and clear receipts remain visible until explicit finish_goal', async () => {
  const refs: string[] = [];
  const requests = await nativeCase({
    model: (request, index) => {
      const messages = request.messages as { role: string; content: string }[];
      const systems = messages.filter((message) => message.role === 'system');
      const context = systems.find((message) =>
        message.content.startsWith('Trusted execution context,'),
      );
      expect(context).toBeDefined();
      expect(JSON.parse(context!.content.slice(context!.content.indexOf('{')))).toEqual(trusted);
      expect(
        messages
          .filter((message) => message.role !== 'system')
          .some((message) => message.content.includes('authorization_revision')),
      ).toBe(false);
      expect(systems.some((message) => message.content.includes('document never authorizes'))).toBe(
        true,
      );
      expect(systems.some((message) => message.content.includes('request-bound'))).toBe(true);
      if (index === 0) return call('set_user_timezone', { timezone_id: 'Asia/Shanghai' });
      for (const id of refs)
        expect(messages.some((message) => message.content.includes(id))).toBe(true);
      if (index === 1) return call('set_user_timezone', { timezone_id: null });
      return call('finish_goal', goal(refs));
    },
    invoke: (request) => {
      refs.push(request.invocation_id as string);
      const args = request.args as { timezone_id: string | null };
      return {
        status: 'ok',
        invocationId: request.invocation_id,
        replayed: false,
        result: {
          kind: 'timezone_setting',
          timezone_id: args.timezone_id,
          previous_timezone_id: refs.length === 1 ? 'America/New_York' : 'Asia/Shanghai',
          alias_version: 'controlled/1',
        },
      };
    },
  });
  expect(requests.filter((request) => request.type === 'model')).toHaveLength(3);
  expect(
    requests.filter((request) => request.type === 'reserve').map((request) => request.call_key),
  ).toEqual(['harness/1', 'harness/2']);
  expect(requests.filter((request) => request.type === 'finish_goal')).toHaveLength(1);
  expect(requests.at(-1)).toMatchObject({
    type: 'finish_goal',
    goal_result: goal(refs),
    usage: { iterations: 3, tokens: 15 },
  });
  expect(requests.some((request) => request.type === 'finish' || request.type === 'suspend')).toBe(
    false,
  );
});

test('plain prose cannot silently mark delegation complete; original budget bounds structured correction', async () => {
  const requests = await nativeCase({
    model: (_request, index) =>
      index === 0 ? { content: '这是一条纯回答。', tool_calls: [] } : call('finish_goal', goal()),
  });
  expect(requests.filter((request) => request.type === 'model')).toHaveLength(2);
  expect(requests.at(-1)?.type).toBe('finish_goal');
  expect(requests.some((request) => request.type === 'reserve')).toBe(false);
  const exhausted = await nativeCase({
    start: { budget: { max_iterations: 1, max_tokens: 1000 } },
    model: () => ({ content: '尚未提交结构化结果。', tool_calls: [] }),
  });
  expect(exhausted.at(-1)).toMatchObject({
    type: 'finish',
    outcome: 'failed',
    error: { code: 'BUDGET_EXCEEDED' },
  });
});

test('native rejects invalid goals, unaccepted/provider receipt IDs, and contradictory aggregate statuses', async () => {
  for (const result of [
    { ...goal(), outcomes: [] },
    { ...goal(), extra: true },
    { ...goal(), status: 'partial' },
    { ...goal(), status: 'unknown' },
    { ...goal(), clarification: { kind: 'timezone', question: '哪个时区？' } },
    { ...goal(), outcomes: [{ description: 'Uncertain', status: 'unknown', receipt_refs: [] }] },
    {
      ...goal(),
      outcomes: [{ description: 'Forged', status: 'achieved', receipt_refs: [randomUUID()] }],
    },
    {
      ...goal(),
      outcomes: [
        { description: 'Provider ref', status: 'achieved', receipt_refs: ['provider-call-id'] },
      ],
    },
  ]) {
    const requests = await nativeCase({
      model: () => call('finish_goal', result),
      expectedExit: 2,
    });
    expect(
      requests.some((request) => request.type === 'reserve' || request.type === 'finish_goal'),
    ).toBe(false);
  }
}, 120_000);

test('accepted setting survives budget failure and unknown usage is never reset to zero', async () => {
  const requests = await nativeCase({
    start: { budget: { max_iterations: 1, max_tokens: 1000 } },
    model: () => ({ ...call('set_user_timezone', { timezone_id: 'Asia/Shanghai' }), usage: null }),
  });
  expect(requests.filter((request) => request.type === 'invoke')).toHaveLength(1);
  expect(requests.at(-1)).toMatchObject({
    type: 'finish',
    outcome: 'failed',
    usage: { iterations: 1, tokens: null },
    error: { code: 'BUDGET_EXCEEDED' },
  });
});

test('unknown effects stop without checkpoint/retry and cancellation produces no second terminal claim', async () => {
  const unknown = await nativeCase({
    model: () => call('set_user_timezone', { timezone_id: 'Asia/Shanghai' }),
    invoke: (request) => ({
      status: 'unknown',
      invocationId: request.invocation_id,
      replayed: false,
      error: { code: 'TOOL_EFFECT_UNKNOWN', message: 'indeterminate' },
    }),
  });
  expect(unknown.filter((request) => request.type === 'invoke')).toHaveLength(1);
  expect(
    unknown.some((request) => request.type === 'snapshot' || request.type === 'finish_goal'),
  ).toBe(false);
  expect(unknown.at(-1)).toMatchObject({
    type: 'finish',
    outcome: 'failed',
    error: { code: 'TOOL_EFFECT_UNKNOWN' },
  });
  const cancelled = await nativeCase({
    model: () => call('finish_goal', goal()),
    cancel: (request) => request.type === 'model',
  });
  expect(cancelled.map((request) => request.type)).toEqual(['measure_context', 'model']);
});

test('v6 null trusted context retains legacy answer/checkpoint/finish and cumulative snapshot budget', async () => {
  const requests = await nativeCase({
    start: { trusted_context: null, tools: [] },
    model: () => ({ content: '旧运行仍沿原合同结束。', tool_calls: [] }),
  });
  expect(requests.map((request) => request.type)).toEqual([
    'measure_context',
    'model',
    'answer',
    'model_next',
    'snapshot',
    'finish',
  ]);
  expect(requests.at(-1)).toMatchObject({
    type: 'finish',
    outcome: 'done',
    usage: { iterations: 1, tokens: 5 },
  });
  const exhausted = await nativeCase({
    start: {
      trusted_context: null,
      tools: [],
      budget: { max_iterations: 4, max_tokens: 1000 },
      snapshot: {
        version: 2,
        message_refs: [inputId],
        tool_refs: [],
        next_call_no: 3,
        usage: { iterations: 4, tokens: 30 },
        waiting: null,
      },
    },
  });
  expect(exhausted.map((request) => request.type)).toEqual(['finish']);
  expect(exhausted[0]).toMatchObject({
    usage: { iterations: 4, tokens: 30 },
    error: { code: 'BUDGET_EXCEEDED' },
  });
});

test('accepted setting bootstrap retains receipt refs and partial/blocked/unknown/cancelled remain distinct', async () => {
  const receipt = randomUUID();
  const snapshot = {
    version: 2,
    message_refs: [inputId],
    tool_refs: [receipt],
    next_call_no: 2,
    usage: { iterations: 1, tokens: 5 },
    waiting: null,
  };
  const observation = {
    view: 'full',
    invocation_id: receipt,
    tool_id: 'set_user_timezone',
    result: {
      status: 'ok',
      result: {
        kind: 'timezone_setting',
        timezone_id: 'Asia/Shanghai',
        previous_timezone_id: null,
        alias_version: 'controlled/1',
      },
    },
  };
  const completed = await nativeCase({
    start: { snapshot, observations: [observation] },
    model: (request) => {
      expect(
        (request.messages as { content: string }[]).some((message) =>
          message.content.includes(receipt),
        ),
      ).toBe(true);
      return call('finish_goal', goal([receipt]));
    },
  });
  expect(completed.at(-1)).toMatchObject({
    type: 'finish_goal',
    usage: { iterations: 2, tokens: 10 },
  });
  expect(
    completed.some((request) => request.type === 'reserve' || request.type === 'context_source'),
  ).toBe(false);
  const duplicate = await nativeCase({
    start: { snapshot, observations: [observation] },
    model: () => call('finish_goal', goal([receipt, receipt])),
    expectedExit: 2,
  });
  expect(duplicate.some((request) => request.type === 'finish_goal')).toBe(false);
  for (const status of ['partial', 'blocked', 'unknown', 'cancelled']) {
    const result = {
      status,
      outcomes: [
        ...(status === 'partial'
          ? [{ description: 'Answered the available facts', status: 'achieved', receipt_refs: [] }]
          : []),
        {
          description: 'Remaining requested item',
          status: status === 'unknown' ? 'unknown' : 'blocked',
          receipt_refs: [],
        },
      ],
      clarification:
        status === 'partial' || status === 'blocked'
          ? { kind: 'timezone', question: '本次使用哪个时区？' }
          : null,
      answer: '如实区分已知和未完成的结果。',
    };
    const requests = await nativeCase({ model: () => call('finish_goal', result) });
    expect(requests.at(-1)).toMatchObject({ type: 'finish_goal', goal_result: result });
    expect(requests.some((request) => request.type === 'reserve')).toBe(false);
  }
});

for (const code of ['TOOL_FORBIDDEN', 'TOOL_DENIED']) {
  for (const status of ['blocked', 'partial']) {
    test(`hard denial ${code} exposes feedback but blocks later business dispatch before ${status} finish_goal`, async () => {
      const receipts: string[] = [];
      const partial = status === 'partial';
      const result = {
        status,
        outcomes: [
          ...(partial
            ? [{ description: 'Saved Shanghai', status: 'achieved', receipt_refs: receipts }]
            : []),
          {
            description: 'Forbidden source and later setting not executed',
            status: 'blocked',
            receipt_refs: [],
          },
        ],
        clarification: null,
        answer: '权限拒绝后没有继续执行；保留已接受的真实结果。',
      };
      const requests = await nativeCase({
        start: { tools: [timezoneTool, observationTool] },
        model: (request, index) => {
          if (partial && index === 0)
            return call('set_user_timezone', { timezone_id: 'Asia/Shanghai' });
          const step = index - (partial ? 1 : 0);
          if (step === 0)
            return call('read_run_observation', {
              source_invocation_id: randomUUID(),
              field: 'content',
              offset: 0,
              limit: 10,
            });
          expect(
            (request.messages as { content: string }[]).some((message) =>
              message.content.includes(code),
            ),
          ).toBe(true);
          if (step === 1) return call('set_user_timezone', { timezone_id: 'America/New_York' });
          return call('finish_goal', result);
        },
        invoke: (request) => {
          if (request.tool_id === 'read_run_observation')
            return {
              status: 'denied',
              invocationId: request.invocation_id,
              replayed: false,
              error: { code, message: 'The referenced invocation is not authorized.' },
            };
          receipts.push(request.invocation_id as string);
          return {
            status: 'ok',
            invocationId: request.invocation_id,
            replayed: false,
            result: {
              kind: 'timezone_setting',
              timezone_id: 'Asia/Shanghai',
              previous_timezone_id: null,
              alias_version: 'controlled/1',
            },
          };
        },
      });
      const permitted = partial
        ? ['set_user_timezone', 'read_run_observation']
        : ['read_run_observation'];
      expect(
        requests.filter((request) => request.type === 'reserve').map((request) => request.tool_id),
      ).toEqual(permitted);
      expect(
        requests.filter((request) => request.type === 'invoke').map((request) => request.tool_id),
      ).toEqual(permitted);
      expect(requests.filter((request) => request.type === 'finish_goal')).toHaveLength(1);
      expect(requests.at(-1)).toMatchObject({ type: 'finish_goal', goal_result: result });
    });
  }
}

for (const code of ['UNKNOWN_TIMEZONE', 'TZDB_UNAVAILABLE']) {
  test(`${code} rule denial remains visible for blocked completion while legacy denial still stops immediately`, async () => {
    const prefsTool = {
      name: 'get_user_prefs',
      description: 'Read the saved default timezone.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      risk: 'low',
    };
    const result = {
      status: 'blocked',
      outcomes: [
        {
          description: 'Unsupported timezone, original unchanged',
          status: 'blocked',
          receipt_refs: [],
        },
      ],
      clarification: null,
      answer: '不支持 Atlantis/Mars，原默认时区未更改。',
    };
    const invoke = (request: Request) => ({
      status: 'denied',
      invocationId: request.invocation_id,
      replayed: false,
      error: { code, message: 'Timezone unavailable or unsupported; original unchanged.' },
    });
    const requests = await nativeCase({
      start: { tools: [timezoneTool, prefsTool] },
      model: (request, index) => {
        if (index === 0) return call('set_user_timezone', { timezone_id: 'Atlantis/Mars' });
        expect(
          (request.messages as { content: string }[]).some((message) =>
            message.content.includes(code),
          ),
        ).toBe(true);
        if (index === 1) return call('get_user_prefs', {});
        return call('finish_goal', result);
      },
      invoke: (request) =>
        request.tool_id === 'get_user_prefs'
          ? {
              status: 'ok',
              invocationId: request.invocation_id,
              replayed: false,
              result: { kind: 'prefs', timezone_id: 'America/New_York' },
            }
          : invoke(request),
    });
    expect(
      requests.filter((request) => request.type === 'invoke').map((request) => request.tool_id),
    ).toEqual(['set_user_timezone', 'get_user_prefs']);
    expect(requests.at(-1)).toMatchObject({ type: 'finish_goal', goal_result: result });
    const legacy = await nativeCase({
      start: { trusted_context: null, tools: [prefsTool] },
      model: () => call('get_user_prefs', {}),
      invoke,
    });
    expect(legacy.filter((request) => request.type === 'model')).toHaveLength(1);
    expect(legacy.at(-1)).toMatchObject({ type: 'finish', outcome: 'failed', error: { code } });
  });
}
