import type { Pool } from 'pg';
import { withTransaction } from '../../../db/transaction.js';
import { validationError } from '../../../platform/errors.js';
import { downloadArtifact, writeOfficeDelivery } from './artifacts.js';
import { attachmentParameters, revokeAttachment, stageAttachment } from './attachments.js';
import type {
  OfficeArtifact,
  OfficeArtifactFormat,
  OfficeAttachment,
  OfficeRole,
  OfficeRun,
  RevokeOfficeAttachment,
  StageOfficeAttachment,
} from './model.js';
import { artifactRevoked, artifactView } from './queries.js';

export {
  assertOfficeInputs,
  assertOfficeSources,
  consumeOfficeAttachments,
  continueOfficeAttachments,
  prepareOfficeAttachments,
  readOfficeAttachment,
} from './inputs.js';
export { writeOfficeDelivery };
export type {
  ConsumeOfficeAttachments,
  OfficeArtifact,
  OfficeArtifactWrite,
  OfficeAttachment,
  OfficeExecution,
  OfficeFrozenInput,
  OfficeRole,
  OfficeRun,
  StageOfficeAttachment,
  WriteOfficeDelivery,
} from './model.js';
export type { StagedOfficeAttachment } from './attachments.js';

type HistoryInput = OfficeAttachment & { role: OfficeRole; status: OfficeArtifact['status'] };
export type OfficeRunMaterials = {
  scopeRunId: string;
  inputs: HistoryInput[];
  artifacts: OfficeArtifact[];
};
type HistoryRow = {
  requestedRunId: string;
  scopeRunId: string;
  id: string;
  role: OfficeRole | null;
  runId: string;
  filename: string;
  format: OfficeAttachment['format'];
  sizeBytes: number;
  expiresAt: Date;
  status: OfficeArtifact['status'];
};

/** Callers page the authorized Run IDs first. This projection never joins bytes. */
async function listRunMaterials(pool: Pool, ownerId: string, runIds: readonly string[]) {
  const result = new Map<string, OfficeRunMaterials>();
  if (!runIds.length) return result;
  const { rows } = await pool.query<HistoryRow>(
    `WITH scope AS (
       SELECT m.run_id, m.scope_run_id FROM office_run_materials m
       WHERE m.owner_id = $1 AND m.run_id = ANY($2::uuid[])
     ), artifacts AS (
       SELECT s.run_id AS "requestedRunId", s.scope_run_id AS "scopeRunId", ${artifactView}
       FROM scope s JOIN office_deliveries d USING (scope_run_id)
       JOIN office_artifacts a USING (scope_run_id)
     )
     SELECT s.run_id AS "requestedRunId", s.scope_run_id AS "scopeRunId", u.id, i.role, s.run_id AS "runId", u.filename,
       u.format, u.size_bytes AS "sizeBytes", u.expires_at AS "expiresAt",
       CASE WHEN u.revoked_at IS NOT NULL THEN 'revoked'
         WHEN u.expires_at <= statement_timestamp() THEN 'expired'
         ELSE 'available' END AS status
     FROM scope s JOIN office_run_inputs i ON i.run_id = s.scope_run_id
     JOIN office_attachments u ON u.id = i.attachment_id
     UNION ALL
     SELECT "requestedRunId", "scopeRunId", "artifactId", NULL, "runId", filename, format, "sizeBytes",
            "expiresAt", status FROM artifacts
     ORDER BY "requestedRunId", role, format`,
    [ownerId, runIds],
  );
  for (const { requestedRunId, scopeRunId, id, role, runId, expiresAt, ...row } of rows) {
    let material = result.get(requestedRunId);
    if (!material) {
      material = { scopeRunId, inputs: [], artifacts: [] };
      result.set(requestedRunId, material);
    }
    const metadata = { ...row, expiresAt: expiresAt.toISOString() };
    if (role) material.inputs.push({ ...metadata, attachmentId: id, role });
    else
      material.artifacts.push({
        ...metadata,
        artifactId: id,
        runId,
        format: row.format as OfficeArtifactFormat,
      });
  }
  return result;
}

/** Delete only bytes already logically unavailable. Keep receipts and metadata. */
async function pruneBytes(pool: Pool, batchSize: number) {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1000) {
    throw validationError('invalid office cleanup batch size');
  }
  return withTransaction(pool, async (client) => {
    const attachments = await client.query(
      `WITH batch AS (
         SELECT b.attachment_id FROM office_attachments u
         JOIN office_attachment_bytes b ON b.attachment_id = u.id
         WHERE u.revoked_at IS NOT NULL OR u.expires_at <= statement_timestamp()
         ORDER BY u.expires_at, u.id LIMIT $1 FOR UPDATE OF b SKIP LOCKED
       ) DELETE FROM office_attachment_bytes b USING batch
         WHERE b.attachment_id = batch.attachment_id`,
      [batchSize],
    );
    const artifacts = await client.query(
      `WITH batch AS (
         SELECT b.artifact_id FROM office_artifacts a JOIN office_artifact_bytes b ON b.artifact_id = a.id
         WHERE a.expires_at <= statement_timestamp() OR ${artifactRevoked}
         ORDER BY a.expires_at, a.id LIMIT $1 FOR UPDATE OF b SKIP LOCKED
       ) DELETE FROM office_artifact_bytes b USING batch WHERE b.artifact_id = batch.artifact_id`,
      [batchSize],
    );
    return { attachments: attachments.rowCount ?? 0, artifacts: artifacts.rowCount ?? 0 };
  });
}

export function createOfficeStorage(pool: Pool) {
  return {
    async stageAttachment(input: StageOfficeAttachment) {
      const digest = attachmentParameters(input);
      return withTransaction(pool, (client) => stageAttachment(client, input, digest));
    },
    revokeAttachment(input: RevokeOfficeAttachment) {
      return withTransaction(pool, (client) => revokeAttachment(client, input));
    },
    downloadArtifact(input: OfficeRun & { artifactId: string; sessionId?: string }) {
      return withTransaction(pool, (client) => downloadArtifact(client, input));
    },
    listRunMaterials: (ownerId: string, runIds: readonly string[]) =>
      listRunMaterials(pool, ownerId, runIds),
    pruneBytes: (batchSize = 100) => pruneBytes(pool, batchSize),
  };
}
