import 'server-only';

import { AccountViewSchema, authStatusSchema, workspaceSummarySchema } from '@along/contracts';
import type { AccountView as AccountProfile, AuthStatus } from '@along/contracts';
import { z } from 'zod';
import { apiGet } from '@/shared/http/server';
import type { ApiResult } from '@/shared/http/result';
import { MeSchema } from '@/shared/session/identity';
import type { Me } from '@/shared/session/identity';
import type { AccountRead } from './account';

function checked<T>(
  result: ApiResult<unknown>,
  parse: (value: unknown) => { success: false } | { success: true; data: T },
): AccountRead<T> {
  if (!result.ok) return { ok: false, failure: result };
  const parsed = parse(result.data);
  return parsed.success
    ? { ok: true, data: parsed.data }
    : { ok: false, failure: { status: 200, code: null, requestId: null } };
}

export async function readAccountStatus(): Promise<AccountRead<AuthStatus>> {
  return checked(await apiGet((api) => api.api.v1.auth.status.get()), (value) =>
    authStatusSchema.safeParse(value),
  );
}

export async function readAccountIdentity(): Promise<AccountRead<Me>> {
  return checked(await apiGet((api) => api.api.v1.me.get()), (value) => MeSchema.safeParse(value));
}

/** Owner-scoped account read; a 401 here is a protected-page boundary and redirects to login. */
export async function readAccountProfile(): Promise<AccountRead<AccountProfile>> {
  return checked(await apiGet((api) => api.api.v1.auth.account.get(), '/account'), (value) =>
    AccountViewSchema.safeParse(value),
  );
}

const workspaceListSchema = z.object({ items: z.array(workspaceSummarySchema) }).strict();

export async function readAccountWorkspaces() {
  return checked(await apiGet((api) => api.api.v1.workspaces.get()), (value) =>
    workspaceListSchema.safeParse(value),
  );
}
