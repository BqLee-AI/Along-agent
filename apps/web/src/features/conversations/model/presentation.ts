import type { ConversationRunHistoryItem, MessageHistoryItem, RunView } from '@along/contracts';
import type { HistoryApprovalReference, RunTranscript } from './conversation-run';

export interface ConversationSelection {
  conversationId: string;
  runId: string;
}
export interface RunHistoryEntry {
  runId: string;
  history?: ConversationRunHistoryItem;
}
export function conversationRunEntries(
  runs: readonly ConversationRunHistoryItem[],
  selected: ConversationSelection | null,
): RunHistoryEntry[] {
  const entries: RunHistoryEntry[] = runs.map((history) => ({ runId: history.run_id, history }));
  if (selected && !entries.some((entry) => entry.runId === selected.runId))
    entries.push({ runId: selected.runId });
  return entries;
}
export function conversationNeedsAction(run: RunView | null, effectsUnknown: boolean): boolean {
  return (
    effectsUnknown ||
    run?.status === 'suspended_approval' ||
    run?.status === 'paused' ||
    Boolean(run?.can_resume)
  );
}
export function otherBlockingRuns(
  runs: readonly ConversationRunHistoryItem[],
  selected: ConversationSelection | null,
): ConversationRunHistoryItem[] {
  return runs.filter(
    (run) =>
      run.run_id !== selected?.runId &&
      (run.status === 'suspended_approval' || run.status === 'running' || run.status === 'paused'),
  );
}
export function runApprovalReferences(
  references: readonly HistoryApprovalReference[] | undefined,
  waiting: RunView['waiting'] | null | undefined,
): HistoryApprovalReference[] {
  const approvals = [...(references ?? [])];
  if (waiting) {
    const kind =
      'approval_kind' in waiting && waiting.approval_kind === 'document' ? 'document' : 'task';
    if (!approvals.some((item) => item.kind === kind && item.approvalId === waiting.approval_id))
      approvals.push({ kind, approvalId: waiting.approval_id, seq: 0 });
  }
  return approvals;
}

/** Older public replies have no source ID. Only use a unique persisted answer match. */
export function archivedReplyRuns(
  messages: readonly MessageHistoryItem[],
  transcripts: ReadonlyMap<string, RunTranscript>,
): ReadonlyMap<string, string> {
  const byAnswer = new Map<string, string | null>();
  for (const [runId, transcript] of transcripts) {
    const answer = transcript.goal_result?.answer ?? transcript.text;
    if (answer) byAnswer.set(answer, byAnswer.has(answer) ? null : runId);
  }
  const counts = new Map<string, number>();
  for (const message of messages) {
    if (message.role === 'assistant')
      counts.set(message.content, (counts.get(message.content) ?? 0) + 1);
  }
  const result = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    const runId =
      message.source_run_id ??
      (counts.get(message.content) === 1 ? byAnswer.get(message.content) : undefined);
    if (runId) result.set(message.message_id, runId);
  }
  return result;
}

export function composerBlockedReason(input: {
  effectsUnknown: boolean;
  reading: boolean;
  run: RunView | null;
  runs: readonly ConversationRunHistoryItem[];
  ambiguous: boolean;
  active: boolean;
  eligibilityReason: string | null;
}): string | null {
  if (input.effectsUnknown) return '原操作效果未知，不能重新发送；请只读核对。';
  if (input.reading) return '正在读取会话…';
  if (input.run?.status === 'paused' || input.runs.some((run) => run.status === 'paused'))
    return '原运行已暂停，请明确继续或停止。';
  if (
    input.run?.status === 'suspended_approval' ||
    input.runs.some((run) => run.status === 'suspended_approval')
  )
    return '请先审阅并明确继续原运行，不能另发消息绕过等待点。';
  if (input.run?.status === 'running' || input.runs.some((run) => run.status === 'running'))
    return '原运行仍在处理。';
  if (input.ambiguous) return '请选择一次时刻，再明确提交。';
  return input.active ? input.eligibilityReason : null;
}
