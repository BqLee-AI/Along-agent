import { z } from 'zod';
import type { ConversationRunHistoryItem } from '@along/contracts';

const uuid = z.string().uuid();

/** View data for an authorized Run projection, not an SSE event or assistant response. */
export type OfficeArtifact = {
  id: string;
  runId: string;
  filename: string;
  format: 'markdown' | 'csv';
  status: 'available' | 'expired' | 'revoked';
  downloadUrl: string | null;
};

export type OfficeRunResults = {
  files: readonly OfficeArtifact[];
  reminder: { state: 'unconfirmed' } | { state: 'created'; taskId: string; currentStatus: string };
};

export function officeDownloadHref(conversationId: string, artifact: OfficeArtifact) {
  if (artifact.status !== 'available' || !artifact.downloadUrl) return null;
  const { runId } = artifact;
  if (![conversationId, runId, artifact.id].every((id) => uuid.safeParse(id).success)) return null;
  const expected = `/api/v1/conversations/${conversationId}/runs/${runId}/artifacts/${artifact.id}/content`;
  return artifact.downloadUrl === expected ? artifact.downloadUrl : null;
}

/** Convert only authorized history. A continuation can share an earlier Run's files. */
export function projectOfficeRunResults(
  materials: NonNullable<ConversationRunHistoryItem['office_materials']>,
): OfficeRunResults {
  const { reminder } = materials;
  return {
    files: materials.artifacts.map((file) => ({
      id: file.artifact_id,
      runId: file.run_id,
      filename: file.filename,
      format: file.format,
      status: file.status,
      downloadUrl: file.download_url,
    })),
    reminder:
      reminder?.state === 'created'
        ? { state: 'created', taskId: reminder.task_id, currentStatus: reminder.current_status }
        : { state: 'unconfirmed' },
  };
}

/** The download action must come from authorized result metadata, never model Markdown. */
export function isOfficeDownloadLink(href: string | undefined) {
  if (!href) return false;
  try {
    const url = new URL(href, 'https://along.invalid/conversations');
    return /^\/api\/v1\/conversations\/[^/]+\/runs\/[^/]+\/artifacts\/[^/]+\/content$/i.test(
      decodeURIComponent(url.pathname),
    );
  } catch {
    return false;
  }
}
