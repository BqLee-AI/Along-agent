import { afterEach, describe, expect, it } from 'bun:test';
import { ApprovalDetailSchema } from '@along/contracts';
import type { RunView } from '@along/contracts';
import {
  confirmInlineReminder,
  inlineReminderWaiting,
  readInlineReminder,
} from '../src/features/conversations/model/inline-reminder';

const approvalId = '11111111-1111-4111-8111-111111111111';
const taskId = '22222222-2222-4222-8222-222222222222';
const frozen = '\r\n  完整冻结提醒\t \r\n';
const detail = ApprovalDetailSchema.parse({
  approval_id: approvalId,
  kind: 'create_task',
  status: 'pending',
  echo_text: frozen,
  original_text: '提醒我喝水',
  fire_at_local: '2026-11-01 15:20:00',
  expires_in_seconds: 3600,
  snapshot: {
    fire_at_utc: '2026-11-01T07:20:00Z',
    timezone_id: 'Asia/Shanghai',
    fold: 0,
    offset_seconds: 28800,
  },
  presentation_hash: 'frozen-hash',
  presentation_version: 'v1',
  expires_at: '2026-11-01T08:00:00Z',
  recreated_from: null,
  result: { task_id: null, successor_approval_id: null },
});
const run: RunView = {
  conversation_id: '33333333-3333-4333-8333-333333333333',
  run_id: '44444444-4444-4444-8444-444444444444',
  execution: 'harness',
  model_selection: { state: 'legacy_unavailable' },
  status: 'suspended_approval',
  attempt_id: '55555555-5555-4555-8555-555555555555',
  attempt_no: 1,
  waiting: {
    checkpoint_id: '66666666-6666-4666-8666-666666666666',
    invocation_id: '77777777-7777-4777-8777-777777777777',
    approval_id: approvalId,
  },
  can_resume: false,
};
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
function envelope(data: unknown) {
  return Response.json({ code: 0, msg: 'ok', request_id: 'request-inline-reminder', data });
}
function args(initial = detail, current = run) {
  return {
    initial,
    run: current,
    csrf: 'csrf-inline-reminder',
    signal: new AbortController().signal,
  };
}

describe('explicit inline reminder confirmation', () => {
  it('recognizes the current harness reminder checkpoint but not documents or terminal history', () => {
    expect(inlineReminderWaiting(run, approvalId)).toBe(true);
    expect(inlineReminderWaiting(run, taskId)).toBe(false);
    expect(inlineReminderWaiting(null, approvalId)).toBe(false);
    for (const status of ['done', 'failed', 'cancelled', 'running'] as const)
      expect(inlineReminderWaiting({ ...run, status }, approvalId)).toBe(false);
    expect(
      inlineReminderWaiting(
        {
          ...run,
          waiting: { ...run.waiting!, approval_kind: 'document' },
        },
        approvalId,
      ),
    ).toBe(false);
  });

  it('reads are strictly GET-only even when the approval is already consumed', async () => {
    const methods: string[] = [];
    globalThis.fetch = (async (_input, init) => {
      methods.push(init?.method ?? 'GET');
      return envelope({
        ...detail,
        status: 'consumed',
        result: { ...detail.result, task_id: taskId },
      });
    }) as typeof fetch;
    const current = await readInlineReminder(detail, args().signal);
    expect(current.status).toBe('consumed');
    expect(current.result.task_id).toBe(taskId);
    expect(methods).toEqual(['GET']);
  });

  it('submits the exact frozen bytes, original approval key and existing CSRF header', async () => {
    const calls: { path: string; method: string; body: unknown; csrf: string | null }[] = [];
    globalThis.fetch = (async (input, init) => {
      const method = init?.method ?? 'GET';
      calls.push({
        path: String(input),
        method,
        body: init?.body ? JSON.parse(String(init.body)) : null,
        csrf: new Headers(init?.headers).get('x-csrf-token'),
      });
      return method === 'GET'
        ? envelope(detail)
        : envelope({
            approval_id: approvalId,
            status: 'consumed',
            task_id: taskId,
            duplicate: false,
          });
    }) as typeof fetch;
    const current = await confirmInlineReminder(args());
    expect(current).toMatchObject({ status: 'consumed', result: { task_id: taskId } });
    expect(calls.map((call) => call.method)).toEqual(['GET', 'POST']);
    expect(calls[1]).toEqual({
      path: `/api/v1/approvals/${approvalId}/actions/confirm`,
      method: 'POST',
      body: {
        presentation_hash: detail.presentation_hash,
        seen_content: frozen,
        idempotency_key: approvalId,
      },
      csrf: 'csrf-inline-reminder',
    });
  });

  it('a lost response permits only a new explicit call, with a read and exactly the same request key', async () => {
    const methods: string[] = [];
    const bodies: unknown[] = [];
    globalThis.fetch = (async (_input, init) => {
      const method = init?.method ?? 'GET';
      methods.push(method);
      if (method === 'GET') return envelope(detail);
      bodies.push(JSON.parse(String(init?.body)));
      if (bodies.length === 1) throw new TypeError('disconnected');
      return envelope({
        approval_id: approvalId,
        status: 'consumed',
        task_id: taskId,
        duplicate: true,
      });
    }) as typeof fetch;
    await expect(confirmInlineReminder(args())).rejects.toThrow('disconnected');
    expect(methods).toEqual(['GET', 'POST']);
    await confirmInlineReminder(args());
    expect(methods).toEqual(['GET', 'POST', 'GET', 'POST']);
    expect(bodies[0]).toEqual(bodies[1]);
  });

  it('recovers a successful unknown response by reading its real task without another POST', async () => {
    const methods: string[] = [];
    globalThis.fetch = (async (_input, init) => {
      methods.push(init?.method ?? 'GET');
      return envelope({
        ...detail,
        status: 'consumed',
        result: { ...detail.result, task_id: taskId },
      });
    }) as typeof fetch;
    const current = await confirmInlineReminder(args());
    expect(current.result.task_id).toBe(taskId);
    expect(methods).toEqual(['GET']);
  });

  it('preserves cancel-task identity rather than proposing a replacement or changing action type', async () => {
    const cancel = { ...detail, kind: 'cancel_task' as const };
    const paths: string[] = [];
    globalThis.fetch = (async (input, init) => {
      paths.push(String(input));
      return init?.method === 'POST'
        ? envelope({
            approval_id: approvalId,
            status: 'consumed',
            task_id: taskId,
            duplicate: false,
          })
        : envelope(cancel);
    }) as typeof fetch;
    expect((await confirmInlineReminder(args(cancel))).kind).toBe('cancel_task');
    expect(paths).toEqual([
      `/api/v1/approvals/${approvalId}`,
      `/api/v1/approvals/${approvalId}/actions/confirm`,
    ]);
  });

  it('never posts on a changed frozen preview, non-pending decision, document checkpoint or completed Run', async () => {
    const calls: string[] = [];
    for (const next of [
      { ...detail, presentation_hash: 'changed' },
      { ...detail, echo_text: `${frozen}changed` },
      { ...detail, kind: 'cancel_task' },
      { ...detail, status: 'expired' },
      { ...detail, status: 'rejected' },
      {
        ...detail,
        status: 'superseded',
        result: { ...detail.result, successor_approval_id: taskId },
      },
    ]) {
      globalThis.fetch = (async (_input, init) => {
        calls.push(init?.method ?? 'GET');
        return envelope(next);
      }) as typeof fetch;
      await expect(confirmInlineReminder(args())).rejects.toThrow();
    }
    expect(calls).toEqual(['GET', 'GET', 'GET', 'GET', 'GET', 'GET']);
    calls.length = 0;
    await expect(confirmInlineReminder(args(detail, { ...run, status: 'done' }))).rejects.toThrow();
    await expect(
      confirmInlineReminder(
        args(detail, {
          ...run,
          waiting: { ...run.waiting!, approval_kind: 'document' },
        }),
      ),
    ).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it('does not turn mismatched or malformed confirmation receipts into accepted task results', async () => {
    for (const result of [
      { approval_id: taskId, status: 'consumed', task_id: taskId, duplicate: false },
      { approval_id: approvalId, status: 'rejected', duplicate: false },
      { approval_id: approvalId, status: 'consumed', duplicate: false },
    ]) {
      globalThis.fetch = (async (_input, init) =>
        envelope(init?.method === 'POST' ? result : detail)) as typeof fetch;
      await expect(confirmInlineReminder(args())).rejects.toThrow();
    }
  });
});
