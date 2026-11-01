import { HarnessToolResultSchema } from '@along/contracts';
import type { RoutingIntent } from '@along/contracts';
import { isGregorianDate } from './facts.js';

// Treat every original result string as data, including Markdown/HTML instructions.
// No content is summarized or shortened by this projection.
function dataText(text: string): string {
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(text))
    throw new Error('ROUTING_RESULT_INVALID_UNICODE');
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/([\\`*_{}\[\]()#+!|~])/g, '\\$1')
    .replace(/(^|\n)([ \t]*)-(?=\s)/g, '$1$2\\-')
    .replace(/(^|\n)([ \t]*\d+)\.(?=\s)/g, '$1$2\\.');
}
export function renderRoutingResult(intent: RoutingIntent, accepted: unknown): string {
  const parsed = HarnessToolResultSchema.parse(accepted);
  if (parsed.status !== 'ok') throw new Error('ROUTING_RESULT_NOT_SUCCESSFUL');
  const result = parsed.result;
  let text: string;
  if (intent === 'task_list_bounded' && result.kind === 'list_tasks') {
    if (
      result.tasks.length > 50 ||
      result.tasks.some(
        (task) =>
          !['saved', 'pending_schedule', 'scheduled', 'cancel_pending'].includes(task.state),
      )
    )
      throw new Error('ROUTING_RESULT_SCOPE');
    const lines = [
      `本次有限查询返回${result.tasks.length}条活动提醒（合同上限50条；标题仅为原预览）。`,
      `has_more: ${result.has_more ? 'true' : 'false'}`,
    ];
    if (result.has_more) lines.push('仍有更多记录；此处不是全部提醒。');
    if (!result.tasks.length) lines.push('本次有限查询未返回记录，不表示从未存在。');
    for (const task of result.tasks)
      lines.push(
        `\n- 标题预览：${dataText(task.note_preview)}\n  状态：${dataText(task.state)}\n  冻结本地时间：${dataText(task.fire_at_local_text)}\n  时区：${dataText(task.timezone_id)}\n  记录：${dataText(task.task_id)}`,
      );
    lines.push(
      '\nscheduled 仅表示已记录的安排状态，不保证必达或已经收到；cancel_pending 不表示已取消。时间按原记录展示，未换算。',
    );
    text = lines.join('\n');
  } else if (intent === 'prefs_timezone_read' && result.kind === 'prefs') {
    text =
      result.timezone_id === null
        ? '本人系统记录的时区：未设置（timezone_id: null）。本次仅为读取，未修改偏好。'
        : `本人系统记录的时区：${dataText(result.timezone_id)}。本次仅为读取，未修改偏好，也不推断当前位置。`;
  } else if (intent === 'brief_cards_read' && result.kind === 'brief') {
    if (!isGregorianDate(result.date) || result.cards.length > 50)
      throw new Error('ROUTING_RESULT_SCOPE');
    const lines = [
      `原日期：${dataText(result.date)}`,
      `本次返回${result.cards.length}张已有简报卡片；接口最多50张，不证明查全；未重新生成或分析。`,
      `简报记录：${dataText(result.brief_id)}`,
    ];
    if (!result.cards.length) lines.push('本次有限查询未返回卡片，不表示从未存在。');
    for (const card of result.cards)
      lines.push(
        `\n### ${dataText(card.title)}\n类型：${dataText(card.kind)}\n${dataText(card.body_text)}\n来源：${card.source_refs.length ? card.source_refs.map(dataText).join('；') : '原记录未提供来源'}\n卡片记录：${dataText(card.card_id)}\n展示版本：${dataText(card.presentation_version)}`,
      );
    text = lines.join('\n');
  } else throw new Error('ROUTING_RESULT_INTENT_MISMATCH');
  if (Buffer.byteLength(text, 'utf8') > 1024 * 1024) throw new Error('ROUTING_RENDER_CAPACITY');
  return text;
}
