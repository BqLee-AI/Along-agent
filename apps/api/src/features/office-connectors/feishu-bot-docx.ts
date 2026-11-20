import { readFeishuDocx } from './feishu-docx.js';
import { issueFeishuTenantToken } from './feishu-tenant-token.js';
import type { FeishuBotDocxConfiguration } from './feishu-bot-docx-config.js';

/** The gateway owns Run eligibility; do not hold database locks during this operation. */
export async function readFeishuBotDocx(
  input: {
    config: FeishuBotDocxConfiguration;
    url: string;
    signal: AbortSignal;
    authorized: () => Promise<boolean>;
  },
  request: (url: string, init: RequestInit) => Promise<Response> = fetch,
  env: NodeJS.ProcessEnv = process.env,
) {
  const { config, url, signal, authorized } = input;
  const denied = { status: 'error', reason: 'local_denied' } as const;
  if (!config.documents.includes(url) || signal.aborted || !(await authorized())) return denied;
  const appSecret = env[config.secretEnv];
  if (!appSecret) return { status: 'error', reason: 'bot_credential_unavailable' } as const;
  const credential = await issueFeishuTenantToken(
    { appId: config.appId, appSecret, signal },
    request,
  );
  if (!credential) return { status: 'error', reason: 'bot_credential_unavailable' } as const;
  if (signal.aborted || !(await authorized()) || signal.aborted) return denied;
  return readFeishuDocx({ documentUrl: url, tenantAccessToken: credential.token, signal }, request);
}
