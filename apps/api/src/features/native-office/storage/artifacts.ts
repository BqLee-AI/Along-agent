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
  const { runId, ownerId, paramsSha256, artifacts } = input;
  if (
    !/^[0-9a-f]{64}$/u.test(paramsSha256) ||
    artifacts.length < 1 ||
    artifacts.length > 2 ||
    new Set(artifacts.map(({ format }) => format)).size !== artifacts.length
  ) {
    throw validationError('invalid office delivery manifest');
  }
  const { scopeRunId } = await lockOfficeExecution(client, input);
  const {
    rows: [prior],
  } = await client.query<{ paramsSha256: string | null }>(
    `SELECT delivery_params_sha256 AS "paramsSha256" FROM office_run_materials WHERE run_id = $1`,
    [scopeRunId],
  );
  if (prior && prior.paramsSha256 !== null) {
    if (prior.paramsSha256 !== paramsSha256) throw idempotencyConflict();
  } else {
    const inputs = await requireActiveInputs(client, scopeRunId);
    const notesId = inputs.find(({ role }) => role === 'notes')?.attachmentId;
    const tasksId = inputs.find(({ role }) => role === 'tasks')?.attachmentId;
    let bytesRequired = 0;
    const writes = artifacts.map(({ filename, format, bytes, sourceAttachmentIds }) => {
      validateFilename(filename);
      validateContent(bytes, MAX_ARTIFACT_BYTES);
      if (format !== 'markdown' && format !== 'csv')
        throw validationError('invalid artifact format');
      let usesNotes = false;
      let usesTasks = false;
      for (const id of sourceAttachmentIds ?? []) {
        const sourceId = id.toLowerCase();
        if (sourceId === notesId) usesNotes = true;
        else if (sourceId === tasksId) usesTasks = true;
        else throw validationError('artifact source is outside the frozen inputs');
      }
      bytesRequired += bytes.length;
      return {
        filename,
        format,
        bytes,
        sourcesKnown: sourceAttachmentIds !== null,
        usesNotes,
        usesTasks,
      };
    });
    await requireOfficeQuota(client, ownerId, bytesRequired);
    await client.query(
      `UPDATE office_run_materials SET delivery_run_id = $2, delivery_params_sha256 = $3
       WHERE run_id = $1`,
      [scopeRunId, runId, paramsSha256],
    );
    for (const { filename, format, bytes, sourcesKnown, usesNotes, usesTasks } of writes) {
      await client.query(
        `INSERT INTO office_artifacts
          (id, scope_run_id, filename, format, size_bytes, sources_known, uses_notes, uses_tasks,
           content, created_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
                 statement_timestamp(), statement_timestamp() + interval '720 hours')`,
        [
          randomUUID(),
          scopeRunId,
          filename,
          format,
          bytes.length,
          sourcesKnown,
          usesNotes,
          usesTasks,
          bytes,
        ],
      );
    }
  }
  const { rows } = await client.query<ArtifactRow>(
    `SELECT ${artifactView} FROM office_run_materials d JOIN office_artifacts a ON a.scope_run_id = d.run_id
     WHERE d.run_id = $1 ORDER BY a.format`,
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
       SELECT ${artifactView}, a.content AS bytes
       FROM office_run_materials d JOIN office_artifacts a ON a.scope_run_id = d.run_id
       WHERE d.owner_id = $1 AND d.conversation_id = $2 AND d.delivery_run_id = $3
         AND a.id = $4 AND a.content IS NOT NULL
     )
     SELECT * FROM authorized WHERE status = 'available'`,
    [ownerId, conversationId, runId, artifactId],
  );
  if (!rows[0]) throw notFound();
  const { bytes, ...row } = rows[0];
  return { ...project(row), status: 'available', bytes };
}
