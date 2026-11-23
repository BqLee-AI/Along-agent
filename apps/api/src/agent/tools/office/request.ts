import type { PoolClient } from 'pg';
import { stateConflict } from '../../../platform/errors.js';
import type { OfficeAuthorityContext } from './authority.js';

type DeliveryFormat = 'markdown' | 'csv';

/** In a restricted continuation, only the original accepted user request grants effects or a cutoff. */
export async function readOriginalOfficeRequest(client: PoolClient, ctx: OfficeAuthorityContext) {
  const {
    rows: [row],
  } = await client.query<{
    content: string;
    anchor: string;
    timezone: string | null;
    ruleset: string;
    tzdb: string;
    aliases: string | null;
  }>(
    `SELECT msg.content, current_run.frozen_context->>'anchorReceivedAtUtc' AS anchor,
       current_run.frozen_context->>'confirmedTimezone' AS timezone,
       current_run.frozen_context->>'rulesetId' AS ruleset,
       current_run.frozen_context->>'tzdbVersion' AS tzdb,
       current_run.frozen_context->>'aliasVersion' AS aliases
     FROM office_run_materials scope
       JOIN agent_runs current_run ON current_run.id=scope.run_id
         AND current_run.owner_id=scope.owner_id AND current_run.conversation_id=scope.conversation_id
       JOIN agent_runs r ON r.id=scope.scope_run_id AND r.owner_id=scope.owner_id
         AND r.conversation_id=scope.conversation_id
       JOIN messages msg ON msg.id=r.input_message_id AND msg.owner_id=r.owner_id
         AND msg.conversation_id=r.conversation_id AND msg.role='user'
       WHERE scope.run_id=$1 AND scope.owner_id=$2 AND scope.conversation_id=$3`,
    [ctx.runId, ctx.ownerId, ctx.conversationId],
  );
  if (!row?.content) throw stateConflict('office original user request unavailable');
  return row;
}

/** Do not treat arbitrary dates (including the reminder's date) as analysis instructions. */
export function requestedOfficeAsOf(request: string): string | undefined {
  const date = '(\\d{4}-\\d{2}-\\d{2})(?![\\d-])';
  const mentions = [
    ...request.matchAll(
      new RegExp(
        `(?:截至(?:日(?:期)?)?|截止日(?:期)?|\\bas\\s+of|\\bcutoff(?:\\s+date)?)\\s*(?:为|是|[:：])?\\s*${date}`,
        'giu',
      ),
    ),
    ...request.matchAll(
      new RegExp(`以\\s*${date}\\s*(?:日)?\\s*(?:为|作为)\\s*(?:截至|截止)日`, 'gu'),
    ),
  ];
  for (const match of mentions) {
    const prefix =
      request
        .slice(0, match.index)
        .split(/[，,。；;！!\n]/u)
        .at(-1) ?? '';
    if (
      /(?:不要|不用|无需|不是|并非|拒绝|禁止|避免|\b(?:not|never|without|avoid|reject|don't|do not)\b)/iu.test(
        prefix,
      )
    )
      throw stateConflict('office analysis cutoff is ambiguous');
  }
  const dates = new Set(mentions.map((match) => match[1]!));
  if (dates.size > 1) throw stateConflict('office analysis cutoff is ambiguous');
  return dates.values().next().value;
}

const interveningOperation =
  /(?:分析|读取|解析|校验|检查|查看|选择|载入|上传|引用|根据|基于|[，,并]\s*统计|\b(?:analyze|analyse|read|parse|validate|check|select|upload|use|from)\b)/iu;
const names = /\bmarkdown\b|\.md\b|\bcsv\b/giu;
const effectVerb =
  /(?:生成|导出|下载|交付|输出|提供|产出|保存|给我|制作|\b(?:generate|export|download|deliver|provide|produce|create|write|save)\b)/giu;
const negative =
  /(?:不要|不用|无需|不必|不得|禁止|避免|不(?:需要|要求|想|用|生成|导出|下载|交付|输出|提供|产出|保存|创建)|\b(?:do\s+not|don't|dont|no|not|never|without|avoid|skip)\b)/iu;
const conditional =
  /(?:假设|假如|如果|若要|是否|能否|可以吗|举例|引述|转述|(?:解释|说明|介绍)如何|[?？]|\b(?:if|whether|explain|quote|example|how\s+to)\b)/iu;
const noFiles =
  /(?:不要|不用|无需|不必|禁止|别)(?:再|实际)?(?:生成|导出|下载|交付|输出|创建)?(?:任何)?(?:文件|工件|产物)|\b(?:no|without)\s+(?:any\s+)?(?:files?|artifacts?)\b/iu;
const inputPrefix =
  /(?:所选(?:的)?|选中(?:的)?|输入(?:的)?|原始|源|\b(?:selected|input|source))\s*$/iu;
const inputSuffix = /^(?:\s*的|-based\b|\s+(?:input|source)\b)/iu;

/** Supported explicit format names must be in a delivery clause. Ambiguous or
 * negated format requests do not authorize occupying the shared delivery slot. */
export function requestedOfficeFormats(request: string): DeliveryFormat[] {
  const formats = new Set<DeliveryFormat>();
  // Commas and conjunctions can join formats in one delivery directive.
  for (const raw of request.split(/[。；;！!\n]+/u)) {
    const clause = raw.trim();
    const mentions = [...clause.matchAll(names)];
    if (noFiles.test(clause)) return [];
    if (!mentions.length) continue;
    const verbs = [...clause.matchAll(effectVerb)];
    if (negative.test(clause) || conditional.test(clause)) return [];
    if (!verbs.length) continue;
    let verbIndex = -1;
    for (const mention of mentions) {
      if (
        inputPrefix.test(clause.slice(0, mention.index)) ||
        inputSuffix.test(clause.slice(mention.index + mention[0].length))
      )
        continue;
      while (verbIndex + 1 < verbs.length && verbs[verbIndex + 1]!.index < mention.index)
        verbIndex++;
      const directive = verbs[verbIndex];
      if (
        directive &&
        !interveningOperation.test(
          clause.slice(directive.index + directive[0].length, mention.index),
        )
      )
        formats.add(mention[0].toLowerCase() === 'csv' ? 'csv' : 'markdown');
    }
  }
  return [...formats].sort();
}
