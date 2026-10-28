import { describe, expect, it } from 'bun:test';
import { ApprovalDetailSchema } from '../src/index.js';

const detail = {
  approval_id: '00000000-0000-4000-8000-000000000001',
  kind: 'create_task',
  status: 'pending',
  echo_text: '请确认：\n  原文  ',
  original_text: '\n  原文  \n',
  fire_at_local: '2026-11-02 09:20',
  expires_in_seconds: 60,
  snapshot: {
    fire_at_utc: '2026-11-02T01:20:00.000Z',
    timezone_id: 'Asia/Shanghai',
    fold: 0,
    offset_seconds: 28800,
  },
  presentation_hash: 'frozen-hash',
  presentation_version: 'v1',
  expires_at: '2026-11-01T01:20:00.000Z',
  recreated_from: null,
  result: { task_id: null, successor_approval_id: null },
} as const;
const taskId = '00000000-0000-4000-8000-000000000002';

describe('shared task approval detail', () => {
  it('preserves the frozen detail and requires both explicit result references', () => {
    expect(ApprovalDetailSchema.parse(detail)).toEqual(detail);
    expect(ApprovalDetailSchema.safeParse({ ...detail, result: undefined }).success).toBe(false);
    for (const result of [{}, { task_id: null }, { successor_approval_id: null }]) {
      expect(ApprovalDetailSchema.safeParse({ ...detail, result }).success).toBe(false);
    }
  });

  it('accepts precise statuses and actual UUID task and successor references', () => {
    for (const status of ['pending', 'consumed', 'rejected', 'expired', 'superseded']) {
      expect(
        ApprovalDetailSchema.safeParse({
          ...detail,
          status,
          result: {
            task_id: status === 'consumed' ? taskId : null,
            successor_approval_id: status === 'superseded' ? taskId : null,
          },
        }).success,
      ).toBe(true);
    }
    expect(ApprovalDetailSchema.safeParse({ ...detail, status: 'approved' }).success).toBe(false);
    expect(ApprovalDetailSchema.safeParse({ ...detail, status: 'consumed' }).success).toBe(false);
    for (const key of ['task_id', 'successor_approval_id']) {
      expect(
        ApprovalDetailSchema.safeParse({
          ...detail,
          result: { ...detail.result, [key]: 'not-a-uuid' },
        }).success,
      ).toBe(false);
    }
  });

  it('rejects private additions at every public object boundary', () => {
    for (const value of [
      { ...detail, owner_id: taskId },
      { ...detail, snapshot: { ...detail.snapshot, root: '/private' } },
      { ...detail, result: { ...detail.result, tool_invocation: {} } },
    ]) {
      expect(ApprovalDetailSchema.safeParse(value).success).toBe(false);
    }
  });
});
