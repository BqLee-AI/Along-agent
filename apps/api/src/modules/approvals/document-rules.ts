import { createHash } from 'node:crypto';
import type {
  DocumentApprovalReceipt,
  WorkspaceAppliedResult,
  WorkspaceConflictResult,
} from '@along/contracts';
import { stateConflict, validationError } from '../../http/errors.js';
import type { DocumentApplyEvidence, DocumentReadEvidence } from './document-evidence.js';
import type { DocumentApprovalRow } from './document-repository.js';

export function documentContentVersion(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}
export function assertExactDocumentText(content: string): void {
  if (content.includes('\0') || Buffer.from(content, 'utf8').toString('utf8') !== content)
    throw validationError('document content must be exact UTF-8 text without NUL');
}
export function buildDocumentPresentation(input: {
  workspace_id: string;
  relative_path: string;
  base_version: string;
  new_version: string;
  before: string;
  exact_new_content: string;
}): Pick<DocumentApprovalReceipt, 'presentation_version' | 'presentation_hash' | 'preview'> {
  const presentation_version = 'document_replace.v1' as const;
  // JSON string encoding makes boundaries unambiguous without changing document whitespace.
  const body = JSON.stringify(
    {
      presentation_version,
      workspace_id: input.workspace_id,
      relative_path: input.relative_path,
      base_version: input.base_version,
      new_version: input.new_version,
      before: input.before,
      after: input.exact_new_content,
    },
    null,
    2,
  );
  return {
    presentation_version,
    presentation_hash: documentContentVersion(body),
    preview: { before: input.before, after: input.exact_new_content, body },
  };
}
export function documentReceipt(row: DocumentApprovalRow): DocumentApprovalReceipt {
  return {
    kind: 'document_replace',
    approval_id: row.id,
    conversation_id: row.conversation_id,
    run_id: row.run_id,
    workspace_id: row.workspace_id,
    relative_path: row.relative_path,
    base_read_invocation_id: row.base_read_invocation_id,
    base_version: row.base_version,
    new_version: row.new_version,
    exact_new_content: row.exact_new_content,
    presentation_version: row.presentation_version,
    presentation_hash: row.presentation_hash,
    preview: row.preview,
    replaces_approval_id: row.replaces_approval_id,
  };
}
function sameTarget(
  row: DocumentApprovalRow,
  evidence: DocumentReadEvidence | DocumentApplyEvidence,
): boolean {
  return (
    evidence.owner_id === row.owner_id &&
    evidence.conversation_id === row.conversation_id &&
    evidence.run_id === row.run_id &&
    evidence.workspace_id === row.workspace_id &&
    evidence.registration_digest === row.workspace_grant.registration_digest &&
    evidence.relative_path === row.relative_path
  );
}
// Preserve PostgreSQL's microsecond timestamp order instead of truncating to JS milliseconds.
function timestamp(value: string): bigint | null {
  const match = /^(.*T\d\d:\d\d:\d\d)(?:\.(\d{1,6}))?Z$/.exec(value);
  if (!match) return null;
  const seconds = Date.parse(`${match[1]}Z`);
  if (!Number.isFinite(seconds)) return null;
  return BigInt(seconds) * 1000n + BigInt((match[2] ?? '').padEnd(6, '0'));
}
export function documentEvidenceLater(later: string, earlier: string): boolean {
  const a = timestamp(later);
  const b = timestamp(earlier);
  return a !== null && b !== null && a > b;
}
export function matchingDocumentApply(
  row: DocumentApprovalRow,
  applies: readonly DocumentApplyEvidence[],
): DocumentApplyEvidence | null {
  const matches = applies.filter((item) => item.invocation_id === row.apply_invocation_id);
  if (matches.length !== 1) return null;
  const item = matches[0]!;
  if (!sameTarget(row, item) || item.approval_id !== row.id) return null;
  return item;
}
export function isDocumentConflict(
  row: DocumentApprovalRow,
  item: DocumentApplyEvidence | null,
): item is DocumentApplyEvidence & { state: 'completed'; result: WorkspaceConflictResult } {
  if (!item || item.state !== 'completed' || item.result?.kind !== 'conflict') return false;
  const result = item.result;
  return (
    result.zero_write === true &&
    result.approval_id === row.id &&
    result.invocation_id === row.apply_invocation_id &&
    result.workspace_id === row.workspace_id &&
    result.path === row.relative_path &&
    result.base_version === row.base_version &&
    result.args_hash.length > 0
  );
}
export function isDocumentApplied(
  row: DocumentApprovalRow,
  item: DocumentApplyEvidence | null,
): item is DocumentApplyEvidence & { state: 'completed'; result: WorkspaceAppliedResult } {
  if (!item || item.state !== 'completed' || item.result?.kind !== 'applied') return false;
  const result = item.result;
  return (
    result.approval_id === row.id &&
    result.invocation_id === row.apply_invocation_id &&
    result.workspace_id === row.workspace_id &&
    result.path === row.relative_path &&
    result.base_version === row.base_version &&
    result.version === row.new_version &&
    result.byte_length === Buffer.byteLength(row.exact_new_content, 'utf8') &&
    result.args_hash.length > 0
  );
}
export function verifiedDocumentRead(
  row: DocumentApprovalRow,
  apply: DocumentApplyEvidence,
  reads: readonly DocumentReadEvidence[],
): DocumentReadEvidence | null {
  return (
    reads.find(
      (read) =>
        sameTarget(row, read) &&
        read.invocation_id !== row.base_read_invocation_id &&
        read.result.kind === 'read' &&
        read.result.path === row.relative_path &&
        read.result.version === row.new_version &&
        read.result.content === row.exact_new_content &&
        read.result.byte_length === Buffer.byteLength(row.exact_new_content, 'utf8') &&
        documentEvidenceLater(read.created_at, apply.accepted_at) &&
        documentEvidenceLater(read.accepted_at, apply.accepted_at),
    ) ?? null
  );
}
export function requireDocumentChainComplete(
  rows: readonly DocumentApprovalRow[],
  reads: readonly DocumentReadEvidence[],
  applies: readonly DocumentApplyEvidence[],
): void {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const successors = new Map<string, DocumentApprovalRow>();
  for (const row of rows) {
    if (!row.replaces_approval_id) continue;
    if (successors.has(row.replaces_approval_id))
      throw stateConflict('document replacement chain branches');
    const parent = byId.get(row.replaces_approval_id);
    if (
      !parent ||
      parent.owner_id !== row.owner_id ||
      parent.run_id !== row.run_id ||
      parent.conversation_id !== row.conversation_id ||
      parent.workspace_id !== row.workspace_id ||
      parent.relative_path !== row.relative_path ||
      parent.workspace_grant.registration_digest !== row.workspace_grant.registration_digest
    )
      throw stateConflict('document replacement chain target mismatch');
    if (
      parent.state !== 'approved' ||
      !isDocumentConflict(parent, matchingDocumentApply(parent, applies))
    )
      throw stateConflict('document replacement edge lacks an accepted zero-write conflict');
    successors.set(row.replaces_approval_id, row);
  }
  for (const initial of rows.filter((row) => row.state === 'approved')) {
    const visited = new Set<string>();
    let row = initial;
    while (true) {
      if (visited.has(row.id) || row.state !== 'approved')
        throw stateConflict('document replacement chain incomplete');
      visited.add(row.id);
      const apply = matchingDocumentApply(row, applies);
      if (isDocumentApplied(row, apply) && verifiedDocumentRead(row, apply, reads)) break;
      if (!isDocumentConflict(row, apply))
        throw stateConflict('approved document has no verified effect');
      const next = successors.get(row.id);
      if (!next) throw stateConflict('document conflict has no completed successor');
      const freshRead = reads.find(
        (read) =>
          read.invocation_id === next.base_read_invocation_id &&
          sameTarget(row, read) &&
          read.result.path === row.relative_path &&
          read.result.version === next.base_version &&
          documentContentVersion(read.result.content) === next.base_version &&
          documentEvidenceLater(read.created_at, apply.accepted_at) &&
          documentEvidenceLater(read.accepted_at, apply.accepted_at),
      );
      if (!freshRead) throw stateConflict('document successor lacks fresh conflict read');
      row = next;
    }
  }
}
