// notifier-core: pure in-app notification copy + channel capability flags.
// No I/O, no time math on display strings: callers pass frozen task fields
// through verbatim (design/04 section 8: display reads frozen fields only).

// v0 channel = in-app only (design/04 section 5, design/08 section 6).
export const INAPP_CHANNEL = 'inapp';

// System three-question capability flags (design/04 section 5, Observed):
// the host cannot confirm idempotent receipt / key lookup / cancel
// interception, so the copy layer MUST render the degraded wording below,
// never promise more.
export const INAPP_CAPABILITIES = {
  supportsIdempotencyKey: false,
  supportsLookupByKey: false,
  supportsCancelIntercept: false,
} as const;

// Honest-copy ceiling (design/08 section 6, design/07 section 4): receipt
// proves intake, never that the user saw it. (Ceiling asserted by
// test/copy.test.ts, which the copy scanner skips.)
export const RECEIPT_COPY = '已记录' as const;
export const CANCEL_INTERCEPT_COPY = '已拦截本次触发，系统排期是否撤掉仍无法确认。' as const;
export const MISSED_COPY = '已错过触发时间，可重新约时间。' as const;
export const CANCEL_CONFIRMING_COPY = '取消确认中，尚未取消。' as const;

export interface NoticeFields {
  wallTime: string;
  timezoneId: string;
  originalNote: string | null;
}

export interface NoticeCopy {
  title: string;
  body: string;
}

/** Title/body built only from frozen task fields; no time conversion. */
export function noticeCopyFor(fields: NoticeFields): NoticeCopy {
  const when = `${fields.wallTime} ${fields.timezoneId}`;
  const note = fields.originalNote && fields.originalNote.length > 0 ? fields.originalNote : '提醒';
  return {
    title: `提醒 ${when}`,
    body: `${RECEIPT_COPY}：${note}（${when}）。到点在调度器运行时尝试通知，关机、休眠或队列拥堵可能错过。`,
  };
}

export type SendOutcome = 'sent' | 'ack_unknown' | 'failed';

export interface SendReport {
  outcome: SendOutcome;
  providerReceiptId: string | null;
}

/** Map a provider result to the persisted outcome vocabulary. */
export function outcomeOf(result: { delivered: boolean; answered: boolean }): SendOutcome {
  if (result.delivered) return 'sent';
  if (!result.answered) return 'ack_unknown';
  return 'failed';
}

/** Map a persisted outcome to the notification row status. */
export function notificationStatusOf(outcome: SendOutcome): 'sent' | 'pending' | 'failed' {
  if (outcome === 'sent') return 'sent';
  if (outcome === 'failed') return 'failed';
  return 'pending';
}
