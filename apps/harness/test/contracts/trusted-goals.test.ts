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
  finishGoal?: (request: Request) => unknown;
  contextSource?: (request: Request) => unknown;
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
          case 'context_source':
            if (!options.contextSource) throw new Error('Unexpected context source request');
            value = options.contextSource(request);
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
          case 'finish_goal':
            value = options.finishGoal?.(request) ?? { accepted: true };
            break;
          case 'answer':
          case 'finish':
            value = { accepted: true };
            break;
          case 'suspend':
            value = { suspended: true };
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
  ]) {
    expect(await nativeCase({ start, expectedExit: 2 })).toEqual([]);
  }
}, 120_000);

test('native accepts frozen elapsed capability without wall rules and exposes it to the model', async () => {
  const requests = await nativeCase({
    start: {
      trusted_context: {
        ...trusted,
        time_capabilities: { elapsed_revision: 'elapsed/1', wall_rules: null },
      },
    },
    model: () => call('finish_goal', goal()),
  });
  const model = requests.find((request) => request.type === 'model');
  expect(JSON.stringify(model)).toContain('elapsed/1');
  expect(requests.at(-1)).toMatchObject({ type: 'finish_goal' });
});

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

test('authority-rejected goal permits bounded correction but never repeats business effects', async () => {
  let attempts = 0;
  const requests = await nativeCase({
    finishGoal: () =>
      ++attempts === 1
        ? {
            accepted: false,
            code: 'INVALID_GOAL_RESULT',
            message: 'goal omits the fresh document read',
          }
        : { accepted: true },
    model: (request, index) => {
      if (index === 0) return call('finish_goal', goal());
      const messages = request.messages as { role: string; content: string }[];
      expect(
        messages.some(
          (m) => m.role === 'tool' && m.content.includes('goal omits the fresh document read'),
        ),
      ).toBe(true);
      if (index === 1) return call('set_user_timezone', { timezone_id: 'Asia/Shanghai' });
      return call('finish_goal', goal());
    },
  });
  expect(requests.filter((request) => request.type === 'finish_goal')).toHaveLength(2);
  expect(requests.some((request) => request.type === 'reserve' || request.type === 'invoke')).toBe(
    false,
  );
  expect(requests.at(-1)?.type).toBe('finish_goal');
});

test('a rejected setting is not a receipt; invalid finish_goal stays in bounded control-only correction', async () => {
  let deniedRef = '';
  const blocked = {
    status: 'blocked',
    outcomes: [
      {
        description: 'Unsupported setting was not saved',
        status: 'blocked',
        receipt_refs: [] as string[],
      },
    ],
    clarification: null,
    answer: '规则不支持所请求的值，未保存，原默认未变。',
  };
  const requests = await nativeCase({
    start: {
      messages: [
        {
          message_id: inputId,
          role: 'user',
          content: '请保存我指定的默认时区，不支持就如实说明。',
        },
      ],
      tools: [timezoneTool, { ...timezoneTool, name: 'get_user_prefs' }],
    },
    invoke: (request) => {
      if (request.tool_id === 'get_user_prefs') {
        return {
          status: 'ok',
          invocationId: request.invocation_id,
          replayed: false,
          result: { kind: 'prefs', timezone_id: null },
        };
      }
      deniedRef = request.invocation_id as string;
      return {
        status: 'denied',
        invocationId: deniedRef,
        replayed: false,
        error: { code: 'UNKNOWN_TIMEZONE', message: 'Unsupported timezone; unchanged.' },
      };
    },
    model: (request, index) => {
      if (index === 0) return call('get_user_prefs', {});
      if (index === 1) return call('set_user_timezone', { timezone_id: 'Unsupported/Zone' });
      if (index === 2) {
        return call('finish_goal', {
          ...blocked,
          outcomes: [{ ...blocked.outcomes[0], receipt_refs: [deniedRef] }],
        });
      }
      const messages = request.messages as {
        role: string;
        content: string;
        tool_call_id?: string;
        tool_calls?: { id: string }[];
      }[];
      const rejected = messages.findLast(
        (message) => message.role === 'tool' && message.content.includes('INVALID_GOAL_RESULT'),
      );
      expect(rejected).toBeDefined();
      expect(JSON.parse(rejected!.content)).toMatchObject({
        accepted: false,
        code: 'INVALID_GOAL_RESULT',
      });
      expect(
        messages.some(
          (message) =>
            message.role === 'assistant' &&
            message.tool_calls?.some((call) => call.id === rejected!.tool_call_id),
        ),
      ).toBe(true);
      if (index === 3) return call('set_user_timezone', { timezone_id: 'Asia/Shanghai' });
      return call('finish_goal', blocked);
    },
  });
  expect(
    requests.filter((request) => request.type === 'reserve').map((request) => request.tool_id),
  ).toEqual(['get_user_prefs', 'set_user_timezone']);
  expect(requests.filter((request) => request.type === 'invoke')).toHaveLength(2);
  expect(requests.filter((request) => request.type === 'finish_goal')).toHaveLength(1);
  expect(requests.at(-1)).toMatchObject({
    type: 'finish_goal',
    goal_result: blocked,
    usage: { iterations: 5, tokens: 25 },
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
      start: { budget: { max_iterations: 1, max_tokens: 1000 } },
      model: () => call('finish_goal', result),
    });
    expect(
      requests.some((request) => request.type === 'reserve' || request.type === 'finish_goal'),
    ).toBe(false);
    expect(requests.at(-1)).toMatchObject({
      type: 'finish',
      outcome: 'failed',
      error: { code: 'BUDGET_EXCEEDED' },
      usage: { iterations: 1, tokens: 5 },
    });
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
    start: {
      snapshot,
      observations: [observation],
      budget: { max_iterations: 2, max_tokens: 1000 },
    },
    model: () => call('finish_goal', goal([receipt, receipt])),
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

const createdTask = {
  kind: 'task_created',
  task_id: randomUUID(),
  state: 'saved',
  wall_time: '2026-11-03 09:00',
  timezone_id: 'America/New_York',
  fold: 0,
  resolved_utc_offset_seconds: -18000,
  tzdb_version: 'controlled/1',
  fire_at_utc: '2026-11-03T14:00:00Z',
  original_note: '提交报告',
};

const elapsedTask = {
  ...createdTask,
  wall_time: '2026-11-02 12:05',
  timezone_id: 'UTC',
  fold: 0,
  resolved_utc_offset_seconds: 0,
  tzdb_version: null,
  fire_at_utc: '2026-11-02T12:05:00Z',
  time_basis: {
    kind: 'elapsed',
    anchor_utc: '2026-11-02T12:00:00Z',
    duration_seconds: 300,
    source_message_id: inputId,
    revision: 'elapsed/1',
  },
  display_version: 'elapsed/1',
};

test('native preserves a UTC elapsed receipt without wall rules and its invocation reference', async () => {
  const invocationId = randomUUID();
  const requests = await nativeCase({
    start: {
      ...reminderStart,
      snapshot: {
        version: 2,
        message_refs: [inputId],
        tool_refs: [invocationId],
        next_call_no: 2,
        usage: { iterations: 0, tokens: 0 },
        waiting: null,
      },
      trusted_context: {
        ...trusted,
        time_capabilities: { elapsed_revision: 'elapsed/1', wall_rules: null },
      },
      observations: [
        {
          view: 'full',
          invocation_id: invocationId,
          tool_id: 'create_reminder',
          result: { status: 'ok', result: elapsedTask },
        },
      ],
    },
    model: () => call('finish_goal', goal([invocationId])),
  });
  expect(JSON.stringify(requests.find((request) => request.type === 'model'))).toContain(
    'duration_seconds',
  );
  expect(requests.at(-1)).toMatchObject({
    type: 'finish_goal',
    goal_result: { outcomes: [{ receipt_refs: [invocationId] }] },
  });
});

test('native rejects malformed elapsed receipts and null rules outside UTC', async () => {
  for (const invalid of [
    { display_version: 'elapsed/2' },
    { time_basis: null },
    { time_basis: { ...elapsedTask.time_basis, duration_seconds: 0 } },
    { time_basis: { ...elapsedTask.time_basis, source_message_id: 'invalid' } },
    { time_basis: { ...elapsedTask.time_basis, anchor_utc: '2026-02-30T12:00:00Z' } },
    { time_basis: { ...elapsedTask.time_basis, revision: 'elapsed/2' } },
    { time_basis: { ...elapsedTask.time_basis, extra: true } },
    { timezone_id: 'America/New_York' },
    { resolved_utc_offset_seconds: 1 },
    { fold: 1 },
  ]) {
    const invocationId = randomUUID();
    expect(
      await nativeCase({
        start: {
          ...reminderStart,
          snapshot: {
            version: 2,
            message_refs: [inputId],
            tool_refs: [invocationId],
            next_call_no: 2,
            usage: { iterations: 0, tokens: 0 },
            waiting: null,
          },
          observations: [
            {
              view: 'full',
              invocation_id: invocationId,
              tool_id: 'create_reminder',
              result: { status: 'ok', result: { ...elapsedTask, ...invalid } },
            },
          ],
        },
        expectedExit: 2,
      }),
    ).toEqual([]);
  }
}, 120_000);

test('native rejects malformed task_created immutable observations before exposing receipts to the model', async () => {
  for (const invalid of [
    { task_id: 'not-a-uuid' },
    { state: 'scheduled' },
    { fold: 2 },
    { resolved_utc_offset_seconds: -18000.5 },
    { original_note: 42 },
    { tzdb_version: null },
    { extra: true },
  ]) {
    const requests = await nativeCase({
      start: {
        observations: [
          {
            view: 'full',
            invocation_id: randomUUID(),
            tool_id: 'create_reminder',
            result: { status: 'ok', result: { ...createdTask, ...invalid } },
          },
        ],
      },
      expectedExit: 2,
    });
    expect(requests).toEqual([]);
  }
}, 120_000);

for (const trustedContext of [trusted, null]) {
  test(`native frozen ${trustedContext ? 'settings-only delegation' : 'legacy'} tool set never gains reminder dispatch`, async () => {
    const requests = await nativeCase({
      start: { trusted_context: trustedContext },
      model: () => call('create_reminder', {}),
    });
    expect(requests.filter((request) => ['reserve', 'invoke'].includes(request.type))).toEqual([]);
    expect(requests.at(-1)).toMatchObject({
      type: 'finish',
      outcome: 'failed',
      error: { code: 'TOOL_DENIED' },
    });
  });
}

test('resuming a frozen settings-only snapshot does not authorize create_reminder', async () => {
  const requests = await nativeCase({
    start: {
      snapshot: {
        version: 2,
        message_refs: [inputId],
        tool_refs: [],
        next_call_no: 3,
        usage: { iterations: 2, tokens: 10 },
        waiting: null,
      },
    },
    model: () => call('create_reminder', {}),
  });
  expect(requests.filter((request) => ['reserve', 'invoke'].includes(request.type))).toEqual([]);
  expect(requests.at(-1)).toMatchObject({
    type: 'finish',
    outcome: 'failed',
    error: { code: 'TOOL_DENIED' },
    usage: { iterations: 3, tokens: 15 },
  });
});

const reminderTool = {
  name: 'create_reminder',
  description: 'Create an explicitly delegated wall/calendar reminder; success proves saved only.',
  risk: 'medium',
  parameters: {
    type: 'object',
    properties: {
      raw_time_text: { type: 'string', minLength: 1 },
      timezone_hint: { type: ['string', 'null'] },
      note: { type: 'string', minLength: 1 },
      occurrence: { const: 'once' },
    },
    required: ['raw_time_text', 'note', 'occurrence'],
    additionalProperties: false,
  },
};
const reminderArgs = {
  raw_time_text: '2026年11月3日9:00提醒我提交报告',
  timezone_hint: 'America/New_York',
  note: '提交报告',
  occurrence: 'once',
};
const reminderStart = {
  tools: [reminderTool],
  messages: [{ message_id: inputId, role: 'user', content: reminderArgs.raw_time_text }],
  trusted_context: {
    ...trusted,
    time_capabilities: {
      elapsed_revision: null,
      wall_rules: {
        ruleset_id: 'controlled/1',
        tzdb_version: 'controlled/1',
        alias_version: 'controlled/1',
      },
    },
  },
};

test('frozen create_reminder dispatch accepts saved receipt and finishes without approval or schedule claims', async () => {
  const receipts: string[] = [];
  const result = {
    ...goal(receipts),
    outcomes: [
      { description: '提醒已保存，尚无排期或通知回执', status: 'achieved', receipt_refs: receipts },
    ],
    answer: '提醒已保存；创建并不证明已排期、触发或通知。',
  };
  const requests = await nativeCase({
    start: reminderStart,
    model: (_request, index) =>
      index === 0 ? call('create_reminder', reminderArgs) : call('finish_goal', result),
    invoke: (request) => {
      receipts.push(request.invocation_id as string);
      return {
        status: 'ok',
        invocationId: request.invocation_id,
        replayed: false,
        result: createdTask,
      };
    },
  });
  expect(requests.filter((request) => request.type === 'reserve')).toEqual([
    expect.objectContaining({
      tool_id: 'create_reminder',
      args: reminderArgs,
      call_key: 'harness/1',
    }),
  ]);
  expect(requests.filter((request) => request.type === 'invoke')).toHaveLength(1);
  expect(requests.some((request) => request.type === 'suspend')).toBe(false);
  expect(requests.at(-1)).toMatchObject({ type: 'finish_goal', goal_result: result });
});

test('task_created accepts nullable original note and preserves bootstrap invocation receipt', async () => {
  const invocationId = randomUUID();
  const requests = await nativeCase({
    start: {
      ...reminderStart,
      snapshot: {
        version: 2,
        message_refs: [inputId],
        tool_refs: [invocationId],
        next_call_no: 2,
        usage: { iterations: 0, tokens: 0 },
        waiting: null,
      },
      observations: [
        {
          view: 'full',
          invocation_id: invocationId,
          tool_id: 'create_reminder',
          result: { status: 'ok', result: { ...createdTask, original_note: null } },
        },
      ],
    },
    model: () => call('finish_goal', goal([invocationId])),
  });
  expect(requests.filter((request) => ['reserve', 'invoke'].includes(request.type))).toEqual([]);
  expect(requests.at(-1)).toMatchObject({
    type: 'finish_goal',
    goal_result: { outcomes: [{ receipt_refs: [invocationId] }] },
  });
});

test('invalid reminder GoalResult cannot dispatch another creation and only corrects within original budget', async () => {
  const receipts: string[] = [];
  const requests = await nativeCase({
    start: { ...reminderStart, budget: { max_iterations: 4, max_tokens: 1000 } },
    model: (_request, index) => {
      if (index === 0 || index === 2) return call('create_reminder', reminderArgs);
      if (index === 1) return call('finish_goal', goal([createdTask.task_id]));
      return call('finish_goal', goal(receipts));
    },
    invoke: (request) => {
      receipts.push(request.invocation_id as string);
      return {
        status: 'ok',
        invocationId: request.invocation_id,
        replayed: false,
        result: createdTask,
      };
    },
  });
  expect(requests.filter((request) => request.type === 'invoke')).toHaveLength(1);
  expect(requests.filter((request) => request.type === 'reserve')).toHaveLength(1);
  expect(requests.filter((request) => request.type === 'model')).toHaveLength(4);
  expect(requests.at(-1)).toMatchObject({ type: 'finish_goal', goal_result: goal(receipts) });
});

for (const code of ['TOOL_FORBIDDEN', 'UNKNOWN_TIMEZONE']) {
  test(`reminder ${code} denial is not a receipt and allows truthful blocked completion`, async () => {
    const result = {
      status: 'blocked',
      outcomes: [{ description: '提醒没有创建', status: 'blocked', receipt_refs: [] }],
      clarification: null,
      answer: '提醒未创建。',
    };
    const requests = await nativeCase({
      start: reminderStart,
      model: (_request, index) => {
        if (index === 0 || (code === 'TOOL_FORBIDDEN' && index === 1))
          return call('create_reminder', reminderArgs);
        return call('finish_goal', result);
      },
      invoke: (request) => ({
        status: 'denied',
        invocationId: request.invocation_id,
        replayed: false,
        error: { code, message: 'Creation denied without an effect.' },
      }),
    });
    expect(requests.filter((request) => request.type === 'invoke')).toHaveLength(1);
    expect(requests.filter((request) => request.type === 'reserve')).toHaveLength(1);
    expect(requests.at(-1)).toMatchObject({ type: 'finish_goal', goal_result: result });
  });
}

test('legacy start cannot advertise the delegation-only create_reminder capability', async () => {
  expect(
    await nativeCase({
      start: { trusted_context: null, tools: [reminderTool] },
      expectedExit: 2,
    }),
  ).toEqual([]);
});

const taskTools = [
  {
    name: 'list_tasks',
    description: 'Read a page of personal tasks.',
    risk: 'low',
    parameters: { type: 'object', properties: { after_task_id: { type: 'string' } } },
  },
  ...['get_task', 'cancel_reminder'].map((name) => ({
    name,
    description: 'Read or cancel one personal task.',
    risk: 'low',
    parameters: {
      type: 'object',
      properties: { task_id: { type: 'string' } },
      required: ['task_id'],
    },
  })),
];

test('native carries paginated task facts and the actual pending cancellation through the model protocol', async () => {
  const first = randomUUID();
  const target = randomUUID();
  let cancelRef = '';
  const task = {
    task_id: target,
    note: '第二页提醒',
    fire_at_local_text: '2026-11-05 12:00',
    timezone_id: 'Asia/Shanghai',
    state: 'scheduled',
  };
  const blocked = () => ({
    status: 'blocked',
    outcomes: [{ description: '撤销待完成', status: 'blocked', receipt_refs: [cancelRef] }],
    clarification: null,
    answer: '已提交取消，撤销仍在等待。',
  });
  const requests = await nativeCase({
    start: { tools: taskTools },
    model: (request, index) => {
      const messages = request.messages as { role: string; content: string }[];
      if (index === 0) {
        expect(
          messages.some((m) => m.role === 'system' && m.content.includes('after_task_id')),
        ).toBe(true);
        return call('list_tasks', {});
      }
      if (index === 1) {
        expect(messages.some((m) => m.role === 'tool' && m.content.includes(first))).toBe(true);
        return call('list_tasks', { after_task_id: first });
      }
      if (index === 2) return call('get_task', { task_id: target });
      if (index === 3) {
        expect(messages.some((m) => m.role === 'tool' && m.content.includes(task.note))).toBe(true);
        return call('cancel_reminder', {
          task_id: target,
          expected_note: task.note,
          expected_wall_time: task.fire_at_local_text,
          expected_timezone_id: task.timezone_id,
        });
      }
      expect(messages.some((m) => m.role === 'tool' && m.content.includes('cancel_pending'))).toBe(
        true,
      );
      return call('finish_goal', blocked());
    },
    invoke: (request) => {
      let result: unknown;
      if (request.tool_id === 'list_tasks') {
        const args = request.args as { after_task_id?: string };
        result = args.after_task_id
          ? {
              kind: 'list_tasks',
              tasks: [
                {
                  task_id: target,
                  note_preview: task.note,
                  fire_at_local_text: task.fire_at_local_text,
                  timezone_id: task.timezone_id,
                  state: task.state,
                },
              ],
              has_more: false,
              next_cursor: null,
            }
          : {
              kind: 'list_tasks',
              tasks: [
                {
                  task_id: first,
                  note_preview: '另一条提醒',
                  fire_at_local_text: task.fire_at_local_text,
                  timezone_id: task.timezone_id,
                  state: task.state,
                },
              ],
              has_more: true,
              next_cursor: first,
            };
      } else if (request.tool_id === 'get_task') {
        result = { kind: 'task_detail', task };
      } else {
        cancelRef = request.invocation_id as string;
        result = {
          kind: 'reminder_cancelled',
          task_id: target,
          state: 'cancel_pending',
          duplicate: false,
        };
      }
      return { status: 'ok', invocationId: request.invocation_id, replayed: false, result };
    },
  });
  expect(requests.filter((r) => r.type === 'invoke').map((r) => [r.tool_id, r.args])).toEqual([
    ['list_tasks', {}],
    ['list_tasks', { after_task_id: first }],
    ['get_task', { task_id: target }],
    [
      'cancel_reminder',
      {
        task_id: target,
        expected_note: task.note,
        expected_wall_time: task.fire_at_local_text,
        expected_timezone_id: task.timezone_id,
      },
    ],
  ]);
  expect(requests.at(-1)).toMatchObject({ type: 'finish_goal', goal_result: blocked() });
});

for (const name of ['get_task', 'cancel_reminder']) {
  test(`frozen old tools cannot dispatch ${name}, and legacy cannot advertise it`, async () => {
    const denied = await nativeCase({ model: () => call(name, { task_id: randomUUID() }) });
    expect(denied.filter((r) => r.type === 'reserve' || r.type === 'invoke')).toEqual([]);
    expect(denied.at(-1)).toMatchObject({ type: 'finish', error: { code: 'TOOL_DENIED' } });
    const tool = taskTools.find((candidate) => candidate.name === name)!;
    expect(
      await nativeCase({ start: { trusted_context: null, tools: [tool] }, expectedExit: 2 }),
    ).toEqual([]);
  });
}

test('unknown cancellation stops without retrying or issuing a completion receipt', async () => {
  const requests = await nativeCase({
    start: { tools: taskTools },
    model: () => call('cancel_reminder', { task_id: randomUUID() }),
    invoke: (request) => ({
      status: 'unknown',
      invocationId: request.invocation_id,
      replayed: false,
      error: { code: 'TOOL_EFFECT_UNKNOWN', message: 'Cancellation outcome is unknown.' },
    }),
  });
  expect(requests.filter((r) => r.type === 'invoke')).toHaveLength(1);
  expect(requests.filter((r) => r.type === 'finish_goal' || r.type === 'snapshot')).toEqual([]);
  expect(requests.at(-1)).toMatchObject({ type: 'finish', error: { code: 'TOOL_EFFECT_UNKNOWN' } });
});

test('older delegated tool snapshots do not receive new cancellation instructions', async () => {
  const requests = await nativeCase({
    start: { tools: [taskTools[0]] },
    model: () => call('finish_goal', goal()),
  });
  const model = requests.find((r) => r.type === 'model')!;
  const messages = model.messages as { role: string; content: string }[];
  expect(messages.some((m) => m.role === 'system' && m.content.includes('after_task_id'))).toBe(
    false,
  );
});

test('trusted continuation exposes historical text as untrusted data and preserves only achieved receipt references', async () => {
  const achieved = randomUUID();
  const notAchieved = randomUUID();
  const originalText = 'original-user-data-unique';
  const priorAnswer = 'prior-model-data-unique';
  const continuation = {
    run_id: randomUUID(),
    invocation_id: null,
    original_input_message_id: randomUUID(),
    original_text: originalText,
    receipts: [
      {
        invocation_id: achieved,
        tool_id: 'cancel_reminder',
        result: {
          status: 'ok',
          result: {
            kind: 'reminder_cancelled',
            task_id: randomUUID(),
            state: 'cancelled',
            duplicate: false,
          },
        },
      },
    ],
    source_result: null,
    goal_result: {
      status: 'partial',
      outcomes: [
        { description: 'Completed earlier', status: 'achieved', receipt_refs: [achieved] },
        { description: 'Still missing', status: 'blocked', receipt_refs: [notAchieved] },
      ],
      clarification: { kind: 'target_selection', question: 'Which one?' },
      answer: priorAnswer,
    },
  };
  const requests = await nativeCase({
    start: { trusted_context: { ...trusted, continuation }, tools: taskTools },
    model: (request, index) => {
      const messages = request.messages as { role: string; content: string }[];
      const system = messages
        .filter((m) => m.role === 'system')
        .map((m) => m.content)
        .join('\n');
      expect(system).not.toContain(originalText);
      expect(system).not.toContain(priorAnswer);
      const source = messages.find(
        (m) => m.role === 'assistant' && m.content.includes(originalText),
      );
      expect(source?.content).toContain(priorAnswer);
      if (index === 0) return call('finish_goal', goal([notAchieved]));
      return call('finish_goal', goal([achieved]));
    },
  });
  expect(requests.filter((r) => r.type === 'invoke' || r.type === 'reserve')).toEqual([]);
  expect(requests.at(-1)).toMatchObject({ type: 'finish_goal', goal_result: goal([achieved]) });
});

test('a historical pending cancellation remains a usable receipt without claiming revocation', async () => {
  const pending = randomUUID();
  const previous = {
    run_id: randomUUID(),
    invocation_id: null,
    original_input_message_id: randomUUID(),
    original_text: '取消两条提醒',
    receipts: [
      {
        invocation_id: pending,
        tool_id: 'cancel_reminder',
        result: {
          status: 'ok',
          result: {
            kind: 'reminder_cancelled',
            task_id: randomUUID(),
            state: 'cancel_pending',
            duplicate: false,
          },
        },
      },
    ],
    source_result: null,
    goal_result: {
      status: 'blocked',
      outcomes: [
        { description: '取消请求已接受，等待撤销回执', status: 'blocked', receipt_refs: [pending] },
      ],
      clarification: { kind: 'target_selection', question: '另一条是哪条？' },
      answer: '取消请求已接受；请选择另一条。',
    },
  };
  const result = {
    status: 'blocked',
    outcomes: [
      { description: '取消请求已接受，等待撤销回执', status: 'blocked', receipt_refs: [pending] },
    ],
    clarification: null,
    answer: '取消请求已接受，等待撤销回执。',
  };
  const requests = await nativeCase({
    start: { trusted_context: { ...trusted, continuation: previous }, tools: taskTools },
    model: () => call('finish_goal', result),
  });
  expect(requests.filter((r) => r.type === 'invoke' || r.type === 'reserve')).toEqual([]);
  expect(requests.at(-1)).toMatchObject({ type: 'finish_goal', goal_result: result });
});

test('old continuation remains accepted without new evidence fields', async () => {
  const continuation = { run_id: randomUUID(), invocation_id: randomUUID() };
  const requests = await nativeCase({
    start: { trusted_context: { ...trusted, continuation } },
    model: (request) => {
      const messages = request.messages as { role: string; content: string }[];
      expect(
        messages.some((m) => m.role === 'system' && m.content.includes(continuation.run_id)),
      ).toBe(true);
      return call('finish_goal', goal());
    },
  });
  expect(requests.at(-1)).toMatchObject({ type: 'finish_goal' });
});

test('tool-only continuation exposes the actual source without inventing or accepting a receipt', async () => {
  const sourceId = randomUUID();
  const sourceText = 'historical-source-error-unique';
  const continuation = {
    run_id: randomUUID(),
    invocation_id: sourceId,
    original_input_message_id: randomUUID(),
    original_text: 'Earlier request',
    goal_result: null,
    receipts: [],
    source_result: {
      invocation_id: sourceId,
      tool_id: 'create_reminder',
      result: { status: 'denied', error: { code: 'UNKNOWN_TIMEZONE', message: sourceText } },
    },
  };
  const requests = await nativeCase({
    start: { trusted_context: { ...trusted, continuation }, tools: taskTools },
    model: (request, index) => {
      const messages = request.messages as { role: string; content: string }[];
      expect(messages.some((m) => m.role === 'system' && m.content.includes(sourceText))).toBe(
        false,
      );
      expect(messages.some((m) => m.role === 'assistant' && m.content.includes(sourceText))).toBe(
        true,
      );
      return call('finish_goal', index === 0 ? goal([sourceId]) : goal());
    },
  });
  expect(requests.filter((r) => r.type === 'invoke' || r.type === 'reserve')).toEqual([]);
  expect(requests.at(-1)).toMatchObject({ type: 'finish_goal', goal_result: goal() });
});

test('parallel proposals have no effects and the model can continue one action at a time', async () => {
  const refs: string[] = [];
  const requests = await nativeCase({
    model: (_request, index) => {
      if (index === 0) {
        return {
          content: null,
          tool_calls: [
            ...call('set_user_timezone', { timezone_id: 'Asia/Shanghai' }).tool_calls,
            ...call('set_user_timezone', { timezone_id: null }).tool_calls,
          ],
        };
      }
      if (index === 1) return call('set_user_timezone', { timezone_id: 'Asia/Shanghai' });
      if (index === 2) return call('set_user_timezone', { timezone_id: null });
      return call('finish_goal', goal(refs));
    },
    invoke: (request) => {
      refs.push(request.invocation_id as string);
      return {
        status: 'ok',
        invocationId: request.invocation_id,
        replayed: false,
        result: {
          kind: 'timezone_setting',
          timezone_id: refs.length === 1 ? 'Asia/Shanghai' : null,
          previous_timezone_id: refs.length === 1 ? null : 'Asia/Shanghai',
          alias_version: 'controlled/1',
        },
      };
    },
  });
  expect(requests.filter((request) => request.type === 'model')).toHaveLength(4);
  expect(requests.filter((request) => request.type === 'invoke')).toHaveLength(2);
  expect(requests.at(-1)).toMatchObject({ type: 'finish_goal', goal_result: goal(refs) });
});

const delegatedWorkspaces = [
  { workspace_id: 'one', label: 'One', readable_paths: ['same.txt'], writable_paths: ['same.txt'] },
  { workspace_id: 'two', label: 'Two', readable_paths: ['same.txt'], writable_paths: [] },
];
const workspaceTool = (name: string) => ({
  name,
  description: name,
  parameters: { type: 'object', properties: {}, additionalProperties: true },
  risk: 'medium',
});
const workspaceTools = [
  'workspace_list',
  'workspace_grep',
  'workspace_read',
  'workspace_replace',
  'workspace_propose_replace',
  'workspace_apply_replace',
].map(workspaceTool);

test('delegated workspaces require frozen resources and tool allowlist, without upgrading legacy', async () => {
  for (const start of [
    { tools: [workspaceTool('workspace_read')] },
    {
      trusted_context: { ...trusted, workspaces: [delegatedWorkspaces[1]] },
      tools: [workspaceTool('workspace_replace')],
    },
    {
      trusted_context: { ...trusted, workspaces: [delegatedWorkspaces[0], delegatedWorkspaces[0]] },
    },
    { trusted_context: null, tools: [workspaceTool('workspace_replace')] },
  ]) {
    expect(await nativeCase({ start, expectedExit: 2 })).toEqual([]);
  }
  const requests = await nativeCase({
    start: {
      trusted_context: { ...trusted, workspaces: delegatedWorkspaces },
      tools: workspaceTools,
    },
    model: (request) => {
      const context = (request.messages as { content: string }[])
        .map((message) => message.content)
        .join('\n');
      expect(context).toContain('"workspace_id":"one"');
      expect(context).toContain('"workspace_id":"two"');
      expect(context).toContain('new independent workspace_read');
      return call('finish_goal', goal());
    },
  });
  expect(requests.at(-1)).toMatchObject({ type: 'finish_goal' });
  const old = await nativeCase({
    start: { trusted_context: { ...trusted, workspaces: delegatedWorkspaces }, tools: [] },
    model: () => call('workspace_replace', {}),
  });
  expect(old.some((request) => request.type === 'reserve')).toBe(false);
  expect(old.at(-1)).toMatchObject({ type: 'finish', error: { code: 'TOOL_DENIED' } });
});

test('creation is available only to delegated starts with frozen output directories', async () => {
  const output = {
    workspace_id: 'out',
    label: 'Output',
    readable_paths: [],
    writable_paths: [],
    output_directories: ['reports'],
  };
  for (const start of [
    { trusted_context: null, tools: [workspaceTool('workspace_create')] },
    {
      trusted_context: { ...trusted, workspaces: [delegatedWorkspaces[0]] },
      tools: [workspaceTool('workspace_create')],
    },
    {
      trusted_context: { ...trusted, workspaces: [{ ...output, output_directories: [] }] },
      tools: [workspaceTool('workspace_create')],
    },
    {
      trusted_context: {
        ...trusted,
        workspaces: [{ ...output, output_directories: ['../escape'] }],
      },
      tools: [workspaceTool('workspace_create')],
    },
    {
      trusted_context: {
        ...trusted,
        workspaces: [{ ...output, output_directories: ['reports', 'reports'] }],
      },
      tools: [workspaceTool('workspace_create')],
    },
  ]) {
    expect(await nativeCase({ start, expectedExit: 2 })).toEqual([]);
  }
  const requests = await nativeCase({
    start: {
      trusted_context: { ...trusted, workspaces: [output] },
      tools: [workspaceTool('workspace_create'), workspaceTool('workspace_read')],
    },
    model: () => call('finish_goal', goal()),
  });
  expect(requests.at(-1)).toMatchObject({ type: 'finish_goal' });
  const old = await nativeCase({
    start: { trusted_context: { ...trusted, workspaces: [output] }, tools: [] },
    model: () => call('workspace_create', {}),
  });
  expect(old.some((request) => request.type === 'reserve')).toBe(false);
  expect(old.at(-1)).toMatchObject({ type: 'finish', error: { code: 'TOOL_DENIED' } });
});

test('unknown creation stops without another reservation or model step', async () => {
  const output = {
    workspace_id: 'out',
    label: 'Output',
    readable_paths: [],
    writable_paths: [],
    output_directories: ['reports'],
  };
  const requests = await nativeCase({
    start: {
      trusted_context: { ...trusted, workspaces: [output] },
      tools: [workspaceTool('workspace_create')],
    },
    model: () =>
      call('workspace_create', {
        workspace_id: 'out',
        output_directory: 'reports',
        filename: 'brief.txt',
        content: 'brief',
      }),
    invoke: (request) => ({
      status: 'unknown',
      invocationId: request.invocation_id,
      replayed: false,
      error: { code: 'TOOL_EFFECT_UNKNOWN', message: 'Unknown effect' },
    }),
  });
  expect(requests.filter((request) => request.type === 'model')).toHaveLength(1);
  expect(requests.filter((request) => request.type === 'reserve')).toHaveLength(1);
  expect(requests.filter((request) => request.type === 'invoke')).toHaveLength(1);
  expect(requests.at(-1)).toMatchObject({ type: 'finish', error: { code: 'TOOL_EFFECT_UNKNOWN' } });
});

test('delegated document proposal suspends and approved bootstrap continues only the frozen target', async () => {
  const approvalId = randomUUID();
  let invocationId = '';
  const receipt = {
    kind: 'document_approval',
    approval: { approval_id: approvalId, workspace_id: 'one', relative_path: 'same.txt' },
  };
  const start = {
    trusted_context: { ...trusted, workspaces: delegatedWorkspaces },
    tools: workspaceTools,
  };
  const pending = await nativeCase({
    start,
    model: () => call('workspace_propose_replace', { read_invocation_id: randomUUID() }),
    invoke: (request) => {
      invocationId = request.invocation_id as string;
      return { status: 'ok', invocationId, replayed: false, result: receipt };
    },
  });
  expect(pending.at(-1)).toMatchObject({
    type: 'suspend',
    invocation_id: invocationId,
    approval_id: approvalId,
  });
  const snapshot = {
    version: 2,
    message_refs: [inputId],
    tool_refs: [invocationId],
    next_call_no: 2,
    usage: { iterations: 1, tokens: 5 },
    waiting: { invocation_id: invocationId, approval_id: approvalId },
  };
  const observation = {
    view: 'full',
    invocation_id: invocationId,
    tool_id: 'workspace_propose_replace',
    result: { status: 'ok', result: receipt },
  };
  const decision = {
    kind: 'document',
    approval_id: approvalId,
    status: 'approved',
    apply_invocation_id: null,
  };
  const resumed = await nativeCase({
    start: { ...start, snapshot, observations: [observation], approval: decision },
    model: (request) => {
      expect(JSON.stringify(request.messages)).toContain('authorization, not a completed write');
      return call('finish_goal', goal());
    },
  });
  expect(resumed.at(-1)).toMatchObject({ type: 'finish_goal' });
  const rejected = await nativeCase({
    start: {
      ...start,
      snapshot,
      observations: [observation],
      approval: { ...decision, status: 'rejected' },
    },
  });
  expect(rejected.at(-1)).toMatchObject({ type: 'finish', error: { code: 'APPROVAL_rejected' } });
  expect(rejected.some((request) => request.type === 'model' || request.type === 'reserve')).toBe(
    false,
  );
  for (const badObservation of [
    { ...observation, tool_id: 'workspace_read' },
    {
      ...observation,
      result: {
        status: 'ok',
        result: { ...receipt, approval: { ...receipt.approval, workspace_id: 'two' } },
      },
    },
  ]) {
    expect(
      await nativeCase({
        start: { ...start, snapshot, observations: [badObservation], approval: decision },
        expectedExit: 2,
      }),
    ).toEqual([]);
  }
});

test('unknown delegated workspace write never checkpoints or retries', async () => {
  const requests = await nativeCase({
    start: {
      trusted_context: { ...trusted, workspaces: delegatedWorkspaces },
      tools: workspaceTools,
    },
    model: () =>
      call('workspace_replace', {
        read_invocation_id: randomUUID(),
        change: { kind: 'full', new_content: 'x' },
      }),
    invoke: (request) => ({
      status: 'unknown',
      invocationId: request.invocation_id,
      replayed: false,
      error: { code: 'TOOL_EFFECT_UNKNOWN', message: 'Unknown effect' },
    }),
  });
  expect(requests.filter((request) => request.type === 'reserve')).toHaveLength(1);
  expect(
    requests.some((request) => request.type === 'snapshot' || request.type === 'suspend'),
  ).toBe(false);
  expect(requests.at(-1)).toMatchObject({ type: 'finish', error: { code: 'TOOL_EFFECT_UNKNOWN' } });
});

test('projected delegated workspace observations retain their frozen workspace identity', async () => {
  const id = randomUUID();
  const source = {
    result_version: 1,
    omitted: true,
    kind: 'read',
    workspace_id: 'two',
    path: 'same.txt',
    version: 'a'.repeat(64),
    byte_length: 1,
    content_total: 1,
  };
  const projected = {
    view: 'projected',
    invocation_id: id,
    tool_id: 'workspace_read',
    outcome: 'ok',
    source,
  };
  const full = {
    view: 'full',
    invocation_id: id,
    tool_id: 'workspace_read',
    result: {
      status: 'ok',
      result: {
        kind: 'read',
        workspace_id: 'two',
        path: 'same.txt',
        content: 'x',
        version: 'a'.repeat(64),
        byte_length: 1,
      },
    },
  };
  const snapshot = {
    version: 2,
    message_refs: [inputId],
    tool_refs: [id],
    next_call_no: 2,
    usage: { iterations: 1, tokens: 5 },
    waiting: null,
  };
  const start = {
    trusted_context: { ...trusted, workspaces: delegatedWorkspaces },
    tools: [workspaceTool('workspace_read'), observationTool],
    snapshot,
    observations: [projected],
  };
  const requests = await nativeCase({
    start,
    contextSource: () => full,
    model: () => call('finish_goal', goal([id])),
  });
  expect(requests.at(-1)).toMatchObject({ type: 'finish_goal' });
  expect(
    await nativeCase({
      start: {
        ...start,
        observations: [{ ...projected, source: { ...source, workspace_id: 'outside' } }],
      },
      expectedExit: 2,
    }),
  ).toEqual([]);
});
