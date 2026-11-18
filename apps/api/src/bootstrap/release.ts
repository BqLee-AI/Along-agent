import type { Pool } from 'pg';
import { withClient } from '../db/transaction.js';
import { inspectReleaseWaiting } from '../agent/operations/public.js';
import { loadHarnessServices } from '../agent/runtime/config.js';
import { readReleaseWaitingRun } from '../features/conversations/public.js';
import { readReleaseApprovalDetail } from '../features/approvals/public.js';
import { readOwnerDisplayName } from '../features/identity/public.js';
import { createUserModelTransport } from '../features/model-providers/public.js';
import { loadTimeContext } from '../features/time/public.js';
import { loadWorkspaceRegistry } from '../features/workspaces/public.js';

/** Minimum inspection assembly: no listener, polling loop, or Run driver. */
export async function inspectInstallationWaiting(pool: Pool) {
  await loadWorkspaceRegistry();
  return inspectReleaseWaiting({
    pool,
    harness: loadHarnessServices(),
    modelTransport: createUserModelTransport,
    timeContext: loadTimeContext(process.env.TZDB_VERSION),
  });
}

/** Preserve the former joined query's single snapshot across public readers. */
export async function readReleaseWaitingDetail(pool: Pool, runId: string) {
  return withClient(pool, async (client) => {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
      const run = await readReleaseWaitingRun(client, runId);
      if (!run) throw new Error('WAITING_NOT_FOUND');
      const owner = await readOwnerDisplayName(client, run.ownerId);
      const approval = await readReleaseApprovalDetail(client, run.ownerId, run.approvalId);
      const detail = {
        runId,
        conversationId: run.conversationId,
        owner,
        checkpoint: run.checkpoint,
        invocation: run.invocation,
        originalMessage: run.originalMessage,
        approvalId: run.approvalId,
        ...approval,
      };
      await client.query('COMMIT');
      return detail;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
}
