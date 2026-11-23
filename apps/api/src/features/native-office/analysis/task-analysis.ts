import { Buffer } from 'node:buffer';
import { utcToLocal, type TimeRuleset } from '@along/time-core';
import type { TaskCsvRecord } from './task-csv.js';

export interface TaskAsOfInput {
  /** Integration supplies this only after verification against the user's request. */
  readonly explicitDate?: string;
  readonly requestAnchorUtc: string;
  readonly timezoneId?: string;
  readonly ruleset?: TimeRuleset;
}

export type TaskAsOfResult =
  | { kind: 'ok'; asOf: string }
  | { kind: 'clarify'; reason: 'missing_timezone' }
  | { kind: 'error'; reason: 'invalid_as_of' | 'invalid_time_context' };

function isGregorianDate(value: string): boolean {
  if (value.length !== 10 || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (year === 0 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const lastDay =
    month === 2
      ? leap
        ? 29
        : 28
      : month === 4 || month === 6 || month === 9 || month === 11
        ? 30
        : 31;
  return day <= lastDay;
}

/** No implicit clock, timezone, or model-provided fallback. */
export function resolveTaskAsOf(input: TaskAsOfInput): TaskAsOfResult {
  if (input.explicitDate !== undefined) {
    return isGregorianDate(input.explicitDate)
      ? { kind: 'ok', asOf: input.explicitDate }
      : { kind: 'error', reason: 'invalid_as_of' };
  }
  if (!input.timezoneId) return { kind: 'clarify', reason: 'missing_timezone' };
  if (!input.ruleset) return { kind: 'error', reason: 'invalid_time_context' };
  const result = utcToLocal(input.requestAnchorUtc, input.timezoneId, input.ruleset);
  if (result.kind !== 'ok') return { kind: 'error', reason: 'invalid_time_context' };
  return { kind: 'ok', asOf: result.wall_time.slice(0, 10) };
}

export interface OfficeSource {
  readonly displayName: string;
  readonly version: string;
}

export type TaskCsvAnomaly = 'missingOwner' | 'missingDueDate' | 'invalidDueDate' | 'invalidStatus';

export interface TaskCsvCounts {
  readonly total: number;
  readonly todo: number;
  readonly inProgress: number;
  readonly done: number;
  readonly canceled: number;
  readonly overdue: number;
  readonly anomalyRows: number;
  readonly missingOwner: number;
  readonly missingDueDate: number;
  readonly invalidDueDate: number;
  readonly invalidStatus: number;
}

type MutableCounts = { -readonly [K in keyof TaskCsvCounts]: TaskCsvCounts[K] };

export interface TaskCsvOwnerGroup {
  /** Null is the unassigned bucket, not a display name. */
  readonly owner: string | null;
  readonly totals: TaskCsvCounts;
}

export interface TaskCsvAnalyzedRecord extends TaskCsvRecord {
  readonly overdue: boolean;
  readonly anomalies: readonly TaskCsvAnomaly[];
}

export interface TaskCsvAnalysis {
  readonly source: OfficeSource;
  readonly asOf: string;
  readonly totals: TaskCsvCounts;
  readonly groups: readonly TaskCsvOwnerGroup[];
  /** Entire accepted data coverage in source order. Use pageTaskCsvAnalysis for observations. */
  readonly records: readonly TaskCsvAnalyzedRecord[];
}

const EMPTY_COUNTS = {
  total: 0,
  todo: 0,
  inProgress: 0,
  done: 0,
  canceled: 0,
  overdue: 0,
  anomalyRows: 0,
  missingOwner: 0,
  missingDueDate: 0,
  invalidDueDate: 0,
  invalidStatus: 0,
} satisfies MutableCounts;

function tally(
  counts: MutableCounts,
  status: 'todo' | 'inProgress' | 'done' | 'canceled' | undefined,
  overdue: boolean,
  anomalies: readonly TaskCsvAnomaly[],
): void {
  counts.total++;
  if (status) counts[status]++;
  if (overdue) counts.overdue++;
  if (anomalies.length) counts.anomalyRows++;
  for (const anomaly of anomalies) counts[anomaly]++;
}

/** Analyze records from a successful parse; neither the order nor the values of source rows change. */
export function analyzeTaskCsv(
  records: readonly TaskCsvRecord[],
  asOf: string,
  source: OfficeSource,
): TaskCsvAnalysis {
  if (!isGregorianDate(asOf)) throw new RangeError('Invalid task CSV as-of date');
  const totals = { ...EMPTY_COUNTS };
  const byOwner = new Map<string | null, MutableCounts>();
  const analyzed = records.map((record): TaskCsvAnalyzedRecord => {
    const owner = record.owner.trim() || null;
    const anomalies: TaskCsvAnomaly[] = [];
    if (owner === null) anomalies.push('missingOwner');
    const validDate = isGregorianDate(record.dueDate);
    if (!record.dueDate) anomalies.push('missingDueDate');
    else if (!validDate) anomalies.push('invalidDueDate');
    let status: 'todo' | 'inProgress' | 'done' | 'canceled' | undefined;
    switch (record.status) {
      case 'todo':
      case 'done':
      case 'canceled':
        status = record.status;
        break;
      case 'in_progress':
        status = 'inProgress';
        break;
      default:
        anomalies.push('invalidStatus');
    }
    const overdue =
      validDate && record.dueDate < asOf && (status === 'todo' || status === 'inProgress');
    let group = byOwner.get(owner);
    if (!group) {
      group = { ...EMPTY_COUNTS };
      byOwner.set(owner, group);
    }
    tally(totals, status, overdue, anomalies);
    tally(group, status, overdue, anomalies);
    return { ...record, overdue, anomalies };
  });
  const groups = Array.from(byOwner, ([owner, totals]) => ({ owner, totals }));
  // Code-unit order is independent of locale; the unassigned bucket is always last.
  groups.sort((a, b) =>
    a.owner === b.owner
      ? 0
      : b.owner === null
        ? -1
        : a.owner === null
          ? 1
          : a.owner < b.owner
            ? -1
            : 1,
  );
  return { source: { ...source }, asOf, totals, groups, records: analyzed };
}

const SAMPLE_FIELDS = ['taskId', 'title', 'owner', 'dueDate', 'status'] as const;
export const TASK_CSV_PAGE_LIMITS = Object.freeze({
  defaultRows: 10,
  maxRows: 25,
  fieldBytes: 192,
});

export interface TaskCsvRecordSample extends TaskCsvAnalyzedRecord {
  readonly truncatedFields: readonly (typeof SAMPLE_FIELDS)[number][];
}

export interface TaskCsvOwnerGroupSample extends TaskCsvOwnerGroup {
  readonly ownerTruncated: boolean;
}

export interface TaskCsvAnalysisPage {
  readonly source: OfficeSource;
  readonly asOf: string;
  readonly totalRecords: number;
  readonly totals: TaskCsvCounts;
  readonly totalGroups: number;
  readonly groups: readonly TaskCsvOwnerGroupSample[];
  readonly records: readonly TaskCsvRecordSample[];
  readonly nextAfterRecord: number | null;
}

function sampleText(value: string): string {
  if (
    value.length * 3 <= TASK_CSV_PAGE_LIMITS.fieldBytes ||
    Buffer.byteLength(value) <= TASK_CSV_PAGE_LIMITS.fieldBytes
  )
    return value;
  let bytes = 0;
  let end = 0;
  for (const scalar of value) {
    bytes += Buffer.byteLength(scalar);
    if (bytes > TASK_CSV_PAGE_LIMITS.fieldBytes) break;
    end += scalar.length;
  }
  return value.slice(0, end);
}

function sampleRecord(record: TaskCsvAnalyzedRecord): TaskCsvRecordSample {
  const truncatedFields: (typeof SAMPLE_FIELDS)[number][] = [];
  const sample = { ...record, truncatedFields };
  for (const field of SAMPLE_FIELDS) {
    const value = sampleText(record[field]);
    if (value === record[field]) continue;
    sample[field] = value;
    truncatedFields.push(field);
  }
  return sample;
}

/**
 * The caller authorizes the original accepted analysis, not a new version or as-of date.
 * One window slices two independent orders: owner groups and source records.
 */
export function pageTaskCsvAnalysis(
  analysis: TaskCsvAnalysis,
  afterRecord = 0,
  limit: number = TASK_CSV_PAGE_LIMITS.defaultRows,
): TaskCsvAnalysisPage {
  const totalRecords = analysis.records.length;
  if (
    !Number.isSafeInteger(afterRecord) ||
    afterRecord < 0 ||
    afterRecord > totalRecords ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > TASK_CSV_PAGE_LIMITS.maxRows
  ) {
    throw new RangeError('Invalid task CSV page bounds');
  }
  const end = Math.min(afterRecord + limit, totalRecords);
  return {
    source: analysis.source,
    asOf: analysis.asOf,
    totalRecords,
    totals: analysis.totals,
    totalGroups: analysis.groups.length,
    groups: analysis.groups.slice(afterRecord, end).map(({ owner, totals }) => {
      const label = owner === null ? null : sampleText(owner);
      return { owner: label, totals, ownerTruncated: label !== owner };
    }),
    records: analysis.records.slice(afterRecord, end).map(sampleRecord),
    nextAfterRecord: end < totalRecords ? end : null,
  };
}
