import { describe, expect, it } from 'bun:test';
import {
  ConversationListItemSchema,
  MessageHistoryItemSchema,
  ConversationRunHistoryItemSchema,
  ConversationListPageSchema,
  ConversationMessagePageSchema,
  ConversationRunPageSchema,
  ConversationListQuerySchema,
  ConversationMessagesQuerySchema,
  ConversationRunsQuerySchema,
} from '../src/conversations.js';

const id = '11111111-1111-4111-8111-111111111111';
const created_at = '2026-10-28T09:00:00.123456Z';
const message = { message_id: id, content: ' \n 原话\t\n ', created_at };
const run = {
  run_id: id,
  conversation_id: id,
  execution: 'harness',
  status: 'done',
  created_at,
  ended_at: null,
};

describe('conversation history public contracts', () => {
  it('preserves original whitespace and six-digit UTC timestamps without private fields', () => {
    expect(MessageHistoryItemSchema.parse({ ...message, role: 'user' }).content).toBe(
      message.content,
    );
    expect(MessageHistoryItemSchema.parse({ ...message, role: 'assistant' }).created_at).toBe(
      created_at,
    );
    for (const role of ['system', 'tool']) {
      expect(MessageHistoryItemSchema.safeParse({ ...message, role }).success).toBe(false);
    }
    for (const timestamp of [
      '2026-02-30T00:00:00.000000Z',
      '2026-10-28T09:00:00.123456+00:00',
      '2026-10-28T09:00:00.1234567Z',
    ]) {
      expect(
        MessageHistoryItemSchema.safeParse({ ...message, role: 'user', created_at: timestamp })
          .success,
      ).toBe(false);
    }
    expect(
      MessageHistoryItemSchema.safeParse({ ...message, role: 'user', owner_id: id }).success,
    ).toBe(false);
  });

  it('distinguishes trusted, unavailable and corrupt originals instead of fabricating content', () => {
    for (const source of ['input_message', 'idempotency_reference'] as const) {
      expect(
        ConversationRunHistoryItemSchema.parse({
          ...run,
          original: { state: 'available', source, message },
        }).original,
      ).toEqual({ state: 'available', source, message });
    }
    for (const state of ['legacy_unavailable', 'invalid_reference'] as const) {
      expect(
        ConversationRunHistoryItemSchema.parse({ ...run, original: { state } }).original,
      ).toEqual({ state });
      expect(
        ConversationRunHistoryItemSchema.safeParse({ ...run, original: { state, message } })
          .success,
      ).toBe(false);
    }
    expect(
      ConversationRunHistoryItemSchema.safeParse({
        ...run,
        original: { state: 'available', source: 'nearby_message', message },
      }).success,
    ).toBe(false);
    expect(
      ConversationRunHistoryItemSchema.safeParse({
        ...run,
        original: { state: 'legacy_unavailable' },
        frozen_context: {},
      }).success,
    ).toBe(false);
  });

  it('requires strict finite pages and factual conversation fields', () => {
    expect(
      ConversationListItemSchema.parse({
        conversation_id: id,
        status: 'closed',
        title: '标题',
        title_message_id: id,
        created_at,
        last_activity_at: null,
      }).created_at,
    ).toBe(created_at);
    for (const schema of [
      ConversationListPageSchema,
      ConversationMessagePageSchema,
      ConversationRunPageSchema,
    ]) {
      expect(schema.parse({ items: [], next_cursor: null })).toEqual({
        items: [],
        next_cursor: null,
      });
      expect(schema.safeParse({ items: [], next_cursor: null, has_more: false }).success).toBe(
        false,
      );
      expect(schema.safeParse({ items: [] }).success).toBe(false);
    }
  });

  it('rejects duplicate, unknown, nondecimal and out-of-range collection query parameters', () => {
    for (const schema of [
      ConversationListQuerySchema,
      ConversationMessagesQuerySchema,
      ConversationRunsQuerySchema,
    ]) {
      expect(schema.parse({}).limit).toBe(20);
      expect(schema.parse({ limit: '50' }).limit).toBe(50);
      for (const limit of ['0', '51', '-1', '+1', '1.0', '1e1', ' 2 ', '', ['1', '2']]) {
        expect(schema.safeParse({ limit }).success).toBe(false);
      }
      expect(schema.safeParse({ owner_id: id }).success).toBe(false);
      expect(schema.safeParse({ cursor: '' }).success).toBe(false);
      expect(schema.safeParse({ cursor: 'x'.repeat(2001) }).success).toBe(false);
      expect(schema.safeParse({ cursor: ['a', 'b'] }).success).toBe(false);
    }
    expect(ConversationRunsQuerySchema.parse({ run_id: id }).run_id).toBe(id);
    expect(ConversationRunsQuerySchema.safeParse({ run_id: id, cursor: 'abc' }).success).toBe(
      false,
    );
    expect(ConversationRunsQuerySchema.safeParse({ run_id: [id, id] }).success).toBe(false);
    expect(ConversationListQuerySchema.safeParse({ run_id: id }).success).toBe(false);
  });
});
