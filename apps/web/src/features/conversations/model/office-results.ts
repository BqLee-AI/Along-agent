import { z } from 'zod';
import type { ConversationRunHistoryItem } from '@along/contracts';

const uuid = z.string().uuid();

type OfficeArtifact = NonNullable<
  ConversationRunHistoryItem['office_materials']
>['artifacts'][number];

export function officeDownloadHref(conversationId: string, artifact: OfficeArtifact) {
  const { status, download_url, run_id, artifact_id } = artifact;
  if (status !== 'available' || !download_url) return null;
  if (![conversationId, run_id, artifact_id].every((id) => uuid.safeParse(id).success)) return null;
  const expected = `/api/v1/conversations/${conversationId}/runs/${run_id}/artifacts/${artifact_id}/content`;
  return download_url === expected ? download_url : null;
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
