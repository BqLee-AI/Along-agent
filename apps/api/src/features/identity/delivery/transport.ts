import { notReady } from '../../../platform/errors.js';
import { normalizeContactEmail } from '../security/email-security.js';
export interface IdentityMailMessage {
  deliveryId: string;
  to: string;
  subject: string;
  text: string;
}
export type IdentityMailResult =
  | { status: 'submitted'; acceptanceId?: string }
  | { status: 'failed'; failureCode: 'provider_rejected' }
  | { status: 'unknown'; failureCode: 'transport_unknown' | 'provider_unknown' };
export type IdentityMailSender = (
  message: IdentityMailMessage,
  signal: AbortSignal,
) => Promise<IdentityMailResult>;
export interface IdentityMailConfig {
  origin: string;
  from: string;
  send: IdentityMailSender;
  timeoutMs?: number;
}
export const SAFE_PROVIDER_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** Explicit endpoint injection is solely for isolated protocol simulators; env configuration uses Resend HTTPS only. */
export function createResendIdentitySender(options: {
  apiKey: string;
  from: string;
  endpoint?: string;
}): IdentityMailSender {
  const endpoint = new URL(options.endpoint ?? 'https://api.resend.com/emails');
  if (
    endpoint.protocol !== 'https:' &&
    !(
      endpoint.protocol === 'http:' &&
      ['127.0.0.1', '[::1]', 'localhost'].includes(endpoint.hostname)
    )
  )
    throw notReady('identity mail endpoint unavailable');
  if (endpoint.username || endpoint.password || endpoint.hash)
    throw notReady('identity mail endpoint unavailable');
  return async (message, signal) => {
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        redirect: 'error',
        signal,
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': message.deliveryId,
        },
        body: JSON.stringify({
          from: options.from,
          to: [message.to],
          subject: message.subject,
          text: message.text,
        }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        return response.status >= 400 && response.status < 500 && response.status !== 408
          ? { status: 'failed', failureCode: 'provider_rejected' }
          : { status: 'unknown', failureCode: 'provider_unknown' };
      }
      const reader = response.body?.getReader();
      if (!reader) return { status: 'unknown', failureCode: 'provider_unknown' };
      let size = 0;
      const chunks: Uint8Array[] = [];
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        size += item.value.length;
        if (size > 16384) {
          await reader.cancel();
          return { status: 'unknown', failureCode: 'provider_unknown' };
        }
        chunks.push(item.value);
      }
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const acceptanceId = body && typeof body === 'object' && 'id' in body ? body.id : undefined;
      if (typeof acceptanceId !== 'string' || !SAFE_PROVIDER_ID.test(acceptanceId))
        return { status: 'unknown', failureCode: 'provider_unknown' };
      return { status: 'submitted', acceptanceId };
    } catch {
      return { status: 'unknown', failureCode: 'transport_unknown' };
    }
  };
}
export function loadIdentityMailConfig(): IdentityMailConfig {
  try {
    const {
      APP_ORIGIN: origin,
      IDENTITY_MAIL_PROVIDER: provider,
      IDENTITY_MAIL_FROM: from,
      IDENTITY_MAIL_API_KEY: apiKey,
    } = process.env;
    if (
      !origin ||
      provider !== 'resend' ||
      !from ||
      !apiKey ||
      apiKey.length > 4096 ||
      /[\r\n]/.test(apiKey)
    )
      throw new Error('missing configuration');
    const config: IdentityMailConfig = {
      origin,
      from,
      send: createResendIdentitySender({ apiKey, from }),
      timeoutMs: 10000,
    };
    return requireIdentityMailReady({ mail: config });
  } catch {
    throw notReady('identity mail configuration unavailable');
  }
}
export function requireIdentityMailReady(
  options: { mail?: IdentityMailConfig } = {},
): IdentityMailConfig {
  const mail = options.mail ?? loadIdentityMailConfig();
  try {
    const origin = new URL(mail.origin);
    if (
      origin.origin !== mail.origin ||
      origin.username ||
      origin.password ||
      (origin.protocol !== 'https:' &&
        !(
          origin.protocol === 'http:' &&
          ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)
        ))
    )
      throw new Error('invalid origin');
    normalizeContactEmail(mail.from);
    if (
      typeof mail.send !== 'function' ||
      (mail.timeoutMs !== undefined &&
        (!Number.isInteger(mail.timeoutMs) || mail.timeoutMs < 1 || mail.timeoutMs > 30000))
    )
      throw new Error('invalid transport');
    return mail;
  } catch {
    throw notReady('identity mail configuration unavailable');
  }
}
