// A committed CAS grants only this stack one call. Recovery of acked_unknown
// reconciles independent receipts; it never recreates that permission.
import { ACK_CHECK_DELAYS_MS, isPastFireWindow } from '@along/scheduler-core';
import type { Pool, PoolClient } from 'pg';
import { withTransaction } from '../../../db/transaction.js';
import { deliverInApp, type InAppProvider } from '../../notifications/public.js';
import { isActiveOwner } from '../../identity/public.js';
import {
  bindCurrentSend,
  publishDeliveryCheckpoint,
  reconcileReceivedSend,
  sameSendBinding,
  type SendBinding,
} from './delivery.js';
import {
  commitSendPermit,
  listDueSendRows,
  lockOutboxRow,
  lockTaskRow,
  markOutboxAckUnknown,
  markOutboxFailedDeadline,
  markOutboxSuperseded,
  recordCancelBreach,
  type OutboxRow,
} from './scheduler-repository.js';

export const SEND_BATCH_LIMIT = 50;

export interface SendSummary {
  scanned: number;
  fired: number;
  ackUnknown: number;
  superseded: number;
  failedDeadline: number;
  breaches: number;
}

type SendDisposition = keyof Omit<SendSummary, 'scanned'>;
type PermitResult = SendBinding | 'superseded' | 'failedDeadline' | null;

export async function runSendPhase(
  pool: Pool,
  provider: InAppProvider,
  nowMs?: number,
): Promise<SendSummary> {
  const summary: SendSummary = {
    scanned: 0,
    fired: 0,
    ackUnknown: 0,
    superseded: 0,
    failedDeadline: 0,
    breaches: 0,
  };
  const rows = await collectDueSend(pool);
  for (const candidate of rows) {
    const permission = await withTransaction<PermitResult>(pool, async (client: PoolClient) => {
      // Never acquire an outbox lock before its task, and never upgrade this
      // task lock: independent intake must pass the existing FK KEY SHARE.
      const task = await lockTaskRow(client, candidate.task_id, 'no_key_update');
      const row = await lockOutboxRow(client, candidate.id);
      if (
        !row ||
        row.task_id !== candidate.task_id ||
        row.status !== 'dispatched' ||
        row.provider_receipt_id !== null
      ) {
        return null;
      }
      const binding = bindCurrentSend(task, row);
      if (!binding || !task) {
        await markOutboxSuperseded(client, row.id);
        return 'superseded';
      }
      if (!(await isActiveOwner(client, binding.ownerId, { lock: 'share' }))) {
        await markOutboxSuperseded(client, row.id, 'owner_ineligible');
        return 'superseded';
      }
      const gateNow = nowMs ?? Date.now();
      if (isPastFireWindow(task.fire_at_utc.getTime(), gateNow)) {
        await markOutboxFailedDeadline(client, row.id, 'past fire window before send permission');
        return 'failedDeadline';
      }
      if (gateNow < task.fire_at_utc.getTime()) return null;
      const granted = await commitSendPermit(
        client,
        row.id,
        new Date(gateNow + ACK_CHECK_DELAYS_MS[0]),
      );
      return granted ? binding : null;
    });
    if (!permission) continue;
    summary.scanned += 1;
    if (typeof permission === 'string') {
      summary[permission] += 1;
      continue;
    }

    // withTransaction has completed COMMIT. No persisted state authorizes
    // another stack to enter the provider, even if this stack dies here.
    publishDeliveryCheckpoint('permit_committed', permission.taskId);
    const disposition = await withTransaction<SendDisposition | null>(
      pool,
      async (client: PoolClient) => {
        const task = await lockTaskRow(client, permission.taskId, 'no_key_update');
        const row = await lockOutboxRow(client, candidate.id);
        if (!row || row.task_id !== permission.taskId || row.status !== 'acked_unknown') {
          return null;
        }
        const binding = bindCurrentSend(task, row);
        if (!binding || !task || !sameSendBinding(permission, binding)) {
          // A cancel committed in the gap wins without any provider call.
          await markOutboxSuperseded(client, row.id);
          return 'superseded';
        }
        const gateNow = nowMs ?? Date.now();
        if (isPastFireWindow(task.fire_at_utc.getTime(), gateNow)) {
          const reconciled = await reconcileReceivedSend(client, task, row);
          if (reconciled === 'fired') return 'fired';
          // Only missed owns the atomic task-missed/send-deadline decision.
          // An expired permission still does not prove that intake failed.
          return 'ackUnknown';
        }
        if (gateNow < task.fire_at_utc.getTime()) return 'ackUnknown';

        let providerFailed = false;
        try {
          // Keep the task lock for the whole call, so cancel cannot commit
          // first. A returned delivered=true is not independent receipt proof.
          await deliverInApp(
            {
              ownerId: binding.ownerId,
              taskId: binding.taskId,
              idempotencyKey: binding.sendKey,
            },
            provider,
          );
        } catch {
          // The receive transaction may already have committed. In either
          // case this permission stays spent; no refusal/retry path exists.
          providerFailed = true;
        }

        // Defensive breach protection for unexpected re-entrant state writes.
        // Ordinary cross-process cancel is blocked by our NO KEY UPDATE lock.
        const current = await lockTaskRow(client, binding.taskId, 'no_key_update');
        if (current?.state === 'cancel_pending' || current?.state === 'cancelled') {
          await recordCancelBreach(client, {
            ownerId: binding.ownerId,
            taskId: binding.taskId,
            evidenceRef: row.provider_receipt_id ?? binding.sendKey,
          });
          await markOutboxSuperseded(client, row.id);
          return 'breaches';
        }
        if (!current) {
          await markOutboxSuperseded(client, row.id);
          return 'superseded';
        }
        const reconciled = await reconcileReceivedSend(client, current, row);
        if (reconciled === 'fired') return 'fired';
        if (reconciled === 'superseded') return 'superseded';
        await markOutboxAckUnknown(client, {
          outboxId: row.id,
          ackCheckNo: row.ack_check_no,
          nextCheckAt: row.last_attempt_at ?? new Date(gateNow + ACK_CHECK_DELAYS_MS[0]),
          lastError: providerFailed
            ? 'inapp provider error; delivery outcome unknown; permission spent'
            : 'inapp receipt unconfirmed; delivery outcome unknown; permission spent',
        });
        publishDeliveryCheckpoint('result_before_commit', binding.taskId);
        return 'ackUnknown';
      },
    );
    if (disposition) summary[disposition] += 1;
  }
  return summary;
}

async function collectDueSend(pool: Pool): Promise<OutboxRow[]> {
  const client = await pool.connect();
  try {
    return await listDueSendRows(client, SEND_BATCH_LIMIT);
  } finally {
    client.release();
  }
}
