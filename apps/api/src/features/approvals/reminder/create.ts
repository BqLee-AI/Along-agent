// Approval creation for the ToolGateway (issue #9): propose_task -> create_task
// approval, request_cancel_task -> cancel_task approval. Both only INSERT an
// approval(pending); they never touch tasks/outbox. Task creation stays in
// confirm.ts (single sanctioned cross-module transaction).
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  computePresentationHash,
  PRESENTATION_VERSION_FIRST_V2,
  PRESENTATION_VERSION_V1,
} from './presentation.js';

const APPROVAL_TTL_HOURS = 24;

interface FrozenTaskApproval {
  ownerId: string;
  conversationId: string | null;
  originalText: string;
  wallTime: string; // "YYYY-MM-DD HH:mm" (minute precision, frozen)
  timezoneId: string;
  fold: 0 | 1;
  offsetSeconds: number;
  fireAtUtc: string;
  tzdbVersion: string | null;
}

export interface CreateTaskApprovalInput extends FrozenTaskApproval {
  foldChoice: 'first' | 'second' | 'none';
  tzdbVersion: string;
  supersedesApprovalId?: string;
}

export interface CancelTaskApprovalInput extends FrozenTaskApproval {
  conversationId: string;
  targetTaskId: string;
  expectedStateVersion: number;
}

export interface CreatedApproval {
  approvalId: string;
  originalText: string;
  presentationHash: string;
  presentationVersion: string;
  expiresAt: string;
  wallTime: string;
  timezoneId: string;
  fold: 0 | 1;
  offsetSeconds: number;
  fireAtUtc: string;
}

function snapshotOf(input: FrozenTaskApproval, presentationVersion: string) {
  return {
    originalText: input.originalText,
    localDatetime: input.wallTime,
    timezoneId: input.timezoneId,
    fold: input.fold,
    offsetSeconds: input.offsetSeconds,
    occurrence: 'single' as const,
    presentationVersion,
  };
}

// time-core emits "YYYY-MM-DDTHH:mm:ss"; the frozen display/snapshot format is
// "YYYY-MM-DD HH:mm" (design/06 §5). Seconds are always :00 for v0 inputs.
export function wallTextOf(wallIso: string): string {
  return `${wallIso.slice(0, 10)} ${wallIso.slice(11, 16)}`;
}

export async function createTaskApproval(
  client: Pick<Pool | PoolClient, 'query'>,
  input: CreateTaskApprovalInput,
): Promise<CreatedApproval> {
  return insertTaskApproval(
    client,
    input,
    input.fold === 0 && input.foldChoice === 'first'
      ? PRESENTATION_VERSION_FIRST_V2
      : PRESENTATION_VERSION_V1,
    { kind: 'create_task', supersedes: input.supersedesApprovalId ?? null },
  );
}

async function insertTaskApproval(
  client: Pick<Pool | PoolClient, 'query'>,
  input: FrozenTaskApproval,
  presentationVersion: string,
  operation:
    | { kind: 'create_task'; supersedes: string | null }
    | { kind: 'cancel_task'; target: string; version: number },
): Promise<CreatedApproval> {
  const approvalId = randomUUID();
  const presentationHash = computePresentationHash(snapshotOf(input, presentationVersion));
  const { rows } = await client.query<{ expires_at: Date }>(
    `WITH creation AS (SELECT CASE WHEN $14::text='create_task' THEN clock_timestamp() ELSE now() END AS at)
     INSERT INTO approvals (id, owner_id, conversation_id, original_text,
       fire_at_utc, wall_time, timezone_id, fold, resolved_utc_offset_seconds,
       tzdb_version, occurrence, presentation_hash, presentation_version,
       state, created_at, expires_at, kind, supersedes_approval_id, target_task_id, expected_state_version)
     SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'single',$11,$12,'pending',
       at, at + ($13 || ' hours')::interval, $14, $15, $16, $17 FROM creation
     RETURNING expires_at`,
    [
      approvalId,
      input.ownerId,
      input.conversationId,
      input.originalText,
      input.fireAtUtc,
      input.wallTime,
      input.timezoneId,
      input.fold,
      input.offsetSeconds,
      input.tzdbVersion,
      presentationHash,
      presentationVersion,
      String(APPROVAL_TTL_HOURS),
      operation.kind,
      operation.kind === 'create_task' ? operation.supersedes : null,
      operation.kind === 'cancel_task' ? operation.target : null,
      operation.kind === 'cancel_task' ? operation.version : null,
    ],
  );
  const expiresAt = rows[0]?.expires_at;
  if (!expiresAt) throw new Error('approval insert returned no row');
  return {
    approvalId,
    originalText: input.originalText,
    presentationHash,
    presentationVersion,
    expiresAt: expiresAt.toISOString(),
    wallTime: input.wallTime,
    timezoneId: input.timezoneId,
    fold: input.fold,
    offsetSeconds: input.offsetSeconds,
    fireAtUtc: input.fireAtUtc,
  };
}

// One pending cancel approval per task: a repeated request_cancel_task in the
// same conversation returns the existing pending row instead of stacking
// duplicates (the approve button must point at one card).
export async function createCancelTaskApproval(
  client: Pick<Pool | PoolClient, 'query'>,
  input: CancelTaskApprovalInput,
): Promise<CreatedApproval> {
  const existing = await client.query<{
    id: string;
    original_text: string | null;
    presentation_hash: string;
    presentation_version: string;
    expires_at: Date;
    wall_time: string;
    timezone_id: string;
    fold: number;
    resolved_utc_offset_seconds: number;
    fire_at_utc: Date;
  }>(
    `SELECT id, original_text, presentation_hash, presentation_version, expires_at,
       wall_time, timezone_id, fold, resolved_utc_offset_seconds, fire_at_utc
     FROM approvals
     WHERE owner_id = $1 AND kind = 'cancel_task' AND target_task_id = $2
       AND state = 'pending' AND expires_at > now() AND fire_at_utc > now()
     ORDER BY created_at DESC LIMIT 1`,
    [input.ownerId, input.targetTaskId],
  );
  const row = existing.rows[0];
  if (row) {
    return {
      approvalId: row.id,
      originalText: row.original_text ?? input.originalText,
      presentationHash: row.presentation_hash,
      presentationVersion: row.presentation_version,
      expiresAt: row.expires_at.toISOString(),
      wallTime: row.wall_time,
      timezoneId: row.timezone_id,
      fold: row.fold === 1 ? 1 : 0,
      offsetSeconds: row.resolved_utc_offset_seconds,
      fireAtUtc: row.fire_at_utc.toISOString(),
    };
  }

  return insertTaskApproval(client, input, PRESENTATION_VERSION_V1, {
    kind: 'cancel_task',
    target: input.targetTaskId,
    version: input.expectedStateVersion,
  });
}
