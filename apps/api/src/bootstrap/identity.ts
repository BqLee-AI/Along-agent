import type { Pool, PoolClient } from 'pg';
import { createAccountService, type AccountServiceOptions } from '../features/identity/public.js';
import { listHistoricalOwners as conversationOwners } from '../features/conversations/public.js';
import { listHistoricalOwners as approvalOwners } from '../features/approvals/public.js';
import { listHistoricalOwners as taskOwners } from '../features/tasks/public.js';
import { listHistoricalOwners as notificationOwners } from '../features/notifications/public.js';
import { listHistoricalOwners as invocationOwners } from '../agent/tools/public.js';

export type ConfiguredAccountOptions = Omit<AccountServiceOptions, 'historicalOwners'>;

async function historicalOwners(db: Pool | PoolClient): Promise<readonly string[]> {
  const owners = new Set<string>();
  for (const read of [
    conversationOwners,
    approvalOwners,
    taskOwners,
    notificationOwners,
    invocationOwners,
  ]) {
    for (const owner of await read(db)) owners.add(owner);
  }
  return [...owners];
}

/** Maintenance and HTTP share the same history qualification, without starting a process. */
export function createConfiguredAccountService(pool: Pool, options: ConfiguredAccountOptions = {}) {
  return createAccountService(pool, { ...options, historicalOwners });
}
