import type { Pool, PoolClient } from 'pg';
import type {
  ExecutionKind,
  RunView,
  WorkspaceGrant,
  WorkspaceSummary,
  GoalResult,
  TrustedExecutionContext,
} from '@along/contracts';
import { forbidden, notFound, stateConflict } from '../../../platform/errors.js';
import { isActiveOwner } from '../../identity/public.js';
import type { RunContext } from '../contracts.js';
import type { ReminderDateSource } from './reminder-date-continuation.js';
import type { AutoCompactPolicy } from '../compact/auto-compact-policy.js';
import type { FeishuBotDocxGrant } from '../../office-connectors/public.js';

export interface RunRow {
  id: string;
  owner_id: string;
  conversation_id: string;
  execution: ExecutionKind;
  status: RunView['status'];
  budget_max_iterations: number;
  budget_max_tokens: number;
  tools_allowlist: string[];
  frozen_context: FrozenContext | null;
  input_message_id: string | null;
  waiting_checkpoint_id: string | null;
  waiting_invocation_id: string | null;
  waiting_approval_id: string | null;
  goal_result: GoalResult | null;
}
export interface FrozenContext {
  confirmedTimezone: string | null;
  anchorReceivedAtUtc: string;
  receivedAtUtc: string;
  foldChoice: 'first' | 'second' | 'none';
  rulesetId: string;
  tzdbVersion: string;
  aliasVersion: string | null;
  reminderDateSource?: ReminderDateSource;
  messageRefs?: string[];
  workspaceGrant?: WorkspaceGrant | null;
  workspaceSummary?: WorkspaceSummary | null;
  workspaceGrants?: WorkspaceGrant[];
  createdArtifactReadRevision?: 'owner-created/1';
  feishuDocx?: { connectionId: string; sessionId: string; url: string } | FeishuBotDocxGrant;
  createResolutionRevision?: 'create-resolution/1' | 'create-resolution/2';
  authorization_revision?: 'delegation/1';
  execution_lifecycle?: 'request-bound' | 'server-owned';
  execution_profile?: 'pause/1' | 'pause-memory/1' | 'compact-memory/1';
  autoCompactPolicy?: AutoCompactPolicy;
  compactCompletionCap?: number;
  trustedExecutionContext?: TrustedExecutionContext;
}
export interface LockedRun {
  run: RunRow;
  attempt: { id: string; attempt_no: number; status: string };
}

// Never lock a Run before its attempt. Callers retry latest-attempt discovery
// outside the transaction when a concurrent resume has relocated execution.
export async function lockRun(
  client: PoolClient,
  binding: Pick<RunContext, 'ownerId' | 'conversationId' | 'runId' | 'attemptId' | 'ownership'>,
  executable = true,
  authorize = true,
): Promise<LockedRun> {
  const attempt = (
    await client.query<{ id: string; attempt_no: number; status: string }>(
      'SELECT id,attempt_no,status FROM run_attempts WHERE id=$1 AND run_id=$2 AND owner_id=$3 FOR UPDATE',
      [binding.attemptId, binding.runId, binding.ownerId],
    )
  ).rows[0];
  if (!attempt) throw notFound('Run attempt not found');
  const run = (
    await client.query<RunRow>(
      `SELECT r.* FROM agent_runs r WHERE r.id=$1 AND r.owner_id=$2 AND r.conversation_id=$3
      AND EXISTS (SELECT 1 FROM conversations c WHERE c.id=r.conversation_id AND c.owner_id=$2)
      FOR UPDATE OF r`,
      [binding.runId, binding.ownerId, binding.conversationId],
    )
  ).rows[0];
  if (!run) throw notFound('Run not found');
  const latest = (
    await client.query<{ attempt_no: number }>(
      'SELECT max(attempt_no)::int AS attempt_no FROM run_attempts WHERE run_id=$1',
      [run.id],
    )
  ).rows[0]?.attempt_no;
  if (latest !== attempt.attempt_no)
    throw stateConflict('stale Run attempt', { reason: 'STALE_ATTEMPT' });
  if (executable && run.frozen_context?.execution_lifecycle === 'server-owned') {
    if (!binding.ownership) throw stateConflict('Run ownership required');
    await binding.ownership.assert(client, binding.runId, binding.attemptId);
  }
  if (executable && (run.status !== 'running' || attempt.status !== 'running')) {
    throw stateConflict('Run attempt cannot execute', { status: run.status });
  }
  if (authorize && !(await isActiveOwner(client, run.owner_id))) {
    throw forbidden('Run authorization revoked');
  }
  return { run, attempt };
}

export async function latestAttemptId(
  client: Pick<PoolClient, 'query'>,
  ownerId: string,
  runId: string,
): Promise<string> {
  const id = (
    await client.query<{ id: string }>(
      'SELECT id FROM run_attempts WHERE run_id=$1 AND owner_id=$2 ORDER BY attempt_no DESC LIMIT 1',
      [runId, ownerId],
    )
  ).rows[0]?.id;
  if (!id) throw notFound('Run not found');
  return id;
}

export async function insertRun(
  client: Pick<Pool | PoolClient, 'query'>,
  args: {
    runId: string;
    ownerId: string;
    conversationId: string;
    agentRevision: string;
    mode: 'chat' | 'task';
    maxIterations: number;
    maxTokens: number;
    execution: 'business' | 'harness';
    allowlist: readonly string[];
    frozenContext: unknown;
    inputMessageId: string;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO agent_runs (id, owner_id, conversation_id, agent_revision,
       mode, status, budget_max_iterations, budget_max_tokens, execution,
       tools_allowlist, frozen_context, input_message_id)
     VALUES ($1,$2,$3,$4,$5,'running',$6,$7,$8,$9::jsonb,$10::jsonb,$11)`,
    [
      args.runId,
      args.ownerId,
      args.conversationId,
      args.agentRevision,
      args.mode,
      args.maxIterations,
      args.maxTokens,
      args.execution,
      JSON.stringify(args.allowlist),
      JSON.stringify(args.frozenContext),
      args.inputMessageId,
    ],
  );
}

export async function insertAttempt(
  client: Pick<Pool | PoolClient, 'query'>,
  args: {
    attemptId: string;
    ownerId: string;
    runId: string;
    attemptNo: number;
    leaseToken?: string;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO run_attempts (id, owner_id, run_id, attempt_no, status, lease_token)
     VALUES ($1,$2,$3,$4,'running',$5)`,
    [args.attemptId, args.ownerId, args.runId, args.attemptNo, args.leaseToken ?? null],
  );
}

export async function insertPauseSuccessor(
  client: PoolClient,
  input: Parameters<typeof insertAttempt>[1] & { pauseId: string } & (
      | { source: 'user'; key: string }
      | { source: 'runtime' }
    ),
): Promise<void> {
  await insertAttempt(client, input);
  const { ownerId, runId, pauseId, attemptId, source } = input;
  await client.query(
    `INSERT INTO harness_pause_resumes(owner_id,idempotency_key,run_id,pause_id,attempt_id,source)
     VALUES($1,$2,$3,$4,$5,$6)`,
    [ownerId, source === 'user' ? input.key : pauseId, runId, pauseId, attemptId, source],
  );
}

export async function activatePauseSuccessor(
  client: PoolClient,
  pauseId: string,
  runId: string,
): Promise<void> {
  await client.query(`UPDATE harness_pauses SET state='consumed' WHERE id=$1`, [pauseId]);
  await client.query(`UPDATE agent_runs SET status='running' WHERE id=$1`, [runId]);
}

export async function finishAttempt(
  client: Pick<Pool | PoolClient, 'query'>,
  attemptId: string,
  status: 'done' | 'failed' | 'fenced_out',
): Promise<void> {
  await client.query('UPDATE run_attempts SET status = $2, ended_at = now() WHERE id = $1', [
    attemptId,
    status,
  ]);
}
