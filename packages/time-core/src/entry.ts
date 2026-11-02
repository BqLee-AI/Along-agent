// Deterministic entry classifier (NOT LLM): text -> wall_time | clarify | reject.
// Shared pure parser; the API supplies its actual validated alias table.
import {
  civilFromEpoch,
  daysSinceEpoch,
  parseUtcEpoch,
  parseWall,
  wallPartsToString,
} from './civil.js';
import type { AliasTable, FoldChoice, TimeRuleset } from './types.js';
import { freezeValue, sameValue } from './immutable.js';
import { isSupportedRuleset, utcInCoverage } from './profile.js';

export type EntryClass = 'normalize_ok' | 'clarify' | 'reject' | 'error';

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
  aliases: AliasTable;
  requireCompleteReminder?: boolean;
  reminderContent?: string;
}

export const ALIAS_TABLE_V1: AliasTable = freezeValue({
  version: 'ALIAS_TABLE_V1',
  aliases: {
    北京时间: 'Asia/Shanghai',
    上海时间: 'Asia/Shanghai',
    纽约时间: 'America/New_York',
    美东时间: 'America/New_York',
    基里巴斯时间: 'Pacific/Kiritimati',
  },
});

const DAYPARTS = ['上午', '下午', '中午', '晚上', '凌晨', '早晨', '早上', '午夜', '半夜'];
// Capture a whole clock numeral, including unsupported magnitudes, so an
// invalid token cannot be accepted by parsing just its last one or two digits.
const CLOCK_NUMERAL = String.raw`[\d零〇一二两三四五六七八九十百千万亿]+`;
const DIAN_CLOCK = new RegExp(`(${CLOCK_NUMERAL})点(半|(${CLOCK_NUMERAL})分?)?`);
const CN_DATE_CLOCK = new RegExp(
  String.raw`(\d{4})年(\d{1,2})月(\d{1,2})[日号]\s*(?:上午|下午|中午|晚上|凌晨|早晨|早上|午夜|半夜)?\s*(${CLOCK_NUMERAL})(?:点(半|(${CLOCK_NUMERAL})分?)?|:(\d{1,2}))?`,
);
const CHINESE_DIGITS = '零一二三四五六七八九';

// Only clock captures enter this function; dates and reminder content remain
// untouched. A negative value denotes an unsupported numeral, not a fallback.
function parseClockNumber(raw: string): number {
  if (/^\d{1,2}$/.test(raw)) return Number(raw);
  if (raw === '两') return 2;
  if (raw === '〇') return 0;
  if (raw === '十') return 10;
  if (raw.length === 1) return CHINESE_DIGITS.indexOf(raw);
  if (/^[零〇][一二三四五六七八九]$/.test(raw)) return CHINESE_DIGITS.indexOf(raw[1]);
  const tens = /^([一二三四五六七八九])?十([一二三四五六七八九])?$/.exec(raw);
  if (!tens) return -1;
  return (
    (tens[1] ? CHINESE_DIGITS.indexOf(tens[1]) : 1) * 10 +
    (tens[2] ? CHINESE_DIGITS.indexOf(tens[2]) : 0)
  );
}

function offsetAtUtc(ruleset: TimeRuleset, tz: string, epoch: number): number | null {
  const zone = ruleset.zones[tz];
  if (!zone) return null;
  let offset = zone.base_offset_seconds;
  for (const t of zone.transitions) {
    const at = parseUtcEpoch(t.at_utc);
    if (at !== null && epoch >= at) offset = t.offset_seconds;
  }
  return offset;
}

function localDate(ruleset: TimeRuleset, tz: string, utc: string): { date: string } | null {
  const epoch = parseUtcEpoch(utc);
  if (epoch === null) return null;
  const offset = offsetAtUtc(ruleset, tz, epoch);
  if (offset === null) return null;
  const local = civilFromEpoch(epoch + offset);
  const mm = local.mo < 10 ? `0${local.mo}` : `${local.mo}`;
  const dd = local.d < 10 ? `0${local.d}` : `${local.d}`;
  return { date: `${local.y}-${mm}-${dd}` };
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
  if (
    text.includes('凌晨') ||
    text.includes('早上') ||
    text.includes('早晨') ||
    text.includes('上午')
  )
    return raw;
  if (text.includes('中午')) return raw === 12 ? 12 : raw + 12;
  if (text.includes('下午') || text.includes('晚上')) return raw < 12 ? raw + 12 : raw;
  if (text.includes('午夜') || text.includes('半夜')) return raw % 12;
  if (colonForm) return raw;
  return -1;
}

const REMINDER_DIRECTIVE = /提醒(?:我)?|叫我|通知我|记得|别忘了/;
const RELATIVE_DATE = /明天|后天|今天|昨天/;

export function findReminderDirective(text: string): number {
  return text.search(REMINDER_DIRECTIVE);
}

function withCompleteReminder(
  input: EntryInput,
  result: EntryClassifyResult,
  timeText: string,
  hasDate: boolean,
): EntryClassifyResult {
  if (!input.requireCompleteReminder) return result;
  if (!hasDate) return { class: 'clarify', reason: 'DATE_MISSING', phrase_key: 'ASK_DATE' };
  if (input.reminderContent !== undefined) {
    return /\S/u.test(input.reminderContent)
      ? result
      : { class: 'clarify', reason: 'CONTENT_MISSING', phrase_key: 'ASK_REMINDER_CONTENT' };
  }
  let content = input.text.replace(timeText, '').replace(RELATIVE_DATE, '');
  for (const alias in input.aliases.aliases) content = content.replaceAll(alias, '');
  for (const zone in input.ruleset.zones) content = content.replaceAll(zone, '');
  for (const daypart of DAYPARTS) content = content.replaceAll(daypart, '');
  content = content.replace(REMINDER_DIRECTIVE, '').replace(/第一次|第二次|时区|timezone/gi, '');
  if (!/[\p{L}\p{N}]/u.test(content))
    return { class: 'clarify', reason: 'CONTENT_MISSING', phrase_key: 'ASK_REMINDER_CONTENT' };
  return result;
}

function classifyEntryInner(input: EntryInput): EntryClassifyResult {
  const text = input.text;
  const fold: FoldChoice = input.fold ?? 'none';

  if (!isSupportedRuleset(input.ruleset)) return { class: 'error', reason: 'TZDB_UNAVAILABLE' };
  const aliases = input.aliases;
  if (!sameValue(aliases, ALIAS_TABLE_V1)) return { class: 'error', reason: 'TZDB_UNAVAILABLE' };
  const explicitZones = new Set<string>();
  // Remove recognized aliases before inspecting remaining explicit indicators.
  let rest = text;
  for (const [alias, zone] of Object.entries(aliases.aliases)) {
    if (text.includes(alias)) {
      explicitZones.add(zone);
      rest = rest.split(alias).join(' ');
    }
  }
  for (const match of rest.matchAll(/[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+/g)) {
    if (!Object.hasOwn(input.ruleset.zones, match[0]))
      return { class: 'error', reason: 'UNKNOWN_TIMEZONE' };
    explicitZones.add(match[0]);
  }
  const reminderAt = findReminderDirective(rest);
  const unknownAliasAt = rest.search(/[\u4e00-\u9fa5]{1,12}时间/);
  // Reminder content is not timezone metadata; parentheses and explicit
  // timezone labels remain annotations even after the reminder directive.
  if (
    (unknownAliasAt >= 0 && (reminderAt < 0 || unknownAliasAt < reminderAt)) ||
    /(?:[（(]\s*|时区\s*[:：]?\s*)[\u4e00-\u9fa5]{1,12}时间(?=\s*(?:[）)]|$))/.test(rest)
  )
    return { class: 'error', reason: 'UNKNOWN_TIMEZONE' };
  if (explicitZones.size > 1)
    return { class: 'clarify', reason: 'TIMEZONE_CONFLICT', phrase_key: 'ASK_TIMEZONE' };
  const tz = explicitZones.values().next().value ?? input.confirmedTz;
  if (tz && !Object.hasOwn(input.ruleset.zones, tz))
    return { class: 'error', reason: 'UNKNOWN_TIMEZONE' };
  if (
    (fold === 'first' && /第二次/.test(text)) ||
    (fold === 'second' && /第一次/.test(text)) ||
    (/第一次/.test(text) && /第二次/.test(text))
  ) {
    return { class: 'clarify', reason: 'FOLD_CONFLICT', phrase_key: 'ASK_FOLD' };
  }

  if (/左右|大概|上下|附近|尽快|早点|晚点|改天|有空|空闲|得空/.test(text)) {
    if (/有空|空闲|得空/.test(text)) {
      return { class: 'reject', reason: 'FUZZY_IDLE', phrase_key: 'NO_CALENDAR' };
    }
    if (/尽快|早点|晚点|改天/.test(text)) {
      return { class: 'reject', reason: 'FUZZY_UNSCHEDULABLE', phrase_key: 'ASK_EXACT_TIME' };
    }
    return { class: 'reject', reason: 'FUZZY_RANGE', phrase_key: 'RANGE_UNSUPPORTED' };
  }

  if (!tz) return { class: 'clarify', reason: 'TIMEZONE_MISSING', phrase_key: 'ASK_TIMEZONE' };

  if (text.includes('月') && !text.includes('年') && !/\d{4}-\d{2}-\d{2}/.test(text)) {
    const md24 = /(\d{1,2})月(\d{1,2})[日号]\s*24(?::00)?/.exec(text);
    if (!md24) return { class: 'clarify', reason: 'YEAR_MISSING', phrase_key: 'ASK_YEAR' };
    if (!utcInCoverage(input.ruleset, tz, input.anchorReceivedAtUtc)) {
      return { class: 'error', reason: 'TZDB_UNAVAILABLE' };
    }
    const anchor24 = localDate(input.ruleset, tz, input.anchorReceivedAtUtc);
    if (!anchor24)
      return { class: 'clarify', reason: 'UNKNOWN_TIMEZONE', phrase_key: 'ASK_TIMEZONE_ALIAS' };
    const year24 = Number(anchor24.date.slice(0, 4));
    const next24 = shiftDate(
      `${year24}-${md24[1].padStart(2, '0')}-${md24[2].padStart(2, '0')}`,
      1,
    );
    if (next24 < anchor24.date)
      return { class: 'clarify', reason: 'YEAR_MISSING', phrase_key: 'ASK_YEAR' };
    return withCompleteReminder(
      input,
      { class: 'normalize_ok', wall_time: `${next24}T00:00:00`, timezone_id: tz, fold },
      md24[0],
      false,
    );
  }

  const hm = /(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(text);
  const dian = DIAN_CLOCK.exec(text);
  if (!hm && !dian)
    return { class: 'clarify', reason: 'DAYPART_MISSING', phrase_key: 'ASK_DAYPART' };
  if (dian && !hm && !DAYPARTS.some((w) => text.includes(w))) {
    return { class: 'clarify', reason: 'DAYPART_MISSING', phrase_key: 'ASK_DAYPART' };
  }

  let baseDate = '';
  const absoluteDate = /\d{4}-\d{2}-\d{2}|\d{4}年/.test(text);
  if (!absoluteDate) {
    if (
      !utcInCoverage(input.ruleset, tz, input.anchorReceivedAtUtc) ||
      (input.receivedAtUtc && !utcInCoverage(input.ruleset, tz, input.receivedAtUtc))
    ) {
      return { class: 'error', reason: 'TZDB_UNAVAILABLE' };
    }
    const anchor = localDate(input.ruleset, tz, input.anchorReceivedAtUtc);
    if (!anchor) return { class: 'error', reason: 'TZDB_UNAVAILABLE' };
    baseDate = anchor.date;
    if (/明天/.test(text)) baseDate = shiftDate(anchor.date, 1);
    else if (/后天/.test(text)) baseDate = shiftDate(anchor.date, 2);
    else if (/昨天/.test(text)) baseDate = shiftDate(anchor.date, -1);
    if (RELATIVE_DATE.test(text) && input.receivedAtUtc) {
      const received = localDate(input.ruleset, tz, input.receivedAtUtc);
      if (!received || received.date !== anchor.date) {
        return { class: 'clarify', reason: 'DATE_CHANGED', phrase_key: 'ASK_DATE_RECONFIRM' };
      }
    }
  }

  const iso = /(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(text);
  if (iso) {
    const hh = Number(iso[4]);
    const mi = Number(iso[5]);
    const ss = iso[6] ? Number(iso[6]) : 0;
    if (hh > 24 || (hh === 24 && (mi !== 0 || ss !== 0)) || mi > 59 || ss > 59)
      return { class: 'clarify', reason: 'DAYPART_MISSING', phrase_key: 'ASK_DAYPART' };
    const h = hh < 10 ? `0${hh}` : `${hh}`;
    const m = mi < 10 ? `0${mi}` : `${mi}`;
    const s = ss < 10 ? `0${ss}` : `${ss}`;
    return withCompleteReminder(
      input,
      {
        class: 'normalize_ok',
        wall_time:
          hh === 24 && parseWall(`${iso[1]}-${iso[2]}-${iso[3]}T00:00:00`) !== null
            ? `${shiftDate(`${iso[1]}-${iso[2]}-${iso[3]}`, 1)}T00:00:00`
            : `${iso[1]}-${iso[2]}-${iso[3]}T${h}:${m}:${s}`,
        timezone_id: tz,
        fold,
      },
      iso[0],
      true,
    );
  }

  const cn = CN_DATE_CLOCK.exec(text);
  if (cn) {
    let y = Number(cn[1]);
    let mo = Number(cn[2]);
    let d = Number(cn[3]);
    let h = parseClockNumber(cn[4]);
    const mi = cn[7] ? Number(cn[7]) : cn[6] ? parseClockNumber(cn[6]) : cn[5] === '半' ? 30 : 0;
    if (h < 0 || h > 24 || mi < 0 || mi > 59 || (h === 24 && mi !== 0))
      return { class: 'clarify', reason: 'DAYPART_MISSING', phrase_key: 'ASK_DAYPART' };
    if (h === 24) {
      const shifted = shiftDate(
        `${y}-${mo < 10 ? `0${mo}` : `${mo}`}-${d < 10 ? `0${d}` : `${d}`}`,
        1,
      );
      const parts = shifted.split('-').map(Number);
      y = parts[0];
      mo = parts[1];
      d = parts[2];
      h = 0;
    }
    const mapped = mapHour(h, text, cn[7] !== undefined || (cn[5] !== undefined && cn[5] !== '半'));
    if (mapped < 0 || mapped > 23 || mi > 59) {
      return { class: 'clarify', reason: 'DAYPART_MISSING', phrase_key: 'ASK_DAYPART' };
    }
    return withCompleteReminder(
      input,
      {
        class: 'normalize_ok',
        wall_time: wallPartsToString({ y, mo, d, h: mapped, mi, s: 0 }),
        timezone_id: tz,
        fold,
      },
      cn[0],
      true,
    );
  }

  let h = -1;
  let mi = 0;
  let ss = 0;
  if (hm) {
    h = mapHour(Number(hm[1]), text, true);
    mi = Number(hm[2]);
    ss = hm[3] ? Number(hm[3]) : 0;
  } else if (dian) {
    const rawHour = parseClockNumber(dian[1]);
    if (rawHour < 0 || rawHour > 23)
      return { class: 'clarify', reason: 'DAYPART_MISSING', phrase_key: 'ASK_DAYPART' };
    h = mapHour(rawHour, text, false);
    if (dian[2] === '半') mi = 30;
    else if (dian[3]) mi = parseClockNumber(dian[3]);
  }
  if (h < 0 || h > 23 || mi < 0 || mi > 59 || ss > 59) {
    return { class: 'clarify', reason: 'DAYPART_MISSING', phrase_key: 'ASK_DAYPART' };
  }
  return withCompleteReminder(
    input,
    {
      class: 'normalize_ok',
      wall_time: `${baseDate}T${h < 10 ? `0${h}` : `${h}`}:${mi < 10 ? `0${mi}` : `${mi}`}:${ss < 10 ? `0${ss}` : `${ss}`}`,
      timezone_id: tz,
      fold,
    },
    (hm ?? dian)![0],
    RELATIVE_DATE.test(text),
  );
}

export function classifyEntry(input: EntryInput): EntryClassifyResult {
  return { ...classifyEntryInner(input), alias_table_version: input.aliases?.version };
}
