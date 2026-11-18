// One fence and one receipt-only finalizer for send, ack, and missed.
import { channel } from 'node:diagnostics_channel';
import { sendKeyFor } from '@along/scheduler-core';
import type { PoolClient } from 'pg';
import { getReceivedInApp } from '../../notifications/public.js';
import {
  appendTaskEvent,
  markOutboxSuperseded,
  supersedeQueuedOutboxForTask,
  transitionTask,
  type OutboxRow,
  type SchedulerTaskRow,
} from './scheduler-repository.js';

const deliveryCheckpoint = channel('along.scheduler.delivery-checkpoint');

export function publishDeliveryCheckpoint(
  stage: 'permit_committed' | 'result_before_commit',
  taskId: string,
): void {
  if (deliveryCheckpoint.hasSubscribers) deliveryCheckpoint.publish({ stage, taskId });
}

export interface SendBinding {
  ownerId: string;
  taskId: string;
  fireAtIso: string;
  expectedStateVersion: number;
  scheduleReceipt: string;
  sendKey: string;
}

/** Historical receipts bypass the time window, never the current task fence. */
export function bindCurrentSend(task: SchedulerTaskRow | null, row: OutboxRow): SendBinding | null {
  if (
    !task ||
    task.state !== 'scheduled' ||
    task.id !== row.task_id ||
    task.owner_id !== row.owner_id ||
    task.state_version !== row.expected_state_version ||
    !Number.isSafeInteger(row.expected_state_version) ||
    row.expected_state_version < 1 ||
    !task.schedule_receipt ||
    (row.status !== 'dispatched' &&
      row.status !== 'acked_unknown' &&
      row.status !== 'failed_deadline')
  ) {
    return null;
  }
  const command = row.command as Record<string, unknown> | null;
  const fireAtIso = task.fire_at_utc.toISOString();
  const sendKey = sendKeyFor(task.id, fireAtIso);
  if (
    !command ||
    command.kind !== 'send' ||
    command.task_id !== task.id ||
    command.fire_at_utc !== fireAtIso ||
    command.expected_state_version !== row.expected_state_version ||
    command.schedule_receipt !== task.schedule_receipt ||
    command.idempotency_key !== sendKey ||
    row.idempotency_key !== sendKey
  ) {
    return null;
  }
  return {
    ownerId: task.owner_id,
    taskId: task.id,
    fireAtIso,
    expectedStateVersion: row.expected_state_version,
    scheduleReceipt: task.schedule_receipt,
    sendKey,
  };
}

export function sameSendBinding(left: SendBinding, right: SendBinding): boolean {
  return (
    left.ownerId === right.ownerId &&
    left.taskId === right.taskId &&
    left.fireAtIso === right.fireAtIso &&
    left.expectedStateVersion === right.expectedStateVersion &&
    left.scheduleReceipt === right.scheduleReceipt &&
    left.sendKey === right.sendKey
  );
}

/** Caller holds task -> outbox locks. No provider call or notification write. */
export async function reconcileReceivedSend(
  client: PoolClient,
  task: SchedulerTaskRow,
  row: OutboxRow,
): Promise<'fired' | 'notReceived' | 'superseded'> {
  const binding = bindCurrentSend(task, row);
  if (!binding) {
    await markOutboxSuperseded(client, row.id);
    return 'superseded';
  }
  // Errors (including a missing receipt table/column) must abort, not mean absent.
  const received = await getReceivedInApp(client, binding.ownerId, binding.taskId, binding.sendKey);
  if (
    !received ||
    received.fireAtUtc !== binding.fireAtIso ||
    received.expectedStateVersion !== binding.expectedStateVersion
  ) {
    return 'notReceived';
  }
  const moved = await transitionTask(client, {
    taskId: binding.taskId,
    fromStates: ['scheduled'],
    toState: 'fired',
    expectedVersion: binding.expectedStateVersion,
  });
  if (!moved) throw new Error('send fence changed while task lock held');
  await appendTaskEvent(client, {
    ownerId: binding.ownerId,
    taskId: binding.taskId,
    stateVersion: binding.expectedStateVersion + 1,
    type: 'fired',
    evidenceRef: received.receiptId,
  });
  await supersedeQueuedOutboxForTask(client, binding.taskId);
  // Accept only the independently read receipt after its current task fence.
  await client.query(
    `UPDATE outbox SET status = 'dispatched', provider_receipt_id = $2,
       last_attempt_at = now(), updated_at = now()
     WHERE id = $1`,
    [row.id, received.receiptId],
  );
  publishDeliveryCheckpoint('result_before_commit', binding.taskId);
  return 'fired';
}
