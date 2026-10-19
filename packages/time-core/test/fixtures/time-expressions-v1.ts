// M1 fixture: 50 rows per docs/agent/06-eval-fixtures.md §time-expressions-v1.
// expect_detail is a time-core-scoped extension (pending owner confirmation):
// gives the exact wall_time/fold or clarify/reject key the entry layer must yield.
export interface ExpressionRow {
  expr_id: string;
  text: string;
  anchor_received_at_utc: string;
  received_at_utc?: string;
  confirmed_tz: string;
  expect: "normalize_ok" | "clarify" | "reject";
  expect_detail: {
    wall_time?: string;
    timezone_id?: string;
    fold?: "first" | "second" | "none";
    fire_at_utc?: string;
    reason?: string;
  };
}

const A = "2026-10-16T15:20:00Z";
const S = "Asia/Shanghai";
const N = "America/New_York";

export const TIME_EXPRESSIONS_V1: ExpressionRow[] = [
  { expr_id: "e01", text: "9:20", anchor_received_at_utc: A, confirmed_tz: S, expect: "normalize_ok", expect_detail: { wall_time: "2026-10-16T09:20:00", timezone_id: S, fold: "none", fire_at_utc: "2026-10-16T01:20:00Z" } },
  { expr_id: "e02", text: "晚上9点", anchor_received_at_utc: A, confirmed_tz: S, expect: "normalize_ok", expect_detail: { wall_time: "2026-10-16T21:00:00", timezone_id: S, fold: "none", fire_at_utc: "2026-10-16T13:00:00Z" } },
  { expr_id: "e03", text: "中午12点", anchor_received_at_utc: A, confirmed_tz: S, expect: "normalize_ok", expect_detail: { wall_time: "2026-10-16T12:00:00", timezone_id: S, fold: "none", fire_at_utc: "2026-10-16T04:00:00Z" } },
  { expr_id: "e04", text: "凌晨0点", anchor_received_at_utc: A, confirmed_tz: S, expect: "normalize_ok", expect_detail: { wall_time: "2026-10-16T00:00:00", timezone_id: S, fold: "none", fire_at_utc: "2026-10-15T16:00:00Z" } },
  { expr_id: "e05", text: "10月16日24:00", anchor_received_at_utc: A, confirmed_tz: S, expect: "normalize_ok", expect_detail: { wall_time: "2026-10-17T00:00:00", timezone_id: S, fold: "none", fire_at_utc: "2026-10-16T16:00:00Z" } },
  { expr_id: "e06", text: "09:05", anchor_received_at_utc: A, confirmed_tz: S, expect: "normalize_ok", expect_detail: { wall_time: "2026-10-16T09:05:00", timezone_id: S, fold: "none", fire_at_utc: "2026-10-16T01:05:00Z" } },
  { expr_id: "e07", text: "早上8点半", anchor_received_at_utc: A, confirmed_tz: S, expect: "normalize_ok", expect_detail: { wall_time: "2026-10-16T08:30:00", timezone_id: S, fold: "none", fire_at_utc: "2026-10-16T00:30:00Z" } },
  { expr_id: "e08", text: "下午3点15分", anchor_received_at_utc: A, confirmed_tz: S, expect: "normalize_ok", expect_detail: { wall_time: "2026-10-16T15:15:00", timezone_id: S, fold: "none", fire_at_utc: "2026-10-16T07:15:00Z" } },
  { expr_id: "e09", text: "2026-10-17 14:00", anchor_received_at_utc: A, confirmed_tz: S, expect: "normalize_ok", expect_detail: { wall_time: "2026-10-17T14:00:00", timezone_id: S, fold: "none", fire_at_utc: "2026-10-17T06:00:00Z" } },
  { expr_id: "e10", text: "2026年10月17日晚上9点20分", anchor_received_at_utc: A, confirmed_tz: S, expect: "normalize_ok", expect_detail: { wall_time: "2026-10-17T21:20:00", timezone_id: S, fold: "none", fire_at_utc: "2026-10-17T13:20:00Z" } },
  { expr_id: "e11", text: "10月17日 9:20", anchor_received_at_utc: A, confirmed_tz: S, expect: "clarify", expect_detail: { reason: "YEAR_MISSING" } },
  { expr_id: "e12", text: "10月18日晚上8点", anchor_received_at_utc: A, confirmed_tz: S, expect: "clarify", expect_detail: { reason: "YEAR_MISSING" } },
  { expr_id: "e13", text: "11月1日 01:30", anchor_received_at_utc: A, confirmed_tz: N, expect: "clarify", expect_detail: { reason: "YEAR_MISSING" } },
  { expr_id: "e14", text: "3月8日 02:30", anchor_received_at_utc: A, confirmed_tz: N, expect: "clarify", expect_detail: { reason: "YEAR_MISSING" } },
  { expr_id: "e15", text: "12月25日中午12点", anchor_received_at_utc: A, confirmed_tz: S, expect: "clarify", expect_detail: { reason: "YEAR_MISSING" } },
  { expr_id: "e16", text: "1月1日凌晨0点", anchor_received_at_utc: A, confirmed_tz: S, expect: "clarify", expect_detail: { reason: "YEAR_MISSING" } },
  { expr_id: "e17", text: "明天 9:20", anchor_received_at_utc: A, confirmed_tz: "", expect: "clarify", expect_detail: { reason: "TIMEZONE_MISSING" } },
  { expr_id: "e18", text: "晚上9点提醒我", anchor_received_at_utc: A, confirmed_tz: "", expect: "clarify", expect_detail: { reason: "TIMEZONE_MISSING" } },
  { expr_id: "e19", text: "10月17日 9:20", anchor_received_at_utc: A, confirmed_tz: "", expect: "clarify", expect_detail: { reason: "TIMEZONE_MISSING" } },
  { expr_id: "e20", text: "9:20", anchor_received_at_utc: A, confirmed_tz: "", expect: "clarify", expect_detail: { reason: "TIMEZONE_MISSING" } },
  { expr_id: "e21", text: "中午12点开会", anchor_received_at_utc: A, confirmed_tz: "", expect: "clarify", expect_detail: { reason: "TIMEZONE_MISSING" } },
  { expr_id: "e22", text: "凌晨0点", anchor_received_at_utc: A, confirmed_tz: "", expect: "clarify", expect_detail: { reason: "TIMEZONE_MISSING" } },
  { expr_id: "e23", text: "9点提醒我", anchor_received_at_utc: A, confirmed_tz: S, expect: "clarify", expect_detail: { reason: "DAYPART_MISSING" } },
  { expr_id: "e24", text: "12点开会", anchor_received_at_utc: A, confirmed_tz: S, expect: "clarify", expect_detail: { reason: "DAYPART_MISSING" } },
  { expr_id: "e25", text: "0点", anchor_received_at_utc: A, confirmed_tz: S, expect: "clarify", expect_detail: { reason: "DAYPART_MISSING" } },
  { expr_id: "e26", text: "明天8点", anchor_received_at_utc: A, confirmed_tz: S, expect: "clarify", expect_detail: { reason: "DAYPART_MISSING" } },
  { expr_id: "e27", text: "10月17日10点", anchor_received_at_utc: A, confirmed_tz: S, expect: "clarify", expect_detail: { reason: "YEAR_MISSING" } },
  { expr_id: "e28", text: "3点", anchor_received_at_utc: A, confirmed_tz: S, expect: "clarify", expect_detail: { reason: "DAYPART_MISSING" } },
  { expr_id: "e29", text: "12点左右", anchor_received_at_utc: A, confirmed_tz: S, expect: "reject", expect_detail: { reason: "FUZZY_RANGE" } },
  { expr_id: "e30", text: "尽快", anchor_received_at_utc: A, confirmed_tz: S, expect: "reject", expect_detail: { reason: "FUZZY_UNSCHEDULABLE" } },
  { expr_id: "e31", text: "有空时", anchor_received_at_utc: A, confirmed_tz: S, expect: "reject", expect_detail: { reason: "FUZZY_IDLE" } },
  { expr_id: "e32", text: "晚点", anchor_received_at_utc: A, confirmed_tz: S, expect: "reject", expect_detail: { reason: "FUZZY_UNSCHEDULABLE" } },
  { expr_id: "e33", text: "早点", anchor_received_at_utc: A, confirmed_tz: S, expect: "reject", expect_detail: { reason: "FUZZY_UNSCHEDULABLE" } },
  { expr_id: "e34", text: "改天", anchor_received_at_utc: A, confirmed_tz: S, expect: "reject", expect_detail: { reason: "FUZZY_UNSCHEDULABLE" } },
  { expr_id: "e35", text: "得空时", anchor_received_at_utc: A, confirmed_tz: S, expect: "reject", expect_detail: { reason: "FUZZY_IDLE" } },
  { expr_id: "e36", text: "大概9点", anchor_received_at_utc: A, confirmed_tz: S, expect: "reject", expect_detail: { reason: "FUZZY_RANGE" } },
  { expr_id: "e37", text: "明天 9:20", anchor_received_at_utc: A, confirmed_tz: S, expect: "normalize_ok", expect_detail: { wall_time: "2026-10-17T09:20:00", timezone_id: S, fold: "none", fire_at_utc: "2026-10-17T01:20:00Z" } },
  { expr_id: "e38", text: "明天上午9点", anchor_received_at_utc: A, confirmed_tz: S, expect: "normalize_ok", expect_detail: { wall_time: "2026-10-17T09:00:00", timezone_id: S, fold: "none", fire_at_utc: "2026-10-17T01:00:00Z" } },
  { expr_id: "e39", text: "明天 9:20", anchor_received_at_utc: "2026-10-16T23:50:00Z", confirmed_tz: S, expect: "normalize_ok", expect_detail: { wall_time: "2026-10-18T09:20:00", timezone_id: S, fold: "none", fire_at_utc: "2026-10-18T01:20:00Z" } },
  { expr_id: "e40", text: "明天 9:20", anchor_received_at_utc: A, received_at_utc: "2026-10-16T15:22:30Z", confirmed_tz: S, expect: "normalize_ok", expect_detail: { wall_time: "2026-10-17T09:20:00", timezone_id: S, fold: "none", fire_at_utc: "2026-10-17T01:20:00Z" } },
  { expr_id: "e41", text: "明天 9:20", anchor_received_at_utc: A, received_at_utc: "2026-10-17T00:05:00Z", confirmed_tz: S, expect: "clarify", expect_detail: { reason: "DATE_CHANGED" } },
  { expr_id: "e42", text: "后天 9:20", anchor_received_at_utc: A, confirmed_tz: S, expect: "normalize_ok", expect_detail: { wall_time: "2026-10-18T09:20:00", timezone_id: S, fold: "none", fire_at_utc: "2026-10-18T01:20:00Z" } },
  { expr_id: "e43", text: "2026-03-08T02:30", anchor_received_at_utc: A, confirmed_tz: N, expect: "normalize_ok", expect_detail: { wall_time: "2026-03-08T02:30:00", timezone_id: N, fold: "none" } },
  { expr_id: "e44", text: "2026-11-01T01:30", anchor_received_at_utc: A, confirmed_tz: N, expect: "normalize_ok", expect_detail: { wall_time: "2026-11-01T01:30:00", timezone_id: N, fold: "none" } },
  { expr_id: "e45", text: "2026-11-01T01:30 second", anchor_received_at_utc: A, confirmed_tz: N, expect: "normalize_ok", expect_detail: { wall_time: "2026-11-01T01:30:00", timezone_id: N, fold: "second", fire_at_utc: "2026-11-01T06:30:00Z" } },
  { expr_id: "e46", text: "2027-11-07T01:30", anchor_received_at_utc: A, confirmed_tz: N, expect: "normalize_ok", expect_detail: { wall_time: "2027-11-07T01:30:00", timezone_id: N, fold: "none" } },
  { expr_id: "e47", text: "北京时间 9:20", anchor_received_at_utc: A, confirmed_tz: S, expect: "normalize_ok", expect_detail: { wall_time: "2026-10-16T09:20:00", timezone_id: S, fold: "none", fire_at_utc: "2026-10-16T01:20:00Z" } },
  { expr_id: "e48", text: "纽约时间 9:20", anchor_received_at_utc: A, confirmed_tz: S, expect: "normalize_ok", expect_detail: { wall_time: "2026-10-16T09:20:00", timezone_id: N, fold: "none", fire_at_utc: "2026-10-16T13:20:00Z" } },
  { expr_id: "e49", text: "火星时间 9:20", anchor_received_at_utc: A, confirmed_tz: "", expect: "clarify", expect_detail: { reason: "UNKNOWN_TIMEZONE" } },
  { expr_id: "e50", text: "上海时间晚上9点", anchor_received_at_utc: A, confirmed_tz: S, expect: "normalize_ok", expect_detail: { wall_time: "2026-10-16T21:00:00", timezone_id: S, fold: "none", fire_at_utc: "2026-10-16T13:00:00Z" } },
];
