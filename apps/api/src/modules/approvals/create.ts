// Approval creation for the ToolGateway (issue #9): propose_task -> create_task
// approval, request_cancel_task -> cancel_task approval. Both only INSERT an
// approval(pending); they never touch tasks/outbox. Task creation stays in
// confirm.ts (single sanctioned cross-module transaction).
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { computePresentationHash, PRESENTATION_VERSION_V1 } from './presentation.js';

const APPROVAL_TTL_HOURS = 24;

export interface CreateTaskApprovalInput {
  ownerId: string;
  conversationId: string;
  originalText: string;
  wallTime: string; // "YYYY-MM-DD HH:mm" (minute precision, frozen)
  timezoneId: string;
  fold: 0 | 1;
  offsetSeconds: number;
  fireAtUtc: string; // ISO-8601 UTC
  tzdbVersion: string;
}

export interface CancelTaskApprovalInput {
  ownerId: string;
  conversationId: string;
  originalText: string;
  targetTaskId: string;
  expectedStateVersion: number;
  wallTime: string;
  timezoneId: string;
  fold: 0 | 1;
  offsetSeconds: number;
  fireAtUtc: string;
  tzdbVersion: string;
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

function snapshotOf(input: {
  originalText: string;
  wallTime: string;
  timezoneId: string;
  fold: 0 | 1;
  offsetSeconds: number;
}) {
  return {
    originalText: input.originalText,
    localDatetime: input.wallTime,
    timezoneId: input.timezoneId,
    fold: input.fold,
    offsetSeconds: input.offsetSeconds,
    occurrence: 'single' as const,
    presentationVersion: PRESENTATION_VERSION_V1,
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
  const approvalId = randomUUID();
  const presentationHash = computePresentationHash(snapshotOf(input));
  const { rows } = await client.query<{ expires_at: Date }>(
    `INSERT INTO approvals (id, owner_id, conversation_id, original_text,
       fire_at_utc, wall_time, timezone_id, fold, resolved_utc_offset_seconds,
       tzdb_version, occurrence, presentation_hash, presentation_version,
       state, expires_at, kind)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'single',$11,$12,'pending',
       now() + ($13 || ' hours')::interval, 'create_task')
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
      PRESENTATION_VERSION_V1,
      String(APPROVAL_TTL_HOURS),
    ],
  );
  const expiresAt = rows[0]?.expires_at;
  if (!expiresAt) throw new Error('approval insert returned no row');
  return {
    approvalId,
    originalText: input.originalText,
    presentationHash,
    presentationVersion: PRESENTATION_VERSION_V1,
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

  const approvalId = randomUUID();
  const presentationHash = computePresentationHash(snapshotOf(input));
  const { rows } = await client.query<{ expires_at: Date }>(
    `INSERT INTO approvals (id, owner_id, conversation_id, original_text,
       fire_at_utc, wall_time, timezone_id, fold, resolved_utc_offset_seconds,
       tzdb_version, occurrence, presentation_hash, presentation_version,
       state, expires_at, kind, target_task_id, expected_state_version)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'single',$11,$12,'pending',
       now() + ($13 || ' hours')::interval, 'cancel_task', $14, $15)
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
      PRESENTATION_VERSION_V1,
      String(APPROVAL_TTL_HOURS),
      input.targetTaskId,
      input.expectedStateVersion,
    ],
  );
  const expiresAt = rows[0]?.expires_at;
  if (!expiresAt) throw new Error('approval insert returned no row');
  return {
    approvalId,
    originalText: input.originalText,
    presentationHash,
    presentationVersion: PRESENTATION_VERSION_V1,
    expiresAt: expiresAt.toISOString(),
    wallTime: input.wallTime,
    timezoneId: input.timezoneId,
    fold: input.fold,
    offsetSeconds: input.offsetSeconds,
    fireAtUtc: input.fireAtUtc,
  };
}
