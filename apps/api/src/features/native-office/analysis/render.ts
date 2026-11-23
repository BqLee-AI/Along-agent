import { Buffer } from 'node:buffer';
import { stringify } from 'csv-stringify/sync';
import type {
  OfficeSource,
  TaskCsvAnalysis,
  TaskCsvAnomaly,
  TaskCsvCounts,
} from './task-analysis.js';

export const OFFICE_REPORT_LIMITS = Object.freeze({
  interpretationBytes: 8 * 1024,
  artifactBytes: 2 * 1024 * 1024,
});

const COUNT_COLUMNS = [
  ['total', '总数', 'total'],
  ['todo', '待办', 'todo'],
  ['inProgress', '进行中', 'in_progress'],
  ['done', '已完成', 'done'],
  ['canceled', '已取消', 'canceled'],
  ['overdue', '逾期未完成', 'overdue'],
  ['anomalyRows', '异常记录数', 'anomaly_rows'],
  ['missingOwner', '缺负责人', 'missing_owner'],
  ['missingDueDate', '缺截止日', 'missing_due_date'],
  ['invalidDueDate', '非法截止日', 'invalid_due_date'],
  ['invalidStatus', '非法状态', 'invalid_status'],
] as const satisfies readonly (readonly [keyof TaskCsvCounts, string, string])[];

const ANOMALY_LABEL: Record<TaskCsvAnomaly, string> = {
  missingOwner: '缺负责人',
  missingDueDate: '缺截止日',
  invalidDueDate: '非法截止日',
  invalidStatus: '非法状态',
};

function displayControls(text: string): string {
  return text.replace(
    /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu,
    (char) => `\\u{${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}}`,
  );
}

function safeSpreadsheetText(text: string): string {
  // Inspect the normalized prefix, but never normalize the visible name or the source facts.
  const prefix = text.normalize('NFKC').replace(/^[\s\p{Cc}\p{Cf}]+/u, '');
  const display = displayControls(text);
  return /^[=+@\-−]/u.test(prefix) ? `'${display}` : display;
}

function withinArtifactLimit(text: string): string {
  if (Buffer.byteLength(text) > OFFICE_REPORT_LIMITS.artifactBytes) {
    throw new RangeError('Office artifact exceeds byte limit');
  }
  return text;
}

/** Render only the accepted group counts; owner_kind distinguishes unassigned from any name. */
export function renderOwnerSummaryCsv(analysis: TaskCsvAnalysis): string {
  const rows: (string | number)[][] = [
    ['owner_kind', 'owner', ...COUNT_COLUMNS.map(([, , column]) => column)],
  ];
  for (const { owner, totals } of analysis.groups) {
    rows.push([
      owner === null ? 'unassigned' : 'named',
      owner === null ? '' : safeSpreadsheetText(owner),
      ...COUNT_COLUMNS.map(([key]) => totals[key]),
    ]);
  }
  return withinArtifactLimit(stringify(rows, { bom: true, record_delimiter: '\r\n' }));
}

export interface OfficeReportInput {
  readonly analysis?: TaskCsvAnalysis;
  readonly notes?: OfficeSource;
  /** Untrusted narrative only, never parsed as a statistic, source, or URL. */
  readonly interpretation?: string;
}

function markdownInline(text: string): string {
  return displayControls(text).replace(/[\\`*_[\]<>|&!~]/g, '\\$&');
}

/** Produce a Markdown report with independent, server-owned statistics and anomaly locators. */
export function renderOfficeReportMarkdown(input: OfficeReportInput): string {
  const { analysis, notes, interpretation } = input;
  if (!analysis && !notes) throw new RangeError('Office report requires an accepted source');
  if (
    interpretation !== undefined &&
    Buffer.byteLength(interpretation) > OFFICE_REPORT_LIMITS.interpretationBytes
  ) {
    throw new RangeError('Office interpretation exceeds byte limit');
  }
  const lines = ['# 办公资料报告', '', '## 来源', ''];
  if (notes) {
    lines.push(
      `- 纪要：${markdownInline(notes.displayName)}（版本：${markdownInline(notes.version)}）`,
    );
  }
  if (analysis) {
    const { source, asOf, totals, groups, records } = analysis;
    lines.push(
      `- 任务表：${markdownInline(source.displayName)}（版本：${markdownInline(source.version)}）`,
      `- 截至日：${asOf}。仅截止日早于截至日的待办、进行中任务计为逾期。`,
      records.length
        ? `- 覆盖：数据记录 1–${records.length}（不含表头）。`
        : '- 覆盖：无数据记录。',
      '',
      '## 任务统计',
      '',
      '| 指标 | 数量 |',
      '| --- | ---: |',
      ...COUNT_COLUMNS.map(([key, label]) => `| ${label} | ${totals[key]} |`),
      '',
      '## 负责人分组',
      '',
      `| 分组类型 | 负责人 | ${COUNT_COLUMNS.map(([, label]) => label).join(' | ')} |`,
      `| --- | --- | ${COUNT_COLUMNS.map(() => '---:').join(' | ')} |`,
    );
    for (const { owner, totals } of groups) {
      const label = owner === null ? '未分配 | —' : `按姓名 | ${markdownInline(owner)}`;
      lines.push(`| ${label} | ${COUNT_COLUMNS.map(([key]) => totals[key]).join(' | ')} |`);
    }
    lines.push('', '## 逐项异常', '', '以下编号为任务表版本中的数据记录号，而不是物理行号。', '');
    if (!totals.anomalyRows) lines.push('无异常。');
    for (const { recordNumber, anomalies } of records) {
      if (anomalies.length) {
        lines.push(
          `- 记录 ${recordNumber}：${anomalies.map((anomaly) => ANOMALY_LABEL[anomaly]).join('、')}。`,
        );
      }
    }
  }
  if (interpretation) {
    lines.push('', '## 模型解读（非统计依据）', '');
    // Indenting every line prevents Markdown headings, links, and tables from becoming report structure.
    for (const line of interpretation.split(/\r\n|\n|\r/u))
      lines.push(`    ${displayControls(line)}`);
  }
  return withinArtifactLimit(`${lines.join('\n')}\n`);
}
