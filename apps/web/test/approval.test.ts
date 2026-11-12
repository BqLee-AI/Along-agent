import { describe, expect, it } from 'bun:test';
import { ApprovalDetailSchema } from '@along/contracts';
import {
  ApprovalPageSchema,
  approvalFilter,
  approvalListPath,
  reminderActionBody,
} from '../src/features/approvals/model/approval';
import { historyPageReducer, initialHistoryPage } from '../src/shared/http/page';

const id = '11111111-1111-4111-8111-111111111111';
const key = '22222222-2222-4222-8222-222222222222';
const frozen = '\r\n  原始冻结提醒\t \r\n';
const detail = ApprovalDetailSchema.parse({
  approval_id: id,
  kind: 'create_task',
  status: 'pending',
  echo_text: frozen,
  original_text: '  用户原话\n',
  fire_at_local: '2026-11-01 01:30:00',
  expires_in_seconds: 3600,
  snapshot: {
    fire_at_utc: '2026-11-01T05:30:00Z',
    timezone_id: 'America/New_York',
    fold: 0,
    offset_seconds: -14400,
  },
  presentation_hash: 'frozen-hash',
  presentation_version: 'v1',
  expires_at: '2026-10-29T12:00:00Z',
  recreated_from: null,
  result: { task_id: null, successor_approval_id: null },
});
const revision = {
  raw_text: '\n 完整修改原话  \r\n',
  confirmed_timezone: 'America/New_York',
  fold_choice: 'second' as const,
};

describe('reminder approval request and pagination behavior', () => {
  it('keeps frozen confirmation bytes and the original same-operation key', () => {
    const body = reminderActionBody(detail, 'confirm', key, revision);
    expect(JSON.parse(JSON.stringify(body))).toEqual({
      presentation_hash: detail.presentation_hash,
      seen_content: frozen,
      idempotency_key: key,
    });
    expect(reminderActionBody(detail, 'confirm', key, revision)).toEqual(body);
    expect(
      reminderActionBody({ ...detail, kind: 'cancel_task' }, 'confirm', key, revision),
    ).toEqual(body);
    expect(reminderActionBody(detail, 'reject', key, revision)).toEqual({ idempotency_key: key });
  });

  it('keeps revision text, explicit timezone and chosen fold without computing a new time', () => {
    expect(reminderActionBody(detail, 'revise', key, revision)).toEqual({
      ...revision,
      idempotency_key: key,
    });
  });

  it('uses the server status scope and preserves opaque cursors verbatim', () => {
    for (const status of [
      'pending',
      'consumed',
      'rejected',
      'expired',
      'superseded',
      'all',
    ] as const) {
      const url = new URL(
        approvalListPath(status, 'tail+/=opaque&status=other'),
        'http://approval.test',
      );
      expect(url.searchParams.get('status')).toBe(status);
      expect(url.searchParams.get('cursor')).toBe('tail+/=opaque&status=other');
      expect(url.searchParams.get('limit')).toBe('50');
    }
    expect(approvalFilter('unknown')).toBe('pending');
    expect(approvalFilter(['all'])).toBe('pending');
  });

  it('reaches items beyond 50 and never advances or deletes loaded scope on a failed GET', () => {
    const items = Array.from({ length: 50 }, (_, index) => ({
      approval_id: `${String(index + 1).padStart(8, '0')}-1111-4111-8111-111111111111`,
      title: `提议${index}`,
      status: 'pending',
      expires_at: 'frozen-time',
      created_at: 'frozen-time',
    }));
    const page = ApprovalPageSchema.parse({ items, next_cursor: 'page-2' });
    let state = initialHistoryPage<(typeof page.items)[number]>('pending');
    state = historyPageReducer(state, {
      type: 'start',
      target: 'pending',
      request: 1,
      reset: true,
    });
    state = historyPageReducer(state, {
      type: 'success',
      target: 'pending',
      request: 1,
      items: page.items,
      nextCursor: page.next_cursor,
    });
    state = historyPageReducer(state, {
      type: 'start',
      target: 'pending',
      request: 2,
      reset: false,
    });
    state = historyPageReducer(state, {
      type: 'failure',
      target: 'pending',
      request: 2,
      error: 'HTTP 503',
    });
    expect(state.items).toEqual(page.items);
    expect(state.nextCursor).toBe('page-2');
    state = historyPageReducer(state, {
      type: 'start',
      target: 'pending',
      request: 3,
      reset: false,
    });
    state = historyPageReducer(state, {
      type: 'success',
      target: 'pending',
      request: 3,
      items: [{ ...page.items[0]!, approval_id: id }],
      nextCursor: null,
    });
    expect(state.items).toHaveLength(51);
    expect(state.nextCursor).toBeNull();
    expect(state.error).toBeNull();
  });
});
