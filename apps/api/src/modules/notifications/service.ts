// Local intake commits independently of the worker's task/outbox transaction.
import { channel } from 'node:diagnostics_channel';
import type { Pool, PoolClient } from 'pg';
import { noticeCopyFor } from '@along/notifier-core';
import { sendKeyFor } from '@along/scheduler-core';
import { withTransaction } from '../../db/transaction.js';
import { getTaskNotificationSource } from '../tasks/notification-source.js';
import { findReceivedNotice, insertReceivedNotice, listTaskNotices } from './repository.js';

const inAppProviderCalls = channel('along.notifications.provider-call');
const inAppReceived = channel('along.notifications.received');

export interface TaskNotification {
  id: string;
  title: string;
  body: string;
  status: 'pending' | 'sent' | 'failed';
  sent_at: string | null;
}

/** Read stored notices only; task existence and authorization belong to tasks. */
export async function getTaskNotifications(
  client: PoolClient,
  ownerId: string,
  taskId: string,
): Promise<TaskNotification[]> {
  const rows = await listTaskNotices(client, ownerId, taskId);
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    body: row.body,
    status: row.status,
    sent_at: row.sent_at?.toISOString() ?? null,
  }));
}

export interface InAppNotice {
  ownerId: string;
  taskId: string;
  idempotencyKey: string;
}

export interface InAppDelivery {
  delivered: boolean;
  answered: boolean;
  providerReceiptId: string | null;
}

export type InAppProvider = (notice: InAppNotice) => Promise<InAppDelivery>;

export interface ReceivedInApp {
  notificationId: string;
  receiptId: `inapp:${string}`;
  fireAtUtc: string;
  expectedStateVersion: number;
}

/** Read intake evidence only; the caller still owns the task/outbox fence. */
export async function getReceivedInApp(
  client: PoolClient,
  ownerId: string,
  taskId: string,
  idempotencyKey: string,
): Promise<ReceivedInApp | null> {
  const row = await findReceivedNotice(client, ownerId, taskId, idempotencyKey);
  if (!row) return null;
  const fireAtUtc = row.fireAtUtc.toISOString();
  if (idempotencyKey !== sendKeyFor(taskId, fireAtUtc)) return null;
  return {
    notificationId: row.id,
    receiptId: `inapp:${row.id}`,
    fireAtUtc,
    expectedStateVersion: row.expectedStateVersion,
  };
}

/**
 * The worker owns this dedicated receive pool's lifetime. Intake never takes
 * a task lock or writes task/outbox state, so the worker can keep its fence.
 */
export function createLocalInAppProvider(receivePool: Pool): InAppProvider {
  return async (notice) => {
    if (inAppProviderCalls.hasSubscribers) {
      inAppProviderCalls.publish({ taskId: notice.taskId });
    }
    const notificationId = await withTransaction(receivePool, async (client) => {
      const source = await getTaskNotificationSource(client, notice.ownerId, notice.taskId);
      if (
        !source ||
        source.state !== 'scheduled' ||
        !source.scheduleReceipt ||
        notice.idempotencyKey !== sendKeyFor(notice.taskId, source.fireAtUtc)
      ) {
        throw new Error('inapp intake task binding mismatch');
      }
      const copy = noticeCopyFor({
        wallTime: source.wallTime,
        timezoneId: source.timezoneId,
        originalNote: source.originalNote,
      });
      const id = await insertReceivedNotice(client, {
        ownerId: notice.ownerId,
        taskId: notice.taskId,
        idempotencyKey: notice.idempotencyKey,
        fireAtUtc: source.fireAtUtc,
        expectedStateVersion: source.stateVersion,
        title: copy.title,
        body: copy.body,
      });
      if (!id) throw new Error('inapp intake idempotency binding conflict');
      return id;
    });
    // withTransaction has committed before this answer-loss checkpoint.
    if (inAppReceived.hasSubscribers) {
      inAppReceived.publish({ taskId: notice.taskId, notificationId });
    }
    return {
      delivered: true,
      answered: true,
      providerReceiptId: `inapp:${notificationId}`,
    };
  };
}

/** Dispatch only; the provider, not the worker transaction, records intake. */
export async function deliverInApp(
  notice: InAppNotice,
  provider: InAppProvider,
): Promise<InAppDelivery> {
  return provider(notice);
}
