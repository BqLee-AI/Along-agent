import type { Pool, PoolClient } from 'pg';
import { withTransaction } from '../../../db/transaction.js';
import {
  approvalExpired,
  approvalSuperseded,
  forbidden,
  notFound,
  notReady,
  presentationMismatch,
  stateConflict,
  validationError,
  type ApplicationError,
} from '../../../platform/errors.js';
import { computePresentationHash, shortNoOf, validateSeenContent } from './presentation.js';
import {
  findSuccessorId,
  getApprovalForUpdate,
  markConsumed,
  markRejected,
  persistExpiredIfDue,
  type ApprovalRow,
} from './repository.js';
import { ConfirmBodySchema, RejectBodySchema } from './schemas.js';
import {
  cancelTaskWithinTransaction,
  createTaskWithinTransaction,
  findOutboxTaskByKey,
} from '../../tasks/public.js';

export interface ConfirmDeps {
  pool: Pool | null;
}

export interface ConfirmResult {
  approval_id: string;
  status: 'consumed';
  task_id: string;
  duplicate: boolean;
}

export interface RejectResult {
  approval_id: string;
  status: 'rejected';
  duplicate: boolean;
}

function requirePool(deps: ConfirmDeps): Pool {
  if (!deps.pool) throw notReady();
  return deps.pool;
}

function outboxKey(ownerId: string, approvalId: string, key: string): string {
  // Scoped per approval: the same client key on a sibling approval is a
  // different operation and must not replay the sibling's task.
  return `confirm:${ownerId}:${approvalId}:${key}`;
}

function snapshotOf(row: {
  original_text: string | null;
  wall_time: string;
  timezone_id: string;
  fold: number;
  resolved_utc_offset_seconds: number;
  presentation_version: string;
}) {
  return {
    originalText: row.original_text ?? '',
    localDatetime: row.wall_time,
    timezoneId: row.timezone_id,
    fold: (row.fold === 1 ? 1 : 0) as 0 | 1,
    offsetSeconds: row.resolved_utc_offset_seconds,
    occurrence: 'single' as const,
    presentationVersion: row.presentation_version,
  };
}

async function lockOwnedApproval(client: PoolClient, ownerId: string, approvalId: string) {
  const row = await getApprovalForUpdate(client, approvalId);
  if (!row) throw notFound('approval not found');
  if (row.owner_id !== ownerId) throw forbidden('approval not found');
  return row;
}

async function expirePendingApproval(client: PoolClient, row: ApprovalRow) {
  if (row.state === 'superseded') throw approvalSuperseded(await findSuccessorId(client, row.id));
  if (row.state === 'expired') throw approvalExpired();
  return persistExpiredIfDue(client, row.id);
}

function consumed(approvalId: string, taskId: string, duplicate: boolean): ConfirmResult {
  return { approval_id: approvalId, status: 'consumed', task_id: taskId, duplicate };
}

// POST /approvals/{id}/actions/confirm. Single transaction: row lock ->
// owner/state/expiry -> hash+seen -> idempotency -> task + created event +
// outbox -> consumed. Any failure rolls back; no task is created.
export async function confirmApproval(
  deps: ConfirmDeps,
  ownerId: string,
  approvalId: string,
  body: unknown,
): Promise<ConfirmResult> {
  const parsed = ConfirmBodySchema.safeParse(body);
  if (!parsed.success) throw validationError('invalid confirm body');
  const { presentation_hash, seen_content, idempotency_key } = parsed.data;
  const pool = requirePool(deps);
  const result = await withTransaction(pool, async (client: PoolClient) => {
    const row = await lockOwnedApproval(client, ownerId, approvalId);

    // Terminal states first: repeat confirm returns the original task.
    if (row.state === 'consumed') {
      if (row.kind === 'cancel_task') return consumed(row.id, row.target_task_id ?? '', true);
      if (!row.consumed_task_id) throw stateConflict('approval consumed without task');
      return consumed(row.id, row.consumed_task_id, true);
    }
    if (row.state === 'rejected') {
      throw stateConflict('approval already rejected') as ApplicationError;
    }
    if (await expirePendingApproval(client, row)) return null;

    // Frozen-snapshot comparison: recompute hash, then seen content.
    const snapshot = snapshotOf(row);
    if (computePresentationHash(snapshot) !== row.presentation_hash) {
      // Stored row predates canonical v1 (should not happen post-PR1 seeds);
      // treat as mismatch rather than crashing.
      throw presentationMismatch() as ApplicationError;
    }
    if (presentation_hash !== row.presentation_hash) {
      throw presentationMismatch() as ApplicationError;
    }
    const ok = validateSeenContent({
      seenContent: seen_content,
      snapshot,
      shortNo: shortNoOf(row.id),
      variant: row.kind === 'cancel_task' ? 'cancel' : row.fold === 1 ? 'second' : 'ordinary',
      presentationVersion: row.presentation_version,
    });
    if (!ok) throw presentationMismatch() as ApplicationError;

    // cancel_task approvals commit the cancel request in the same transaction
    // as the approval consume (single sanctioned cross-module transaction).
    const key = outboxKey(ownerId, row.id, idempotency_key);
    if (row.kind === 'cancel_task') {
      if (!row.target_task_id) {
        throw stateConflict('cancel approval without target task') as ApplicationError;
      }
      const cancel = await cancelTaskWithinTransaction(client, {
        ownerId,
        taskId: row.target_task_id,
        reason: row.original_text,
        idempotencyKey: key,
      });
      await markConsumed(client, row.id, null);
      return consumed(row.id, cancel.task_id, cancel.duplicate);
    }

    // Idempotency: same key on the same approval replays the original task.
    const replayTaskId = await findOutboxTaskByKey(client, key);
    if (replayTaskId) return consumed(row.id, replayTaskId, true);

    const task = await createTaskWithinTransaction(client, {
      ownerId,
      source: { approvalId: row.id },
      fireAtUtc: row.fire_at_utc.toISOString(),
      wallTime: row.wall_time,
      timezoneId: row.timezone_id,
      fold: row.fold === 1 ? 1 : 0,
      resolvedUtcOffsetSeconds: row.resolved_utc_offset_seconds,
      tzdbVersion: row.tzdb_version,
      originalNote: row.original_text,
      idempotencyKey: key,
    });
    await markConsumed(client, row.id, task.task_id);
    return consumed(row.id, task.task_id, false);
  });
  if (!result) throw approvalExpired();
  return result;
}

// POST /approvals/{id}/actions/reject. Terminal rejected state; rejected
// rows replay 200 + duplicate on repeat. Consumed rows 409 with task ref.
export async function rejectApproval(
  deps: ConfirmDeps,
  ownerId: string,
  approvalId: string,
  body: unknown,
): Promise<RejectResult> {
  const parsed = RejectBodySchema.safeParse(body);
  if (!parsed.success) throw validationError('invalid reject body');
  const pool = requirePool(deps);
  const result = await withTransaction(pool, async (client: PoolClient) => {
    const row = await lockOwnedApproval(client, ownerId, approvalId);

    if (row.state === 'rejected') {
      return { approval_id: row.id, status: 'rejected' as const, duplicate: true };
    }
    if (row.state === 'consumed') {
      throw stateConflict('approval already consumed, use cancel', {
        task_id: row.kind === 'cancel_task' ? row.target_task_id : row.consumed_task_id,
      }) as ApplicationError;
    }
    if (await expirePendingApproval(client, row)) return null;
    await markRejected(client, row.id);
    return { approval_id: row.id, status: 'rejected' as const, duplicate: false };
  });
  if (!result) throw approvalExpired();
  return result;
}
