import { EnvelopeSchema } from '@along/contracts';
import { MeSchema } from '@/shared/session/identity';
import type { Me } from '@/shared/session/identity';
import type { AccountRequest } from './account-actions';
import { createBrowserApi } from '@/shared/http/eden';

export type AccountLinkPurpose = 'invitation' | 'reset' | 'contact';
export type LinkSession = { status: number; actor: Me | null };

/** GET only. Opening or previewing an email link never consumes its token. */
export async function readLinkSession(request: AccountRequest = fetch): Promise<LinkSession> {
  const result = await createBrowserApi(request).api.v1.me.get();
  const { response } = result;
  const payload = EnvelopeSchema.safeParse(result.error ? result.error.value : result.data);
  const actor =
    response.ok && payload.success && payload.data.code === 0
      ? MeSchema.safeParse(payload.data.data)
      : null;
  return { status: response.status, actor: actor?.success ? actor.data : null };
}
