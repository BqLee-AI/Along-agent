import { randomBytes, randomUUID } from 'node:crypto';
import QRCode from 'qrcode';
import { z } from 'zod';
import { notReady } from '../../platform/errors.js';
import { credentialKey, decryptCredential, encryptCredential } from '../model-providers/public.js';

const origin = 'https://ilinkai.weixin.qq.com';
const channelVersion = '3.0.0';
const appHeaders = { 'iLink-App-Id': 'bot', 'iLink-App-ClientVersion': '196608' };
export const WECHAT_POLL_TIMEOUT_MS = 35_000;
const requestTimeoutMs = 15_000;
const pairingSchema = z.object({
  qrcode: z.string().min(1).max(4096),
  origin: z.string(),
  status: z.enum(['waiting', 'scanned', 'pin_required']),
});
const credentialSchema = z.object({
  origin: z.string(),
  token: z.string().regex(/^[\x21-\x7e]+$/),
  botId: z.string().min(1),
  recipient: z.string().min(1),
});
const qrResponseSchema = z.object({
  qrcode: pairingSchema.shape.qrcode,
  qrcode_img_content: z.string().min(1).max(2048),
});
const pollResponseSchema = z.object({
  status: z.string(),
  redirect_host: z.string().optional(),
  baseurl: z.string().optional(),
  bot_token: z.string().optional(),
  ilink_bot_id: z.string().optional(),
  ilink_user_id: z.string().optional(),
});
const receiptSchema = z.object({
  ret: z.number().int().optional(),
  errcode: z.number().int().optional(),
});

export type WechatPairing = z.infer<typeof pairingSchema>;
type Credential = z.infer<typeof credentialSchema>;
export type WechatPoll =
  | { status: WechatPairing['status']; pairing: WechatPairing }
  | { status: 'expired' }
  | { status: 'bound'; credential: Credential };
export type WechatSendResult = { status: 'accepted' | 'failed' | 'unknown' };

// Provider-supplied hosts must stay within Tencent's WeChat API domain.
function trustedOrigin(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.port ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    !/^(?:[a-z0-9-]+\.)+weixin\.qq\.com$/.test(url.hostname)
  )
    throw new Error('Invalid WeChat API origin');
  return url.origin;
}

function post(body: unknown, token?: string): RequestInit {
  return {
    method: 'POST',
    headers: {
      ...appHeaders,
      'Content-Type': 'application/json',
      AuthorizationType: 'ilink_bot_token',
      'X-WECHAT-UIN': Buffer.from(String(randomBytes(4).readUInt32BE())).toString('base64'),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
    redirect: 'error',
    signal: AbortSignal.timeout(requestTimeoutMs),
  };
}

type FetchWechat = (input: string | URL, init?: RequestInit) => Promise<Response>;

export function createWechatProvider(fetcher: FetchWechat = (input, init) => fetch(input, init)) {
  return {
    async begin() {
      try {
        const response = await fetcher(
          `${origin}/ilink/bot/get_bot_qrcode?bot_type=3`,
          post({ local_token_list: [] }),
        );
        if (!response.ok) throw new Error('WeChat QR request failed');
        const data = qrResponseSchema.parse(await response.json());
        return {
          pairing: { qrcode: data.qrcode, origin, status: 'waiting' } satisfies WechatPairing,
          qrDataUrl: await QRCode.toDataURL(data.qrcode_img_content, { width: 256 }),
        };
      } catch {
        throw notReady('WeChat pairing unavailable');
      }
    },

    async poll(pairing: WechatPairing, pin?: string): Promise<WechatPoll> {
      const unchanged = { status: pairing.status, pairing };
      try {
        const url = new URL('/ilink/bot/get_qrcode_status', trustedOrigin(pairing.origin));
        url.searchParams.set('qrcode', pairing.qrcode);
        if (pin !== undefined) url.searchParams.set('verify_code', pin);
        const response = await fetcher(url, {
          headers: appHeaders,
          redirect: 'error',
          signal: AbortSignal.timeout(WECHAT_POLL_TIMEOUT_MS),
        });
        if (!response.ok) return unchanged;
        const data = pollResponseSchema.parse(await response.json());
        if (data.status.includes('need_verifycode')) {
          return { status: 'pin_required', pairing: { ...pairing, status: 'pin_required' } };
        }
        switch (data.status) {
          case 'scaned':
            return { status: 'scanned', pairing: { ...pairing, status: 'scanned' } };
          case 'scaned_but_redirect': {
            const nextOrigin = data.redirect_host
              ? trustedOrigin(`https://${data.redirect_host}`)
              : pairing.origin;
            return {
              status: 'scanned',
              pairing: { ...pairing, origin: nextOrigin, status: 'scanned' },
            };
          }
          case 'expired':
          case 'verify_code_blocked':
          case 'binded_redirect':
            return { status: 'expired' };
          case 'confirmed': {
            const credential = credentialSchema.safeParse({
              origin: data.baseurl ? trustedOrigin(data.baseurl) : pairing.origin,
              token: data.bot_token,
              botId: data.ilink_bot_id,
              recipient: data.ilink_user_id,
            });
            return credential.success
              ? { status: 'bound', credential: credential.data }
              : { status: 'expired' };
          }
          default:
            return unchanged;
        }
      } catch {
        return unchanged;
      }
    },

    async send(
      ciphertext: string,
      owner: string,
      id: string,
      recipient: string,
      text: string,
    ): Promise<WechatSendResult> {
      let url: URL;
      let init: RequestInit;
      try {
        const credential = credentialSchema.parse(open('binding', owner, id, ciphertext));
        if (credential.recipient !== recipient) return { status: 'failed' };
        url = new URL('/ilink/bot/sendmessage', trustedOrigin(credential.origin));
        init = post(
          {
            msg: {
              from_user_id: '',
              to_user_id: recipient,
              client_id: `along-${randomUUID()}`,
              message_type: 2,
              message_state: 2,
              item_list: [{ type: 1, text_item: { text } }],
            },
            base_info: { channel_version: channelVersion, bot_agent: 'Along/1.0.0' },
          },
          credential.token,
        );
      } catch {
        return { status: 'failed' };
      }
      try {
        const response = await fetcher(url, init);
        if (response.status === 408 || response.status >= 500) return { status: 'unknown' };
        if (response.status >= 400) return { status: 'failed' };
        if (!response.ok) return { status: 'unknown' };
        const receipt = receiptSchema.safeParse(await response.json());
        if (!receipt.success) return { status: 'unknown' };
        const { ret, errcode } = receipt.data;
        if ((ret !== undefined && ret !== 0) || (errcode !== undefined && errcode !== 0)) {
          return { status: 'failed' };
        }
        return { status: ret === 0 ? 'accepted' : 'unknown' };
      } catch {
        return { status: 'unknown' };
      }
    },
  };
}

function open(kind: 'binding' | 'pairing', owner: string, id: string, ciphertext: string): unknown {
  return JSON.parse(decryptCredential(credentialKey(), owner, `wechat:${kind}:${id}`, ciphertext));
}

function seal(kind: 'binding' | 'pairing', owner: string, id: string, data: object): string {
  return encryptCredential(credentialKey(), owner, `wechat:${kind}:${id}`, JSON.stringify(data));
}

export function sealWechatBinding(owner: string, id: string, credential: Credential): string {
  return seal('binding', owner, id, credential);
}

export function sealWechatPairing(owner: string, id: string, pairing: WechatPairing): string {
  return seal('pairing', owner, id, pairing);
}

export function openWechatPairing(owner: string, id: string, ciphertext: string): WechatPairing {
  return pairingSchema.parse(open('pairing', owner, id, ciphertext));
}

// Callers must acquire a send permit for the current owner and binding before calling.
export const sendWechat = createWechatProvider((input, init) => fetch(input, init)).send;
