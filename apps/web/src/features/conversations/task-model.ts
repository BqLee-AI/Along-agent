import type { ExecutionKind, WorkspaceSummary } from '@along/contracts';

export type TaskIntent = 'reminder' | 'document';

export function taskIntentFromQuery(query: {
  intent?: string | string[];
  conversation_id?: string | string[];
  run_id?: string | string[];
}): TaskIntent | null {
  if (query.conversation_id !== undefined || query.run_id !== undefined) return null;
  return query.intent === 'reminder' || query.intent === 'document' ? query.intent : null;
}

export function taskExecution(intent: TaskIntent): ExecutionKind {
  return intent === 'document' ? 'harness' : 'business';
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
  if (!intent) return { allowed: false, reason: '先选择创建提醒或处理资料。' };
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
