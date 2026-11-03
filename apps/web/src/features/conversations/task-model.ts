import type {
  ConversationRunHistoryItem,
  ExecutionKind,
  RunView,
  WorkspaceSummary,
} from '@along/contracts';

export type TaskIntent = 'chat' | 'reminder' | 'document';

export function taskIntentFromQuery(query: {
  intent?: string | string[];
  conversation_id?: string | string[];
  run_id?: string | string[];
}): TaskIntent | null {
  if (query.conversation_id !== undefined || query.run_id !== undefined) return null;
  return query.intent === 'reminder' || query.intent === 'document' ? query.intent : 'chat';
}

export function taskAdmission(intent: TaskIntent): {
  execution: ExecutionKind;
  authorization_revision?: 'delegation/1';
} {
  return intent === 'chat'
    ? { execution: 'harness', authorization_revision: 'delegation/1' }
    : { execution: intent === 'reminder' ? 'business' : 'harness' };
}

export function taskSendEligibility({
  intent,
  text,
  busy,
  workspaceState,
  workspaceId,
  workspaces,
}: {
  intent: TaskIntent | null;
  text: string;
  busy: boolean;
  workspaceState: 'loading' | 'ready' | 'error';
  workspaceId: string;
  workspaces: readonly WorkspaceSummary[];
}): { allowed: boolean; reason: string | null } {
  if (busy) return { allowed: false, reason: '当前操作尚未结束，请先核实原运行。' };
  if (!intent) return { allowed: false, reason: '正在恢复会话，请稍候。' };
  if (intent === 'document') {
    if (workspaceState !== 'ready')
      return { allowed: false, reason: '资料范围尚未成功读取，不能开始处理。' };
    if (!workspaces.length)
      return { allowed: false, reason: '没有可选登记，请按账户中的本机维护说明配置。' };
    if (!workspaces.some((workspace) => workspace.workspace_id === workspaceId))
      return { allowed: false, reason: '请显式选择读取成功的资料登记。' };
  }
  if (!text.trim()) return { allowed: false, reason: '请填写完整任务原话。' };
  return { allowed: true, reason: null };
}

export function conversationSendBlocked({
  busy,
  reading,
  readError,
  ready,
  selected,
  run,
  runs,
  sendUncertain,
  effectsUnknown,
}: {
  busy: boolean;
  reading: boolean;
  readError: string | null;
  ready: boolean;
  selected: boolean;
  run: RunView | null;
  runs: readonly ConversationRunHistoryItem[];
  sendUncertain: boolean;
  effectsUnknown: boolean;
}): boolean {
  return (
    busy ||
    reading ||
    Boolean(readError) ||
    !ready ||
    sendUncertain ||
    effectsUnknown ||
    (selected && !run) ||
    run?.status === 'running' ||
    run?.status === 'suspended_approval' ||
    runs.some((item) => item.status === 'running' || item.status === 'suspended_approval')
  );
}

// Only the persisted original-message reference can connect archive text to a Run.
// Assistant archives deliberately have no inferred Run association.
export function messageRunReference(
  message: { message_id: string; role: 'user' | 'assistant' },
  runs: readonly ConversationRunHistoryItem[],
): string | null {
  if (message.role !== 'user') return null;
  return (
    runs.find(
      (run) =>
        run.original.state === 'available' &&
        run.original.message.message_id === message.message_id,
    )?.run_id ?? null
  );
}

export function shouldSubmitMessage({
  key,
  shiftKey,
  isComposing,
  keyCode,
}: {
  key: string;
  shiftKey: boolean;
  isComposing: boolean;
  keyCode?: number;
}): boolean {
  // Safari may finish composition before its Enter keydown, retaining keyCode 229.
  return key === 'Enter' && !shiftKey && !isComposing && keyCode !== 229;
}

export function isNearChatBottom({
  scrollHeight,
  scrollTop,
  clientHeight,
}: {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}): boolean {
  return scrollHeight - scrollTop - clientHeight <= 96;
}
