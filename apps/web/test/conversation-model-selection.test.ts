import { describe, expect, it } from 'bun:test';
import {
  ConversationRunPageSchema as ConversationRunHistoryPageSchema,
  RunViewSchema as ConversationRunViewSchema,
} from '@along/contracts';
import { modelSelectionLabel } from '../src/features/conversations/model/conversation-run';

const cid = '11111111-1111-4111-8111-111111111111';
const rid = '22222222-2222-4222-8222-222222222222';
const projection = {
  state: 'available' as const,
  provider_id: cid,
  provider_name: '冻结名称',
  model_id: 'provider/full/model-id',
};
const detail = {
  run_id: rid,
  conversation_id: cid,
  execution: 'harness',
  status: 'done',
  model_selection: { state: 'legacy_unavailable' },
  attempt_id: cid,
  attempt_no: 1,
  waiting: null,
  can_resume: false,
};
const history = {
  run_id: rid,
  conversation_id: cid,
  execution: 'harness',
  status: 'done',
  model_selection: { state: 'legacy_unavailable' },
  created_at: '2026-10-29T01:00:00.000000Z',
  ended_at: null,
  original: { state: 'legacy_unavailable' },
};

describe('server-frozen run model selection', () => {
  it('accepts the same snapshot in detail and history without consulting current settings', () => {
    const view = ConversationRunViewSchema.parse({ ...detail, model_selection: projection });
    const page = ConversationRunHistoryPageSchema.parse({
      items: [{ ...history, model_selection: projection }],
      next_cursor: null,
    });
    expect(view.model_selection).toEqual(page.items[0]?.model_selection);
    expect(modelSelectionLabel(view.model_selection)).toBe('冻结名称 · provider/full/model-id');
  });

  it('distinguishes legacy, non-model, missing and malformed projections without guessing', () => {
    for (const state of ['legacy_unavailable', 'not_applicable'] as const) {
      const value = ConversationRunViewSchema.parse({ ...detail, model_selection: { state } });
      expect(value.model_selection).toEqual({ state });
      expect(
        ConversationRunHistoryPageSchema.parse({
          items: [{ ...history, model_selection: { state } }],
          next_cursor: null,
        }).items[0]?.model_selection,
      ).toEqual({ state });
    }
    expect(modelSelectionLabel({ state: 'legacy_unavailable' })).toBe('历史模型信息不可还原');
    expect(modelSelectionLabel({ state: 'not_applicable' })).toBe('此运行不使用模型');
    expect(
      ConversationRunViewSchema.safeParse({ ...detail, model_selection: undefined }).success,
    ).toBe(false);
    expect(
      ConversationRunViewSchema.safeParse({
        ...detail,
        model_selection: { state: 'available', model_id: 'guessed' },
      }).success,
    ).toBe(false);
    expect(
      ConversationRunHistoryPageSchema.safeParse({
        items: [
          { ...history, model_selection: { state: 'legacy_unavailable', model_id: 'guessed' } },
        ],
        next_cursor: null,
      }).success,
    ).toBe(false);
  });
});
