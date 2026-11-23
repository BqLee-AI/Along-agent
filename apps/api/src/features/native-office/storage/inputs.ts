import type { PoolClient } from 'pg';
import { isUuid, notFound, validationError } from '../../../platform/errors.js';
import {
  unavailableMaterials,
  type ConsumeOfficeAttachments,
  type OfficeExecution,
  type OfficeFrozenInput,
  type OfficeRole,
  type OfficeRun,
  type OfficeSourceSelection,
} from './model.js';
import { attachmentView, lockOfficeOwner, requireOfficeSession } from './queries.js';

type InputRow = Omit<OfficeFrozenInput, 'expiresAt'> & { expiresAt: Date };
type Scope = { scopeRunId: string; draftId: string };

function frozen(row: InputRow): OfficeFrozenInput {
  return {
    attachmentId: row.attachmentId,
    filename: row.filename,
    format: row.format,
    sizeBytes: row.sizeBytes,
    expiresAt: row.expiresAt.toISOString(),
    role: row.role,
    sha256: row.sha256,
  };
}

async function selectOfficeAttachments(
  client: PoolClient,
  input: ConsumeOfficeAttachments,
): Promise<{ ids: string[]; roles: OfficeRole[]; inputs: OfficeFrozenInput[] }> {
  const { ownerId, sessionId, draftId, conversationId, notesAttachmentId, tasksAttachmentId } =
    input;
  const picks: { role: OfficeRole; id: string }[] = [];
  if (notesAttachmentId !== undefined)
    picks.push({ role: 'notes', id: notesAttachmentId.toLowerCase() });
  if (tasksAttachmentId !== undefined)
    picks.push({ role: 'tasks', id: tasksAttachmentId.toLowerCase() });
  if (
    !isUuid(draftId) ||
    !picks.length ||
    picks.some((item) => !isUuid(item.id)) ||
    (picks.length === 2 && picks[0]!.id === picks[1]!.id)
  ) {
    throw validationError('invalid office materials selection');
  }
  await requireOfficeSession(client, input);
  await lockOfficeOwner(client, ownerId);
  const ids = picks.map(({ id }) => id);
  const roles = picks.map(({ role }) => role);
  const { rows } = await client.query<InputRow & { eligible: boolean }>(
    `SELECT ${attachmentView}, chosen.role, u.sha256,
       u.revoked_at IS NULL AND u.expires_at > statement_timestamp()
         AND u.bound_conversation_id IS NULL AS eligible
     FROM unnest($1::uuid[], $2::text[]) AS chosen(attachment_id, role)
     JOIN office_attachments u ON u.id = chosen.attachment_id
     WHERE u.owner_id = $3 AND u.session_id = $4 AND u.draft_id = $5
       AND (u.upload_conversation_id IS NULL OR u.upload_conversation_id = $6)
     ORDER BY chosen.role`,
    [ids, roles, ownerId, sessionId, draftId, conversationId],
  );
  if (rows.length !== picks.length) throw notFound();
  if (rows.some((item) => !item.eligible)) throw unavailableMaterials();
  if (rows.some(({ role, format }) => (role === 'tasks') !== (format === 'csv'))) {
    throw validationError('attachment format does not match its office role');
  }
  return { ids, roles, inputs: rows.map(frozen) };
}

/** Freeze while holding the owner lock before inserting the immutable Run. */
export async function prepareOfficeAttachments(
  client: PoolClient,
  input: ConsumeOfficeAttachments,
): Promise<OfficeFrozenInput[]> {
  return (await selectOfficeAttachments(client, input)).inputs;
}

/** Consume only after receipt replay has been resolved; errors must roll back admission. */
export async function consumeOfficeAttachments(
  client: PoolClient,
  input: ConsumeOfficeAttachments,
): Promise<OfficeFrozenInput[]> {
  const { ownerId, sessionId, draftId, conversationId, runId } = input;
  const { ids, roles, inputs } = await selectOfficeAttachments(client, input);

  // The caller has inserted this exact Run and holds the conversation lock.
  // This statement's FK prevents binding inputs to a stitched owner/conversation/Run.
  const run = await client.query(
    `INSERT INTO office_run_materials (run_id, owner_id, conversation_id, session_id, draft_id, scope_run_id)
     SELECT r.id, r.owner_id, r.conversation_id, $4, $5, r.id
     FROM agent_runs r WHERE r.id = $1 AND r.owner_id = $2 AND r.conversation_id = $3
       AND r.execution = 'harness' AND r.status = 'running'
       AND EXISTS (SELECT 1 FROM run_attempts a WHERE a.run_id = r.id AND a.owner_id = r.owner_id
                   AND a.attempt_no = 1 AND a.status = 'running')`,
    [runId, ownerId, conversationId, sessionId, draftId],
  );
  if (run.rowCount !== 1) throw notFound();
  await client.query(
    'UPDATE office_attachments SET bound_conversation_id = $2 WHERE id = ANY($1::uuid[])',
    [ids, conversationId],
  );
  await client.query(
    `INSERT INTO office_run_inputs (run_id, owner_id, conversation_id, session_id, draft_id, role,
                                    attachment_id, format, sha256)
     SELECT $1, $2, $3, $4, $5, chosen.role, u.id, u.format, u.sha256
     FROM unnest($6::uuid[], $7::text[]) AS chosen(attachment_id, role)
     JOIN office_attachments u ON u.id = chosen.attachment_id`,
    [runId, ownerId, conversationId, sessionId, draftId, ids, roles],
  );
  return inputs;
}

export async function lockOfficeExecution(
  client: PoolClient,
  input: OfficeExecution,
): Promise<Scope> {
  const { runId, ownerId, conversationId, sessionId } = input;
  await requireOfficeSession(client, input);
  await lockOfficeOwner(client, ownerId);
  const { rows } = await client.query<Scope>(
    `SELECT scope_run_id AS "scopeRunId", draft_id AS "draftId" FROM office_run_materials
     WHERE run_id = $1 AND owner_id = $2 AND conversation_id = $3 AND session_id = $4`,
    [runId, ownerId, conversationId, sessionId],
  );
  const scope = rows[0];
  if (!scope) throw notFound();
  return scope;
}

export async function requireActiveInputs(client: PoolClient, scopeRunId: string) {
  const { rows } = await client.query<InputRow & { eligible: boolean }>(
    `SELECT ${attachmentView}, i.role, i.sha256,
       u.revoked_at IS NULL AND u.expires_at > statement_timestamp() AS eligible
     FROM office_run_inputs i JOIN office_attachments u ON u.id = i.attachment_id
     WHERE i.run_id = $1 ORDER BY i.role`,
    [scopeRunId],
  );
  if (!rows.length || rows.some((row) => !row.eligible)) throw unavailableMaterials();
  return rows.map(frozen);
}

/** Also recheck during acceptance while the caller holds its Run/attempt fence. */
export async function assertOfficeInputs(
  client: PoolClient,
  input: OfficeExecution,
): Promise<void> {
  const { scopeRunId } = await lockOfficeExecution(client, input);
  await requireActiveInputs(client, scopeRunId);
}

/** Caller must prove this is the unique, adjacent and trusted pending clarification. */
export async function continueOfficeAttachments(
  client: PoolClient,
  input: OfficeExecution & { previousRunId: string },
): Promise<OfficeFrozenInput[]> {
  const { ownerId, conversationId, runId, sessionId, previousRunId } = input;
  await requireOfficeSession(client, input);
  await lockOfficeOwner(client, ownerId);
  const { rows } = await client.query<Scope>(
    `SELECT scope_run_id AS "scopeRunId", draft_id AS "draftId" FROM office_run_materials
     WHERE run_id = $1 AND owner_id = $2 AND conversation_id = $3`,
    [previousRunId, ownerId, conversationId],
  );
  const prior = rows[0];
  if (!prior) throw notFound();
  const inputs = await requireActiveInputs(client, prior.scopeRunId);
  const result = await client.query(
    `INSERT INTO office_run_materials
       (run_id, owner_id, conversation_id, session_id, draft_id, scope_run_id, previous_run_id)
     SELECT r.id, r.owner_id, r.conversation_id, $4, $5, $6, $7
     FROM agent_runs r WHERE r.id = $1 AND r.owner_id = $2 AND r.conversation_id = $3
       AND r.execution = 'harness' AND r.status = 'running'
       AND EXISTS (SELECT 1 FROM run_attempts a WHERE a.run_id = r.id AND a.owner_id = r.owner_id
                   AND a.attempt_no = 1 AND a.status = 'running')
     ON CONFLICT (previous_run_id) DO NOTHING`,
    [runId, ownerId, conversationId, sessionId, prior.draftId, prior.scopeRunId, previousRunId],
  );
  if (result.rowCount !== 1) throw unavailableMaterials();
  return inputs;
}

/** Reads a frozen role, never a requester/model-supplied attachment ID. */
export async function readOfficeAttachment(
  client: PoolClient,
  input: OfficeExecution & { role: OfficeRole },
): Promise<OfficeFrozenInput & { bytes: Buffer }> {
  const { scopeRunId } = await lockOfficeExecution(client, input);
  const { rows } = await client.query<InputRow & { bytes: Buffer }>(
    `WITH authorized AS MATERIALIZED (
       SELECT ${attachmentView}, i.role, i.sha256
       FROM office_run_inputs i JOIN office_attachments u ON u.id = i.attachment_id
       WHERE i.run_id = $1 AND i.role = $2 AND u.revoked_at IS NULL
         AND u.expires_at > statement_timestamp()
     )
     SELECT a.*, b.content AS bytes FROM authorized a
     JOIN office_attachment_bytes b ON b.attachment_id = a."attachmentId"`,
    [scopeRunId, input.role],
  );
  if (!rows[0]) throw unavailableMaterials();
  const { bytes, ...row } = rows[0];
  return { ...frozen(row), bytes };
}

/** Hold the caller's transaction through handing off the authorized event. */
export async function assertOfficeSources(
  client: PoolClient,
  input: OfficeRun & OfficeSourceSelection,
): Promise<void> {
  await lockOfficeOwner(client, input.ownerId, true);
  const { rows } = await client.query<{ allowed: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM office_run_inputs i WHERE i.run_id = m.scope_run_id)
     AND NOT EXISTS (
       SELECT 1 FROM office_run_inputs i JOIN office_attachments u ON u.id = i.attachment_id
       WHERE i.run_id = m.scope_run_id AND u.revoked_at IS NOT NULL
         AND ($4::uuid[] IS NULL OR i.attachment_id = ANY($4::uuid[]))
     ) AND NOT EXISTS (
       SELECT 1 FROM unnest($4::uuid[]) AS source(id)
       WHERE NOT EXISTS (SELECT 1 FROM office_run_inputs i
                         WHERE i.run_id = m.scope_run_id AND i.attachment_id = source.id)
     ) AS allowed
     FROM office_run_materials m WHERE m.run_id = $1 AND m.owner_id = $2 AND m.conversation_id = $3`,
    [input.runId, input.ownerId, input.conversationId, input.sourceAttachmentIds],
  );
  if (!rows[0]?.allowed) throw notFound();
}
