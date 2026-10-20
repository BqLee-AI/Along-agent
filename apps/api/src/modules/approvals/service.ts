import type { Pool, PoolClient } from 'pg';
import { withClient } from '../../db/transaction.js';
import {
  decodeCursor,
  encodeCursor,
  forbidden,
  isUuid,
  notFound,
  notReady,
  validationError,
  type HttpError,
} from '../../http/errors.js';
import { effectiveStatus, findSuccessorId, getApproval, listApprovals } from './repository.js';
import {
  PRESENTATION_VERSION_V1,
  renderEchoCancelV1,
  renderEchoV1,
  renderEchoV1Second,
  shortNoOf,
} from './presentation.js';
import { ApprovalListQuerySchema } from './schemas.js';

export interface Deps {
  pool: Pool | null;
  now?: () => Date;
}

export interface ApprovalListItem {
  approval_id: string;
  title: string;
  status: string;
  expires_at: string;
  created_at: string;
}

export interface ApprovalDetail {
  approval_id: string;
  kind: 'create_task' | 'cancel_task';
  status: string;
  echo_text: string;
  original_text: string | null;
  fire_at_local: string;
  expires_in_seconds: number;
  snapshot: {
    fire_at_utc: string;
    timezone_id: string;
    fold: number;
    offset_seconds: number;
  };
  presentation_hash: string;
  presentation_version: string;
  expires_at: string;
  recreated_from: string | null;
}

function titleOf(originalText: string | null, effective: string): string {
  if (effective === 'expired') return '已过期';
  if (!originalText || originalText.trim() === '') return '(空内容)';
  const firstLine = originalText.split('\n', 1)[0] ?? '';
  return firstLine.length > 42 ? `${firstLine.slice(0, 42)}…` : firstLine;
}

function echoOf(row: {
  original_text: string | null;
  wall_time: string;
  timezone_id: string;
  id: string;
}): string {
  const original = row.original_text ?? '';
  const snapshot = {
    originalText: original,
    localDatetime: row.wall_time,
    timezoneId: row.timezone_id,
    fold: 0 as const,
    offsetSeconds: 0,
    occurrence: 'single' as const,
    presentationVersion: PRESENTATION_VERSION_V1,
  };
  return renderEchoV1(snapshot, shortNoOf(row.id));
}

export function detailOf(
  row: Parameters<typeof echoOf>[0] & {
    fire_at_utc: Date;
    fold: number;
    resolved_utc_offset_seconds: number;
    presentation_hash: string;
    presentation_version: string;
    expires_at: Date;
    supersedes_approval_id: string | null;
    state: string;
    kind?: 'create_task' | 'cancel_task';
  },
  now: Date,
): ApprovalDetail {
  const effective = effectiveStatus(row, now);
  const snapshot = {
    originalText: row.original_text ?? '',
    localDatetime: row.wall_time,
    timezoneId: row.timezone_id,
    fold: (row.fold === 1 ? 1 : 0) as 0 | 1,
    offsetSeconds: row.resolved_utc_offset_seconds,
    occurrence: 'single' as const,
    presentationVersion: PRESENTATION_VERSION_V1,
  };
  const echo =
    row.kind === 'cancel_task'
      ? renderEchoCancelV1(snapshot, shortNoOf(row.id))
      : row.fold === 1
        ? renderEchoV1Second(snapshot)
        : renderEchoV1(snapshot, shortNoOf(row.id));
  return {
    approval_id: row.id,
    kind: row.kind ?? 'create_task',
    status: effective,
    echo_text: echo,
    original_text: row.original_text,
    fire_at_local: row.wall_time,
    expires_in_seconds: Math.max(0, Math.floor((row.expires_at.getTime() - now.getTime()) / 1000)),
    snapshot: {
      fire_at_utc: row.fire_at_utc.toISOString(),
      timezone_id: row.timezone_id,
      fold: row.fold,
      offset_seconds: row.resolved_utc_offset_seconds,
    },
    presentation_hash: row.presentation_hash,
    presentation_version: row.presentation_version,
    expires_at: row.expires_at.toISOString(),
    recreated_from: row.supersedes_approval_id,
  };
}

function requirePool(deps: Deps): Pool {
  if (!deps.pool) throw notReady();
  return deps.pool;
}

export async function listApprovalsForOwner(
  deps: Deps,
  ownerId: string,
  query: Record<string, string | string[] | undefined>,
): Promise<{ items: ApprovalListItem[]; next_cursor: string | null }> {
  const parsed = ApprovalListQuerySchema.safeParse({
    status: query.status,
    cursor: Array.isArray(query.cursor) ? query.cursor[0] : query.cursor,
    limit: Array.isArray(query.limit) ? query.limit[0] : query.limit,
  });
  if (!parsed.success) throw validationError('invalid query');
  const now = deps.now?.() ?? new Date();
  let cursor: { createdAt: string; id: string } | undefined;
  if (parsed.data.cursor) {
    const decoded = decodeCursor(parsed.data.cursor);
    if (
      !decoded ||
      typeof decoded.createdAt !== 'string' ||
      typeof decoded.id !== 'string' ||
      !isUuid(decoded.id) ||
      Number.isNaN(Date.parse(decoded.createdAt))
    ) {
      throw validationError('invalid cursor');
    }
    cursor = { createdAt: decoded.createdAt, id: decoded.id };
  }
  const rows = await withClient(requirePool(deps), (client: PoolClient) =>
    listApprovals(client, {
      ownerId,
      status: parsed.data.status,
      limit: parsed.data.limit,
      cursor,
      now,
    }),
  );
  const hasMore = rows.length > parsed.data.limit;
  const page = hasMore ? rows.slice(0, parsed.data.limit) : rows;
  const items: ApprovalListItem[] = page.map((row) => ({
    approval_id: row.id,
    title: titleOf(row.original_text, effectiveStatus(row, now)),
    status: effectiveStatus(row, now),
    expires_at: row.expires_at.toISOString(),
    created_at: row.created_at.toISOString(),
  }));
  const lastRow = page[page.length - 1] as
    | { id: string; created_at: Date; created_at_cursor?: string }
    | undefined;
  const nextCursor =
    hasMore && lastRow
      ? encodeCursor({
          createdAt: lastRow.created_at_cursor ?? lastRow.created_at.toISOString(),
          id: lastRow.id,
        })
      : null;
  return { items, next_cursor: nextCursor };
}

export async function getApprovalDetail(
  deps: Deps,
  ownerId: string,
  approvalId: string,
): Promise<{ detail: ApprovalDetail; successorId: string | null }> {
  const now = deps.now?.() ?? new Date();
  return withClient(requirePool(deps), async (client: PoolClient) => {
    const lookup = await getApproval(client, ownerId, approvalId);
    if (!lookup.found) throw notFound('approval not found') as HttpError;
    if (lookup.forbidden) throw forbidden('approval not found') as HttpError;
    const detail = detailOf(lookup.row, now);
    const successorId =
      detail.status === 'superseded' ? await findSuccessorId(client, approvalId) : null;
    return { detail, successorId };
  });
}

export { echoOf };
