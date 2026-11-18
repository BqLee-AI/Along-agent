import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type {
  DocumentApprovalDetail,
  DocumentApprovalReceipt,
  WorkspaceOperationError,
} from '@along/contracts';
import { withClient } from '../../../db/transaction.js';
import { forbidden, notReady, stateConflict, validationError } from '../../../platform/errors.js';
import { validateWorkspaceGrant } from '../../workspaces/public.js';
import { readWorkspaceFile } from '../../workspaces/public.js';
import { compileWorkspaceEdit, type WorkspaceEditChange } from '../../workspaces/public.js';
import type {
  CreateDocumentApprovalInput,
  DocumentApplyBinding,
  DocumentRunEvidence,
} from './document-evidence.js';
import {
  getDocumentApproval,
  listDocumentApprovals,
  type DocumentApprovalRow,
} from './document-query.js';
import {
  assertExactDocumentText,
  buildDocumentPresentation,
  documentContentVersion,
  documentEvidenceLater,
  documentReceipt,
  isDocumentApplied,
  isDocumentConflict,
  matchingDocumentApply,
  requireDocumentChainComplete,
  verifiedDocumentRead,
} from './document-rules.js';

export class DocumentProposalOperationError extends Error {
  constructor(public readonly reason: WorkspaceOperationError['reason']) {
    super(reason);
    this.name = 'DocumentProposalOperationError';
  }
}

type DocumentApprovalInput =
  | CreateDocumentApprovalInput
  | (Omit<CreateDocumentApprovalInput, 'oldText' | 'newText'> & {
      change: WorkspaceEditChange;
    });

// Caller holds attempt → Run → proposal invocation locks. This uses the same
// PoolClient as proposal acceptance, so a failed acceptance leaves no approval.
export async function createDocumentApproval(
  client: PoolClient,
  input: DocumentApprovalInput,
): Promise<DocumentApprovalReceipt> {
  const { baseRead: read, workspaceGrant: grant } = input;
  const summary = validateWorkspaceGrant(input.ownerId, grant);
  if (!summary.writable_paths.includes(input.relativePath))
    throw forbidden('document target is not writable');
  if (
    read.owner_id !== input.ownerId ||
    read.conversation_id !== input.conversationId ||
    read.run_id !== input.runId ||
    read.workspace_id !== grant.workspace_id ||
    read.registration_digest !== grant.registration_digest ||
    read.relative_path !== input.relativePath ||
    read.result.kind !== 'read' ||
    read.result.path !== input.relativePath ||
    !read.accepted_at ||
    documentContentVersion(read.result.content) !== read.result.version ||
    Buffer.byteLength(read.result.content, 'utf8') !== read.result.byte_length
  )
    throw forbidden('proposal requires an accepted same-Run full read');
  assertExactDocumentText(read.result.content);
  const change: WorkspaceEditChange =
    'change' in input
      ? input.change
      : { kind: 'literal', old_text: input.oldText, new_text: input.newText };
  if (change.kind === 'literal') {
    assertExactDocumentText(change.old_text);
    assertExactDocumentText(change.new_text);
    if (!change.old_text) throw validationError('replacement requires a nonempty literal');
  } else {
    assertExactDocumentText(change.new_content);
  }
  const compiled = compileWorkspaceEdit(read.result.content, change);
  if (!compiled.ok) throw new DocumentProposalOperationError(compiled.reason);
  const exactNewContent = compiled.exact_new_content;
  const current = await readWorkspaceFile(input.ownerId, grant, input.relativePath);
  if (current.kind !== 'read') throw new DocumentProposalOperationError(current.reason);
  if (current.version !== read.result.version)
    throw new DocumentProposalOperationError('version_changed');
  const rows = await listDocumentApprovals(
    client,
    input.ownerId,
    input.conversationId,
    input.runId,
  );
  const sameTarget = rows.filter(
    (row) => row.workspace_id === grant.workspace_id && row.relative_path === input.relativePath,
  );
  if (sameTarget.some((row) => row.state === 'rejected'))
    throw stateConflict('rejected document action cannot be reproposed');
  const predecessors = new Set(
    sameTarget.flatMap((row) => (row.replaces_approval_id ? [row.replaces_approval_id] : [])),
  );
  const tails = sameTarget.filter((row) => !predecessors.has(row.id));
  if (tails.length > 1) throw stateConflict('ambiguous document replacement chain');
  const predecessor = tails[0];
  if (predecessor) {
    const apply = matchingDocumentApply(predecessor, input.evidence.applies);
    if (
      predecessor.state !== 'approved' ||
      !isDocumentConflict(predecessor, apply) ||
      predecessor.workspace_grant.registration_digest !== grant.registration_digest ||
      !documentEvidenceLater(read.created_at, apply.accepted_at) ||
      !documentEvidenceLater(read.accepted_at, apply.accepted_at)
    )
      throw stateConflict('same-target action is not a replaceable zero-write conflict');
  }
  const presentation = buildDocumentPresentation({
    workspace_id: grant.workspace_id,
    relative_path: input.relativePath,
    base_version: read.result.version,
    new_version: compiled.new_version,
    before: read.result.content,
    exact_new_content: exactNewContent,
  });
  const row: DocumentApprovalRow = {
    id: randomUUID(),
    owner_id: input.ownerId,
    conversation_id: input.conversationId,
    run_id: input.runId,
    workspace_id: grant.workspace_id,
    workspace_grant: grant,
    relative_path: input.relativePath,
    base_read_invocation_id: read.invocation_id,
    base_version: read.result.version,
    exact_new_content: exactNewContent,
    new_version: compiled.new_version,
    ...presentation,
    state: 'pending',
    apply_invocation_id: null,
    replaces_approval_id: predecessor?.id ?? null,
  };
  const receipt = documentReceipt(row);
  if (
    // Confirmation JSON-escapes the frozen preview again; a receipt fitting is not enough.
    Buffer.byteLength(
      JSON.stringify({
        presentation_hash: receipt.presentation_hash,
        seen_content: receipt.preview.body,
        idempotency_key: row.id,
      }),
      'utf8',
    ) > 131_072 ||
    Buffer.byteLength(
      JSON.stringify({ status: 'ok', result: { kind: 'document_approval', approval: receipt } }),
      'utf8',
    ) > 240_000
  )
    throw new DocumentProposalOperationError('range_too_large');
  await client.query(
    `INSERT INTO document_approvals
    (id,owner_id,conversation_id,run_id,workspace_id,workspace_grant,relative_path,base_read_invocation_id,
     base_version,exact_new_content,new_version,presentation_version,presentation_hash,preview,replaces_approval_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [
      row.id,
      row.owner_id,
      row.conversation_id,
      row.run_id,
      row.workspace_id,
      JSON.stringify(grant),
      row.relative_path,
      row.base_read_invocation_id,
      row.base_version,
      row.exact_new_content,
      row.new_version,
      row.presentation_version,
      row.presentation_hash,
      JSON.stringify(row.preview),
      row.replaces_approval_id,
    ],
  );
  return receipt;
}

// The caller supplies the agent's invocation facts; approvals own the lookup.
type ReadRunDocumentEvidence = (
  client: PoolClient,
  binding: { ownerId: string; conversationId: string; runId: string },
) => Promise<DocumentRunEvidence>;

export async function getDocumentApprovalDetail(
  pool: Pool | null,
  ownerId: string,
  approvalId: string,
  readRunDocumentEvidence: ReadRunDocumentEvidence,
): Promise<DocumentApprovalDetail> {
  if (!pool) throw notReady();
  return withClient(pool, (client) =>
    readDocumentApprovalDetail(client, ownerId, approvalId, readRunDocumentEvidence),
  );
}

export async function readDocumentApprovalDetail(
  client: PoolClient,
  ownerId: string,
  approvalId: string,
  readRunDocumentEvidence: ReadRunDocumentEvidence,
): Promise<DocumentApprovalDetail> {
  const row = await getDocumentApproval(client, ownerId, approvalId);
  // Owner-bound frozen receipts remain readable after workspace revocation;
  // confirmation and apply retain their separate live authority checks.
  const evidence = await readRunDocumentEvidence(client, {
    ownerId,
    conversationId: row.conversation_id,
    runId: row.run_id,
  });
  const rows = await listDocumentApprovals(client, ownerId, row.conversation_id, row.run_id);
  const apply = matchingDocumentApply(row, evidence.applies);
  const read =
    apply && isDocumentApplied(row, apply)
      ? verifiedDocumentRead(row, apply, evidence.reads)
      : null;
  const status = read
    ? 'verified'
    : isDocumentApplied(row, apply)
      ? 'applied'
      : isDocumentConflict(row, apply)
        ? 'conflict'
        : !row.apply_invocation_id
          ? 'not_started'
          : !apply
            ? 'unknown'
            : apply.state === 'completed'
              ? 'failed'
              : apply.state;
  return {
    ...documentReceipt(row),
    state: row.state,
    apply_invocation_id: row.apply_invocation_id,
    effect: {
      status,
      apply_invocation_id: row.apply_invocation_id,
      read_invocation_id: read?.invocation_id ?? null,
      successor_approval_id: rows.find((item) => item.replaces_approval_id === row.id)?.id ?? null,
    },
  };
}
function assertApplyBinding(row: DocumentApprovalRow, binding: DocumentApplyBinding): void {
  validateWorkspaceGrant(binding.ownerId, binding.workspaceGrant);
  if (
    row.conversation_id !== binding.conversationId ||
    row.run_id !== binding.runId ||
    row.state !== 'approved' ||
    row.workspace_id !== binding.workspaceGrant.workspace_id ||
    row.workspace_grant.registration_digest !== binding.workspaceGrant.registration_digest ||
    row.workspace_grant.root_identity !== binding.workspaceGrant.root_identity
  )
    throw forbidden('document apply is not authorized for this Run and workspace');
  if (row.apply_invocation_id !== null && row.apply_invocation_id !== binding.invocationId)
    throw forbidden('document approval is already bound to another apply invocation');
}
// Reservation and binding share a transaction. No filesystem operation occurs here.
export async function bindDocumentApprovalApply(
  client: PoolClient,
  binding: DocumentApplyBinding,
): Promise<DocumentApprovalReceipt> {
  const row = await getDocumentApproval(client, binding.ownerId, binding.approvalId, true);
  assertApplyBinding(row, binding);
  if (row.apply_invocation_id === null)
    await client.query('UPDATE document_approvals SET apply_invocation_id=$2 WHERE id=$1', [
      row.id,
      binding.invocationId,
    ]);
  return documentReceipt(row);
}
// Called again inside the existing once-only dispatch transaction, before unknown COMMIT.
export async function validateDocumentApprovalApply(
  client: PoolClient,
  binding: DocumentApplyBinding,
): Promise<DocumentApprovalReceipt> {
  const row = await getDocumentApproval(client, binding.ownerId, binding.approvalId, true);
  assertApplyBinding(row, binding);
  if (row.apply_invocation_id !== binding.invocationId)
    throw forbidden('document apply invocation is not bound');
  return documentReceipt(row);
}
export async function validateDocumentApprovalsDone(
  client: PoolClient,
  binding: { ownerId: string; conversationId: string; runId: string },
  evidence: DocumentRunEvidence,
): Promise<void> {
  const rows = await listDocumentApprovals(
    client,
    binding.ownerId,
    binding.conversationId,
    binding.runId,
  );
  requireDocumentChainComplete(rows, evidence.reads, evidence.applies);
}
