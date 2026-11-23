import type { PoolClient } from 'pg';
import { ApplicationError, unauthorized } from '../../../platform/errors.js';
import { lockViewerAccess } from '../../identity/public.js';
import { MAX_OWNER_BYTES, type OfficeActor } from './model.js';

// The owner-scoped advisory lock orders quota changes, revoke, consume, reads and
// effect acceptance. Shared mode is only for transactions that will not mutate
// office state, avoiding lock upgrades. Take it in a separate statement so queries
// after a wait see the winner's committed facts at PostgreSQL READ COMMITTED.
export async function lockOfficeOwner(client: PoolClient, ownerId: string, shared = false) {
  const fn = shared ? 'pg_advisory_xact_lock_shared' : 'pg_advisory_xact_lock';
  await client.query(`SELECT ${fn}(hashtextextended('native-office:' || $1::uuid::text, 0))`, [
    ownerId,
  ]);
}

export async function requireOfficeSession(
  client: PoolClient,
  { ownerId, sessionId }: OfficeActor,
) {
  if (!sessionId || !(await lockViewerAccess(client, ownerId, sessionId))) throw unauthorized();
}

// All callers use `a` for the artifact and query under the same owner lock when
// deciding byte disclosure. Natural source expiry is deliberately not checked.
export const artifactRevoked = `EXISTS (
  SELECT 1 FROM office_run_inputs i
  JOIN office_attachments u ON u.id = i.attachment_id
  WHERE i.run_id = a.scope_run_id AND u.revoked_at IS NOT NULL
    AND (NOT a.sources_known OR EXISTS (
      SELECT 1 FROM office_artifact_sources s
      WHERE s.artifact_id = a.id AND s.attachment_id = i.attachment_id
    ))
)`;

export const artifactView = `a.id AS "artifactId", d.run_id AS "runId", a.filename, a.format,
  a.size_bytes AS "sizeBytes", a.expires_at AS "expiresAt",
  CASE WHEN ${artifactRevoked} THEN 'revoked'
       WHEN a.expires_at <= statement_timestamp() THEN 'expired'
       ELSE 'available' END AS status`;

export const attachmentView = `u.id AS "attachmentId", u.filename, u.format,
  u.size_bytes AS "sizeBytes", u.expires_at AS "expiresAt"`;

export const attachmentStatus = `CASE WHEN u.revoked_at IS NOT NULL THEN 'revoked'
  WHEN u.expires_at <= statement_timestamp() THEN 'expired'
  WHEN u.bound_conversation_id IS NOT NULL THEN 'consumed'
  ELSE 'available' END`;

export async function requireOfficeQuota(client: PoolClient, ownerId: string, additional: number) {
  const { rows } = await client.query<{ fits: boolean }>(
    `SELECT (COALESCE((
      SELECT sum(u.size_bytes) FROM office_attachments u
      WHERE u.owner_id = $1 AND u.revoked_at IS NULL AND u.expires_at > statement_timestamp()
    ), 0) + COALESCE((
      SELECT sum(a.size_bytes) FROM office_deliveries d
      JOIN office_artifacts a USING (scope_run_id)
      WHERE d.owner_id = $1 AND a.expires_at > statement_timestamp() AND NOT ${artifactRevoked}
    ), 0) + $2::integer) <= $3::integer AS fits`,
    [ownerId, additional, MAX_OWNER_BYTES],
  );
  if (!rows[0]?.fits) {
    throw new ApplicationError(409, 'OFFICE_QUOTA_EXCEEDED', 'office storage quota exceeded');
  }
}
