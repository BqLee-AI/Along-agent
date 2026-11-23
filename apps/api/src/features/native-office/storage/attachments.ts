import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { isUuid, notFound, validationError } from '../../../platform/errors.js';
import {
  idempotencyConflict,
  MAX_ATTACHMENT_BYTES,
  validateContent,
  validateFilename,
  type OfficeAttachment,
  type OfficeAttachmentStatus,
  type RevokeOfficeAttachment,
  type StageOfficeAttachment,
} from './model.js';
import {
  attachmentStatus,
  attachmentView,
  lockOfficeOwner,
  requireOfficeQuota,
  requireOfficeSession,
} from './queries.js';

export type StagedOfficeAttachment = OfficeAttachment & { status: OfficeAttachmentStatus };
type AttachmentRow = Omit<StagedOfficeAttachment, 'expiresAt'> & { expiresAt: Date };

export function attachmentParameters(input: StageOfficeAttachment): string {
  validateFilename(input.filename);
  validateContent(input.bytes, MAX_ATTACHMENT_BYTES);
  if (!isUuid(input.draftId)) throw validationError('invalid office draft');
  if (input.conversationId != null && !isUuid(input.conversationId)) throw notFound();
  if (
    !input.idempotencyKey.trim() ||
    input.idempotencyKey.length > 200 ||
    /[\u0000-\u001f\u007f]/u.test(input.idempotencyKey)
  ) {
    throw validationError('invalid office upload idempotency key');
  }
  if (input.format !== 'txt' && input.format !== 'markdown' && input.format !== 'csv') {
    throw validationError('unsupported attachment format');
  }
  // The HTTP boundary validates the original UTF-8 once while parsing OfficeUpload.
  return createHash('sha256').update(input.bytes).digest('hex');
}

export async function stageAttachment(
  client: PoolClient,
  input: StageOfficeAttachment,
  sha256: string,
): Promise<StagedOfficeAttachment> {
  const { ownerId, sessionId, draftId, idempotencyKey, filename, format, bytes } = input;
  const conversationId = input.conversationId?.toLowerCase() ?? null;
  // Admission already holds the conversation lock before consuming. Keep the
  // same order and hold the FK target until the stage completes.
  let ownsConversation = true;
  if (conversationId !== null) {
    const owned = await client.query(
      'SELECT 1 FROM conversations WHERE id = $1 AND owner_id = $2 FOR KEY SHARE',
      [conversationId, ownerId],
    );
    ownsConversation = owned.rowCount === 1;
  }
  await requireOfficeSession(client, input);
  if (!ownsConversation) throw notFound();
  await lockOfficeOwner(client, ownerId);
  const prior = await client.query<
    AttachmentRow & { uploadConversationId: string | null; sha256: string }
  >(
    `SELECT ${attachmentView}, ${attachmentStatus} AS status,
      u.upload_conversation_id AS "uploadConversationId", u.sha256
     FROM office_attachments u
     WHERE u.owner_id = $1 AND u.session_id = $2 AND u.draft_id = $3 AND u.idempotency_key = $4`,
    [ownerId, sessionId, draftId, idempotencyKey],
  );
  if (prior.rows.length) {
    const { uploadConversationId, sha256: previousHash, ...existing } = prior.rows[0]!;
    if (
      uploadConversationId !== conversationId ||
      existing.filename !== filename ||
      existing.format !== format ||
      existing.sizeBytes !== bytes.length ||
      previousHash !== sha256
    ) {
      throw idempotencyConflict();
    }
    return { ...existing, expiresAt: existing.expiresAt.toISOString() };
  }

  await requireOfficeQuota(client, ownerId, bytes.length);
  const { rows } = await client.query<AttachmentRow>(
    `INSERT INTO office_attachments AS u
      (id, owner_id, session_id, draft_id, upload_conversation_id, idempotency_key,
       filename, format, size_bytes, sha256, content, created_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
             statement_timestamp(), statement_timestamp() + interval '24 hours')
     RETURNING ${attachmentView}, 'available' AS status`,
    [
      randomUUID(),
      ownerId,
      sessionId,
      draftId,
      conversationId,
      idempotencyKey,
      filename,
      format,
      bytes.length,
      sha256,
      bytes,
    ],
  );
  const staged = rows[0]!;
  return { ...staged, expiresAt: staged.expiresAt.toISOString() };
}

export async function revokeAttachment(client: PoolClient, input: RevokeOfficeAttachment) {
  const { ownerId, sessionId, attachmentId, draftId, conversationId } = input;
  if (
    !isUuid(attachmentId) ||
    (draftId !== undefined && !isUuid(draftId)) ||
    (conversationId != null && !isUuid(conversationId))
  )
    throw notFound();
  await requireOfficeSession(client, input);
  await lockOfficeOwner(client, ownerId);
  const revoked = await client.query(
    `WITH target AS MATERIALIZED (
       SELECT u.id FROM office_attachments u
       WHERE u.id = $1 AND u.owner_id = $2 AND (
         (u.bound_conversation_id IS NOT NULL
           AND (NOT $6::boolean OR u.bound_conversation_id = $5::uuid))
         OR (u.bound_conversation_id IS NULL AND u.session_id = $3 AND u.draft_id = $4
           AND u.upload_conversation_id IS NOT DISTINCT FROM $5::uuid)
       )
     ), updated AS (
       UPDATE office_attachments u SET revoked_at = statement_timestamp()
       FROM target WHERE target.id = u.id AND u.revoked_at IS NULL
     ) SELECT id FROM target`,
    [
      attachmentId,
      ownerId,
      sessionId,
      draftId ?? null,
      conversationId ?? null,
      conversationId !== undefined,
    ],
  );
  if (revoked.rowCount !== 1) throw notFound();
}
