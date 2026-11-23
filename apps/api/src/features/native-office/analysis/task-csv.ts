import { Buffer, isUtf8 } from 'node:buffer';
import { CsvError, parse } from 'csv-parse/sync';

const COLUMNS = ['task_id', 'title', 'owner', 'due_date', 'status'] as const;
export type TaskCsvColumn = (typeof COLUMNS)[number];
export const TASK_CSV_TEMPLATE = `${COLUMNS.join(',')}\r\n`;
export const TASK_CSV_LIMITS = Object.freeze({
  inputBytes: 1024 * 1024,
  records: 5000,
  columns: 32,
  fieldBytes: 8 * 1024,
});

export interface TaskCsvRecord {
  readonly recordNumber: number;
  readonly taskId: string;
  readonly title: string;
  readonly owner: string;
  readonly dueDate: string;
  readonly status: string;
}

type TaskCsvIssueCode =
  | 'invalid_utf8'
  | 'input_byte_limit'
  | 'missing_header'
  | 'empty_header'
  | 'duplicate_header'
  | 'missing_columns'
  | 'unexpected_column'
  | 'malformed_csv'
  | 'record_width'
  | 'column_limit'
  | 'record_limit'
  | 'field_byte_limit'
  | 'empty_task_id'
  | 'duplicate_task_id';

/** Record 0 is the header; data records and columns start at 1. */
export interface TaskCsvIssue {
  readonly code: TaskCsvIssueCode;
  readonly recordNumber?: number;
  readonly columnNumber?: number;
  readonly missingColumns?: readonly TaskCsvColumn[];
}

export type TaskCsvParseResult =
  | { kind: 'ok'; records: readonly TaskCsvRecord[] }
  | { kind: 'error'; issue: TaskCsvIssue; template: string };

class RejectedTaskCsv extends Error {
  constructor(readonly issue: TaskCsvIssue) {
    super(issue.code);
  }
}

function invalid(issue: TaskCsvIssue): Extract<TaskCsvParseResult, { kind: 'error' }> {
  return { kind: 'error', issue, template: TASK_CSV_TEMPLATE };
}

function readHeader(row: string[]): Record<TaskCsvColumn, number> {
  const indices = new Map<string, number>();
  for (const [index, name] of row.entries()) {
    if (!name.trim()) {
      throw new RejectedTaskCsv({ code: 'empty_header', recordNumber: 0, columnNumber: index + 1 });
    }
    if (indices.has(name)) {
      throw new RejectedTaskCsv({
        code: 'duplicate_header',
        recordNumber: 0,
        columnNumber: index + 1,
      });
    }
    indices.set(name, index);
  }
  const missingColumns = COLUMNS.filter((column) => !indices.has(column));
  if (missingColumns.length) {
    throw new RejectedTaskCsv({ code: 'missing_columns', recordNumber: 0, missingColumns });
  }
  const unexpected = row.findIndex((name) => !COLUMNS.some((column) => column === name));
  if (unexpected !== -1) {
    throw new RejectedTaskCsv({
      code: 'unexpected_column',
      recordNumber: 0,
      columnNumber: unexpected + 1,
    });
  }
  return {
    task_id: indices.get('task_id')!,
    title: indices.get('title')!,
    owner: indices.get('owner')!,
    due_date: indices.get('due_date')!,
    status: indices.get('status')!,
  };
}

function rejectNulAfterClosingQuote(raw: string, recordNumber: number): void {
  // csv-parse's lookahead treats a NUL after the closing quote as EOF.
  if (!raw.includes('"\0')) return;
  let quoted = false;
  let columnNumber = 1;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '"') {
      if (quoted && raw[i + 1] === '"') {
        i++;
        continue;
      }
      quoted = !quoted;
      if (!quoted && raw[i + 1] === '\0') {
        throw new RejectedTaskCsv({ code: 'malformed_csv', recordNumber, columnNumber });
      }
    } else if (!quoted && raw[i] === ',') {
      columnNumber++;
    }
  }
}

/** Validate the whole input before exposing any data records. Errors carry no cell contents. */
export function parseTaskCsv(bytes: Uint8Array): TaskCsvParseResult {
  if (bytes.byteLength > TASK_CSV_LIMITS.inputBytes) return invalid({ code: 'input_byte_limit' });
  if (!isUtf8(bytes)) return invalid({ code: 'invalid_utf8' });

  const records: TaskCsvRecord[] = [];
  const ids = new Set<string>();
  let header: Record<TaskCsvColumn, number> | undefined;
  try {
    parse(bytes, {
      bom: true,
      record_delimiter: ['\r\n', '\n', '\r'],
      // The fixed template checks row width below, so limit and shape errors have separate locators.
      raw: bytes.includes(0),
      relax_column_count: true,
      cast(value, { index, records: recordNumber }) {
        const columnNumber = index + 1;
        if (recordNumber > TASK_CSV_LIMITS.records) {
          throw new RejectedTaskCsv({ code: 'record_limit', recordNumber });
        }
        if (columnNumber > TASK_CSV_LIMITS.columns) {
          throw new RejectedTaskCsv({ code: 'column_limit', recordNumber, columnNumber });
        }
        if (
          value.length * 3 > TASK_CSV_LIMITS.fieldBytes &&
          Buffer.byteLength(value) > TASK_CSV_LIMITS.fieldBytes
        ) {
          throw new RejectedTaskCsv({ code: 'field_byte_limit', recordNumber, columnNumber });
        }
        return value;
      },
      on_record(input: string[] | { record: string[]; raw: string }, { records: parsedCount }) {
        const recordNumber = parsedCount - 1; // The callback count already includes this row.
        const row = Array.isArray(input) ? input : input.record;
        if (!Array.isArray(input)) rejectNulAfterClosingQuote(input.raw, recordNumber);
        if (!header) {
          header = readHeader(row);
          return null;
        }
        if (row.length !== COLUMNS.length) {
          throw new RejectedTaskCsv({
            code: 'record_width',
            recordNumber,
            columnNumber: Math.min(row.length, COLUMNS.length) + 1,
          });
        }
        const taskId = row[header.task_id];
        const emptyId = !taskId.trim();
        if (emptyId || ids.has(taskId)) {
          throw new RejectedTaskCsv({
            code: emptyId ? 'empty_task_id' : 'duplicate_task_id',
            recordNumber,
            columnNumber: header.task_id + 1,
          });
        }
        ids.add(taskId);
        records.push({
          recordNumber,
          taskId,
          title: row[header.title],
          owner: row[header.owner],
          dueDate: row[header.due_date],
          status: row[header.status],
        });
        return null;
      },
    });
    return header ? { kind: 'ok', records } : invalid({ code: 'missing_header', recordNumber: 0 });
  } catch (error) {
    if (error instanceof RejectedTaskCsv) return invalid(error.issue);
    if (!(error instanceof CsvError)) throw error;
    const columnNumber = typeof error.index === 'number' ? error.index + 1 : undefined;
    const recordNumber = header ? records.length + 1 : 0;
    return invalid({ code: 'malformed_csv', recordNumber, columnNumber });
  }
}
