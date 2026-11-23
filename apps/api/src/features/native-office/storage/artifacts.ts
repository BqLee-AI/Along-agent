import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { isUuid, notFound, validationError } from '../../../platform/errors.js';
import { lockOfficeExecution, requireActiveInputs } from './inputs.js';
import {
  idempotencyConflict,
  MAX_ARTIFACT_BYTES,
  validateContent,
  validateFilename,
  type OfficeArtifact,
  type OfficeRun,
  type WriteOfficeDelivery,
} from './model.js';
import {
  artifactView,
  lockOfficeOwner,
  requireOfficeQuota,
  requireOfficeSession,
} from './queries.js';

type ArtifactRow = Omit<OfficeArtifact, 'expiresAt'> & { expiresAt: Date };

function project(row: ArtifactRow): OfficeArtifact {
  return { ...row, expiresAt: row.expiresAt.toISOString() };
}

/** Call inside the authorized attempt fence and the accepted receipt transaction. */
export async function writeOfficeDelivery(
  client: PoolClient,
  input: WriteOfficeDelivery,
): Promise<OfficeArtifact[]> {
  const { runId, ownerId, conversationId, paramsSha256, artifacts } = input;
  if (
    !/^[0-9a-f]{64}$/u.test(paramsSha256) ||
    artifacts.length < 1 ||
    artifacts.length > 2 ||
    new Set(artifacts.map(({ format }) => format)).size !== artifacts.length
  ) {
    throw validationError('invalid office delivery manifest');
  }
  const { scopeRunId } = await lockOfficeExecution(client, input);
  const prior = await client.query<{ paramsSha256: string }>(
    'SELECT params_sha256 AS "paramsSha256" FROM office_deliveries WHERE scope_run_id = $1',
    [scopeRunId],
  );
  if (prior.rows.length) {
    if (prior.rows[0]!.paramsSha256 !== paramsSha256) throw idempotencyConflict();
  } else {
    const inputs = await requireActiveInputs(client, scopeRunId);
    const selected = new Set(inputs.map(({ attachmentId }) => attachmentId));
    let bytesRequired = 0;
    for (const { filename, format, bytes, sourceAttachmentIds } of artifacts) {
      validateFilename(filename);
      validateContent(bytes, MAX_ARTIFACT_BYTES);
      if (format !== 'markdown' && format !== 'csv')
        throw validationError('invalid artifact format');
      if (sourceAttachmentIds?.some((id) => !selected.has(id.toLowerCase()))) {
        throw validationError('artifact source is outside the frozen inputs');
      }
      bytesRequired += bytes.length;
    }
    await requireOfficeQuota(client, ownerId, bytesRequired);
    await client.query(
      `INSERT INTO office_deliveries (scope_run_id, run_id, owner_id, conversation_id, params_sha256)
       VALUES ($1, $2, $3, $4, $5)`,
      [scopeRunId, runId, ownerId, conversationId, paramsSha256],
    );
    for (const { filename, format, bytes, sourceAttachmentIds } of artifacts) {
      await client.query(
        `WITH artifact AS (
           INSERT INTO office_artifacts
             (id, scope_run_id, filename, format, size_bytes, sources_known, created_at, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6::uuid[] IS NOT NULL,
                   statement_timestamp(), statement_timestamp() + interval '720 hours')
           RETURNING id, scope_run_id, size_bytes
         ), sources AS (
           INSERT INTO office_artifact_sources (artifact_id, scope_run_id, attachment_id)
           SELECT DISTINCT a.id, a.scope_run_id, s.id FROM artifact a
           CROSS JOIN unnest($6::uuid[]) AS s(id)
         )
         INSERT INTO office_artifact_bytes (artifact_id, size_bytes, content)
         SELECT id, size_bytes, $7::bytea FROM artifact`,
        [randomUUID(), scopeRunId, filename, format, bytes.length, sourceAttachmentIds, bytes],
      );
    }
  }
  const { rows } = await client.query<ArtifactRow>(
    `SELECT ${artifactView} FROM office_deliveries d JOIN office_artifacts a USING (scope_run_id)
     WHERE d.scope_run_id = $1 ORDER BY a.format`,
    [scopeRunId],
  );
  return rows.map(project);
}

export async function downloadArtifact(
  client: PoolClient,
  input: OfficeRun & { artifactId: string; sessionId?: string },
): Promise<Omit<OfficeArtifact, 'status'> & { status: 'available'; bytes: Buffer }> {
  const { ownerId, conversationId, runId, artifactId, sessionId } = input;
  if (![conversationId, runId, artifactId].every(isUuid)) throw notFound();
  if (sessionId !== undefined) await requireOfficeSession(client, { ownerId, sessionId });
  await lockOfficeOwner(client, ownerId, true);
  const { rows } = await client.query<ArtifactRow & { bytes: Buffer }>(
    `WITH authorized AS MATERIALIZED (
       SELECT ${artifactView} FROM office_deliveries d JOIN office_artifacts a USING (scope_run_id)
       WHERE d.owner_id = $1 AND d.conversation_id = $2 AND d.run_id = $3 AND a.id = $4
     )
     SELECT a.*, b.content AS bytes FROM authorized a
     JOIN office_artifact_bytes b ON b.artifact_id = a."artifactId" AND a.status = 'available'`,
    [ownerId, conversationId, runId, artifactId],
  );
  if (!rows[0]) throw notFound();
  const { bytes, ...row } = rows[0];
  return { ...project(row), status: 'available', bytes };
}
