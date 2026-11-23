import { ApplicationError, validationError } from '../../../platform/errors.js';
import type { OfficeUpload } from '../upload.js';

export const MAX_ATTACHMENT_BYTES = 1024 * 1024;
export const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;
export const MAX_OWNER_BYTES = 32 * 1024 * 1024;

export type OfficeActor = { ownerId: string; sessionId: string };
export type OfficeRun = { ownerId: string; conversationId: string; runId: string };
export type OfficeExecution = OfficeRun & OfficeActor;
export type OfficeRole = 'notes' | 'tasks';
export type OfficeFormat = OfficeUpload['format'];
export type OfficeArtifactFormat = 'markdown' | 'csv';
export type OfficeAttachmentStatus = 'available' | 'consumed' | 'expired' | 'revoked';
export type OfficeArtifactStatus = Exclude<OfficeAttachmentStatus, 'consumed'>;

export type OfficeAttachment = {
  attachmentId: string;
  filename: string;
  format: OfficeFormat;
  sizeBytes: number;
  expiresAt: string;
};
export type OfficeFrozenInput = OfficeAttachment & { role: OfficeRole; sha256: string };
export type OfficeArtifact = {
  artifactId: string;
  runId: string;
  filename: string;
  format: OfficeArtifactFormat;
  sizeBytes: number;
  expiresAt: string;
  status: OfficeArtifactStatus;
};

export type StageOfficeAttachment = OfficeActor &
  OfficeUpload & {
    draftId: string;
    conversationId?: string | null;
    idempotencyKey: string;
  };
export type RevokeOfficeAttachment = OfficeActor & {
  attachmentId: string;
  draftId?: string;
  conversationId?: string | null;
};
export type ConsumeOfficeAttachments = OfficeExecution & {
  draftId: string;
  notesAttachmentId?: string;
  tasksAttachmentId?: string;
};
export type OfficeSourceSelection = {
  // null: unproven provenance; []: proven independent of all frozen inputs.
  sourceAttachmentIds: readonly string[] | null;
};
export type OfficeArtifactWrite = OfficeSourceSelection & {
  filename: string;
  format: OfficeArtifactFormat;
  bytes: Buffer;
};
export type WriteOfficeDelivery = OfficeExecution & {
  paramsSha256: string;
  artifacts: readonly OfficeArtifactWrite[];
};

export function validateFilename(filename: string) {
  if (
    !filename ||
    filename.length > 255 ||
    filename === '.' ||
    filename === '..' ||
    /[\u0000-\u001f\u007f/\\]/u.test(filename)
  ) {
    throw validationError('invalid filename');
  }
}

export function validateContent(bytes: Buffer, limit: number) {
  if (bytes.length > limit) {
    throw new ApplicationError(413, 'PAYLOAD_TOO_LARGE', 'office file is too large');
  }
  if (!bytes.length) throw validationError('empty office file');
}

export function idempotencyConflict() {
  return new ApplicationError(409, 'IDEMPOTENCY_CONFLICT', 'office idempotency conflict');
}

export function unavailableMaterials() {
  return new ApplicationError(409, 'OFFICE_MATERIALS_UNAVAILABLE', 'office materials unavailable');
}
