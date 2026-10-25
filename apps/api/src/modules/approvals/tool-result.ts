import type { PoolClient } from 'pg';
import { z } from 'zod';
import { stateConflict } from '../../http/errors.js';
import {
  computePresentationHash,
  renderCreateTaskEcho,
  renderEchoCancelV1,
  shortNoOf,
} from './presentation.js';
import type { CreatedApproval } from './create.js';

const rowSchema = z.object({
  id: z.string().uuid(),
  original_text: z.string(),
  presentation_hash: z.string(),
  presentation_version: z.string(),
  expires_at: z.date(),
  wall_time: z.string(),
  timezone_id: z.string(),
  fold: z.union([z.literal(0), z.literal(1)]),
  resolved_utc_offset_seconds: z.number().int(),
  fire_at_utc: z.date(),
  kind: z.enum(['create_task', 'cancel_task']),
});

// Public frozen receipt use case. Deliberately does not read mutable state,
// consumed_task_id, remaining TTL, or the dynamic approval details DTO.
export async function readFrozenToolApproval(
  client: PoolClient,
  input: {
    ownerId: string;
    approvalId: string;
    fireAtUtc: string;
    presentationHash: string;
    presentationVersion: string;
  },
): Promise<{
  kind: 'approval';
  approval: CreatedApproval;
  echo_text: string;
  card_id: string;
  original_text: string;
}> {
  const result = await client.query(
    `SELECT id, original_text, presentation_hash, presentation_version, expires_at,
       wall_time, timezone_id, fold, resolved_utc_offset_seconds, fire_at_utc, kind
     FROM approvals WHERE id = $1 AND owner_id = $2`,
    [input.approvalId, input.ownerId],
  );
  const parsed = rowSchema.safeParse(result.rows[0]);
  if (!parsed.success) throw stateConflict('frozen approval receipt unavailable');
  const row = parsed.data;
  const snapshot = {
    originalText: row.original_text,
    localDatetime: row.wall_time,
    timezoneId: row.timezone_id,
    fold: row.fold,
    offsetSeconds: row.resolved_utc_offset_seconds,
    occurrence: 'single' as const,
    presentationVersion: row.presentation_version,
  };
  if (
    row.fire_at_utc.getTime() !== Date.parse(input.fireAtUtc) ||
    row.presentation_hash !== input.presentationHash ||
    row.presentation_version !== input.presentationVersion ||
    computePresentationHash(snapshot) !== row.presentation_hash
  ) {
    throw stateConflict('frozen approval receipt conflict');
  }
  const approval: CreatedApproval = {
    approvalId: row.id,
    originalText: row.original_text,
    presentationHash: row.presentation_hash,
    presentationVersion: row.presentation_version,
    expiresAt: row.expires_at.toISOString(),
    wallTime: row.wall_time,
    timezoneId: row.timezone_id,
    fold: row.fold,
    offsetSeconds: row.resolved_utc_offset_seconds,
    fireAtUtc: input.fireAtUtc,
  };
  const render = row.kind === 'cancel_task' ? renderEchoCancelV1 : renderCreateTaskEcho;
  return {
    kind: 'approval',
    approval,
    echo_text: render(snapshot, shortNoOf(row.id)),
    card_id: `card:${row.id}`,
    original_text: row.original_text,
  };
}
