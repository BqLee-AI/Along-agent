import { describe, expect, it } from 'bun:test';
import { ThreadEventSchema, type ThreadEvent } from '@along/stream-protocol';
import {
  ApiReadError,
  collectRunTranscript,
  eventPageComplete,
  historyPageReducer,
  initialHistoryPage,
  readEnvelope,
} from '../src/lib/conversation-run';
import { clearAppRetryState } from '../src/lib/account-navigation';

const cid = '11111111-1111-4111-8111-111111111111';
const rid = '22222222-2222-4222-8222-222222222222';
function event(
  seq: number,
  type: 'message.delta' | 'approval_required',
  fields: Record<string, unknown>,
): ThreadEvent {
  return ThreadEventSchema.parse({
    protocol_version: 'v1',
    seq,
    type,
    request_id: 'history-read',
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

  it('merges all attempt deltas by seq and keeps every kind+ID approval once in first-event order', () => {
    const events = [
      event(2, 'message.delta', { delta: '第一轮。' }),
      event(5, 'approval_required', { approval_id: cid, card_id: 'task-card' }),
      event(8, 'approval_required', { approval_id: cid, card_id: `document-approval:${cid}` }),
      event(9, 'message.delta', { delta: '第二轮。' }),
      event(10, 'approval_required', { approval_id: cid, card_id: 'task-card' }),
    ];
    const transcript = collectRunTranscript([...events, events[0]!], rid);
    expect(transcript.text).toBe('第一轮。第二轮。');
    expect(transcript.approvals).toEqual([
      { kind: 'task', approvalId: cid, seq: 5 },
      { kind: 'document', approvalId: cid, seq: 8 },
    ]);
    expect(collectRunTranscript(events, 'another-run').text).toBe('');
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
