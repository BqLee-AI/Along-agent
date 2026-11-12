import { describe, expect, it } from 'bun:test';
import { ThreadEventSchema } from '@along/stream-protocol';
import type { ThreadEvent } from '@along/stream-protocol';
import {
  collectRunTranscripts,
  eventPageComplete,
  mergeThreadEvents,
} from '../src/features/conversations/model/conversation-run';
import { ApiReadError, readEnvelope } from '../src/shared/http/client';
import { historyPageReducer, initialHistoryPage } from '../src/shared/http/page';
import { clearAppRetryState } from '../src/shared/session/navigation';

const cid = '11111111-1111-4111-8111-111111111111';
const rid = '22222222-2222-4222-8222-222222222222';
function event(
  seq: number,
  type: 'message.delta' | 'approval_required',
  fields: Record<string, unknown>,
  requestId = 'history-read',
): ThreadEvent {
  return ThreadEventSchema.parse({
    protocol_version: 'v1',
    seq,
    type,
    request_id: requestId,
    payload: {
      conversation_id: cid,
      run_id: rid,
      ...(type === 'approval_required' ? { presentation_hash: 'frozen' } : {}),
      ...fields,
    },
  });
}

describe('history resource state consumed by the Web', () => {
  it('preserves successful items and cursor on a later-page failure, and retries that page', () => {
    let state = initialHistoryPage<string>('one');
    state = historyPageReducer(state, { type: 'start', target: 'one', request: 1, reset: true });
    state = historyPageReducer(state, {
      type: 'success',
      target: 'one',
      request: 1,
      items: ['original'],
      nextCursor: 'page-2',
    });
    state = historyPageReducer(state, { type: 'start', target: 'one', request: 2, reset: false });
    state = historyPageReducer(state, {
      type: 'failure',
      target: 'one',
      request: 2,
      error: 'HTTP 503 / request-2',
    });
    expect(state.items).toEqual(['original']);
    expect(state.nextCursor).toBe('page-2');
    expect(state.loaded).toBe(true);
    expect(state.error).toBe('HTTP 503 / request-2');
    state = historyPageReducer(state, { type: 'start', target: 'one', request: 3, reset: false });
    state = historyPageReducer(state, {
      type: 'success',
      target: 'one',
      request: 3,
      items: ['reply'],
      nextCursor: null,
    });
    expect(state.items).toEqual(['original', 'reply']);
    expect(state.nextCursor).toBeNull();
    expect(state.error).toBeNull();
  });

  it('discards late success and failure from an old URL or superseded read', () => {
    let state = initialHistoryPage<string>('one');
    state = historyPageReducer(state, { type: 'start', target: 'one', request: 1, reset: true });
    state = historyPageReducer(state, { type: 'start', target: 'two', request: 2, reset: true });
    state = historyPageReducer(state, {
      type: 'success',
      target: 'one',
      request: 1,
      items: ['private-old'],
      nextCursor: 'old',
    });
    state = historyPageReducer(state, {
      type: 'failure',
      target: 'one',
      request: 1,
      error: 'late error',
    });
    expect(state.target).toBe('two');
    expect(state.items).toEqual([]);
    expect(state.error).toBeNull();
    state = historyPageReducer(state, {
      type: 'success',
      target: 'two',
      request: 2,
      items: [],
      nextCursor: null,
    });
    expect(state.loaded).toBe(true);
    expect(state.items).toEqual([]);
  });

  it('keeps last successful facts on failed refresh and rejects an earlier read of the same target', () => {
    let state = initialHistoryPage<string>('one');
    state = historyPageReducer(state, { type: 'start', target: 'one', request: 1, reset: true });
    state = historyPageReducer(state, {
      type: 'success',
      target: 'one',
      request: 1,
      items: ['saved'],
      nextCursor: 'saved-cursor',
    });
    state = historyPageReducer(state, { type: 'start', target: 'one', request: 2, reset: true });
    state = historyPageReducer(state, {
      type: 'failure',
      target: 'one',
      request: 2,
      error: 'refresh unavailable',
    });
    expect(state.items).toEqual(['saved']);
    expect(state.nextCursor).toBe('saved-cursor');
    expect(state.resetting).toBe(true);
    state = historyPageReducer(state, { type: 'start', target: 'one', request: 3, reset: true });
    state = historyPageReducer(state, {
      type: 'success',
      target: 'one',
      request: 2,
      items: ['late'],
      nextCursor: null,
    });
    expect(state.items).toEqual(['saved']);
    state = historyPageReducer(state, {
      type: 'success',
      target: 'one',
      request: 3,
      items: ['fresh'],
      nextCursor: null,
    });
    expect(state.items).toEqual(['fresh']);
    expect(state.error).toBeNull();
  });

  it('keeps independent resource cursors and does not declare a full event page complete', () => {
    const messages = historyPageReducer(initialHistoryPage<string>('messages'), {
      type: 'start',
      target: 'messages',
      request: 1,
      reset: true,
    });
    const runs = historyPageReducer(initialHistoryPage<string>('runs'), {
      type: 'start',
      target: 'runs',
      request: 1,
      reset: true,
    });
    const loaded = historyPageReducer(messages, {
      type: 'success',
      target: 'messages',
      request: 1,
      items: ['m'],
      nextCursor: 'message-cursor',
    });
    expect(loaded.nextCursor).toBe('message-cursor');
    expect(runs.nextCursor).toBeNull();
    expect(eventPageComplete(200, 200)).toBe(false);
    expect(eventPageComplete(0, 200)).toBe(true);
    expect(eventPageComplete(199, 200)).toBe(true);
  });

  it('normalizes all attempt deltas by seq and keeps every kind+ID approval once in first-event order', () => {
    const events = [
      event(9, 'message.delta', { delta: '第二轮。' }, 'resumed-attempt'),
      event(2, 'message.delta', { delta: '第一轮。' }, 'initial-attempt'),
      event(8, 'approval_required', { approval_id: cid, card_id: `document-approval:${cid}` }),
      event(5, 'approval_required', { approval_id: cid, card_id: 'task-card' }),
      event(10, 'approval_required', { approval_id: cid, card_id: 'task-card' }),
      event(2, 'message.delta', { delta: '重复 seq 不应替换第一条。' }),
    ];
    const transcripts = collectRunTranscripts(mergeThreadEvents([], events));
    expect(transcripts.get(rid)).toEqual({
      text: '第一轮。第二轮。',
      approvals: [
        { kind: 'task', approvalId: cid, seq: 5 },
        { kind: 'document', approvalId: cid, seq: 8 },
      ],
    });
    expect(transcripts.get('another-run')).toBeUndefined();
  });

  it('keeps interleaved Runs separate and orders Runs and their approvals by first persisted event', () => {
    const otherRunId = '33333333-3333-4333-8333-333333333333';
    const events = mergeThreadEvents(
      [],
      [
        event(8, 'message.delta', { run_id: otherRunId, delta: '乙二。' }),
        event(3, 'message.delta', { run_id: otherRunId, delta: '乙一。' }),
        event(2, 'message.delta', { delta: '甲一。' }),
        event(7, 'message.delta', { delta: '甲二。' }, 'resumed-attempt'),
        event(5, 'approval_required', { approval_id: cid, card_id: 'task-card' }),
        event(4, 'approval_required', {
          run_id: otherRunId,
          approval_id: cid,
          card_id: `document-approval:${cid}`,
        }),
        event(6, 'approval_required', {
          run_id: otherRunId,
          approval_id: cid,
          card_id: 'task-card',
        }),
        event(9, 'approval_required', {
          run_id: otherRunId,
          approval_id: cid,
          card_id: 'task-card',
        }),
      ],
    );
    expect([...collectRunTranscripts(events)]).toEqual([
      [
        rid,
        {
          text: '甲一。甲二。',
          approvals: [{ kind: 'task', approvalId: cid, seq: 5 }],
        },
      ],
      [
        otherRunId,
        {
          text: '乙一。乙二。',
          approvals: [
            { kind: 'document', approvalId: cid, seq: 4 },
            { kind: 'task', approvalId: cid, seq: 6 },
          ],
        },
      ],
    ]);
  });

  it('retains approval references with text disabled and handles an empty event collection', () => {
    const events = mergeThreadEvents(
      [],
      [
        event(2, 'message.delta', { delta: '不展示的回复。' }),
        event(3, 'approval_required', { approval_id: cid, card_id: 'task-card' }),
        event(4, 'approval_required', { approval_id: cid, card_id: `document-approval:${cid}` }),
        event(5, 'approval_required', { approval_id: cid, card_id: 'task-card' }),
      ],
    );
    expect([...collectRunTranscripts(events, { includeText: false })]).toEqual([
      [
        rid,
        {
          text: '',
          approvals: [
            { kind: 'task', approvalId: cid, seq: 3 },
            { kind: 'document', approvalId: cid, seq: 4 },
          ],
        },
      ],
    ]);
    expect([...collectRunTranscripts([])]).toEqual([]);
    expect([...collectRunTranscripts([], { includeText: false })]).toEqual([]);
  });

  it.each([403, 404, 503])(
    'retains HTTP %s, public error code and request ID rather than an empty history',
    async (status) => {
      let failure: unknown;
      try {
        await readEnvelope(
          new Response(
            JSON.stringify({
              code: 1,
              data: null,
              msg: 'failed',
              error: {
                code: 'NOT_READY',
                message: 'Read unavailable',
                request_id: 'history-request',
              },
              request_id: 'history-request',
            }),
            { status },
          ),
        );
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(ApiReadError);
      expect(failure).toMatchObject({ status, code: 'NOT_READY', requestId: 'history-request' });
    },
  );

  it('clears app action retries without deleting unrelated storage', () => {
    const values = new Map([
      ['run-resume:one', 'a'],
      ['run-cancel:two', 'b'],
      ['document-decision:three', 'c'],
      ['unrelated', 'keep'],
    ]);
    const storage = {
      get length() {
        return values.size;
      },
      key(index: number) {
        return [...values.keys()][index] ?? null;
      },
      removeItem(key: string) {
        values.delete(key);
      },
    };
    clearAppRetryState(storage);
    expect([...values.entries()]).toEqual([['unrelated', 'keep']]);
  });
});
