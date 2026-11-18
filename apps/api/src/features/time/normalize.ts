import {
  classifyEntry,
  normalize,
  type EntryClassifyResult,
  type FoldChoice,
  type NormalizeErrorCode,
  type NormalizeOk,
} from '@along/time-core';
import type { TimeContext } from './context.js';

export interface NormalizeTimeInput {
  raw_text: string;
  anchorReceivedAtUtc: string;
  receivedAtUtc: string;
  confirmedTimezone: string | null;
  foldChoice: FoldChoice;
  requireCompleteReminder?: boolean;
  reminderContent?: string;
}

export interface TimeFailure {
  code: NormalizeErrorCode;
  message: string;
  http_status: 422 | 503;
  details?: unknown;
}

export type ApplicationTimeResult =
  | { kind: 'clarify'; classified: EntryClassifyResult }
  | { kind: 'error'; error: TimeFailure }
  | {
      kind: 'ok';
      wall_time: string;
      timezone_id: string;
      tzdb_version: string;
      normalized: NormalizeOk;
    };

const TIME_ERROR_TEXT: Record<NormalizeErrorCode, string> = {
  NONEXISTENT_LOCAL_TIME: '当地并不存在这个时刻；不猜、不存、不排，请重定。',
  AMBIGUOUS_LOCAL_TIME: '这个本地时间出现了两次，请选择第一次或第二次。',
  TZDB_UNAVAILABLE: '时区规则库暂不可用，现在无法排期，请稍后再试。',
  UNKNOWN_TIMEZONE: '本版本不认识这个时区，请提供支持的规范时区或别名。',
};

// Public application use case for conversation and future approval revision.
// The caller owns persistent anchors, clocks, transactions and approvals.
export function normalizeTime(
  context: TimeContext,
  input: NormalizeTimeInput,
): ApplicationTimeResult {
  if (!context.available) {
    return {
      kind: 'error',
      error: {
        code: 'TZDB_UNAVAILABLE',
        message: TIME_ERROR_TEXT.TZDB_UNAVAILABLE,
        http_status: 503,
      },
    };
  }
  const classified = classifyEntry({
    text: input.raw_text,
    anchorReceivedAtUtc: input.anchorReceivedAtUtc,
    receivedAtUtc: input.receivedAtUtc,
    confirmedTz: input.confirmedTimezone ?? '',
    fold: input.foldChoice,
    ruleset: context.ruleset,
    aliases: context.aliases,
    requireCompleteReminder: input.requireCompleteReminder,
    reminderContent: input.reminderContent,
  });
  if (classified.class === 'error') {
    const code = classified.reason === 'UNKNOWN_TIMEZONE' ? 'UNKNOWN_TIMEZONE' : 'TZDB_UNAVAILABLE';
    return {
      kind: 'error',
      error: {
        code,
        message: TIME_ERROR_TEXT[code],
        http_status: code === 'TZDB_UNAVAILABLE' ? 503 : 422,
      },
    };
  }
  if (classified.class !== 'normalize_ok' || !classified.wall_time || !classified.timezone_id) {
    return { kind: 'clarify', classified };
  }
  const normalized = normalize(
    classified.wall_time,
    classified.timezone_id,
    classified.fold ?? 'none',
    context.ruleset,
  );
  if (normalized.kind === 'error') {
    const code = normalized.error;
    return {
      kind: 'error',
      error: {
        code,
        message: TIME_ERROR_TEXT[code],
        http_status: code === 'TZDB_UNAVAILABLE' ? 503 : 422,
        ...(code === 'AMBIGUOUS_LOCAL_TIME'
          ? {
              details: {
                wall_time: classified.wall_time,
                timezone_id: classified.timezone_id,
                ruleset_id: normalized.ruleset_id,
                candidates: normalized.candidates,
              },
            }
          : {}),
      },
    };
  }
  return {
    kind: 'ok',
    wall_time: classified.wall_time,
    timezone_id: classified.timezone_id,
    tzdb_version: context.tzdb_version,
    normalized,
  };
}
