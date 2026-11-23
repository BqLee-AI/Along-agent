import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Pool, PoolClient } from 'pg';
import {
  OfficeAnalyzeTasksInputSchema,
  OfficeCreateArtifactsInputSchema,
  OfficeReadNotesInputSchema,
} from '@along/contracts';
import {
  analyzeTaskCsv,
  parseTaskCsv,
  renderOfficeReportMarkdown,
  renderOwnerSummaryCsv,
  resolveTaskAsOf,
} from '../../../features/native-office/public.js';
import type {
  TaskCsvAnalysis,
  TaskCsvRecord,
  OfficeArtifactWrite,
  OfficeFrozenInput,
  OfficeRole,
} from '../../../features/native-office/public.js';
import {
  readOfficeAttachment,
  writeOfficeDelivery,
} from '../../../features/native-office/public.js';
import { ApplicationError, stateConflict } from '../../../platform/errors.js';
import type { InvocationInput, ToolContext, ToolResult } from '../contracts.js';
import { executeLocalInvocation } from '../invocations/invocations.js';
import { officeExecution, requireOfficeKey } from './authority.js';
import { officeSource, pageOfficeNotes } from './notes.js';
import { assertOfficeManifest, readOfficeSourceReceipts } from './receipts.js';
import {
  readOriginalOfficeRequest,
  requestedOfficeAsOf,
  requestedOfficeFormats,
} from './request.js';
import { taskAnalysisDigest, taskPage, taskPreview } from './task-results.js';

const denial = (code: string, message: string): ToolResult => ({
  status: 'denied',
  error: { code, message },
});
const invalidArgs = denial('OFFICE_INVALID_ARGUMENTS', '办公工具参数不符合约定。');
const invalidCsv = denial(
  'OFFICE_INVALID_CSV',
  '任务表未通过校验，请使用 preview 查看问题和模板。',
);
const invalidSource = denial('OFFICE_INVALID_SOURCE', '办公回执或分页游标不可用。');

async function readFrozenRole(client: PoolClient, ctx: ToolContext, role: OfficeRole) {
  const input = await readOfficeAttachment(client, { ...officeExecution(ctx), role });
  const { bytes, ...binding } = input;
  if (
    !isDeepStrictEqual(
      binding,
      ctx.officeMaterials?.find((item) => item.role === role),
    ) ||
    bytes.length !== binding.sizeBytes ||
    createHash('sha256').update(bytes).digest('hex') !== binding.sha256
  )
    throw stateConflict('office input differs from accepted version');
  return input;
}

function analyze(records: readonly TaskCsvRecord[], source: OfficeFrozenInput, asOf: string) {
  const wire = officeSource(source);
  return analyzeTaskCsv(records, asOf, { displayName: wire.display_name, version: wire.version });
}

async function readFrozenAnalysis(client: PoolClient, ctx: ToolContext, invocationId: string) {
  const [receipt] = await readOfficeSourceReceipts(
    client,
    ctx,
    requireOfficeKey(),
    'office_analyze_tasks',
    [invocationId],
  );
  if (
    !receipt ||
    receipt.value.status !== 'ok' ||
    receipt.value.result.kind !== 'office_analyze_tasks' ||
    receipt.value.result.action !== 'analyze' ||
    !receipt.analysisDigest
  )
    throw stateConflict('office action requires an accepted analysis');
  const accepted = receipt.value.result;
  const source = await readFrozenRole(client, ctx, 'tasks');
  if (!isDeepStrictEqual(accepted.source, officeSource(source)))
    throw stateConflict('office analysis version mismatch');
  const parsed = parseTaskCsv(source.bytes);
  if (parsed.kind !== 'ok') throw stateConflict('office analysis source no longer verifies');
  const analysis = analyze(parsed.records, source, accepted.as_of);
  if (taskAnalysisDigest(analysis) !== receipt.analysisDigest)
    throw stateConflict('office accepted analysis facts no longer verify');
  return { analysis, attachmentId: source.attachmentId, digest: receipt.analysisDigest };
}

async function runAnalyzeTasks(client: PoolClient, ctx: ToolContext, raw: unknown) {
  const args = OfficeAnalyzeTasksInputSchema.safeParse(raw);
  if (!args.success) return invalidArgs;
  const { action } = args.data;
  if (action === 'page') {
    const { analysis } = await readFrozenAnalysis(client, ctx, args.data.analysis_invocation_id);
    if (args.data.after_record >= analysis.records.length) return invalidSource;
    return { status: 'ok' as const, result: taskPage(analysis, args.data.after_record) };
  }
  const source = await readFrozenRole(client, ctx, 'tasks');
  const parsed = parseTaskCsv(source.bytes);
  if (action === 'preview')
    return { status: 'ok' as const, result: taskPreview(officeSource(source), parsed) };
  if (parsed.kind !== 'ok') return invalidCsv;
  const request = await readOriginalOfficeRequest(client, ctx);
  const time = ctx.timeContext;
  const frozenRules =
    time.available &&
    time.ruleset_id === request.ruleset &&
    time.tzdb_version === request.tzdb &&
    time.aliases.version === request.aliases
      ? time.ruleset
      : undefined;
  const asOf = resolveTaskAsOf({
    explicitDate: requestedOfficeAsOf(request.content),
    requestAnchorUtc: request.anchor,
    timezoneId: request.timezone ?? undefined,
    ruleset: frozenRules,
  });
  if (asOf.kind === 'clarify')
    return denial('OFFICE_TIMEZONE_REQUIRED', '请确认本次任务分析使用的时区。');
  if (asOf.kind === 'error')
    return denial('OFFICE_TIME_UNAVAILABLE', '已接受的分析日期或时间规则不可用。');
  const analysis = analyze(parsed.records, source, asOf.asOf);
  return {
    value: { status: 'ok' as const, result: taskPage(analysis, 0) },
    officeAnalysisDigest: taskAnalysisDigest(analysis),
  };
}

async function runCreateArtifacts(
  client: PoolClient,
  ctx: ToolContext,
  raw: unknown,
): Promise<ToolResult> {
  const parsed = OfficeCreateArtifactsInputSchema.safeParse(raw);
  if (!parsed.success) return invalidArgs;
  const { analysis_invocation_id, notes_invocation_ids, interpretation } = parsed.data;
  const formats = [...parsed.data.formats].sort();
  const requested = requestedOfficeFormats((await readOriginalOfficeRequest(client, ctx)).content);
  if (!isDeepStrictEqual(formats, requested)) {
    return denial('OFFICE_DELIVERY_SCOPE', '请明确本次交付所需的全部文件格式；不能部分交付。');
  }
  const notesSource = ctx.officeMaterials?.find(({ role }) => role === 'notes');
  const taskSource = ctx.officeMaterials?.find(({ role }) => role === 'tasks');
  // A selected task table may be part of a Markdown report even when the user
  // did not ask for CSV. Do not occupy the only delivery slot before analysis.
  if (
    (taskSource && !analysis_invocation_id) ||
    (formats.includes('markdown') && notesSource && !notes_invocation_ids)
  )
    return denial('OFFICE_DELIVERY_INCOMPLETE', '交付前需要完成所选资料的读取和任务分析。');

  let analyzed: { analysis: TaskCsvAnalysis; attachmentId: string; digest: string } | undefined;
  if (analysis_invocation_id)
    analyzed = await readFrozenAnalysis(client, ctx, analysis_invocation_id);
  const covered: Array<[number, number]> = [];
  if (notes_invocation_ids) {
    if (!notesSource) return invalidSource;
    const source = officeSource(notesSource);
    const receipts = await readOfficeSourceReceipts(
      client,
      ctx,
      requireOfficeKey(),
      'office_read_notes',
      notes_invocation_ids,
    );
    for (const { value } of receipts) {
      if (
        value.status !== 'ok' ||
        value.result.kind !== 'office_read_notes' ||
        !isDeepStrictEqual(value.result.source, source)
      )
        return invalidSource;
      const { offset, content } = value.result;
      covered.push([offset, offset + Buffer.byteLength(content)]);
    }
    covered.sort(([a, aEnd], [b, bEnd]) => a - b || aEnd - bEnd);
  }
  const notes = notesSource && covered.length ? officeSource(notesSource) : undefined;
  const analysis = analyzed?.analysis;
  const markdownSources = [
    ...(notes ? [notesSource!.attachmentId] : []),
    ...(analyzed ? [analyzed.attachmentId] : []),
  ];
  const artifacts: OfficeArtifactWrite[] = [];
  for (const format of formats) {
    if (format === 'csv') {
      if (!analyzed) return invalidSource;
      artifacts.push({
        format,
        filename: 'owner-summary.csv',
        sourceAttachmentIds: [analyzed.attachmentId],
        bytes: Buffer.from(renderOwnerSummaryCsv(analyzed.analysis)),
      });
    } else {
      artifacts.push({
        format,
        filename: 'office-report.md',
        sourceAttachmentIds: markdownSources,
        bytes: Buffer.from(
          renderOfficeReportMarkdown({
            analysis,
            ...(notes
              ? { notes: { displayName: notes.display_name, version: notes.version } }
              : {}),
            interpretation,
          }),
        ),
      });
    }
  }
  const paramsSha256 = createHash('sha256')
    .update('along/office-delivery/v1\0')
    .update(
      JSON.stringify([
        formats,
        ...(notes ? [notes.version, covered] : [null, []]),
        analyzed?.digest ?? null,
        interpretation ?? null,
      ]),
    )
    .digest('hex');
  const accepted = await writeOfficeDelivery(client, {
    ...officeExecution(ctx),
    paramsSha256,
    artifacts,
  });
  // A committed manifest must exist for every requested format. If it cannot
  // be accepted, the invocation transaction rolls back all new byte writes.
  if (accepted.length !== artifacts.length || accepted.some(({ status }) => status !== 'available'))
    throw stateConflict('office delivery is not available');
  const result = {
    kind: 'office_create_artifacts' as const,
    artifacts: accepted.map((artifact) => ({
      artifact_id: artifact.artifactId,
      filename: artifact.filename,
      format: artifact.format,
      size_bytes: artifact.sizeBytes,
    })),
  };
  await assertOfficeManifest(client, ctx, result);
  return { status: 'ok', result };
}

export function invokeOfficeTool(pool: Pool, ctx: ToolContext, input: InvocationInput) {
  return executeLocalInvocation(pool, ctx, input, async (client, frozen) => {
    // Errors converted to safe tool output must not preserve partial writes.
    // Source/page conflicts are pre-write; all artifact storage errors propagate.
    if (input.toolId === 'office_create_artifacts')
      return runCreateArtifacts(client, frozen, input.args);
    try {
      if (input.toolId === 'office_analyze_tasks')
        return await runAnalyzeTasks(client, frozen, input.args);
      const args = OfficeReadNotesInputSchema.safeParse(input.args);
      if (!args.success) return invalidArgs;
      const notes = await readFrozenRole(client, frozen, 'notes');
      return { status: 'ok', result: pageOfficeNotes(notes, args.data.offset ?? 0) };
    } catch (error) {
      if (error instanceof ApplicationError && error.errorCode === 'STATE_CONFLICT')
        return invalidSource;
      throw error;
    }
  });
}
