// GET /brief (issue #10): deterministic, read-only assembly.
// No LLM, no snapshot table, no time conversion on display fields.
import type { Pool, PoolClient } from 'pg';
import { withClient } from '../../db/transaction.js';
import { notReady, validationError, type HttpError } from '../../http/errors.js';
import {
  listBriefApprovals,
  listBriefTasks,
  type BriefApprovalRow,
  type BriefTaskRow,
} from './repository.js';
import {
  BriefCardSchema,
  BriefQuerySchema,
  type BriefCard,
  type BriefResponse,
} from './schemas.js';

export interface BriefDeps {
  pool: Pool | null;
  tzdbVersion?: string;
  now?: () => Date;
}

interface CardEntry {
  card: BriefCard;
  fireAt: Date;
}

function shortTitle(text: string | null, fallback: string, max = 60): string {
  const firstLine = (text ?? '').split('\n', 1)[0]?.trim() ?? '';
  if (firstLine === '') return fallback;
  return firstLine.length > max ? `${firstLine.slice(0, max)}…` : firstLine;
}

function validatedCard(entry: CardEntry, requestId: string): BriefCard {
  const parsed = BriefCardSchema.safeParse(entry.card);
  if (parsed.success) return parsed.data;
  // docs/api/brief §3: invalid cards are replaced in place by a text card and
  // logged (no API error, no structured payload leak).
  console.warn(
    JSON.stringify({
      event: 'BRIEF_CARD_INVALID',
      request_id: requestId,
      card_id: entry.card.card_id,
      kind: entry.card.kind,
    }),
  );
  return {
    card_id: entry.card.card_id,
    kind: 'text',
    schema_version: 1,
    title: '这条内容暂时无法结构化展示，请升级后重试。',
  };
}

function localDateAt(now: Date, timezoneId: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezoneId,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(now);
    const value = (type: string) => parts.find((part) => part.type === type)?.value;
    const year = value('year');
    const month = value('month');
    const day = value('day');
    if (!year || !month || !day) throw new RangeError('missing date parts');
    return `${year}-${month}-${day}`;
  } catch {
    throw validationError('confirmed timezone is not a valid IANA zone') as HttpError;
  }
}

function taskEntry(row: BriefTaskRow): CardEntry {
  return {
    fireAt: row.fire_at_utc,
    card: {
      card_id: `card_task_${row.id}`,
      kind: 'task',
      schema_version: 1,
      title: shortTitle(row.original_note, '提醒'),
      status: row.state,
      fire_at_local: row.wall_time,
      ref: { task_id: row.id },
    },
  };
}

function approvalEntry(row: BriefApprovalRow): CardEntry {
  return {
    fireAt: row.fire_at_utc,
    card: {
      card_id: `card_approval_${row.id}`,
      kind: 'approval',
      schema_version: 1,
      title: `请确认：${shortTitle(row.original_text, '待确认提醒')}`,
      status: 'pending',
      ref: { approval_id: row.id },
    },
  };
}

export async function getBrief(
  deps: BriefDeps,
  ownerId: string,
  confirmedTimezone: string | null,
  query: Record<string, string | string[] | undefined>,
  requestId: string,
): Promise<BriefResponse> {
  if (!deps.pool) throw notReady() as HttpError;
  if (!deps.tzdbVersion) throw notReady() as HttpError;
  const parsed = BriefQuerySchema.safeParse({
    date: Array.isArray(query.date) ? query.date[0] : query.date,
    timezone: Array.isArray(query.timezone) ? query.timezone[0] : query.timezone,
  });
  if (!parsed.success) throw validationError('invalid query') as HttpError;
  if (!confirmedTimezone) {
    throw validationError('confirmed timezone is required') as HttpError;
  }

  const now = deps.now?.() ?? new Date();
  // Validate the stored zone even when the caller supplied an explicit date.
  const currentDay = localDateAt(now, confirmedTimezone);
  const date = parsed.data.date ?? currentDay;
  const timezoneNote =
    parsed.data.timezone && parsed.data.timezone !== confirmedTimezone
      ? `请求时区 ${parsed.data.timezone} 与已确认时区 ${confirmedTimezone} 不一致；未换算，按已确认时区展示。`
      : null;

  const { tasks, approvals } = await withClient(deps.pool, async (client: PoolClient) => ({
    tasks: await listBriefTasks(client, ownerId, date, confirmedTimezone),
    approvals: await listBriefApprovals(client, ownerId, date, confirmedTimezone, now),
  }));

  const entries: CardEntry[] = [...tasks.map(taskEntry), ...approvals.map(approvalEntry)].sort(
    (a, b) => {
      const byTime = a.fireAt.getTime() - b.fireAt.getTime();
      if (byTime !== 0) return byTime;
      return a.card.card_id.localeCompare(b.card.card_id);
    },
  );
  const cards = entries.map((entry) => validatedCard(entry, requestId));

  return {
    date,
    timezone_id: confirmedTimezone,
    summary: {
      pending_count: approvals.length,
      fired_count: tasks.filter((row) => row.state === 'fired').length,
    },
    cards,
    meta: {
      brief_state: cards.length === 0 ? 'empty' : 'day-in-progress',
      timezone_note: timezoneNote,
    },
  };
}
