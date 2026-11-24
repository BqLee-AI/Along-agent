import 'server-only';

import { safeReturnTo } from '@/shared/session/navigation';
import type { AccountView as AccountProfile } from '@along/contracts';
import type { AccountScreenState, AccountView } from '../model/account';
import {
  readAccountIdentity,
  readAccountProfile,
  readAccountStatus,
  readAccountWorkspaces,
} from '../model/account-query';

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
  const [profile, registration] = await Promise.all([
    mode === 'account' && canSignOut ? readAccountProfile() : null,
    mode === 'account' ? readAccountWorkspaces() : null,
  ]);
  if (profile && !profile.ok) return { ...base, mode: 'account-error', failure: profile.failure };
  const account: AccountProfile | null = profile?.data ?? null;
  const unavailable = account
    ? account.workspace.state === 'unavailable'
    : status.workspace_state === 'invalid' || status.workspace_state === 'unreadable';
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
    workspaces: registration?.ok && !unavailable ? registration.data.items : null,
  };
}
