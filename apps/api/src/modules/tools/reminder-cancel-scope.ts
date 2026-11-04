export type CancellationCandidate = { id: string; wall_time: string; timezone_id: string };

export function renderCancellationClarification(
  candidates: readonly CancellationCandidate[],
): string {
  const times = candidates
    .slice(0, 20)
    .map(
      (candidate, index) =>
        `${index + 1}. ${candidate.wall_time} ${candidate.timezone_id}（编号 ${candidate.id}）`,
    )
    .join('；');
  const instruction =
    candidates.length > 1
      ? '请指出序号、日期或时间，或说明要取消全部同名提醒。'
      : '请明确说取消第几条，或重新写出要取消的完整名称。';
  return `${candidates.length > 1 ? '有多条同名提醒' : '无法核验所选提醒'}，未取消。候选：${times || '无可取消候选'}${candidates.length > 20 ? '；还有其他候选，请继续查询' : ''}。${instruction}`;
}

// Only the exact numbered surface is useful as an ordinal source; each
// selected entry is compared again with the live owned task before writing.
export function readShownCancellationCandidates(answer: string): CancellationCandidate[] {
  const prefix = answer.startsWith('有多条同名提醒，未取消。候选：')
    ? '有多条同名提醒，未取消。候选：'
    : '无法核验所选提醒，未取消。候选：';
  const suffix = prefix.startsWith('有多条')
    ? '。请指出序号、日期或时间，或说明要取消全部同名提醒。'
    : '。请明确说取消第几条，或重新写出要取消的完整名称。';
  if (!answer.startsWith(prefix) || !answer.endsWith(suffix)) return [];
  const entries = answer.slice(prefix.length, -suffix.length).split('；');
  if (entries.at(-1) === '还有其他候选，请继续查询') entries.pop();
  if (entries.length < 1 || entries.length > 20) return [];
  const candidates: CancellationCandidate[] = [];
  for (const [index, entry] of entries.entries()) {
    const match =
      /^(\d+)\. (\d{4}-\d{2}-\d{2} \d{2}:\d{2}) ([^；（）]+)（编号 ([0-9a-f-]{36})）$/u.exec(entry);
    if (!match || Number(match[1]) !== index + 1) return [];
    candidates.push({ wall_time: match[2]!, timezone_id: match[3]!, id: match[4]! });
  }
  if (new Set(candidates.map((candidate) => candidate.id)).size !== candidates.length) return [];
  return candidates;
}

const dateAndTime = String.raw`(?:(\d{4})年)?(\d{1,2})月(\d{1,2})(?:日|号)?(?:(上午|下午|晚上|早上)?(\d{1,2})(?:[:：](\d{2})|点(?:(\d{1,2})分?|整)?))?(?:那条|这条|的)?(?:提醒|事项)?(?:时区([A-Za-z_+-]+(?:\/[A-Za-z_+-]+)+)|(上海时间))?(?:的提醒)?`;
const directDate = new RegExp(
  String.raw`^(?:请只|请|帮我|请帮我|麻烦)?(?:取消|删除|删掉)(?:名叫|名称为|名为)?\0(?:的)?(?:这条)?${dateAndTime}$`,
  'u',
);
const continuationDate = new RegExp(
  String.raw`^(?:请|帮我|请帮我|麻烦)?(?:取消|删除|删掉)?${dateAndTime}$`,
  'u',
);

function markNote(text: string, note: string): string | null {
  if (!note || note.includes('\0')) return null;
  const index = text.indexOf(note);
  if (index < 0 || text.indexOf(note, index + note.length) >= 0) return null;
  return (text.slice(0, index) + '\0' + text.slice(index + note.length)).replace(
    /[\s“”‘’"'。！!，,、]/gu,
    '',
  );
}

export function isUnspecifiedSameNoteCancellation(text: string, note: string): boolean {
  const marked = markNote(text, note);
  return (
    marked !== null &&
    /^(?:请|帮我|请帮我|麻烦)?(?:取消|删除|删掉)(?:提醒|事项)?(?:名叫|名称为|名为)?\0(?:的)?(?:这条|那条|一个)?(?:提醒|事项)?$/u.test(
      marked,
    )
  );
}

export function isBoundedCancellationForNote(text: string, note: string): boolean {
  const marked = markNote(text, note);
  return (
    isUnspecifiedSameNoteCancellation(text, note) || (marked !== null && directDate.test(marked))
  );
}

// Only complete, independently verifiable forms are accepted; a model's
// proposed task metadata is not evidence of the user's selection.
export function cancellationScopeIncludes(
  current: string,
  original: string | null,
  note: string | null,
  candidates: CancellationCandidate[],
  targetId: string,
  shownCandidates: readonly CancellationCandidate[] = [],
): boolean {
  if (!note) return false;
  const text = markNote(current, note);
  if (
    candidates.length === 1 &&
    candidates[0]!.id === targetId &&
    isUnspecifiedSameNoteCancellation(current, note)
  )
    return true;
  if (
    text &&
    /^(?:请|帮我|请帮我|麻烦)?(?:取消|删除|删掉)(?:(?:名叫|名称为|名为)?\0(?:的)?(?:所有|全部)(?:提醒|事项)|(?:所有|全部)(?:名叫|名称为|名为)?\0(?:的)?(?:提醒|事项))$/u.test(
      text,
    )
  )
    return true;
  const previousWasTargetRequest =
    original !== null && isUnspecifiedSameNoteCancellation(original, note);
  const ordinal = current
    .replace(/[\s。！!，,、]/gu, '')
    .match(
      /^(?:请|帮我|请帮我|麻烦)?(?:取消|删除|删掉)?第([一二两三四五六七八九十]|1\d|20|[1-9])条(?:提醒|事项)?$/u,
    );
  if (ordinal) {
    const chinese: Record<string, number> = {
      一: 1,
      二: 2,
      两: 2,
      三: 3,
      四: 4,
      五: 5,
      六: 6,
      七: 7,
      八: 8,
      九: 9,
      十: 10,
    };
    const position = chinese[ordinal[1]!] ?? Number(ordinal[1]);
    const shown = shownCandidates[position - 1];
    return (
      shown?.id === targetId &&
      original !== null &&
      cancellationScopeIncludes(original, null, note, [shown], targetId) &&
      candidates.some(
        (candidate) =>
          candidate.id === shown.id &&
          candidate.wall_time === shown.wall_time &&
          candidate.timezone_id === shown.timezone_id,
      )
    );
  }
  const normalizedCurrent = current.replace(/[\s“”‘’"'。！!，,、]/gu, '');
  if (
    previousWasTargetRequest &&
    /^(?:请|帮我|请帮我|麻烦)?(?:取消|删除|删掉)?(?:全部|所有)(?:提醒|事项)?$/u.test(
      normalizedCurrent,
    )
  )
    return true;
  const idSelection =
    text?.match(
      /^(?:请|帮我|请帮我|麻烦)?(?:取消|删除|删掉)(?:名叫|名称为|名为)?\0(?:的)?(?:编号|ID)([0-9a-f-]{36})(?:那条|这条|的)?(?:提醒|事项)?$/iu,
    ) ??
    (previousWasTargetRequest
      ? normalizedCurrent.match(
          /^(?:请|帮我|请帮我|麻烦)?(?:取消|删除|删掉)?(?:编号|ID)([0-9a-f-]{36})(?:那条|这条|的)?(?:提醒|事项)?$/iu,
        )
      : null);
  if (idSelection)
    return (
      idSelection[1]!.toLowerCase() === targetId.toLowerCase() &&
      candidates.some((candidate) => candidate.id === targetId)
    );
  const date =
    text?.match(directDate) ??
    (previousWasTargetRequest ? normalizedCurrent.match(continuationDate) : null);
  if (!date) return false;
  const [, year, month, day, daypart, hourText, colonMinute, pointMinute, timezone, shanghai] =
    date;
  let hour = hourText === undefined ? null : Number(hourText);
  const minute = Number(colonMinute ?? pointMinute ?? 0);
  if (hour !== null) {
    if (minute > 59 || hour > 23 || (daypart && (hour < 1 || hour > 11))) return false;
    if (daypart === '下午' || daypart === '晚上') hour += 12;
  }
  const matching = candidates.filter(({ wall_time, timezone_id }) => {
    const parts = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/u.exec(wall_time);
    return (
      parts &&
      (!year || parts[1] === year) &&
      Number(parts[2]) === Number(month) &&
      Number(parts[3]) === Number(day) &&
      (hour === null || (Number(parts[4]) === hour && Number(parts[5]) === minute)) &&
      (!timezone || timezone_id === timezone) &&
      (!shanghai || timezone_id === 'Asia/Shanghai')
    );
  });
  return matching.length === 1 && matching[0]!.id === targetId;
}

export function candidatesInCancellationRequest(
  original: string,
  note: string,
  candidates: CancellationCandidate[],
): CancellationCandidate[] {
  return candidates.filter((candidate) =>
    cancellationScopeIncludes(original, null, note, [candidate], candidate.id),
  );
}
