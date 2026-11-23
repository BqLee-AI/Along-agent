import { z } from 'zod';
import { readEnvelope } from '@/shared/http/client';
import { writeOptions } from '@/shared/http/eden';
import { MeSchema } from '@/shared/session/identity';

const base = '/api/v1/connections/microsoft-learn';
const status = z.object({ state: z.enum(['idle', 'connected']) }).strict();

export type MicrosoftLearnStatus = z.infer<typeof status>;
export type MicrosoftLearnAction = 'connect' | 'disconnect';

export async function readMicrosoftLearnStatus(signal: AbortSignal): Promise<MicrosoftLearnStatus> {
  return status.parse(await readEnvelope(await fetch(base, { signal, cache: 'no-store' })));
}

export async function changeMicrosoftLearnConnection(
  action: MicrosoftLearnAction,
  signal: AbortSignal,
): Promise<MicrosoftLearnStatus> {
  const me = MeSchema.parse(
    await readEnvelope(await fetch('/api/v1/me', { signal, cache: 'no-store' })),
  );
  if (!me.csrf_token) throw new Error('当前会话没有 CSRF 凭据，请重新登录。');
  signal.throwIfAborted();
  const options = writeOptions(me.csrf_token, signal);
  const response = await fetch(`${base}/${action}`, {
    ...options.fetch,
    method: 'POST',
    headers: { ...options.headers, 'content-type': 'application/json' },
    body: '{}',
    redirect: 'error',
  });
  return status.parse(await readEnvelope(response));
}
