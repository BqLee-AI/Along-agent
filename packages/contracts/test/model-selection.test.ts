import { expect, test } from 'bun:test';
import { RunViewSchema } from '../src/harness.js';
import { ConversationRunHistoryItemSchema } from '../src/conversations.js';
import {
  ProviderConnectionTestResultSchema,
  ProviderConnectionTestSchema,
  ProviderModelCreateSchema,
  ProviderModelContextWindowSchema,
  ProviderModelDefaultSchema,
  ProviderModelSchema,
  ProviderTestResultSchema,
  ProviderTestSchema,
  ProviderViewSchema,
} from '../src/model-providers.js';

const id = '00000000-0000-4000-8000-000000000001';
const selection = {
  state: 'available',
  provider_id: id,
  provider_name: 'Original',
  model_id: 'vendor/model',
} as const;

test('run detail and history expose the same immutable model selection states without secrets', () => {
  const detail = {
    run_id: id,
    conversation_id: id,
    execution: 'harness',
    status: 'running',
    attempt_id: id,
    attempt_no: 1,
    waiting: null,
    can_resume: false,
  };
  const history = {
    run_id: id,
    conversation_id: id,
    execution: 'harness',
    status: 'running',
    created_at: '2026-01-01T00:00:00.000000Z',
    ended_at: null,
    original: { state: 'legacy_unavailable' },
  };
  for (const model_selection of [
    selection,
    { state: 'legacy_unavailable' },
    { state: 'not_applicable' },
  ] as const) {
    expect(RunViewSchema.parse({ ...detail, model_selection }).model_selection).toEqual(
      model_selection,
    );
    expect(
      ConversationRunHistoryItemSchema.parse({ ...history, model_selection }).model_selection,
    ).toEqual(model_selection);
  }
  expect(
    RunViewSchema.safeParse({ ...detail, model_selection: { ...selection, api_key: 'secret' } })
      .success,
  ).toBe(false);
});

test('provider model windows are nullable positive integers and create differs from edit', () => {
  expect(ProviderModelCreateSchema.parse({ model_id: 'x' })).toEqual({ model_id: 'x' });
  expect(
    ProviderModelCreateSchema.parse({ model_id: 'x', context_window_tokens: null })
      .context_window_tokens,
  ).toBeNull();
  expect(ProviderModelContextWindowSchema.safeParse({ model_id: 'x' }).success).toBe(false);
  expect(ProviderModelSchema.safeParse({ model_id: 'x', context_window_tokens: 1 }).success).toBe(
    false,
  );
  for (const invalid of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1024']) {
    expect(
      ProviderModelContextWindowSchema.safeParse({ model_id: 'x', context_window_tokens: invalid })
        .success,
    ).toBe(false);
  }
  const provider = {
    id,
    name: 'example',
    enabled: true,
    base_url: '',
    has_api_key: false,
    key_hint: null,
    models: ['x'],
    model_context_windows: { x: 1024 },
    default_model_id: null,
  };
  expect(ProviderViewSchema.parse(provider).model_context_windows.x).toBe(1024);
  expect(
    ProviderViewSchema.safeParse({ ...provider, model_context_windows: undefined }).success,
  ).toBe(false);
});

test('provider default model contract requires a nullable model id and rejects extra fields', () => {
  expect(ProviderModelDefaultSchema.parse({ model_id: null })).toEqual({ model_id: null });
  expect(ProviderModelDefaultSchema.parse({ model_id: 'vendor/model' })).toEqual({
    model_id: 'vendor/model',
  });
  for (const input of [
    {},
    { model_id: '' },
    { model_id: 'x'.repeat(513) },
    { model_id: 1 },
    { model_id: 'x', extra: true },
  ]) {
    expect(ProviderModelDefaultSchema.safeParse(input).success).toBe(false);
  }
  const provider = {
    id,
    name: 'example',
    enabled: true,
    base_url: '',
    has_api_key: false,
    key_hint: null,
    models: ['x'],
    model_context_windows: { x: null },
  };
  expect(ProviderViewSchema.safeParse(provider).success).toBe(false);
  expect(
    ProviderViewSchema.parse({ ...provider, default_model_id: null }).default_model_id,
  ).toBeNull();
  expect(ProviderViewSchema.parse({ ...provider, default_model_id: 'x' }).default_model_id).toBe(
    'x',
  );
  expect(
    ProviderViewSchema.safeParse({ ...provider, default_model_id: '', extra: true }).success,
  ).toBe(false);
});

test('connection and model tests have distinct strict contracts', () => {
  expect(ProviderConnectionTestSchema.parse({})).toEqual({});
  expect(ProviderConnectionTestSchema.safeParse({ model_id: 'model' }).success).toBe(false);
  expect(ProviderTestSchema.safeParse({}).success).toBe(false);
  expect(ProviderTestSchema.safeParse({ model_id: '' }).success).toBe(false);
  expect(ProviderTestSchema.parse({ model_id: 'vendor/model' }).model_id).toBe('vendor/model');
  expect(
    ProviderConnectionTestResultSchema.safeParse({ status: 'passed', latency_ms: 0 }).success,
  ).toBe(true);
  expect(
    ProviderConnectionTestResultSchema.safeParse({ status: 'failed', latency_ms: 0 }).success,
  ).toBe(false);
  const status = { status: 'not_tested', latency_ms: null };
  expect(
    ProviderTestResultSchema.safeParse({
      text_stream: status,
      tool_round_trip: status,
      usage: status,
    }).success,
  ).toBe(true);
});
