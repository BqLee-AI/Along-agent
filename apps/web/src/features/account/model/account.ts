import type { AccountView as AccountProfile, AuthStatus, WorkspaceSummary } from '@along/contracts';
import type { Me } from '@/shared/session/identity';
import type { AccountFailure } from './account-operation';

export type AccountView = 'account' | 'login' | 'setup' | 'claim' | 'logout';
export type AccountReadFailure = Pick<AccountFailure, 'status' | 'code' | 'requestId'>;
export type AccountRead<T> = { ok: true; data: T } | { ok: false; failure: AccountReadFailure };
export type AccountScreenState = {
  view: AccountView;
  destination: string;
  retryHref: string;
} & (
  | { mode: 'status-error'; failure: AccountReadFailure }
  | { mode: 'setup' }
  | { mode: 'login'; destinationLabel: string }
  | { mode: 'identity-error'; status: AuthStatus; failure: AccountReadFailure }
  | { mode: 'account-error'; failure: AccountReadFailure }
  | {
      mode: 'logout' | 'legacy' | 'configured' | 'signed-out' | 'account';
      status: AuthStatus;
      actor: Me | null;
      /** Owner-scoped account read; present only for a verified signed session in account mode. */
      account: AccountProfile | null;
      canClaim: boolean;
      canSignOut: boolean;
      /** Null means the registration could not be read. */
      workspaces: readonly WorkspaceSummary[] | null;
    }
);
