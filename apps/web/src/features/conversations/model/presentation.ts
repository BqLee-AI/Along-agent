import type { ConversationRunHistoryItem, RunView } from '@along/contracts';
import type { HistoryApprovalReference } from './conversation-run';

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
  return effectsUnknown || run?.status === 'suspended_approval' || Boolean(run?.can_resume);
}
export function otherBlockingRuns(
  runs: readonly ConversationRunHistoryItem[],
  selected: ConversationSelection | null,
): ConversationRunHistoryItem[] {
  return runs.filter(
    (run) =>
      run.run_id !== selected?.runId &&
      (run.status === 'suspended_approval' || run.status === 'running'),
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

export interface ConversationContextProjection {
  selected: ConversationSelection | null;
  status: RunView['status'] | null;
  workspace: RunView['workspace'] | null;
  waiting: boolean;
  effectsUnknown: boolean;
  streaming: boolean;
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
