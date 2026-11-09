import { describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { DocumentApprovalConfirmBodySchema } from '@along/contracts';
import type {
  DocumentApplyEvidence,
  DocumentReadEvidence,
} from '../src/modules/approvals/document-evidence.js';
import type { DocumentApprovalRow } from '../src/modules/approvals/document-query.js';
import {
  assertExactDocumentText,
  buildDocumentPresentation,
  documentContentVersion,
  documentEvidenceLater,
  requireDocumentChainComplete,
} from '../src/modules/approvals/document-rules.js';

function fixture() {
  const ownerId = randomUUID(),
    conversationId = randomUUID(),
    runId = randomUUID();
  const before = '\uFEFFprefix\r\nold  \r\nsuffix\n';
  const after = '\uFEFFprefix\r\nnew  \r\nsuffix\n';
  const grant = {
    owner_id: ownerId,
    workspace_id: 'documents',
    registration_digest: 'a'.repeat(64),
    root_identity: '1:2',
  };
  const row: DocumentApprovalRow = {
    id: randomUUID(),
    owner_id: ownerId,
    conversation_id: conversationId,
    run_id: runId,
    workspace_id: grant.workspace_id,
    workspace_grant: grant,
    relative_path: 'memo.txt',
    base_read_invocation_id: randomUUID(),
    base_version: documentContentVersion(before),
    exact_new_content: after,
    new_version: documentContentVersion(after),
    ...buildDocumentPresentation({
      workspace_id: grant.workspace_id,
      relative_path: 'memo.txt',
      base_version: documentContentVersion(before),
      new_version: documentContentVersion(after),
      before,
      exact_new_content: after,
    }),
    state: 'approved',
    apply_invocation_id: randomUUID(),
    replaces_approval_id: null,
  };
  const identity = {
    owner_id: ownerId,
    conversation_id: conversationId,
    run_id: runId,
    workspace_id: grant.workspace_id,
    registration_digest: grant.registration_digest,
    relative_path: 'memo.txt',
  };
  const apply: DocumentApplyEvidence = {
    ...identity,
    kind: 'apply',
    invocation_id: row.apply_invocation_id!,
    approval_id: row.id,
    state: 'completed',
    created_at: '2026-10-26T00:00:01.000001Z',
    accepted_at: '2026-10-26T00:00:02.000001Z',
    result: {
      kind: 'applied',
      workspace_id: grant.workspace_id,
      path: 'memo.txt',
      approval_id: row.id,
      invocation_id: row.apply_invocation_id!,
      args_hash: 'b'.repeat(64),
      base_version: row.base_version,
      version: row.new_version,
      byte_length: Buffer.byteLength(after),
      evidence_ref: 'file:accepted',
    },
  };
  const read: DocumentReadEvidence = {
    ...identity,
    kind: 'read',
    invocation_id: randomUUID(),
    created_at: '2026-10-26T00:00:02.000002Z',
    accepted_at: '2026-10-26T00:00:02.000003Z',
    result: {
      kind: 'read',
      path: 'memo.txt',
      version: row.new_version,
      content: after,
      byte_length: Buffer.byteLength(after),
    },
  };
  return { row, apply, read, before, after };
}
describe('document approval exact presentation and done evidence', () => {
  it('preserves BOM, CRLF, whitespace and complete before/after in frozen preview', () => {
    const { row, before, after } = fixture();
    expect(row.preview.before).toBe(before);
    expect(row.preview.after).toBe(after);
    expect(JSON.parse(row.preview.body)).toMatchObject({ before, after });
    expect(documentContentVersion(row.preview.body)).toBe(row.presentation_hash);
    const changed = buildDocumentPresentation({
      workspace_id: row.workspace_id,
      relative_path: row.relative_path,
      base_version: row.base_version,
      new_version: row.new_version,
      before,
      exact_new_content: after + ' ',
    });
    expect(changed.presentation_hash).not.toBe(row.presentation_hash);
    expect(
      DocumentApprovalConfirmBodySchema.parse({
        presentation_hash: row.presentation_hash,
        seen_content: row.preview.body + ' ',
        idempotency_key: randomUUID(),
      }).seen_content,
    ).toBe(row.preview.body + ' ');
    expect(() => assertExactDocumentText('\ud800')).toThrow();
  });
  it('requires applied plus independent later exact read, preserving microsecond ordering', () => {
    const { row, apply, read } = fixture();
    expect(documentEvidenceLater(read.created_at, apply.accepted_at)).toBe(true);
    expect(() => requireDocumentChainComplete([row], [read], [apply])).not.toThrow();
    expect(() => requireDocumentChainComplete([row], [], [apply])).toThrow();
    expect(() =>
      requireDocumentChainComplete([row], [{ ...read, created_at: apply.created_at }], [apply]),
    ).toThrow();
    expect(() =>
      requireDocumentChainComplete(
        [row],
        [{ ...read, result: { ...read.result, content: read.result.content + ' ' } }],
        [apply],
      ),
    ).toThrow();
    expect(() =>
      requireDocumentChainComplete([row], [{ ...read, run_id: randomUUID() }], [apply]),
    ).toThrow();
    expect(() =>
      requireDocumentChainComplete([row], [read], [{ ...apply, state: 'unknown', result: null }]),
    ).toThrow();
  });
  it('accepts only a unique zero-write conflict chain followed by fresh read and approved applied successor', () => {
    const { row, apply, read, before } = fixture();
    const predecessor: DocumentApprovalRow = {
      ...row,
      id: randomUUID(),
      apply_invocation_id: randomUUID(),
      base_version: documentContentVersion(before + 'older'),
      base_read_invocation_id: randomUUID(),
    };
    row.replaces_approval_id = predecessor.id;
    const conflict: DocumentApplyEvidence = {
      ...apply,
      approval_id: predecessor.id,
      invocation_id: predecessor.apply_invocation_id!,
      created_at: '2026-10-26T00:00:00.000001Z',
      accepted_at: '2026-10-26T00:00:00.000002Z',
      result: {
        kind: 'conflict',
        workspace_id: row.workspace_id,
        path: row.relative_path,
        approval_id: predecessor.id,
        invocation_id: predecessor.apply_invocation_id!,
        args_hash: 'b'.repeat(64),
        base_version: predecessor.base_version,
        actual_version: row.base_version,
        reason: 'version_changed',
        zero_write: true,
      },
    };
    const fresh: DocumentReadEvidence = {
      ...read,
      invocation_id: row.base_read_invocation_id,
      created_at: '2026-10-26T00:00:00.000003Z',
      accepted_at: '2026-10-26T00:00:00.000004Z',
      result: {
        kind: 'read',
        path: row.relative_path,
        content: before,
        version: row.base_version,
        byte_length: Buffer.byteLength(before),
      },
    };
    expect(() =>
      requireDocumentChainComplete([predecessor, row], [fresh, read], [conflict, apply]),
    ).not.toThrow();
    for (const state of ['pending', 'rejected'] as const)
      expect(() =>
        requireDocumentChainComplete(
          [predecessor, { ...row, state }],
          [fresh, read],
          [conflict, apply],
        ),
      ).toThrow();
    expect(() =>
      requireDocumentChainComplete([predecessor, row], [read], [conflict, apply]),
    ).toThrow();
    expect(() =>
      requireDocumentChainComplete(
        [predecessor, row],
        [fresh, read],
        [{ ...conflict, result: null }, apply],
      ),
    ).toThrow();
    expect(() =>
      requireDocumentChainComplete(
        [predecessor, row, { ...row, id: randomUUID() }],
        [fresh, read],
        [conflict, apply],
      ),
    ).toThrow();
    expect(() =>
      requireDocumentChainComplete(
        [predecessor, row],
        [fresh, read],
        [{ ...conflict, state: 'reserved', result: null }, apply],
      ),
    ).toThrow();
  });
});
