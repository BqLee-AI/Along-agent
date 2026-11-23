import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  HarnessR3ContextStartSchema,
  HarnessRequestSchema,
  HarnessR3SnapshotSchema,
  type HarnessRequest,
} from '@along/contracts';

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
  const decoder = new TextDecoder();
  for await (const bytes of child.stdout) {
    buffer += decoder.decode(bytes, { stream: true });
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

test('only v8 restores successful Docx bodies from saved units without bootstrap duplicates', async () => {
  const inputId = randomUUID();
  const context = {
    manifest: { message_ids: [] },
    summary: null,
    messages: [],
    input: { type: 'user', message_id: inputId, content: 'Use the retained receipts.' },
  };
  const trusted_context = {
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
  const docx = Array.from({ length: 3 }, (_, i) => ({
    view: 'full',
    invocation_id: randomUUID(),
    tool_id: 'feishu_docx_read',
    result: {
      status: 'ok',
      result: {
        kind: 'feishu_docx_read',
        source: {
          type: 'feishu_docx',
          identity: 'bot',
          url: `https://fixture.feishu.cn/docx/${String(i).repeat(27)}`,
          title: `Fixture ${i}`,
        },
        revision: { before: 1, after: 1 },
        fetched_at: '2026-11-02T12:00:00.000Z',
        content_hash: 'a'.repeat(64),
        representation: 'plain_text',
        completeness: 'complete_plain_text',
        content: `DOCX_${i}_START${'&'.repeat(180_000)}DOCX_${i}_TAIL`,
      },
    },
  }));
  const other = {
    view: 'full',
    invocation_id: randomUUID(),
    tool_id: 'set_user_timezone',
    result: {
      status: 'ok',
      result: {
        kind: 'timezone_setting',
        timezone_id: 'UTC',
        previous_timezone_id: null,
        alias_version: 'fixture',
      },
    },
  };
  const full = [docx[0]!, other, ...docx.slice(1)];
  const state = {
    protected_messages: [{ role: 'user', content: context.input.content }],
    units: full.map((observation) => ({
      entries: [
        { role: 'user', content: 'Reconstruct Docx disclosure from the immutable result.' },
      ],
      observation,
      seen: true,
      projected: false,
    })),
    hard_denied: '',
    closing_goal: false,
    pending_model: null,
  };
  const snapshot = {
    version: 4,
    original_manifest: context.manifest,
    original_summary: null,
    context,
    tool_refs: full.map((observation) => observation.invocation_id),
    next_call_no: full.length + 1,
    usage: { iterations: 1, tokens: 5 },
    waiting: null,
    native_state: { ...state, history_index: 0 },
  };
  const start = {
    ...base,
    protocol: 'harness/v8',
    trusted_context,
    r3_context: context,
    tools: ['feishu_docx_read', 'set_user_timezone'].map((name) => ({
      name,
      description: 'Fixture',
      parameters: {},
      risk: 'low',
    })),
    snapshot,
    observations: [other],
  };
  expect(Buffer.byteLength(JSON.stringify(start))).toBeLessThan(1_048_576);
  expect(Buffer.byteLength(JSON.stringify({ ...start, observations: full }))).toBeGreaterThan(
    1_048_576,
  );
  const resumed = await run(start, (r) => {
    if (r.type === 'pause_probe') return { value: { pending: true } };
    if (r.type === 'pause_point') {
      expect(r.context).toMatchObject({
        tool_refs: snapshot.tool_refs,
        native_state: { units: state.units.map(({ observation }) => ({ observation })) },
      });
      return { value: { paused: true } };
    }
    throw new Error(`unexpected request ${r.type}`);
  });
  expect(resumed.map((r) => r.type)).toEqual(['pause_probe', 'pause_point']);
  const [preview] = await run({ ...start, mode: 'measure_only' }, () => ({
    value: { accepted: true },
  }));
  if (preview?.type !== 'context_preview') throw new Error('missing preview');
  for (let i = 0; i < docx.length; i++) {
    expect(JSON.stringify(preview.messages)).toContain(`DOCX_${i}_START`);
    expect(JSON.stringify(preview.messages)).not.toContain(`DOCX_${i}_TAIL`);
  }

  const missingBody = structuredClone(start);
  Object.assign(missingBody.snapshot.native_state.units[0]!.observation.result.result, {
    content: undefined,
  });
  for (const invalid of [missingBody, { ...start, observations: [] }])
    expect(await run(invalid, () => ({}), 2)).toEqual([]);

  const v7 = {
    ...base,
    protocol: 'harness/v7',
    trusted_context,
    messages: [{ message_id: inputId, role: 'user', content: context.input.content }],
    tools: start.tools,
    snapshot: {
      version: 3,
      message_refs: [inputId],
      tool_refs: [docx[0]!.invocation_id],
      next_call_no: 2,
      usage: snapshot.usage,
      waiting: null,
      native_state: { ...state, units: state.units.slice(0, 1) },
    },
    observations: docx.slice(0, 1),
  };
  expect(await run({ ...v7, observations: [] }, () => ({}), 2)).toEqual([]);
  const old = await run(v7, (r) => ({
    value: r.type === 'pause_probe' ? { pending: true } : { paused: true },
  }));
  expect(old.map((r) => r.type)).toEqual(['pause_probe', 'pause_point']);
}, 30_000);

test('native office resumes the exact accepted source and receipt pairs without resetting budget', async () => {
  const inputId = randomUUID();
  const artifactsId = randomUUID();
  const ids = [randomUUID(), randomUUID(), randomUUID()];
  const source = { display_name: 'fixture', version: 'a'.repeat(64) };
  const totals = {
    total: 1,
    todo: 1,
    in_progress: 0,
    done: 0,
    canceled: 0,
    overdue: 1,
    anomaly_rows: 0,
    missing_owner: 0,
    missing_due_date: 0,
    invalid_due_date: 0,
    invalid_status: 0,
  };
  const payloads = [
    {
      kind: 'office_read_notes',
      source,
      offset: 0,
      start_line: 1,
      end_line: 1,
      total_lines: 2,
      content: '私有纪要片段',
      next_offset: Buffer.byteLength('私有纪要片段'),
    },
    {
      kind: 'office_analyze_tasks',
      action: 'analyze',
      source,
      as_of: '2028-02-29',
      after_record: 0,
      total_records: 1,
      total_groups: 1,
      totals,
      groups: [{ owner: '甲', owner_truncated: false, totals }],
      records: [
        {
          record_number: 1,
          task_id: '001',
          title: 'review',
          owner: '甲',
          due_date: '2028-02-28',
          status: 'todo',
          overdue: true,
          anomalies: [],
          truncated_fields: [],
        },
      ],
      next_after_record: null,
    },
    {
      kind: 'office_create_artifacts',
      artifacts: [
        { artifact_id: artifactsId, format: 'markdown', filename: 'report.md', size_bytes: 35 },
      ],
    },
  ];
  const tools = payloads.map(({ kind: name }) => ({
    name,
    description: 'Office fixture',
    risk: 'low',
    parameters: {},
  }));
  const start = {
    ...base,
    protocol: 'harness/v8',
    tools,
    budget: { max_iterations: 8, max_tokens: 1000 },
    r3_context: {
      manifest: { message_ids: [] },
      messages: [],
      summary: null,
      input: {
        type: 'user',
        message_id: inputId,
        content: 'Use the notes and task analysis to make a report.',
      },
    },
    trusted_context: {
      version: 1,
      authorization_revision: 'delegation/1',
      execution_lifecycle: 'server-owned',
      input_message_id: inputId,
      received_at_utc: '2028-02-29T12:00:00Z',
      request_anchor_utc: '2028-02-29T12:00:00Z',
      continuation: null,
      timezone: null,
      time_capabilities: { elapsed_revision: null, wall_rules: null },
      workspaces: [],
    },
  };
  expect(HarnessR3ContextStartSchema.safeParse(start).success).toBe(true);
  expect(await run({ ...start, trusted_context: null }, () => ({}), 2)).toEqual([]);
  expect(
    await run(
      {
        ...start,
        tools: [
          ...tools,
          { name: 'remember_memory', description: 'remember', risk: 'low', parameters: {} },
        ],
      },
      () => ({}),
      2,
    ),
  ).toEqual([]);
  const calls = [
    { name: tools[0]!.name, arguments: '{"attachment_id":"not-an-authorized-argument"}' },
    { name: tools[0]!.name, arguments: '{}' },
    { name: tools[1]!.name, arguments: '{"action":"analyze"}' },
    {
      name: tools[2]!.name,
      arguments: JSON.stringify({
        formats: ['markdown'],
        notes_invocation_ids: [ids[0]],
        analysis_invocation_id: ids[1],
      }),
    },
  ];
  const measurement = {
    wire_bytes: 1,
    http_bytes: 1,
    input_meter: { quality: 'unavailable', input_tokens: null, meter_revision: 'unavailable/1' },
    output_ceiling: 37,
    limit_reason: null,
  };
  const malformed = await run(
    start,
    (r) => {
      if (r.type === 'pause_probe') return { value: { pending: false } };
      if (r.type === 'measure_context') return { value: measurement };
      if (r.type === 'model')
        return {
          value: {
            type: 'complete',
            reply: {
              message: {
                content: null,
                tool_calls: [{ id: 'malformed', type: 'function', function: calls[1] }],
              },
              usage: { total_tokens: 1 },
            },
          },
        };
      if (r.type === 'reserve') return { value: { invocation_id: ids[0] } };
      if (r.type === 'invoke')
        return {
          value: {
            status: 'ok',
            invocationId: ids[0],
            replayed: false,
            result: { ...payloads[0], bytes: 'private-file-bytes' },
          },
        };
      throw new Error(`malformed tool result crossed the native boundary at ${r.type}`);
    },
    2,
  );
  expect(malformed.at(-1)?.type).toBe('invoke');

  let modelRound = 0;
  let pending = false;
  const first = await run(start, (r) => {
    if (r.type === 'pause_probe') return { value: { pending } };
    if (r.type === 'pause_point') return { value: { paused: true } };
    if (r.type === 'measure_context') return { value: measurement };
    if (r.type === 'model') {
      const fn = calls[modelRound++];
      if (!fn) throw new Error('unexpected extra model round');
      return {
        value: {
          type: 'complete',
          reply: {
            message: {
              content: null,
              tool_calls: [{ id: `call-${modelRound}`, type: 'function', function: fn }],
            },
            usage: { total_tokens: 7 },
          },
        },
      };
    }
    if (r.type === 'reserve') {
      expect(r.call_key).toBe(`harness/${modelRound - 1}`);
      expect(r.tool_id).toBe(tools[modelRound - 2]!.name);
      return { value: { invocation_id: ids[modelRound - 2] } };
    }
    if (r.type === 'invoke') {
      const index = modelRound - 2;
      pending = index === 2;
      return {
        value: {
          status: 'ok',
          invocationId: ids[index],
          replayed: false,
          result: payloads[index],
        },
      };
    }
    throw new Error(`unexpected request ${r.type}`);
  });
  const point = first.find((r) => r.type === 'pause_point');
  if (point?.context.version !== 4) throw new Error('missing office v4 pause');
  const snapshot = point.context;
  expect(snapshot.next_call_no).toBe(4);
  expect(snapshot.tool_refs).toEqual(ids);
  expect(snapshot.usage).toEqual({ iterations: 4, tokens: 28 });
  const observations = snapshot.native_state.units.map(({ observation }) => observation);
  const resume = { ...start, snapshot, observations };
  expect(HarnessR3ContextStartSchema.safeParse(resume).success).toBe(true);
  const missing = { ...resume, observations: observations.slice(1) };
  const changed = {
    ...resume,
    observations: [
      {
        ...observations[0],
        result: {
          status: 'ok',
          result: { ...payloads[0], source: { ...source, version: 'b'.repeat(64) } },
        },
      },
      ...observations.slice(1),
    ],
  };
  for (const invalid of [missing, changed]) {
    expect(HarnessR3ContextStartSchema.safeParse(invalid).success).toBe(false);
    expect(await run(invalid, () => ({}), 2)).toEqual([]);
  }
  const unpaired = structuredClone(resume);
  unpaired.snapshot.native_state.units[0]!.entries[1] = {
    role: 'tool',
    tool_call_id: 'call-2',
    content: '{}',
  };
  expect(await run(unpaired, () => ({}), 2)).toEqual([]);

  const [preview] = await run({ ...resume, mode: 'measure_only' }, () => ({
    value: { accepted: true },
  }));
  const resumed = await run(resume, (r) => {
    if (r.type === 'pause_probe') return { value: { pending: false } };
    if (r.type === 'measure_context') return { value: measurement };
    if (r.type === 'model')
      return {
        value: {
          type: 'complete',
          reply: {
            usage: { total_tokens: 3 },
            message: {
              content: null,
              tool_calls: [
                {
                  id: 'finish',
                  type: 'function',
                  function: {
                    name: 'finish_goal',
                    arguments: JSON.stringify({
                      status: 'completed',
                      outcomes: [
                        { status: 'achieved', description: 'Report', receipt_refs: [ids[2]] },
                      ],
                      clarification: null,
                      answer: 'Report created.',
                    }),
                  },
                },
              ],
            },
          },
        },
      };
    if (r.type === 'finish_goal') {
      expect(r.usage).toEqual({ iterations: 5, tokens: 31 });
      expect(r.goal_result.outcomes[0]?.receipt_refs).toEqual([ids[2]]);
      return { value: { accepted: true } };
    }
    throw new Error(`unexpected recovery request ${r.type}`);
  });
  const model = resumed.find((r) => r.type === 'model');
  if (preview?.type !== 'context_preview' || model?.type !== 'model')
    throw new Error('missing model context');
  expect(preview.remaining_tokens).toBe(972);
  expect(model.remaining_tokens).toBe(preview.remaining_tokens);
  expect(model.messages).toEqual(preview.messages);
  const toolMessages = model.messages.filter((message) => message.role === 'tool');
  expect(toolMessages.map(({ content }) => JSON.parse(content))).toEqual(observations);

  const delivery = {
    invocation_id: ids[2],
    tool_id: 'office_create_artifacts',
    result: { status: 'ok', result: payloads[2] },
  };
  const prior = {
    run_id: randomUUID(),
    invocation_id: null,
    original_input_message_id: randomUUID(),
    original_text: 'Make a report, then remind me on March 1 at 9 AM.',
    goal_result: {
      status: 'partial',
      answer: 'PRIVATE_PREVIOUS_MODEL_TEXT',
      outcomes: [
        { status: 'achieved', description: 'Report', receipt_refs: [ids[2]] },
        { status: 'blocked', description: 'Reminder', receipt_refs: [] },
      ],
      clarification: { kind: 'timezone', question: 'What timezone?' },
    },
    receipts: [delivery],
    source_result: null,
  };
  const continuation = {
    ...start,
    tools: [{ name: 'create_reminder', description: 'reminder', risk: 'low', parameters: {} }],
    trusted_context: { ...start.trusted_context, continuation: prior },
  };
  expect(HarnessR3ContextStartSchema.safeParse(continuation).success).toBe(true);
  const unrelated = {
    ...continuation,
    trusted_context: {
      ...continuation.trusted_context,
      continuation: { ...prior, receipts: [{ ...delivery, invocation_id: randomUUID() }] },
    },
  };
  for (const invalid of [unrelated, { ...continuation, tools }]) {
    expect(HarnessR3ContextStartSchema.safeParse(invalid).success).toBe(false);
    expect(await run(invalid, () => ({}), 2)).toEqual([]);
  }
  await run(continuation, (r) => {
    if (r.type === 'pause_probe') return { value: { pending: false } };
    if (r.type === 'measure_context') return { value: measurement };
    if (r.type === 'model') {
      expect(JSON.stringify(r.messages)).toContain(artifactsId);
      expect(JSON.stringify(r.messages)).not.toContain('PRIVATE_PREVIOUS_MODEL_TEXT');
      return {
        value: {
          type: 'complete',
          reply: {
            usage: { total_tokens: 2 },
            message: {
              content: null,
              tool_calls: [
                {
                  id: 'continue',
                  type: 'function',
                  function: { name: 'finish_goal', arguments: JSON.stringify(prior.goal_result) },
                },
              ],
            },
          },
        },
      };
    }
    if (r.type === 'finish_goal') {
      expect(r.goal_result.outcomes[0]?.receipt_refs).toEqual([ids[2]]);
      return { value: { accepted: true } };
    }
    throw new Error(`unexpected continuation request ${r.type}`);
  });
}, 30_000);

test('v8 compact resume replaces only history and retains protected state and unknown usage', async () => {
  const id = randomUUID(),
    inputId = randomUUID();
  const context = {
    manifest: { message_ids: [id] },
    summary: null,
    messages: [{ message_id: id, role: 'user', content: 'old historical fact' }],
    input: { type: 'user', message_id: inputId, content: 'complete current input' },
  };
  const first = await run({ ...base, protocol: 'harness/v8', r3_context: context }, (r) => ({
    value: r.type === 'pause_probe' ? { pending: true } : { paused: true },
  }));
  const pause = first.find((r) => r.type === 'pause_point');
  if (!pause || pause.context.version !== 4) throw new Error('missing v4 pause');
  const snapshot = HarnessR3SnapshotSchema.parse(pause.context);
  snapshot.native_state.protected_messages.push({
    role: 'system',
    content: 'protected later feedback',
  });
  snapshot.usage = { iterations: 1, tokens: null };
  const next = {
    ...context,
    summary: { id: randomUUID(), revision: '1', text: 'new summary', message_ids: [id] },
    messages: [],
  };
  const pausedAgain = await run(
    { ...base, protocol: 'harness/v8', r3_context: next, snapshot },
    (r) => ({ value: r.type === 'pause_probe' ? { pending: true } : { paused: true } }),
  );
  const secondPause = pausedAgain.find((r) => r.type === 'pause_point');
  if (!secondPause || secondPause.context.version !== 4)
    throw new Error('missing repeated v4 pause');
  const secondSnapshot = HarnessR3SnapshotSchema.parse(secondPause.context);
  expect(secondSnapshot.context.summary?.text).toBe('new summary');
  const previewOnly = await run(
    {
      ...base,
      protocol: 'harness/v8',
      mode: 'measure_only',
      r3_context: next,
      snapshot: secondSnapshot,
    },
    (r) => {
      if (r.type !== 'context_preview') throw new Error(`unexpected dry-run request ${r.type}`);
      return { value: { accepted: true } };
    },
  );
  expect(previewOnly.map((r) => r.type)).toEqual(['context_preview']);
  const preview = previewOnly[0];
  if (!preview || preview.type !== 'context_preview') throw new Error('missing preview');
  expect(preview.pending_model).toBe(false);
  expect(preview.remaining_tokens).toBeNull();
  expect(JSON.stringify(preview.messages)).toContain('protected later feedback');
  expect(JSON.stringify(preview.messages)).toContain('new summary');
  const pendingSnapshot = HarnessR3SnapshotSchema.parse(secondSnapshot);
  pendingSnapshot.native_state.pending_model = { content: 'pending response', tool_calls: [] };
  pendingSnapshot.usage = { iterations: 1, tokens: 990 };
  const pendingPreview = await run(
    {
      ...base,
      protocol: 'harness/v8',
      mode: 'measure_only',
      r3_context: next,
      snapshot: pendingSnapshot,
    },
    () => ({ value: { accepted: true } }),
  );
  expect(pendingPreview[0]).toMatchObject({
    type: 'context_preview',
    pending_model: true,
    remaining_tokens: 10,
    max_output_tokens: 10,
  });
  if (pendingPreview[0]?.type !== 'context_preview') throw new Error('missing pending preview');
  expect(pendingPreview[0].messages.at(-1)).toEqual({
    role: 'assistant',
    content: 'pending response',
  });
  pendingSnapshot.native_state.pending_model = {
    content: null,
    tool_calls: [
      {
        id: 'pending-call',
        type: 'function',
        function: { name: 'get_user_prefs', arguments: '{}' },
      },
    ],
  };
  const toolPreview = await run(
    {
      ...base,
      protocol: 'harness/v8',
      mode: 'measure_only',
      r3_context: next,
      snapshot: pendingSnapshot,
    },
    () => ({ value: { accepted: true } }),
  );
  if (toolPreview[0]?.type !== 'context_preview') throw new Error('missing tool preview');
  expect(toolPreview[0].messages.at(-1)).toEqual({
    role: 'assistant',
    content: '',
    tool_calls: pendingSnapshot.native_state.pending_model.tool_calls,
  });
  const resumed = await run(
    { ...base, protocol: 'harness/v8', r3_context: next, snapshot: secondSnapshot },
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
          value: { type: 'failed', error: { code: 'FIXTURE', message: 'stop' }, usage: null },
        };
      return { value: { accepted: true } };
    },
  );
  const model = resumed.find((r) => r.type === 'model');
  if (!model || model.type !== 'model') throw new Error('missing model request');
  expect(preview.messages).toEqual(model.messages);
  expect(preview.remaining_tokens).toBe(model.remaining_tokens);
  expect(preview.max_output_tokens).toBe(model.max_output_tokens);
  const text = JSON.stringify(model.messages);
  expect(text).toContain('new summary');
  expect(text).not.toContain('old historical fact');
  expect(text).toContain('complete current input');
  expect(text).toContain('protected later feedback');
  expect(model.remaining_tokens).toBeNull();
  const finish = resumed.at(-1);
  expect(finish?.type === 'finish' ? finish.usage.tokens : 'missing').toBeNull();
}, 30000);

for (const protocol of ['harness/v7', 'harness/v8'])
  test(`${protocol} probes pause before routing on fresh runs`, async () => {
    const id = randomUUID();
    const input =
      protocol === 'harness/v7'
        ? { messages: [{ message_id: id, role: 'user', content: 'route' }] }
        : {
            r3_context: {
              manifest: { message_ids: [] },
              summary: null,
              messages: [],
              input: { type: 'user', message_id: id, content: 'route' },
            },
          };
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

for (const protocol of ['harness/v7', 'harness/v8'])
  test(`${protocol} completes a direct route when pause arrives inside its bounded unit`, async () => {
    const inputId = randomUUID(),
      factsId = randomUUID(),
      decisionId = randomUUID(),
      invocationId = randomUUID();
    const input =
      protocol === 'harness/v7'
        ? { messages: [{ message_id: inputId, role: 'user', content: 'route' }] }
        : {
            r3_context: {
              manifest: { message_ids: [] },
              summary: null,
              messages: [],
              input: { type: 'user', message_id: inputId, content: 'route' },
            },
          };
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

for (const protocol of ['harness/v7', 'harness/v8'])
  test(`${protocol} pauses before an unaccepted direct decision and safely resumes without it`, async () => {
    const inputId = randomUUID(),
      factsId = randomUUID();
    const input =
      protocol === 'harness/v7'
        ? { messages: [{ message_id: inputId, role: 'user', content: 'route' }] }
        : {
            r3_context: {
              manifest: { message_ids: [] },
              summary: null,
              messages: [],
              input: { type: 'user', message_id: inputId, content: 'route' },
            },
          };
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

for (const protocol of ['harness/v7', 'harness/v8'])
  test(`${protocol} pauses after route fallback before model work`, async () => {
    const id = randomUUID(),
      factsId = randomUUID();
    const input =
      protocol === 'harness/v7'
        ? { messages: [{ message_id: id, role: 'user', content: 'route' }] }
        : {
            r3_context: {
              manifest: { message_ids: [] },
              summary: null,
              messages: [],
              input: { type: 'user', message_id: id, content: 'route' },
            },
          };
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

test('compact control pauses without inventing a user message or executing business work, then terminates after published resume', async () => {
  const id = randomUUID();
  const context = {
    manifest: { message_ids: [id] },
    summary: null,
    messages: [{ message_id: id, role: 'user', content: 'historical fact' }],
    input: { type: 'compact_control' },
  };
  const initial = await run({ ...base, protocol: 'harness/v8', r3_context: context }, (r) => {
    if (r.type === 'pause_probe') return { value: { pending: true } };
    if (r.type === 'pause_point') return { value: { paused: true } };
    throw new Error(`unexpected control request ${r.type}`);
  });
  expect(initial.map((r) => r.type)).toEqual(['pause_probe', 'pause_point']);
  const point = initial.find((r) => r.type === 'pause_point');
  if (!point || point.context.version !== 4) throw new Error('missing control snapshot');
  const snapshot = HarnessR3SnapshotSchema.parse(point.context);
  expect(snapshot.context.input).toEqual({ type: 'compact_control' });
  snapshot.usage = { iterations: 1, tokens: 19 };
  const compacted = {
    ...context,
    summary: { id: randomUUID(), revision: '1', text: 'published summary', message_ids: [id] },
    messages: [],
  };
  const preview = await run(
    { ...base, protocol: 'harness/v8', mode: 'measure_only', r3_context: compacted, snapshot },
    (r) => {
      if (r.type !== 'context_preview')
        throw new Error(`unexpected control preview request ${r.type}`);
      return { value: { accepted: true } };
    },
  );
  expect(preview.map((r) => r.type)).toEqual(['context_preview']);
  expect(preview[0]).toMatchObject({ pending_model: false, remaining_tokens: 981 });
  const resumed = await run(
    { ...base, protocol: 'harness/v8', r3_context: compacted, snapshot },
    (r) => {
      if (r.type !== 'finish') throw new Error(`unexpected resumed control request ${r.type}`);
      return { value: { accepted: true } };
    },
  );
  expect(resumed).toHaveLength(1);
  expect(resumed[0]).toMatchObject({
    type: 'finish',
    outcome: 'done',
    usage: { iterations: 1, tokens: 19 },
  });
}, 30000);

test('compact control fails if no safe-point pause was accepted', async () => {
  const context = {
    manifest: { message_ids: [] },
    summary: null,
    messages: [],
    input: { type: 'compact_control' },
  };
  const requests = await run({ ...base, protocol: 'harness/v8', r3_context: context }, (r) => {
    if (r.type === 'pause_probe') return { value: { pending: false } };
    if (r.type === 'finish') return { value: { accepted: true } };
    throw new Error(`unexpected control request ${r.type}`);
  });
  expect(requests.map((r) => r.type)).toEqual(['pause_probe', 'finish']);
  expect(requests[1]).toMatchObject({
    outcome: 'failed',
    error: { code: 'COMPACT_PAUSE_UNAVAILABLE' },
  });
}, 30000);

for (const pendingAfterMeasure of [false, true])
  test(`v8 ${pendingAfterMeasure ? 'pauses' : 'continues'} at the post-measure safe point`, async () => {
    const context = {
      manifest: { message_ids: [] },
      summary: null,
      messages: [],
      input: { type: 'user', message_id: randomUUID(), content: 'complete input' },
    };
    let measured = false;
    const requests = await run({ ...base, protocol: 'harness/v8', r3_context: context }, (r) => {
      if (r.type === 'pause_probe')
        return {
          value: { pending: measured && pendingAfterMeasure && r.after_measurement === true },
        };
      if (r.type === 'pause_point') return { value: { paused: true } };
      if (r.type === 'measure_context') {
        measured = true;
        return {
          value: {
            wire_bytes: 1,
            http_bytes: 1,
            input_meter: {
              quality: 'unavailable',
              input_tokens: null,
              meter_revision: 'fixture/1',
            },
            output_ceiling: 10,
            limit_reason: null,
          },
        };
      }
      if (r.type === 'model')
        return {
          value: {
            type: 'failed',
            error: { code: 'FIXTURE', message: 'stop' },
            usage: { total_tokens: 7 },
          },
        };
      if (r.type === 'finish') return { value: { accepted: true } };
      throw new Error(`unexpected post-measure request ${r.type}`);
    });
    const types = requests.map((r) => r.type);
    expect(types).toEqual(
      pendingAfterMeasure
        ? [
            'pause_probe',
            'pause_probe',
            'measure_context',
            'measure_context',
            'pause_probe',
            'pause_point',
          ]
        : [
            'pause_probe',
            'pause_probe',
            'measure_context',
            'measure_context',
            'pause_probe',
            'model',
            'finish',
          ],
    );
    const probes = requests.filter((r) => r.type === 'pause_probe');
    expect(probes.map((r) => r.after_measurement)).toEqual([undefined, undefined, true]);
    if (pendingAfterMeasure) {
      const point = requests.find((r) => r.type === 'pause_point');
      expect(point?.context).toMatchObject({ version: 4, usage: { iterations: 0, tokens: 0 } });
    } else {
      const finish = requests.find((r) => r.type === 'finish');
      expect(finish?.usage).toEqual({ iterations: 1, tokens: 7 });
    }
  }, 30000);

test('v8 passes bounded recalled source observations to the model as untrusted data', async () => {
  const [inputId, recallId, memoryId, sourceId, conversationId, invocationId] = Array.from(
    { length: 6 },
    () => randomUUID(),
  );
  const args = {
    recall_invocation_id: recallId,
    memory_id: memoryId,
    message_id: sourceId,
    offset: 0,
    limit: 4096,
  };
  const context = {
    manifest: { message_ids: [] },
    summary: null,
    messages: [],
    input: { type: 'user', message_id: inputId, content: 'verify a historical fact' },
  };
  let modelCount = 0;
  const requests = await run(
    {
      ...base,
      protocol: 'harness/v8',
      r3_context: context,
      tools: [
        { name: 'read_memory_source', description: 'read source', parameters: {}, risk: 'low' },
      ],
    },
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
        modelCount++;
        if (modelCount === 1)
          return {
            value: {
              type: 'complete',
              reply: {
                message: {
                  content: null,
                  tool_calls: [
                    {
                      id: 'source-call',
                      type: 'function',
                      function: { name: 'read_memory_source', arguments: JSON.stringify(args) },
                    },
                  ],
                },
                usage: { total_tokens: 1 },
              },
            },
          };
        return {
          value: { type: 'failed', error: { code: 'FIXTURE', message: 'stop' }, usage: null },
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
              kind: 'memory_source',
              ...args,
              conversation_id: conversationId,
              role: 'user',
              content: 'A😀',
              end: 2,
              total: 2,
              has_more: false,
              limit: undefined,
            },
          },
        };
      if (r.type === 'finish') return { value: { accepted: true } };
      throw new Error(`unexpected source request ${r.type}`);
    },
  );
  const models = requests.filter((r) => r.type === 'model');
  expect(models).toHaveLength(2);
  expect(JSON.stringify(models[0].messages)).toContain('unverified derived candidates');
  expect(JSON.stringify(models[1].messages)).toContain('A😀');
}, 30000);

for (const protocol of ['harness/v7', 'harness/v8'] as const) {
  for (const deferred of ['model', 'reserve'] as const) {
    test(`${protocol} resumes a deferred ${deferred} without replaying accepted tools or resetting usage`, async () => {
      const inputId = randomUUID();
      const firstId = randomUUID();
      const secondId = randomUUID();
      const input =
        protocol === 'harness/v7'
          ? { messages: [{ message_id: inputId, role: 'user', content: 'read preferences twice' }] }
          : {
              r3_context: {
                manifest: { message_ids: [] },
                summary: null,
                messages: [],
                input: { type: 'user', message_id: inputId, content: 'read preferences twice' },
              },
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
      if (!pause) throw new Error('missing deferred safe point');
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

for (const protocol of ['harness/v7', 'harness/v8'] as const) {
  test(`${protocol} accepts 1..128 distinct memory source references and rejects invalid sources`, async () => {
    const inputId = randomUUID();
    const input =
      protocol === 'harness/v7'
        ? { messages: [{ message_id: inputId, role: 'user', content: 'recall' }] }
        : {
            r3_context: {
              manifest: { message_ids: [] },
              summary: null,
              messages: [],
              input: { type: 'user', message_id: inputId, content: 'recall' },
            },
          };
    const ids = Array.from({ length: 129 }, () => randomUUID());
    const cases: Array<{
      ids: string[];
      accepted: boolean;
      content?: string;
      match?: string;
      count?: number;
    }> = [
      { ids: ids.slice(0, 1), accepted: true },
      { ids: ids.slice(0, 65), accepted: true },
      { ids: ids.slice(0, 128), accepted: true },
      { ids, accepted: false },
      { ids: [], accepted: false },
      { ids: [ids[0], ids[0]], accepted: false },
      { ids: ['not-a-uuid'], accepted: false },
      { ids: ids.slice(0, 1), content: 'x'.repeat(12000), accepted: true },
      { ids: ids.slice(0, 1), content: 'x'.repeat(12001), accepted: false },
      { ids: ids.slice(0, 1), count: 50, accepted: true },
      { ids: ids.slice(0, 1), count: 51, accepted: false },
      { ids: ids.slice(0, 1), match: 'semantic', accepted: protocol === 'harness/v8' },
    ];
    for (const example of cases) {
      let models = 0;
      const requests = await run(
        {
          ...base,
          ...input,
          protocol,
          tools: [{ name: 'recall_memories', description: 'recall', parameters: {}, risk: 'low' }],
        },
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
            return {
              value: {
                type: 'complete',
                reply: {
                  message: {
                    content: null,
                    tool_calls: [
                      {
                        id: 'recall',
                        type: 'function',
                        function: { name: 'recall_memories', arguments: '{}' },
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
                result: {
                  kind: 'memory_recall',
                  completeness: 'complete',
                  items: Array.from({ length: example.count ?? 1 }, () => ({
                    memory_id: randomUUID(),
                    content: example.content ?? 'remembered fact',
                    conversation_id: randomUUID(),
                    message_ids: example.ids,
                    created_at: '2026-11-01T00:00:00Z',
                    updated_at: '2026-11-01T00:00:00Z',
                    ...(example.match ? { match: example.match } : {}),
                  })),
                },
              },
            };
          if (r.type === 'finish') return { value: { accepted: true } };
          throw new Error(`unexpected request ${r.type}`);
        },
        example.accepted ? 0 : 2,
      );
      const observed = requests.filter((r) => r.type === 'model');
      expect(observed).toHaveLength(example.accepted ? 2 : 1);
      if (example.accepted) {
        expect(JSON.stringify(observed[1].messages)).toContain(example.ids[example.ids.length - 1]);
      }
    }
  }, 30000);
}

test('v6 snapshot message references retain their 64-entry boundary', async () => {
  const ids = Array.from({ length: 65 }, () => randomUUID());
  const messages = ids
    .slice(0, 64)
    .map((message_id) => ({ message_id, role: 'user', content: 'history' }));
  for (const count of [64, 65]) {
    const requests = await run(
      {
        ...base,
        protocol: 'harness/v6',
        messages,
        snapshot: {
          version: 2,
          message_refs: ids.slice(0, count),
          tool_refs: [],
          next_call_no: 1,
          usage: { iterations: 4, tokens: 0 },
          waiting: null,
        },
      },
      (r) => {
        if (r.type === 'finish') return { value: { accepted: true } };
        throw new Error(`unexpected request ${r.type}`);
      },
      count === 64 ? 0 : 2,
    );
    expect(requests.some((r) => r.type === 'finish')).toBe(count === 64);
  }
}, 30000);
