import { parse } from 'csv-parse/browser/esm/sync';
import { stringify } from 'csv-stringify/browser/esm/sync';
import { z } from 'zod';

export const OFFICE_CSV_BYTES = 1024 * 1024;
export const OFFICE_NOTES_BYTES = 48 * 1024;

export interface OfficeAnalysis {
  total: number;
  overdue: number;
  csv: string;
  markdown: string;
}
const COLUMNS = ['task_id', 'title', 'owner', 'due_date', 'status'];
const STATUSES = ['todo', 'in_progress', 'done', 'canceled'];
const calendarDate = z.string().date();

function isDate(value: string): boolean {
  return !value.startsWith('0000-') && calendarDate.safeParse(value).success;
}

function safeCell(value: string): string {
  // Spreadsheet formula prefixes can follow whitespace or use full-width variants.
  return /^[=+\-@\t\r\n]/u.test(value) || /^[=+\-@]/u.test(value.normalize('NFKC').trimStart())
    ? `'${value}`
    : value;
}

export async function readOfficeFile(file: File, limit: number): Promise<string> {
  if (file.size === 0 || file.size > limit)
    throw new Error(`请选择非空文件，大小不超过 ${limit / 1024} KiB。`);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
  } catch {
    throw new Error('无法读取文件，请使用 UTF-8 编码。');
  }
}

export function analyzeOfficeCsv(csv: string, cutoff: string): OfficeAnalysis {
  if (!isDate(cutoff)) throw new Error('请选择有效的截至日期。');
  if (csv.includes('\0')) throw new Error('任务表含有无效的空字符。');
  let rows: string[][];
  try {
    rows = parse(csv, { bom: true, to: 5002 });
  } catch (error) {
    const line = error && typeof error === 'object' && 'lines' in error ? error.lines : null;
    throw new Error(
      typeof line === 'number' ? `CSV 第 ${line} 行格式有误。` : '无法解析任务 CSV。',
    );
  }
  const [header, ...records] = rows;
  if (header?.length !== COLUMNS.length || !COLUMNS.every((name) => header.includes(name))) {
    throw new Error(`表头必须包含且仅包含 ${COLUMNS.join('、')}。`);
  }
  if (records.length > 5000) throw new Error('任务表最多支持 5000 条记录。');
  const [idIndex, titleIndex, ownerIndex, dueIndex, statusIndex] = COLUMNS.map((name) =>
    header.indexOf(name),
  );
  const ids = new Set<string>();
  const groups = new Map<
    string,
    { total: number; overdue: number; missing: number; invalid: number; unknown: number }
  >();
  const issues: string[][] = [];
  let overdue = 0;
  for (const [index, row] of records.entries()) {
    const id = row[idIndex!]!.trim();
    if (!id || ids.has(id)) throw new Error(`第 ${index + 1} 条记录的 task_id 为空或重复。`);
    ids.add(id);
    const owner = row[ownerIndex!]!.trim();
    const due = row[dueIndex!]!.trim();
    const status = row[statusIndex!]!;
    let group = groups.get(owner);
    if (!group) {
      group = { total: 0, overdue: 0, missing: 0, invalid: 0, unknown: 0 };
      groups.set(owner, group);
    }
    group.total++;
    const classifications: string[] = [];
    if (!due) {
      group.missing++;
      classifications.push('缺日期');
    } else if (!isDate(due)) {
      group.invalid++;
      classifications.push('非法日期');
    } else if (due < cutoff && (status === 'todo' || status === 'in_progress')) {
      overdue++;
      group.overdue++;
      classifications.push('逾期');
    }
    if (!STATUSES.includes(status)) {
      group.unknown++;
      classifications.push('异常状态');
    }
    if (classifications.length) {
      issues.push([
        String(index + 1),
        id,
        row[titleIndex!]!,
        owner || '（未分配）',
        due,
        classifications.join('、'),
      ]);
    }
  }
  const headings = ['负责人', '已分配', '总数', '逾期', '缺日期', '非法日期', '异常状态'];
  const summary = Array.from(groups.keys())
    .sort()
    .map((owner) => {
      const counts = groups.get(owner)!;
      return [
        owner,
        owner ? '是' : '否',
        counts.total,
        counts.overdue,
        counts.missing,
        counts.invalid,
        counts.unknown,
      ];
    });
  return {
    total: records.length,
    overdue,
    csv: stringify(
      [headings, ...summary.map(([owner, ...counts]) => [safeCell(String(owner)), ...counts])],
      { record_delimiter: 'windows' },
    ),
    markdown: [
      `截至 ${cutoff}，共 ${records.length} 条任务，其中 ${overdue} 条逾期未完成。`,
      '',
      '## 按负责人汇总',
      '',
      markdownTable(headings, summary),
      '',
      '## 逾期与异常明细',
      '',
      issues.length
        ? markdownTable(['记录', '任务 ID', '标题', '负责人', '截止日期', '分类'], issues)
        : '无。',
    ].join('\n'),
  };
}

function markdownTable(headings: string[], rows: (string | number)[][]): string {
  const escaped = (value: string | number) =>
    String(value).replace(/[&<>|\\`*_~![\]\r\n]/gu, (char) =>
      char === '\n' || char === '\r' ? ' ' : `&#${char.charCodeAt(0)};`,
    );
  const line = (row: (string | number)[]) => `| ${row.map(escaped).join(' | ')} |`;
  return [line(headings), line(headings.map(() => '---')), ...rows.map(line)].join('\n');
}

export function officeReport(analysis: string, notes: string, summary: string): string {
  const excerpt = summary || notes;
  const sections = ['# 资料报告', ...(analysis ? [analysis] : [])];
  if (excerpt) {
    sections.push(
      summary ? '## 模型纪要摘要' : '## 纪要原文',
      excerpt
        .split(/\r\n|\r|\n/u)
        .map((line) => `    ${line}`)
        .join('\n'),
    );
  }
  return sections.join('\n\n') + '\n';
}
