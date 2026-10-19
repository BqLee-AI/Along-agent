// Deterministic entry classifier (NOT LLM): text -> wall_time | clarify | reject.
// Provisional placement in time-core; owner to confirm (see PR). Zero imports.
import { civilFromEpoch, daysSinceEpoch, parseUtcEpoch, wallPartsToString } from "./civil.js";
import type { FoldChoice, TimeRuleset } from "./types.js";

export type EntryClass = "normalize_ok" | "clarify" | "reject";

export interface EntryClassifyResult {
  class: EntryClass;
  wall_time?: string;
  timezone_id?: string;
  fold?: FoldChoice;
  reason?: string;
  phrase_key?: string;
  alias_table_version?: string;
}

export interface EntryInput {
  text: string;
  anchorReceivedAtUtc: string;
  confirmedTz: string;
  receivedAtUtc?: string;
  fold?: FoldChoice;
  ruleset: TimeRuleset;
}

export const ALIAS_TABLE_V1: { version: string; aliases: Record<string, string> } = {
  version: "ALIAS_TABLE_V1",
  aliases: {
    "北京时间": "Asia/Shanghai",
    "上海时间": "Asia/Shanghai",
    "纽约时间": "America/New_York",
    "美东时间": "America/New_York",
    "基里巴斯时间": "Pacific/Kiritimati",
  },
};

const DAYPARTS = ["上午", "下午", "中午", "晚上", "凌晨", "早晨", "早上", "午夜", "半夜"];

function offsetAtUtc(ruleset: TimeRuleset, tz: string, epoch: number): number | null {
  const zone = ruleset.zones[tz];
  if (!zone) return null;
  let offset = zone.base_offset_seconds;
  const sorted = [...zone.transitions].sort((a, b) => (a.at_utc < b.at_utc ? -1 : 1));
  for (const t of sorted) {
    const at = parseUtcEpoch(t.at_utc);
    if (at !== null && epoch >= at) offset = t.offset_seconds;
  }
  return offset;
}

function localDate(ruleset: TimeRuleset, tz: string, utc: string): { date: string; epoch: number } | null {
  const epoch = parseUtcEpoch(utc);
  if (epoch === null) return null;
  const offset = offsetAtUtc(ruleset, tz, epoch);
  if (offset === null) return null;
  const local = civilFromEpoch(epoch + offset);
  const mm = local.mo < 10 ? `0${local.mo}` : `${local.mo}`;
  const dd = local.d < 10 ? `0${local.d}` : `${local.d}`;
  return { date: `${local.y}-${mm}-${dd}`, epoch };
}

function shiftDate(date: string, days: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return date;
  const base = daysSinceEpoch(Number(m[1]), Number(m[2]), Number(m[3]));
  const c = civilFromEpoch((base + days) * 86400);
  const mm = c.mo < 10 ? `0${c.mo}` : `${c.mo}`;
  const dd = c.d < 10 ? `0${c.d}` : `${c.d}`;
  return `${c.y}-${mm}-${dd}`;
}

function mapHour(raw: number, text: string, colonForm: boolean): number {
  if (text.includes("凌晨") || text.includes("早上") || text.includes("早晨") || text.includes("上午")) return raw;
  if (text.includes("中午")) return raw === 12 ? 12 : raw + 12;
  if (text.includes("下午") || text.includes("晚上")) return raw < 12 ? raw + 12 : raw;
  if (text.includes("午夜") || text.includes("半夜")) return raw % 12;
  if (colonForm) return raw;
  return -1;
}

function classifyEntryInner(input: EntryInput): EntryClassifyResult {
  const text = input.text;
  const fold: FoldChoice = input.fold ?? "none";

  if (/左右|大概|上下|附近|尽快|早点|晚点|改天|有空|空闲|得空/.test(text)) {
    if (/有空|空闲|得空/.test(text)) {
      return { class: "reject", reason: "FUZZY_IDLE", phrase_key: "NO_CALENDAR" };
    }
    if (/尽快|早点|晚点|改天/.test(text)) {
      return { class: "reject", reason: "FUZZY_UNSCHEDULABLE", phrase_key: "ASK_EXACT_TIME" };
    }
    return { class: "reject", reason: "FUZZY_RANGE", phrase_key: "RANGE_UNSUPPORTED" };
  }

  let tz = input.confirmedTz;
  for (const [alias, zone] of Object.entries(ALIAS_TABLE_V1.aliases)) {
    if (text.includes(alias)) {
      tz = zone;
      break;
    }
  }
  if (!tz) {
    const stray = /([\u4e00-\u9fa5]{1,6})时间/.exec(text);
    if (stray) return { class: "clarify", reason: "UNKNOWN_TIMEZONE", phrase_key: "ASK_TIMEZONE_ALIAS" };
    return { class: "clarify", reason: "TIMEZONE_MISSING", phrase_key: "ASK_TIMEZONE" };
  }
  if (!input.ruleset.zones[tz]) {
    return { class: "clarify", reason: "UNKNOWN_TIMEZONE", phrase_key: "ASK_TIMEZONE_ALIAS" };
  }

  if (text.includes("月") && !text.includes("年") && !/\d{4}-\d{2}-\d{2}/.test(text)) {
    const md24 = /(\d{1,2})月(\d{1,2})[日号]\s*24(?::00)?/.exec(text);
    if (!md24) return { class: "clarify", reason: "YEAR_MISSING", phrase_key: "ASK_YEAR" };
    const anchor24 = localDate(input.ruleset, tz, input.anchorReceivedAtUtc);
    if (!anchor24) return { class: "clarify", reason: "UNKNOWN_TIMEZONE", phrase_key: "ASK_TIMEZONE_ALIAS" };
    const year24 = Number(anchor24.date.slice(0, 4));
    const next24 = shiftDate(`${year24}-${md24[1].padStart(2, "0")}-${md24[2].padStart(2, "0")}`, 1);
    if (next24 < anchor24.date) return { class: "clarify", reason: "YEAR_MISSING", phrase_key: "ASK_YEAR" };
    return { class: "normalize_ok", wall_time: `${next24}T00:00:00`, timezone_id: tz, fold };
  }

  const hasClock = /(\d{1,2}):(\d{2})/.test(text) || /(\d{1,2})点/.test(text);
  if (!hasClock) return { class: "clarify", reason: "DAYPART_MISSING", phrase_key: "ASK_DAYPART" };
  if (/(\d{1,2})点/.test(text) && !/(\d{1,2}):(\d{2})/.test(text) && !DAYPARTS.some((w) => text.includes(w))) {
    if (!/(\d{4})-(\d{2})-(\d{2})/.test(text) && !/\d{4}年/.test(text)) {
      return { class: "clarify", reason: "DAYPART_MISSING", phrase_key: "ASK_DAYPART" };
    }
    return { class: "clarify", reason: "DAYPART_MISSING", phrase_key: "ASK_DAYPART" };
  }

  const anchor = localDate(input.ruleset, tz, input.anchorReceivedAtUtc);
  if (!anchor) return { class: "clarify", reason: "UNKNOWN_TIMEZONE", phrase_key: "ASK_TIMEZONE_ALIAS" };
  let baseDate = anchor.date;
  if (/明天/.test(text)) baseDate = shiftDate(anchor.date, 1);
  else if (/后天/.test(text)) baseDate = shiftDate(anchor.date, 2);
  else if (/昨天/.test(text)) baseDate = shiftDate(anchor.date, -1);

  if (/明天|后天|今天|昨天/.test(text) && input.receivedAtUtc) {
    const received = localDate(input.ruleset, tz, input.receivedAtUtc);
    if (received && received.date !== anchor.date) {
      return { class: "clarify", reason: "DATE_CHANGED", phrase_key: "ASK_DATE_RECONFIRM" };
    }
  }

  const iso = /(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(text);
  if (iso) {
    const hh = Number(iso[4]);
    const mi = Number(iso[5]);
    const ss = iso[6] ? Number(iso[6]) : 0;
    if (hh > 23 || mi > 59 || ss > 59) return { class: "clarify", reason: "DAYPART_MISSING", phrase_key: "ASK_DAYPART" };
    const h = hh < 10 ? `0${hh}` : `${hh}`;
    const m = mi < 10 ? `0${mi}` : `${mi}`;
    const s = ss < 10 ? `0${ss}` : `${ss}`;
    return { class: "normalize_ok", wall_time: `${iso[1]}-${iso[2]}-${iso[3]}T${h}:${m}:${s}`, timezone_id: tz, fold };
  }

  const cn = /(\d{4})年(\d{1,2})月(\d{1,2})[日号]\s*(?:上午|下午|中午|晚上|凌晨|早晨|早上|午夜|半夜)?\s*(\d{1,2})(?:点(半|(\d{1,2})分?)?|:(\d{1,2}))?/.exec(text);
  if (cn) {
    let y = Number(cn[1]);
    let mo = Number(cn[2]);
    let d = Number(cn[3]);
    let h = Number(cn[4]);
    const mi = cn[7] ? Number(cn[7]) : cn[6] ? Number(cn[6]) : cn[5] === "半" ? 30 : cn[5] ? Number(cn[5]) : 0;
    if (h === 24) {
      const shifted = shiftDate(`${y}-${mo < 10 ? `0${mo}` : `${mo}`}-${d < 10 ? `0${d}` : `${d}`}`, 1);
      const parts = shifted.split("-").map(Number);
      y = parts[0];
      mo = parts[1];
      d = parts[2];
      h = 0;
    }
    const mapped = mapHour(h, text, cn[7] !== undefined || (cn[5] !== undefined && cn[5] !== "半"));
    if (mapped < 0 || mapped > 23 || mi > 59) {
      return { class: "clarify", reason: "DAYPART_MISSING", phrase_key: "ASK_DAYPART" };
    }
    return {
      class: "normalize_ok",
      wall_time: wallPartsToString({ y, mo, d, h: mapped, mi, s: 0 }),
      timezone_id: tz,
      fold,
    };
  }

  const hm = /(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(text);
  const dian = /(\d{1,2})点(半|(\d{1,2})分?)?/.exec(text);
  let h = -1;
  let mi = 0;
  let ss = 0;
  if (hm) {
    h = mapHour(Number(hm[1]), text, true);
    mi = Number(hm[2]);
    ss = hm[3] ? Number(hm[3]) : 0;
  } else if (dian) {
    h = mapHour(Number(dian[1]), text, false);
    if (dian[2] === "半") mi = 30;
    else if (dian[3]) mi = Number(dian[3]);
  }
  if (h < 0 || h > 23 || mi > 59 || ss > 59) {
    return { class: "clarify", reason: "DAYPART_MISSING", phrase_key: "ASK_DAYPART" };
  }
  return { class: "normalize_ok", wall_time: `${baseDate}T${h < 10 ? `0${h}` : `${h}`}:${mi < 10 ? `0${mi}` : `${mi}`}:${ss < 10 ? `0${ss}` : `${ss}`}`, timezone_id: tz, fold };
}

export function classifyEntry(input: EntryInput): EntryClassifyResult {
  return { ...classifyEntryInner(input), alias_table_version: ALIAS_TABLE_V1.version };
}
