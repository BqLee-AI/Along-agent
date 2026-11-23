import type { PoolClient } from 'pg';
import { HarnessToolResultSchema } from '@along/contracts';
import type { z } from 'zod';
import { stateConflict } from '../../../platform/errors.js';
import type { ToolContext, ToolResult } from '../contracts.js';
import type { CreateReminderInputSchema } from '../schemas.js';
import { assertOfficeManifest } from './receipts.js';
import { requestedOfficeFormats } from './request.js';

const reminderDirective =
  /提醒我|通知我|叫我|(?:添加|创建|设置|设定|建立|安排)(?:一次|一条|一个)?(?:站内)?提醒|\bremind\s+me\b|\b(?:set|create|schedule)\s+(?:a\s+|one\s+)?reminder\b/giu;
const ambiguousReminder =
  /(?:不要|不用|无需|不必|不得|禁止|避免|取消|是否|如果|假如|假设|[?？]|\b(?:don't|do\s+not|not|never|without|if|whether|cancel|skip)\b)/iu;
const recurringReminder =
  /(?:每天|每周|每月|每年|重复提醒|定期|每隔|\b(?:daily|weekly|monthly|yearly|every|recurring|repeatedly)\b)/iu;

function reminderClause(request: string) {
  const segments = request.split(
    /[，,。；;！!\n]+|(?:，?并且|并于|并在|然后|另外)|\b(?:and then|then|also)\b/iu,
  );
  const matches = segments.flatMap((clause) =>
    Array.from(clause.matchAll(reminderDirective), (match) => ({
      clause,
      noteClause: clause.slice(match.index + match[0].length),
    })),
  );
  if (
    matches.length !== 1 ||
    ambiguousReminder.test(matches[0]!.clause) ||
    recurringReminder.test(matches[0]!.clause)
  )
    return null;
  return matches[0]!;
}

function trustedElapsedSeconds(text: string): number | undefined {
  const phrase =
    /^(?:再)?\s*(\d{1,9})\s*(秒(?:钟)?|分钟|小时|天)\s*(?:以)?后$/u.exec(text.trim()) ??
    /^(?:in|after)\s+(\d{1,9})\s+(seconds?|minutes?|hours?|days?)$/iu.exec(text.trim());
  if (!phrase) return undefined;
  const units = /^(?:秒|second)/iu.test(phrase[2]!)
    ? 1
    : /^(?:分钟|minute)/iu.test(phrase[2]!)
      ? 60
      : /^(?:小时|hour)/iu.test(phrase[2]!)
        ? 3600
        : 86400;
  return Number(phrase[1]) * units;
}

/** Guards the existing reminder handler while the gateway holds office authority. */
export async function bindOfficeReminder(
  client: PoolClient,
  ctx: ToolContext,
  originalText: string,
  input: z.infer<typeof CreateReminderInputSchema>,
): Promise<{ scopeRunId: string } | { denied: ToolResult }> {
  const source = reminderClause(originalText);
  if (
    !source ||
    !source.clause.includes(input.raw_time_text) ||
    !input.note.trim() ||
    !source.noteClause.includes(input.note) ||
    (input.timezone_hint != null && input.timezone_hint !== ctx.confirmedTimezone) ||
    ('time_kind' in input && trustedElapsedSeconds(input.raw_time_text) !== input.duration_seconds)
  )
    return {
      denied: {
        status: 'denied',
        error: {
          code: 'OFFICE_REMINDER_UNAUTHORIZED',
          message: '提醒事项、时刻和一次性站内授权必须由本人原请求明确给出。',
        },
      },
    };

  // The owner lock remains held through task, its outbox command, and the
  // invocation's acceptance. Together they form one serialized shared slot.
  const {
    rows: [scope],
  } = await client.query<{ scope_run_id: string; occupied: boolean }>(
    `SELECT s.scope_run_id, EXISTS (
       SELECT 1 FROM office_run_materials m JOIN tool_invocations t
         ON t.run_id=m.run_id AND t.owner_id=m.owner_id AND t.conversation_id=m.conversation_id
       WHERE m.scope_run_id=s.scope_run_id AND t.tool_id='create_reminder'
         AND t.state='completed' AND t.outcome_kind='success'
         AND t.accepted_result #>> '{result,kind}'='task_created'
     ) AS occupied FROM office_run_materials s
     WHERE s.run_id=$1 AND s.owner_id=$2 AND s.conversation_id=$3`,
    [ctx.runId, ctx.ownerId, ctx.conversationId],
  );
  if (!scope) throw stateConflict('missing office reminder scope');
  if (scope.occupied)
    return {
      denied: {
        status: 'denied',
        error: {
          code: 'STATE_CONFLICT',
          message: '此办公委托已经接受一次提醒，不能重复创建。',
        },
      },
    };

  const formats = requestedOfficeFormats(originalText);
  if (
    formats.length ||
    /(?:交付|导出|下载|生成.{0,16}(?:报告|汇总|文件)|\b(?:export|download|deliver|artifact|files?)\b)/iu.test(
      originalText,
    )
  ) {
    const {
      rows: [row],
    } = await client.query<{ accepted_result: unknown }>(
      `SELECT t.accepted_result FROM office_deliveries d JOIN tool_invocations t
         ON t.run_id=d.run_id AND t.owner_id=d.owner_id AND t.conversation_id=d.conversation_id
       WHERE d.scope_run_id=$1 AND d.owner_id=$2 AND d.conversation_id=$3
         AND t.tool_id='office_create_artifacts' AND t.state='completed' AND t.outcome_kind='success'
         AND t.result_version=1 AND t.approval_id IS NULL
       ORDER BY t.accepted_at,t.invocation_id LIMIT 1`,
      [scope.scope_run_id, ctx.ownerId, ctx.conversationId],
    );
    const receipt = HarnessToolResultSchema.safeParse(row?.accepted_result);
    if (
      !receipt.success ||
      receipt.data.status !== 'ok' ||
      receipt.data.result.kind !== 'office_create_artifacts' ||
      formats.length !== receipt.data.result.artifacts.length ||
      !receipt.data.result.artifacts.every(({ format }) => formats.includes(format))
    )
      return {
        denied: {
          status: 'denied',
          error: {
            code: 'OFFICE_DELIVERY_REQUIRED',
            message: '原委托要求的完整文件交付尚未接受，提醒未创建。',
          },
        },
      };
    await assertOfficeManifest(client, ctx, receipt.data.result);
  }
  return { scopeRunId: scope.scope_run_id };
}
