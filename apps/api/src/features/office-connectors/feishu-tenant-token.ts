import { z } from 'zod';

const tokenUrl = 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal';
const tokenResponse = z.object({
  code: z.literal(0),
  tenant_access_token: z.string().min(1),
  expire: z.number().int().positive().safe(),
});

/** Credentials must already be resolved for the qualified bot binding. */
export async function issueFeishuTenantToken(
  input: { appId: string; appSecret: string; signal: AbortSignal },
  request: (url: string, init: RequestInit) => Promise<Response> = fetch,
) {
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(8_000)]);
  try {
    signal.throwIfAborted();
    const response = await request(tokenUrl, {
      method: 'POST',
      redirect: 'error',
      signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ app_id: input.appId, app_secret: input.appSecret }),
    });
    if (!response.ok) return null;
    const parsed = tokenResponse.safeParse(await response.json());
    if (signal.aborted || !parsed.success) return null;
    return { token: parsed.data.tenant_access_token, expiresInSeconds: parsed.data.expire };
  } catch {
    // Network and parsing exceptions can contain raw provider data.
    return null;
  }
}
