import type {
  WorkspaceGrant,
  WorkspaceReadResult,
  WorkspaceAppliedResult,
  WorkspaceConflictResult,
} from '@along/contracts';

// Trusted projections supplied by tools public queries, never model/HTTP input.
export interface DocumentInvocationIdentity {
  invocation_id: string;
  owner_id: string;
  conversation_id: string;
  run_id: string;
  workspace_id: string;
  registration_digest: string;
  relative_path: string;
  created_at: string;
  accepted_at: string;
}
export interface DocumentReadEvidence extends DocumentInvocationIdentity {
  kind: 'read';
  result: WorkspaceReadResult;
}
export interface DocumentApplyEvidence extends DocumentInvocationIdentity {
  kind: 'apply';
  approval_id: string;
  state: 'reserved' | 'unknown' | 'completed';
  result: WorkspaceAppliedResult | WorkspaceConflictResult | null;
}
export interface DocumentRunEvidence {
  reads: readonly DocumentReadEvidence[];
  applies: readonly DocumentApplyEvidence[];
}
export interface CreateDocumentApprovalInput {
  ownerId: string;
  conversationId: string;
  runId: string;
  workspaceGrant: WorkspaceGrant;
  relativePath: string;
  baseRead: DocumentReadEvidence;
  oldText: string;
  newText: string;
  evidence: DocumentRunEvidence;
}
export interface DocumentApplyBinding {
  ownerId: string;
  conversationId: string;
  runId: string;
  approvalId: string;
  invocationId: string;
  workspaceGrant: WorkspaceGrant;
}
