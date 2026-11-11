import 'server-only';

import { safeReturnTo } from '@/shared/session/navigation';
import type { AccountView as AccountProfile } from '@along/contracts';
import type { AccountScreenState, AccountView } from '../model/account';
import { readAccountIdentity, readAccountProfile, readAccountStatus } from '../model/account-query';

const workspaceCopy = {
  loaded: {
    label: '已设置',
    message:
      '已登记可处理的资料位置。登记不代表文件一定存在，具体能用哪些资料，以发起任务时看到的范围为准。',
  },
  unconfigured: {
    label: '未设置',
    message: '还没有登记任何资料位置，账户和聊天记录不受影响。',
  },
  invalid: {
    label: '设置有误',
    message: '资料位置的设置有误，请联系部署者检查，账户和聊天记录不受影响。',
  },
  unreadable: {
    label: '读取失败',
    message: '读取资料位置失败，请联系部署者检查，账户和聊天记录不受影响。',
  },
  unknown: {
    label: '状态不明',
    message: '没能确认资料位置的状态，暂时不能认为资料已经可用。',
  },
} as const;

/** The signed-in account's own workspace count replaces the installation-level registry label. */
function accountWorkspaceCopy(account: AccountProfile) {
  const { state, count } = account.workspace;
  return state === 'none'
    ? { label: '未设置', message: '你还没有资料工作区，仍可使用完整的账户功能。' }
    : state === 'available'
      ? {
          label: `${count} 个可用`,
          message: `你有 ${count} 个可用的资料工作区。工作区状态不代表模型是否可用。`,
        }
      : { label: '暂不可用', message: '你的资料工作区暂时不可用，账户和聊天记录不受影响。' };
}

/** Owns the read sequence and eligibility projection; GETs never execute an account operation. */
export async function loadAccountScreen(
  view: AccountView,
  returnTo?: unknown,
): Promise<AccountScreenState> {
  const destination = safeReturnTo(returnTo);
  const base = {
    view,
    destination,
    retryHref:
      view === 'login' || view === 'setup'
        ? `/${view}?${new URLSearchParams({ returnTo: destination })}`
        : `/${view}`,
  };
  const statusResult = await readAccountStatus();
  if (!statusResult.ok) return { ...base, mode: 'status-error', failure: statusResult.failure };
  const status = statusResult.data;
  if (status.state === 'setup_required') return { ...base, mode: 'setup' };
  if (view === 'login' && status.state === 'ready') {
    const destinations: Record<string, string> = {
      conversations: '原对话页面',
      approvals: '原提醒确认页面',
      'document-approvals': '原文档批准页面',
      tasks: '原提醒任务页面',
      activity: '活动页面',
      account: '账户页面',
    };
    return {
      ...base,
      mode: 'login',
      destinationLabel: destinations[destination.split(/[/?#]/, 2)[1]] ?? '今日页面',
    };
  }
  const identityResult = await readAccountIdentity();
  if (!identityResult.ok && identityResult.failure.status !== 401) {
    return { ...base, mode: 'identity-error', status, failure: identityResult.failure };
  }
  const actor = identityResult.ok ? identityResult.data : null;
  const workspace = workspaceCopy[status.workspace_state ?? 'unknown'];
  const mode =
    view === 'logout'
      ? 'logout'
      : status.state === 'legacy_claim_required'
        ? 'legacy'
        : view === 'setup' || view === 'claim'
          ? 'configured'
          : !actor
            ? 'signed-out'
            : 'account';
  const canSignOut = actor !== null && actor.csrf_token !== null;
  let account: AccountProfile | null = null;
  if (mode === 'account' && canSignOut) {
    const profile = await readAccountProfile();
    if (!profile.ok) return { ...base, mode: 'account-error', failure: profile.failure };
    account = profile.data;
  }
  const ownWorkspace = account ? accountWorkspaceCopy(account) : null;
  return {
    ...base,
    mode,
    status,
    actor,
    account,
    canClaim:
      status.state === 'legacy_claim_required' &&
      status.can_claim === true &&
      actor !== null &&
      actor.csrf_token !== null,
    canSignOut,
    workspaceLabel: (ownWorkspace ?? workspace).label,
    workspaceMessage: (ownWorkspace ?? workspace).message,
  };
}
