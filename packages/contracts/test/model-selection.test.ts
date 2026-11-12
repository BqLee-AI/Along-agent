import { expect, test } from 'bun:test';
import { RunViewSchema } from '../src/harness.js';
import { ConversationRunHistoryItemSchema } from '../src/conversations.js';

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
