import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { HarnessSnapshot, HarnessPauseSnapshot, HarnessR3Snapshot } from '@along/contracts';
import { stateConflict } from '../../../platform/errors.js';
import type { RunContext } from '../contracts.js';

type AttemptBinding = Pick<RunContext, 'ownerId' | 'conversationId' | 'runId' | 'attemptId'>;

export async function readRunSnapshotPayload(
  client: PoolClient,
  ownerId: string,
  runId: string,
  checkpointId: string,
): Promise<unknown> {
  const checkpoint = (
    await client.query<{ payload: unknown }>(
      `SELECT c.payload FROM run_checkpoints c JOIN run_attempts a ON a.id=c.attempt_id
      WHERE c.id=$1 AND c.owner_id=$2 AND a.run_id=$3 AND c.kind='harness_snapshot'`,
      [checkpointId, ownerId, runId],
    )
  ).rows[0];
  if (!checkpoint) throw stateConflict('invalid harness checkpoint');
  return checkpoint.payload;
}

export async function readLatestRunSnapshotPayload(
  client: PoolClient,
  runId: string,
): Promise<{ payload: unknown } | undefined> {
  return (
    await client.query<{ payload: unknown }>(
      `SELECT c.payload FROM run_checkpoints c JOIN run_attempts a ON a.id=c.attempt_id
          WHERE a.run_id=$1 AND c.kind='harness_snapshot' ORDER BY c.event_seq DESC LIMIT 1`,
      [runId],
    )
  ).rows[0];
}

export async function readLatestAttemptSnapshotId(
  client: PoolClient,
  attemptId: string,
): Promise<string | undefined> {
  return (
    await client.query<{ id: string }>(
      `SELECT id FROM run_checkpoints WHERE attempt_id=$1 AND kind='harness_snapshot' ORDER BY seq DESC LIMIT 1`,
      [attemptId],
    )
  ).rows[0]?.id;
}

/** Qualification and validation have already run under the caller's attempt -> Run locks. */
export async function writeHarnessSnapshotWithinTransaction(
  client: PoolClient,
  binding: AttemptBinding,
  snapshot: HarnessSnapshot | HarnessPauseSnapshot | HarnessR3Snapshot,
  protocol: string,
): Promise<string> {
  const seq = (
    await client.query<{ seq: number }>(
      'SELECT COALESCE(max(seq),0)::int+1 AS seq FROM run_checkpoints WHERE attempt_id=$1',
      [binding.attemptId],
    )
  ).rows[0]?.seq;
  const id = randomUUID();
  await client.query(
    `INSERT INTO run_checkpoints(id,owner_id,attempt_id,seq,kind,payload,stream_protocol_version)
          VALUES($1,$2,$3,$4,'harness_snapshot',$5::jsonb,$6)`,
    [id, binding.ownerId, binding.attemptId, seq, JSON.stringify(snapshot), protocol],
  );
  return id;
}

export async function suspendRunWithinTransaction(
  client: PoolClient,
  binding: AttemptBinding,
  waiting: { checkpointId: string; invocationId: string; approvalId: string },
): Promise<void> {
  await client.query(
    `UPDATE harness_pauses SET state='invalidated'
               WHERE owner_id=$1 AND run_id=$2 AND attempt_id=$3 AND state='pending'`,
    [binding.ownerId, binding.runId, binding.attemptId],
  );
  await client.query(
    `UPDATE agent_runs SET status='suspended_approval',waiting_checkpoint_id=$2,
          waiting_invocation_id=$3,waiting_approval_id=$4 WHERE id=$1`,
    [binding.runId, waiting.checkpointId, waiting.invocationId, waiting.approvalId],
  );
  await client.query(`UPDATE run_attempts SET status='done',ended_at=now() WHERE id=$1`, [
    binding.attemptId,
  ]);
}

export async function hasPendingPauseWithinTransaction(
  client: PoolClient,
  binding: AttemptBinding,
): Promise<boolean> {
  return !!(
    await client.query(
      `SELECT 1 FROM harness_pauses WHERE owner_id=$1 AND run_id=$2 AND attempt_id=$3 AND state='pending'`,
      [binding.ownerId, binding.runId, binding.attemptId],
    )
  ).rowCount;
}

export async function listPendingApprovalRuns(
  client: PoolClient,
  binding: Pick<AttemptBinding, 'ownerId' | 'conversationId'>,
) {
  return (
    await client.query<{ id: string; waiting_invocation_id: string; waiting_approval_id: string }>(
      `SELECT id,waiting_invocation_id,waiting_approval_id FROM agent_runs
              WHERE owner_id=$1 AND conversation_id=$2 AND status='suspended_approval'`,
      [binding.ownerId, binding.conversationId],
    )
  ).rows;
}
