import { describe, expect, it } from 'bun:test';
import { Buffer } from 'node:buffer';
import { FIXTURE_V1 } from '@along/time-core';
import { parse } from 'csv-parse/sync';
import {
  analyzeTaskCsv,
  OFFICE_REPORT_LIMITS,
  pageTaskCsvAnalysis,
  parseTaskCsv,
  renderOfficeReportMarkdown,
  renderOwnerSummaryCsv,
  resolveTaskAsOf,
  TASK_CSV_LIMITS,
  TASK_CSV_PAGE_LIMITS,
  TASK_CSV_TEMPLATE,
  type TaskCsvIssue,
} from '../src/features/native-office/analysis/index.js';

const source = { displayName: '任务.csv', version: 'csv-version' };
const notes = { displayName: '会议纪要.md', version: 'notes-version' };
const asOf = '2026-11-23';

const golden =
  '\uFEFFstatus,owner,title,task_id,due_date\r\n' +
  'todo, 甲 ,"first, ""quoted""\r\nsecond line 🍵",001,2026-11-22\r\n' +
  'in_progress,甲,Today,002,2026-11-23\r\n' +
  'done,乙,Completed,003,2026-11-22\r\n' +
  'unknown, ,Missing,004,\r\n' +
  'todo,乙,Invalid,005,2026-02-29\r\n';

function accepted(csv: string) {
  // Use a standalone Uint8Array rather than depending on caller-specific Buffer behavior.
  const parsed = parseTaskCsv(new TextEncoder().encode(csv));
  if (parsed.kind !== 'ok') throw new Error(JSON.stringify(parsed.issue));
  return analyzeTaskCsv(parsed.records, asOf, source);
}

function expectInvalid(input: string | Uint8Array, issue: TaskCsvIssue) {
  expect(parseTaskCsv(typeof input === 'string' ? Buffer.from(input) : input)).toEqual({
    kind: 'error',
    issue,
    template: TASK_CSV_TEMPLATE,
  });
}

const goldenTotals = {
  total: 5,
  todo: 2,
  inProgress: 1,
  done: 1,
  canceled: 0,
  overdue: 1,
  anomalyRows: 2,
  missingOwner: 1,
  missingDueDate: 1,
  invalidDueDate: 1,
  invalidStatus: 1,
};

describe('native office task CSV', () => {
  it('analyzes all five golden records with stable, logical record numbers and overlapping anomalies', () => {
    const analysis = accepted(golden);
    expect(analysis).toMatchObject({ source, asOf, totals: goldenTotals });
    expect(
      analysis.groups.map((group) => [group.owner, group.totals.total, group.totals.overdue]),
    ).toEqual([
      ['乙', 2, 0],
      ['甲', 2, 1],
      [null, 1, 0],
    ]);
    expect(analysis.records[0]).toMatchObject({
      title: 'first, "quoted"\r\nsecond line 🍵',
      owner: ' 甲 ',
    });
    expect(
      analysis.records.map(({ recordNumber, taskId, overdue, anomalies }) => [
        recordNumber,
        taskId,
        overdue,
        anomalies,
      ]),
    ).toEqual([
      [1, '001', true, []],
      [2, '002', false, []],
      [3, '003', false, []],
      [4, '004', false, ['missingOwner', 'missingDueDate', 'invalidStatus']],
      [5, '005', false, ['invalidDueDate']],
    ]);
    expect(accepted(golden)).toEqual(analysis);
    expect(accepted(TASK_CSV_TEMPLATE).totals).toMatchObject({ total: 0, overdue: 0 });
  });

  it('uses exact status, Gregorian dates and trimmed but otherwise exact owner names', () => {
    const analysis = accepted(
      TASK_CSV_TEMPLATE +
        '01,One, 未分配 ,2000-02-29,in_progress\n' +
        '1,Two,,1900-02-29,todo\n' +
        '2,Three,é,2026-11-22,canceled\n' +
        '3,Four,e\u0301, 2026-11-22 ,todo\n' +
        '4,Five,甲,2026-11-22,Todo\n' +
        '5,Six,甲,2026-11-24,todo\n',
    );
    expect(analysis.groups.map(({ owner }) => owner)).toEqual([
      'e\u0301',
      'é',
      '未分配',
      '甲',
      null,
    ]);
    expect(analysis.records.map(({ overdue, anomalies }) => [overdue, anomalies])).toEqual([
      [true, []],
      [false, ['missingOwner', 'invalidDueDate']],
      [false, []],
      [false, ['invalidDueDate']],
      [false, ['invalidStatus']],
      [false, []],
    ]);
    expect(() => analyzeTaskCsv(analysis.records, '2026-11-23\n', source)).toThrow(RangeError);
  });

  it('returns the precise template problem without exposing user fields or partial success', () => {
    for (const input of ['', '\uFEFF']) {
      expectInvalid(input, { code: 'missing_header', recordNumber: 0 });
    }
    expectInvalid('task_id,,owner,due_date,status', {
      code: 'empty_header',
      recordNumber: 0,
      columnNumber: 2,
    });
    expectInvalid('task_id,title,owner,owner,status', {
      code: 'duplicate_header',
      recordNumber: 0,
      columnNumber: 4,
    });
    expectInvalid('task_id,title,owner,probably_due,status', {
      code: 'missing_columns',
      recordNumber: 0,
      missingColumns: ['due_date'],
    });
    expectInvalid(TASK_CSV_TEMPLATE.trimEnd() + ',private_extra', {
      code: 'unexpected_column',
      recordNumber: 0,
      columnNumber: 6,
    });
    const first = '001,"Line 1\nLine 2",甲,2026-11-22,todo\r\n';
    expectInvalid(TASK_CSV_TEMPLATE + first + '001,Private,甲,2026-11-22,todo', {
      code: 'duplicate_task_id',
      recordNumber: 2,
      columnNumber: 1,
    });
    expectInvalid(TASK_CSV_TEMPLATE + ' ,Private,甲,2026-11-22,todo', {
      code: 'empty_task_id',
      recordNumber: 1,
      columnNumber: 1,
    });
    expectInvalid(TASK_CSV_TEMPLATE + first + '002,Private,甲,2026-11-22', {
      code: 'record_width',
      recordNumber: 2,
      columnNumber: 5,
    });
    expectInvalid(TASK_CSV_TEMPLATE + first + '\r\n003,Private,甲,2026-11-22,todo', {
      code: 'record_width',
      recordNumber: 2,
      columnNumber: 2,
    });
    expectInvalid(TASK_CSV_TEMPLATE + first + '002,"Private\nunfinished', {
      code: 'malformed_csv',
      recordNumber: 2,
      columnNumber: 2,
    });
    for (const title of ['in"fix', '"closed" trailing', '"closed"\u0000']) {
      expectInvalid(TASK_CSV_TEMPLATE + `001,${title},甲,2026-11-22,todo`, {
        code: 'malformed_csv',
        recordNumber: 1,
        columnNumber: 2,
      });
    }
    for (const bytes of [
      Buffer.concat([Buffer.from(TASK_CSV_TEMPLATE), Buffer.from([0xed, 0xa0, 0x80])]),
      Buffer.from([0xff, 0xfe, 0x74, 0]),
    ]) {
      expectInvalid(bytes, { code: 'invalid_utf8' });
    }
    expectInvalid('\uFEFF\uFEFF' + TASK_CSV_TEMPLATE, {
      code: 'missing_columns',
      recordNumber: 0,
      missingColumns: ['task_id'],
    });
  });

  it('checks byte, field, column and logical record limits with boundary values', () => {
    expectInvalid(Buffer.alloc(TASK_CSV_LIMITS.inputBytes + 1, 65), { code: 'input_byte_limit' });
    const title = '🍵'.repeat(TASK_CSV_LIMITS.fieldBytes / 4);
    expect(accepted(TASK_CSV_TEMPLATE + `1,${title},甲,,todo`).records[0].title).toBe(title);
    expectInvalid(TASK_CSV_TEMPLATE + `1,${title}a,甲,,todo`, {
      code: 'field_byte_limit',
      recordNumber: 1,
      columnNumber: 2,
    });
    expectInvalid(
      Array.from({ length: TASK_CSV_LIMITS.columns + 1 }, (_, i) => `c${i}`).join(','),
      {
        code: 'column_limit',
        recordNumber: 0,
        columnNumber: TASK_CSV_LIMITS.columns + 1,
      },
    );
    const atLimit =
      TASK_CSV_TEMPLATE +
      Array.from({ length: TASK_CSV_LIMITS.records }, (_, i) => `${i},task,甲,,todo\n`).join('');
    expect(accepted(atLimit).totals.total).toBe(TASK_CSV_LIMITS.records);
    expectInvalid(atLimit + 'overflow,task,甲,,todo', {
      code: 'record_limit',
      recordNumber: TASK_CSV_LIMITS.records + 1,
    });
  });

  it('paginates only the original version, as-of date and logical sequence; long samples are labeled', () => {
    const analysis = accepted(golden);
    const first = pageTaskCsvAnalysis(analysis, 0, 2);
    expect(first).toMatchObject({
      source,
      asOf,
      totals: goldenTotals,
      totalRecords: 5,
      totalGroups: 3,
      nextAfterRecord: 2,
    });
    const second = pageTaskCsvAnalysis(analysis, first.nextAfterRecord!, 2);
    const third = pageTaskCsvAnalysis(analysis, second.nextAfterRecord!, 2);
    expect(
      [...first.records, ...second.records, ...third.records].map(
        ({ recordNumber }) => recordNumber,
      ),
    ).toEqual([1, 2, 3, 4, 5]);
    expect([...first.groups, ...second.groups, ...third.groups].map(({ owner }) => owner)).toEqual([
      '乙',
      '甲',
      null,
    ]);
    expect(third.nextAfterRecord).toBeNull();
    expect(() => pageTaskCsvAnalysis(analysis, 6)).toThrow(RangeError);
    expect(() => pageTaskCsvAnalysis(analysis, 0, TASK_CSV_PAGE_LIMITS.maxRows + 1)).toThrow(
      RangeError,
    );
    const title = '🙂'.repeat(200);
    const long = accepted(TASK_CSV_TEMPLATE + `1,${title},甲,,todo`);
    expect(pageTaskCsvAnalysis(long).records[0]).toMatchObject({
      recordNumber: 1,
      title: '🙂'.repeat(TASK_CSV_PAGE_LIMITS.fieldBytes / 4),
      truncatedFields: ['title'],
    });
    expect(long.records[0].title).toBe(title);
  });
});

describe('trusted office as-of date', () => {
  it('prefers a preverified absolute date and strictly rejects impossible dates', () => {
    const anchor = { requestAnchorUtc: 'invalid-but-unused' };
    expect(resolveTaskAsOf({ ...anchor, explicitDate: '2000-02-29' })).toEqual({
      kind: 'ok',
      asOf: '2000-02-29',
    });
    for (const explicitDate of [
      '1900-02-29',
      '2026-04-31',
      '0000-01-01',
      '2026-4-01',
      '2026-04-01\n',
      '',
    ]) {
      expect(resolveTaskAsOf({ ...anchor, explicitDate })).toEqual({
        kind: 'error',
        reason: 'invalid_as_of',
      });
    }
  });

  it('uses only the frozen rules, timezone and anchor across local midnight, or asks only for timezone', () => {
    const input = { timezoneId: 'America/New_York', ruleset: FIXTURE_V1 };
    expect(resolveTaskAsOf({ ...input, requestAnchorUtc: '2026-11-23T04:59:59Z' })).toEqual({
      kind: 'ok',
      asOf: '2026-11-22',
    });
    expect(resolveTaskAsOf({ ...input, requestAnchorUtc: '2026-11-23T05:00:00Z' })).toEqual({
      kind: 'ok',
      asOf: '2026-11-23',
    });
    expect(resolveTaskAsOf({ requestAnchorUtc: '2026-11-23T05:00:00Z' })).toEqual({
      kind: 'clarify',
      reason: 'missing_timezone',
    });
    expect(
      resolveTaskAsOf({
        ...input,
        timezoneId: 'Invalid/Zone',
        requestAnchorUtc: '2026-11-23T05:00:00Z',
      }),
    ).toEqual({ kind: 'error', reason: 'invalid_time_context' });
  });
});

describe('native office artifacts', () => {
  it('renders both artifacts from the same accepted facts, with source versions and per-record anomalies', () => {
    const analysis = accepted(golden);
    const markdown = renderOfficeReportMarkdown({
      analysis,
      notes,
      interpretation:
        '## 任务统计\n| 总数 | 999 |\n[外链](https://example.test/)\n<script>不执行</script>',
    });
    expect(markdown).toContain('纪要：会议纪要.md（版本：notes-version）');
    expect(markdown).toContain('任务表：任务.csv（版本：csv-version）');
    expect(markdown).toContain('数据记录 1–5');
    expect(markdown).toContain('| 总数 | 5 |');
    expect(markdown).toContain('| 逾期未完成 | 1 |');
    expect(markdown).toContain('记录 4：缺负责人、缺截止日、非法状态。');
    expect(markdown).toContain('记录 5：非法截止日。');
    expect(markdown.match(/^## 任务统计$/gm)).toHaveLength(1);
    expect(markdown).toContain('## 模型解读（非统计依据）\n\n    ## 任务统计\n    | 总数 | 999 |');
    expect(markdown).not.toMatch(/^\| 总数 \| 999 \|/m);
    const output = renderOwnerSummaryCsv(analysis);
    const rows = parse(output, { bom: true });
    expect(rows).toEqual([
      [
        'owner_kind',
        'owner',
        'total',
        'todo',
        'in_progress',
        'done',
        'canceled',
        'overdue',
        'anomaly_rows',
        'missing_owner',
        'missing_due_date',
        'invalid_due_date',
        'invalid_status',
      ],
      ['named', '乙', '2', '1', '0', '1', '0', '0', '1', '0', '0', '1', '0'],
      ['named', '甲', '2', '1', '1', '0', '0', '1', '0', '0', '0', '0', '0'],
      ['unassigned', '', '1', '0', '0', '0', '0', '0', '1', '1', '1', '0', '1'],
    ]);
  });

  it('escapes formulas (including fullwidth and ignorable prefixes), controls and CSV delimiters without mutating records', () => {
    const analysis = accepted(
      TASK_CSV_TEMPLATE +
        '1,task," \t=1+2",,todo\n' +
        '2,task,　＋12,,todo\n' +
        '3,task,－12,,todo\n' +
        '4,task,\u200B＠SUM,,todo\n' +
        '5,task,"甲,""乙""\u0000\r\n丙",,todo\n' +
        '6,task,, ,todo\n' +
        '7,task,未分配,,todo\n',
    );
    const csv = renderOwnerSummaryCsv(analysis);
    const owners = parse(csv, { bom: true })
      .slice(1)
      .map(([kind, owner]) => [kind, owner]);
    expect(owners).toContainEqual(['named', "'=1+2"]);
    expect(owners).toContainEqual(['named', "'＋12"]);
    expect(owners).toContainEqual(['named', "'－12"]);
    expect(owners).toContainEqual(['named', "'\\u{200B}＠SUM"]);
    expect(owners).toContainEqual(['named', '甲,"乙"\\u{0000}\\u{000D}\\u{000A}丙']);
    expect(owners).toContainEqual(['named', '未分配']);
    expect(owners).toContainEqual(['unassigned', '']);
    expect(csv).not.toMatch(/[\u0000\u0009\u200B]/u);
    expect(analysis.records[0].owner).toBe(' \t=1+2');
    expect(analysis.records[4].owner).toBe('甲,"乙"\u0000\r\n丙');
  });

  it('bounds UTF-8 interpretation bytes and supports notes-only Markdown without fabricating task facts', () => {
    const max = '🍵'.repeat(OFFICE_REPORT_LIMITS.interpretationBytes / 4);
    const markdown = renderOfficeReportMarkdown({ notes, interpretation: max });
    expect(markdown).toContain(max);
    expect(markdown).not.toContain('## 任务统计');
    expect(() => renderOfficeReportMarkdown({ notes, interpretation: max + '字' })).toThrow(
      RangeError,
    );
    expect(() => renderOfficeReportMarkdown({ interpretation: 'No source' })).toThrow(RangeError);
  });
});
