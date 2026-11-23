import { createHash } from 'node:crypto';
import { OfficeAnalyzeTasksResultSchema } from '@along/contracts';
import type {
  TaskCsvAnalysis,
  TaskCsvAnomaly,
  TaskCsvCounts,
  TaskCsvParseResult,
} from '../../../features/native-office/public.js';
import { pageTaskCsvAnalysis, TASK_CSV_TEMPLATE } from '../../../features/native-office/public.js';
import type { OfficeWireSource } from './notes.js';

function counts(value: TaskCsvCounts) {
  return {
    total: value.total,
    todo: value.todo,
    in_progress: value.inProgress,
    done: value.done,
    canceled: value.canceled,
    overdue: value.overdue,
    anomaly_rows: value.anomalyRows,
    missing_owner: value.missingOwner,
    missing_due_date: value.missingDueDate,
    invalid_due_date: value.invalidDueDate,
    invalid_status: value.invalidStatus,
  };
}
const anomalies = {
  missingOwner: 'missing_owner',
  missingDueDate: 'missing_due_date',
  invalidDueDate: 'invalid_due_date',
  invalidStatus: 'invalid_status',
} as const satisfies Record<TaskCsvAnomaly, string>;
const fields = {
  taskId: 'task_id',
  title: 'title',
  owner: 'owner',
  dueDate: 'due_date',
  status: 'status',
} as const;

export function taskPreview(source: OfficeWireSource, parsed: TaskCsvParseResult) {
  const issue = parsed.kind === 'error' ? parsed.issue : undefined;
  return OfficeAnalyzeTasksResultSchema.parse({
    kind: 'office_analyze_tasks',
    action: 'preview',
    source,
    result:
      parsed.kind === 'ok'
        ? { valid: true, total_records: parsed.records.length }
        : {
            valid: false,
            template: TASK_CSV_TEMPLATE,
            issue: {
              code: issue!.code,
              ...(issue!.recordNumber !== undefined && { record_number: issue!.recordNumber }),
              ...(issue!.columnNumber !== undefined && { column_number: issue!.columnNumber }),
              ...(issue!.missingColumns !== undefined && {
                missing_columns: issue!.missingColumns,
              }),
            },
          },
  });
}

export function taskPage(analysis: TaskCsvAnalysis, afterRecord: number) {
  const page = pageTaskCsvAnalysis(analysis, afterRecord, 5);
  return OfficeAnalyzeTasksResultSchema.parse({
    kind: 'office_analyze_tasks',
    action: afterRecord === 0 ? 'analyze' : 'page',
    source: { display_name: page.source.displayName, version: page.source.version },
    as_of: page.asOf,
    after_record: afterRecord,
    total_records: page.totalRecords,
    total_groups: page.totalGroups,
    totals: counts(page.totals),
    groups: page.groups.map((group) => ({
      owner: group.owner,
      owner_truncated: group.ownerTruncated,
      totals: counts(group.totals),
    })),
    records: page.records.map((record) => ({
      record_number: record.recordNumber,
      task_id: record.taskId,
      title: record.title,
      owner: record.owner,
      due_date: record.dueDate,
      status: record.status,
      overdue: record.overdue,
      anomalies: record.anomalies.map((tag) => anomalies[tag]),
      truncated_fields: record.truncatedFields.map((field) => fields[field]),
    })),
    next_after_record: page.nextAfterRecord,
  });
}

/** Fingerprint all accepted facts, not just the bounded initial result. */
export function taskAnalysisDigest(analysis: TaskCsvAnalysis) {
  const hash = createHash('sha256');
  hash.update('along/office-analysis/v1\0');
  hash.update(JSON.stringify([analysis.source, analysis.asOf, analysis.totals]));
  for (const group of analysis.groups) hash.update(JSON.stringify(group));
  for (const record of analysis.records) hash.update(JSON.stringify(record));
  return hash.digest('hex');
}
