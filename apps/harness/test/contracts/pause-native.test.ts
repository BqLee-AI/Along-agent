import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { HarnessRequestSchema, type HarnessRequest } from '@along/contracts';

const policy = {
  revision: 'r2a/1',
  completion_cap: 37,
  model_window_tokens: null,
  input_meter: 'unavailable',
  meter_revision: 'unavailable/1',
  reserve_tokens: 0,
  model_binding: { model: 'fixture', adapter_revision: 'openai-chat/v1' },
};
const intents = ['task_list_bounded', 'prefs_timezone_read', 'brief_cards_read'];
const routing = {
  revision: 'r2b/1',
  mode: 'shadow',
  bundle_sha256: 'a'.repeat(64),
  encoding_sha256: 'b'.repeat(64),
  candidate_intents: intents,
  direct_intents: [],
  competition: [...intents, 'other_query'],
  thresholds: Object.fromEntries(intents.map((x) => [x, { tau_intent: 0.8, tau_gap: 0.1 }])),
  deadline_ms: 1000,
  max_inflight: 2,
  guard_revision: 'guard/1',
  parser_revision: 'parser/1',
  handler_revision: 'handler/1',
  renderer_revision: 'renderer/1',
  scorer_revision: 'scorer/1',
};

async function run(
  start: Record<string, unknown>,
  handle: (request: HarnessRequest) => Record<string, unknown>,
  expectedExit = 0,
) {
  if (!process.env.HARNESS_BINARY) throw new Error('HARNESS_BINARY is required');
  const child = Bun.spawn([process.env.HARNESS_BINARY], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      LD_LIBRARY_PATH: process.env.HARNESS_LIBRARY_PATH ?? process.env.LD_LIBRARY_PATH,
    },
  });
  const protocol = start.protocol;
  child.stdin.write(JSON.stringify(start) + '\n');
  const requests: HarnessRequest[] = [];
  let buffer = '';
  for await (const bytes of child.stdout) {
    buffer += new TextDecoder().decode(bytes);
    while (buffer.includes('\n')) {
      const at = buffer.indexOf('\n');
      const request = HarnessRequestSchema.parse(JSON.parse(buffer.slice(0, at)));
      buffer = buffer.slice(at + 1);
      requests.push(request);
      const result = handle(request);
      child.stdin.write(
        JSON.stringify({ protocol, type: 'reply', reply_to: request.request_ref, ...result }) +
          '\n',
      );
    }
  }
  expect(await child.exited, await new Response(child.stderr).text()).toBe(expectedExit);
  child.stdin.end();
  return requests;
}
const base = {
  type: 'start',
  trusted_context: null,
  tools: [],
  budget: { max_iterations: 4, max_tokens: 1000 },
  context_policy: policy,
  routing_policy: { revision: 'r2b/1', mode: 'off' },
  eligible_phase: 'disabled',
  snapshot: null,
  observations: [],
  approval: null,
};

for (const protocol of ['harness/v7'])
  test(`${protocol} probes pause before routing on fresh runs`, async () => {
    const id = randomUUID();
    const input = { messages: [{ message_id: id, role: 'user', content: 'route' }] };
    const requests = await run(
      { ...base, ...input, protocol, routing_policy: routing, eligible_phase: 'fresh_first_step' },
      (r) => {
        if (r.type === 'pause_probe') return { value: { pending: false } };
        if (r.type === 'route_probe')
          return { error: { code: 'FIXTURE', message: 'stop at routing' } };
        return { value: { accepted: true } };
      },
    );
    expect(requests.map((r) => r.type)).toEqual(['pause_probe', 'route_probe', 'finish']);
  }, 30000);

for (const protocol of ['harness/v7'])
  test(`${protocol} completes a direct route when pause arrives inside its bounded unit`, async () => {
    const inputId = randomUUID(),
      factsId = randomUUID(),
      decisionId = randomUUID(),
      invocationId = randomUUID();
    const input = { messages: [{ message_id: inputId, role: 'user', content: 'route' }] };
    let pausePending = false;
    const requests = await run(
      {
        ...base,
        ...input,
        protocol,
        routing_policy: { ...routing, mode: 'enforce', direct_intents: intents },
        eligible_phase: 'fresh_first_step',
        tools: [{ name: 'get_user_prefs', description: 'read', parameters: {}, risk: 'low' }],
      },
      (r) => {
        if (r.type === 'pause_probe') return { value: { pending: pausePending } };
        if (r.type === 'route_probe') {
          return {
            value: {
              facts_ref: factsId,
              input_sha256: 'c'.repeat(64),
              bundle_sha256: 'a'.repeat(64),
              eligible: true,
              reason: null,
              rule_intent: 'prefs_timezone_read',
              candidates: [
                { intent: 'prefs_timezone_read', tool_id: 'get_user_prefs', args: {}, sources: [] },
              ],
            },
          };
        }
        if (r.type === 'route_decide') {
          pausePending = true;
          return {
            value: {
              decision_ref: decisionId,
              decision: 'direct',
              intent: 'prefs_timezone_read',
              tool_id: 'get_user_prefs',
              args: {},
            },
          };
        }
        if (r.type === 'reserve') return { value: { invocation_id: invocationId } };
        if (r.type === 'invoke')
          return {
            value: {
              status: 'ok',
              invocationId,
              replayed: false,
              result: {
                kind: 'prefs',
                timezone_id: null,
                alias_version: 'fixture',
                quiet_hours: null,
                locale: null,
              },
            },
          };
        if (r.type === 'snapshot') return { value: { checkpoint_ref: randomUUID() } };
        if (r.type === 'render_route_result') return { value: { rendered: true } };
        return { value: { accepted: true } };
      },
    );
    expect(requests.map((r) => r.type)).toEqual([
      'pause_probe',
      'route_probe',
      'route_decide',
      'reserve',
      'invoke',
      'snapshot',
      'render_route_result',
      'finish',
    ]);
    const finish = requests.at(-1);
    expect(finish?.type === 'finish' ? finish.outcome : null).toBe('done');
  }, 30000);

for (const protocol of ['harness/v7'])
  test(`${protocol} pauses before an unaccepted direct decision and safely resumes without it`, async () => {
    const inputId = randomUUID(),
      factsId = randomUUID();
    const input = { messages: [{ message_id: inputId, role: 'user', content: 'route' }] };
    const start = {
      ...base,
      ...input,
      protocol,
      routing_policy: { ...routing, mode: 'enforce', direct_intents: intents },
      eligible_phase: 'fresh_first_step',
      tools: [{ name: 'get_user_prefs', description: 'read', parameters: {}, risk: 'low' }],
    };
    let pending = false;
    const first = await run(start, (r) => {
      if (r.type === 'pause_probe') return { value: { pending } };
      if (r.type === 'pause_point') return { value: { paused: true } };
      if (r.type === 'route_probe')
        return {
          value: {
            facts_ref: factsId,
            input_sha256: 'c'.repeat(64),
            bundle_sha256: 'a'.repeat(64),
            eligible: true,
            reason: null,
            rule_intent: 'prefs_timezone_read',
            candidates: [
              { intent: 'prefs_timezone_read', tool_id: 'get_user_prefs', args: {}, sources: [] },
            ],
          },
        };
      if (r.type === 'route_decide') {
        pending = true;
        return { value: { pause_requested: true } };
      }
      throw new Error(`unexpected pre-pause request ${r.type}`);
    });
    expect(first.map((r) => r.type)).toEqual([
      'pause_probe',
      'route_probe',
      'route_decide',
      'pause_probe',
      'pause_point',
    ]);
    const point = first.find((r) => r.type === 'pause_point');
    if (!point) throw new Error('missing pause');
    expect(point.context.tool_refs).toEqual([]);
    expect(point.context.usage).toEqual({ iterations: 0, tokens: 0 });
    const resumed = await run(
      { ...start, eligible_phase: 'disabled', snapshot: point.context },
      (r) => {
        if (r.type === 'pause_probe') return { value: { pending: false } };
        if (r.type === 'measure_context')
          return {
            value: {
              wire_bytes: 1,
              http_bytes: 1,
              input_meter: {
                quality: 'unavailable',
                input_tokens: null,
                meter_revision: 'fixture/1',
              },
              output_ceiling: 37,
              limit_reason: null,
            },
          };
        if (r.type === 'model')
          return {
            value: {
              type: 'failed',
              error: { code: 'FIXTURE', message: 'stop' },
              usage: { total_tokens: 3 },
            },
          };
        if (r.type === 'finish') return { value: { accepted: true } };
        throw new Error(`unexpected post-pause request ${r.type}`);
      },
    );
    expect(
      resumed.some((r) => ['route_decide', 'route_probe', 'reserve', 'invoke'].includes(r.type)),
    ).toBe(false);
    expect(resumed.find((r) => r.type === 'finish')?.usage).toEqual({ iterations: 1, tokens: 3 });
  }, 30000);

for (const protocol of ['harness/v7'])
  test(`${protocol} pauses after route fallback before model work`, async () => {
    const id = randomUUID(),
      factsId = randomUUID();
    const input = { messages: [{ message_id: id, role: 'user', content: 'route' }] };
    let pending = false;
    const requests = await run(
      { ...base, ...input, protocol, routing_policy: routing, eligible_phase: 'fresh_first_step' },
      (r) => {
        if (r.type === 'pause_probe') return { value: { pending } };
        if (r.type === 'route_probe') {
          pending = true;
          return {
            value: {
              facts_ref: factsId,
              input_sha256: 'c'.repeat(64),
              bundle_sha256: 'a'.repeat(64),
              eligible: false,
              reason: 'CONTEXT_UNKNOWN',
              rule_intent: null,
              candidates: [],
            },
          };
        }
        if (r.type === 'route_decide')
          return {
            value: {
              decision_ref: randomUUID(),
              decision: 'fallback',
              intent: null,
              tool_id: null,
              args: null,
            },
          };
        if (r.type === 'pause_point') return { value: { paused: true } };
        throw new Error(`unexpected ${r.type}`);
      },
    );
    expect(requests.map((r) => r.type)).toEqual([
      'pause_probe',
      'route_probe',
      'route_decide',
      'pause_probe',
      'pause_point',
    ]);
  }, 30000);
for (const protocol of ['harness/v7'] as const) {
  for (const deferred of ['model', 'reserve'] as const) {
    test(`${protocol} resumes a deferred ${deferred} without replaying accepted tools or resetting usage`, async () => {
      const inputId = randomUUID();
      const firstId = randomUUID();
      const secondId = randomUUID();
      const input = {
        messages: [{ message_id: inputId, role: 'user', content: 'read preferences twice' }],
      };
      const start = {
        ...base,
        ...input,
        protocol,
        tools: [{ name: 'get_user_prefs', description: 'read', parameters: {}, risk: 'low' }],
      };
      const measurement = {
        wire_bytes: 1,
        http_bytes: 1,
        input_meter: { quality: 'unavailable', input_tokens: null, meter_revision: 'fixture/1' },
        output_ceiling: 37,
        limit_reason: null,
      };
      const modelTool = (callId: string, tokens: number) => ({
        type: 'complete',
        reply: {
          message: {
            content: null,
            tool_calls: [
              {
                id: callId,
                type: 'function',
                function: { name: 'get_user_prefs', arguments: '{}' },
              },
            ],
          },
          usage: { total_tokens: tokens },
        },
      });
      const toolResult = (invocationId: string) => ({
        status: 'ok',
        invocationId,
        replayed: false,
        result: {
          kind: 'prefs',
          timezone_id: null,
          alias_version: 'fixture',
          quiet_hours: null,
          locale: null,
        },
      });
      let pending = false;
      let models = 0;
      const before = await run(start, (r) => {
        if (r.type === 'pause_probe') return { value: { pending } };
        if (r.type === 'pause_point') return { value: { paused: true } };
        if (r.type === 'measure_context') return { value: measurement };
        if (r.type === 'model') {
          models++;
          if (models === 1) return { value: modelTool('first-call', 5) };
          if (deferred === 'model') {
            pending = true;
            return { value: { type: 'pause_requested' } };
          }
          return { value: modelTool('second-call', 7) };
        }
        if (r.type === 'reserve') {
          if (r.call_key === 'harness/1') return { value: { invocation_id: firstId } };
          if (deferred !== 'reserve') throw new Error('unexpected second reservation');
          pending = true;
          return { value: { pause_requested: true } };
        }
        if (r.type === 'invoke') {
          expect(r.invocation_id).toBe(firstId);
          return { value: toolResult(firstId) };
        }
        throw new Error(`unexpected pre-pause request ${r.type}`);
      });
      const pause = before.find((r) => r.type === 'pause_point');
      if (!pause || pause.context.version !== 3) throw new Error('missing deferred safe point');
      const snapshot = pause.context;
      expect(snapshot.tool_refs).toEqual([firstId]);
      expect(snapshot.next_call_no).toBe(2);
      expect(snapshot.usage).toEqual(
        deferred === 'model' ? { iterations: 1, tokens: 5 } : { iterations: 2, tokens: 12 },
      );
      expect(snapshot.native_state.pending_model).toEqual(
        deferred === 'model' ? null : modelTool('second-call', 7).reply.message,
      );
      expect(before.filter((r) => r.type === 'invoke')).toHaveLength(1);

      let resumedModels = 0;
      const after = await run(
        {
          ...start,
          snapshot,
          observations: snapshot.native_state.units.map((unit) => unit.observation),
        },
        (r) => {
          if (r.type === 'pause_probe') return { value: { pending: false } };
          if (r.type === 'measure_context') return { value: measurement };
          if (r.type === 'model') {
            resumedModels++;
            if (deferred === 'model' && resumedModels === 1)
              return { value: modelTool('second-call', 7) };
            return {
              value: {
                type: 'failed',
                error: { code: 'FIXTURE', message: 'stop' },
                usage: { total_tokens: 3 },
              },
            };
          }
          if (r.type === 'reserve') {
            expect(r.call_key).toBe('harness/2');
            return { value: { invocation_id: secondId } };
          }
          if (r.type === 'invoke') {
            expect(r.invocation_id).toBe(secondId);
            return { value: toolResult(secondId) };
          }
          if (r.type === 'finish') return { value: { accepted: true } };
          throw new Error(`unexpected post-pause request ${r.type}`);
        },
      );
      expect(after.filter((r) => r.type === 'reserve')).toHaveLength(1);
      expect(after.filter((r) => r.type === 'invoke')).toHaveLength(1);
      expect(after.filter((r) => r.type === 'model')).toHaveLength(deferred === 'model' ? 2 : 1);
      const finish = after.find((r) => r.type === 'finish');
      expect(finish?.usage).toEqual({ iterations: 3, tokens: 15 });
    }, 30000);
  }
}

test('v6 restores snapshot 2 without sending pause frames', async () => {
  const id = randomUUID();
  const requests = await run(
    {
      ...base,
      protocol: 'harness/v6',
      messages: [{ message_id: id, role: 'user', content: 'continue' }],
      snapshot: {
        version: 2,
        message_refs: [id],
        tool_refs: [],
        next_call_no: 1,
        usage: { iterations: 1, tokens: 5 },
        waiting: null,
      },
    },
    (r) => {
      if (r.type === 'measure_context')
        return {
          value: {
            wire_bytes: 1,
            http_bytes: 1,
            input_meter: {
              quality: 'unavailable',
              input_tokens: null,
              meter_revision: 'fixture/1',
            },
            output_ceiling: 37,
            limit_reason: null,
          },
        };
      if (r.type === 'model')
        return {
          value: {
            type: 'failed',
            error: { code: 'FIXTURE', message: 'stop' },
            usage: { total_tokens: 3 },
          },
        };
      if (r.type === 'finish') return { value: { accepted: true } };
      throw new Error(`unexpected v6 request ${r.type}`);
    },
  );
  expect(requests.map((r) => r.type)).toEqual(['measure_context', 'model', 'finish']);
  const finish = requests.find((r) => r.type === 'finish');
  expect(finish?.usage).toEqual({ iterations: 2, tokens: 8 });
}, 30000);

test('v7 drains a streaming answer before pause and does not replay it after continue', async () => {
  const id = randomUUID();
  const start = {
    ...base,
    protocol: 'harness/v7',
    messages: [{ message_id: id, role: 'user', content: 'answer' }],
  };
  let pending = false;
  const before = await run(start, (r) => {
    if (r.type === 'pause_probe') return { value: { pending } };
    if (r.type === 'pause_point') return { value: { paused: true } };
    if (r.type === 'measure_context')
      return {
        value: {
          wire_bytes: 1,
          http_bytes: 1,
          input_meter: { quality: 'unavailable', input_tokens: null, meter_revision: 'fixture/1' },
          output_ceiling: 37,
          limit_reason: null,
        },
      };
    if (r.type === 'model') {
      pending = true;
      return { value: { type: 'delta', delta: 'hello' } };
    }
    if (r.type === 'answer') return { value: { accepted: true } };
    if (r.type === 'model_next')
      return {
        value: {
          type: 'complete',
          reply: { message: { content: 'hello', tool_calls: [] }, usage: { total_tokens: 7 } },
        },
      };
    throw new Error(`unexpected pre-pause request ${r.type}`);
  });
  const point = before.find((r) => r.type === 'pause_point');
  if (!point) throw new Error('missing pause');
  expect(before.map((r) => r.type)).toEqual([
    'pause_probe',
    'pause_probe',
    'measure_context',
    'model',
    'answer',
    'model_next',
    'pause_probe',
    'pause_point',
  ]);
  expect(point.context.usage).toEqual({ iterations: 1, tokens: 7 });
  expect(point.context.native_state.pending_model).toEqual({ content: 'hello', tool_calls: [] });
  const after = await run({ ...start, snapshot: point.context }, (r) => {
    if (r.type === 'pause_probe') return { value: { pending: false } };
    if (r.type === 'snapshot') return { value: { checkpoint_ref: randomUUID() } };
    if (r.type === 'finish') return { value: { accepted: true } };
    throw new Error(`unexpected continued request ${r.type}`);
  });
  expect(after.map((r) => r.type)).toEqual([
    'pause_probe',
    'pause_probe',
    'pause_probe',
    'snapshot',
    'finish',
  ]);
  const finish = after.find((r) => r.type === 'finish');
  expect(finish?.usage).toEqual({ iterations: 1, tokens: 7 });
}, 30000);

test('v6 rejects a v3 pause snapshot', async () => {
  const id = randomUUID();
  const requests = await run(
    {
      ...base,
      protocol: 'harness/v6',
      messages: [{ message_id: id, role: 'user', content: 'continue' }],
      snapshot: {
        version: 3,
        message_refs: [id],
        tool_refs: [],
        next_call_no: 1,
        usage: { iterations: 0, tokens: 0 },
        waiting: null,
        native_state: {
          protected_messages: [],
          units: [],
          hard_denied: '',
          closing_goal: false,
          pending_model: null,
        },
      },
    },
    (r) => {
      throw new Error(`unexpected request ${r.type}`);
    },
    2,
  );
  expect(requests).toEqual([]);
}, 30000);

test('v7 delegated memory uses only frozen tools and validates recalled source references', async () => {
  const inputId = randomUUID();
  const ids = Array.from({ length: 129 }, () => randomUUID());
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
  const tool = { name: 'recall_memories', description: 'recall', parameters: {}, risk: 'low' };
  const start = {
    ...base,
    protocol: 'harness/v7',
    trusted_context: trusted,
    messages: [{ message_id: inputId, role: 'user', content: 'recall' }],
    tools: [tool],
  };
  for (const example of [
    { ids: ids.slice(0, 1), accepted: true },
    { ids: ids.slice(0, 128), accepted: true },
    { ids: [], accepted: false },
    { ids: [ids[0], ids[0]], accepted: false },
    { ids, accepted: false },
    { ids: [], accepted: true, saved: true, content: 'fact' },
    { ids: [], accepted: false, saved: true, content: '' },
  ]) {
    let models = 0;
    const selectedTool = example.saved ? 'remember_memory' : 'recall_memories';
    const requests = await run(
      { ...start, tools: [{ ...tool, name: selectedTool }] },
      (r) => {
        if (r.type === 'pause_probe') return { value: { pending: false } };
        if (r.type === 'measure_context')
          return {
            value: {
              wire_bytes: 1,
              http_bytes: 1,
              input_meter: {
                quality: 'unavailable',
                input_tokens: null,
                meter_revision: 'fixture/1',
              },
              output_ceiling: 37,
              limit_reason: null,
            },
          };
        if (r.type === 'model') {
          models++;
          if (models > 1)
            return {
              value: { type: 'failed', error: { code: 'FIXTURE', message: 'stop' }, usage: null },
            };
          expect(JSON.stringify(r.messages)).toContain('low-trust historical candidates');
          return {
            value: {
              type: 'complete',
              reply: {
                message: {
                  content: null,
                  tool_calls: [
                    {
                      id: 'memory',
                      type: 'function',
                      function: { name: selectedTool, arguments: '{}' },
                    },
                  ],
                },
                usage: { total_tokens: 1 },
              },
            },
          };
        }
        if (r.type === 'reserve') return { value: { invocation_id: randomUUID() } };
        if (r.type === 'invoke')
          return {
            value: {
              status: 'ok',
              invocationId: r.invocation_id,
              replayed: false,
              result: example.saved
                ? { kind: 'memory_saved', memory_id: randomUUID(), content: example.content }
                : {
                    kind: 'memory_recall',
                    completeness: 'degraded',
                    items: [
                      {
                        memory_id: randomUUID(),
                        content: 'fact',
                        conversation_id: randomUUID(),
                        message_ids: example.ids,
                        created_at: '2026-11-01T00:00:00Z',
                        updated_at: '2026-11-01T00:00:00Z',
                      },
                    ],
                  },
            },
          };
        if (r.type === 'finish') return { value: { accepted: true } };
        throw new Error(`unexpected request ${r.type}`);
      },
      example.accepted ? 0 : 2,
    );
    expect(requests.filter((r) => r.type === 'model')).toHaveLength(example.accepted ? 2 : 1);
  }
  for (const protocol of ['harness/v6', 'harness/v7']) {
    const requests = await run(
      { ...start, protocol, tools: [{ ...tool, name: 'read_memory_source' }] },
      () => ({}),
      2,
    );
    expect(requests).toEqual([]);
  }
  const denied = await run({ ...start, tools: [] }, (r) => {
    if (r.type === 'pause_probe') return { value: { pending: false } };
    if (r.type === 'measure_context')
      return {
        value: {
          wire_bytes: 1,
          http_bytes: 1,
          input_meter: { quality: 'unavailable', input_tokens: null, meter_revision: 'fixture/1' },
          output_ceiling: 37,
          limit_reason: null,
        },
      };
    if (r.type === 'model')
      return {
        value: {
          type: 'complete',
          reply: {
            message: {
              content: null,
              tool_calls: [
                {
                  id: 'unlisted',
                  type: 'function',
                  function: { name: 'remember_memory', arguments: '{}' },
                },
              ],
            },
            usage: { total_tokens: 1 },
          },
        },
      };
    if (r.type === 'finish') return { value: { accepted: true } };
    throw new Error(`unexpected request ${r.type}`);
  });
  expect(denied.some((r) => r.type === 'reserve' || r.type === 'invoke')).toBe(false);
  expect(await run({ ...start, protocol: 'harness/v6' }, () => ({}), 2)).toEqual([]);
});
