import type { PoolClient } from 'pg';
import type { RunRow } from '../run/repository.js';

/** Release inspection reads frozen facts; it never authorizes a resume. */
export async function listReleaseWaitingRuns(client: PoolClient): Promise<RunRow[]> {
  return (
    await client.query<RunRow>(
      "SELECT * FROM agent_runs WHERE execution='harness' AND status='suspended_approval' ORDER BY id",
    )
  ).rows;
}

export interface ReleaseWaitingRun {
  ownerId: string;
  conversationId: string;
  checkpoint: string | null;
  invocation: string | null;
  approvalId: string | null;
  originalMessage: string | null;
}

export async function readReleaseWaitingRun(
  client: PoolClient,
  runId: string,
): Promise<ReleaseWaitingRun | null> {
  return (
    (
      await client.query<ReleaseWaitingRun>(
        `SELECT r.owner_id AS "ownerId",r.conversation_id AS "conversationId",
      r.waiting_checkpoint_id AS checkpoint,r.waiting_invocation_id AS invocation,
      r.waiting_approval_id AS "approvalId",m.content AS "originalMessage"
     FROM agent_runs r LEFT JOIN messages m ON m.id=r.input_message_id
       AND m.owner_id=r.owner_id AND m.conversation_id=r.conversation_id
     WHERE r.id=$1 AND r.status='suspended_approval'`,
        [runId],
      )
    ).rows[0] ?? null
  );
}
