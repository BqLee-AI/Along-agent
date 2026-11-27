import { z } from 'zod';
import { readEnvelope } from '@/shared/http/client';
import { api } from '@/shared/http/eden';
import { MeSchema } from '@/shared/session/identity';

const wechat = '/api/v1/channels/wechat';
const news = '/api/v1/news';
const uuid = z.string().uuid();
const binding = z.object({ binding_id: uuid.nullable() });
const pair = z.object({
  pair_id: uuid,
  qr_data_url: z.string().regex(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/),
});
const poll = z.discriminatedUnion('status', [
  z.object({ status: z.literal('bound'), binding_id: uuid.optional() }),
  z.object({ status: z.enum(['waiting', 'scanned', 'pin_required', 'expired']) }),
]);
const test = z.object({ status: z.enum(['accepted', 'failed', 'unknown']) });
const preferences = z.object({
  topics: z.array(z.string().min(1).max(80)).max(12),
  region: z.string().min(1).max(80).nullable(),
  enabled: z.boolean(),
  binding_id: uuid.nullable(),
});
const subscription = preferences.extend({ timezone_id: z.string().nullable() });
const edition = z.object({
  id: uuid,
  local_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  coverage: z.enum(['complete', 'partial', 'failed']),
  delivery: z.enum(['pending', 'sending', 'accepted', 'failed', 'unknown', 'skipped']),
});
const editions = z.object({ items: z.array(edition) });
const detail = edition.extend({
  items: z.array(z.object({
    section: z.enum(['topic', 'local']),
    summary: z.string(),
    sources: z.array(z.object({ name: z.string(), url: z.string().url().regex(/^https?:\/\//i) })),
  })),
});

export type NewsPreferences = z.infer<typeof preferences>;
export type Subscription = z.infer<typeof subscription>;
export type Edition = z.infer<typeof edition>;
export type EditionDetail = z.infer<typeof detail>;
export type WechatPair = z.infer<typeof pair>;
export type WechatPoll = z.infer<typeof poll>;
export type WechatTestStatus = z.infer<typeof test>['status'];

async function read<T>(path: string, schema: z.ZodType<T>, signal: AbortSignal) {
  return schema.parse(await readEnvelope(await fetch(path, { signal, cache: 'no-store' })));
}

async function write<T>(
  path: string,
  schema: z.ZodType<T>,
  method: 'POST' | 'PUT' | 'DELETE',
  csrf: string,
  signal: AbortSignal,
  body?: object,
) {
  return schema.parse(await readEnvelope(await fetch(path, {
    method,
    signal,
    cache: 'no-store',
    headers: { 'x-csrf-token': csrf, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })));
}

export async function readNewsCsrf(signal: AbortSignal) {
  const me = MeSchema.parse(await readEnvelope(await api.api.v1.me.get({ fetch: { signal } })));
  if (!me.csrf_token) throw new Error('请重新登录 Along。');
  return me.csrf_token;
}

export const readWechat = (signal: AbortSignal) => read(wechat, binding, signal);
export const pairWechat = (csrf: string, signal: AbortSignal) =>
  write(`${wechat}/pair`, pair, 'POST', csrf, signal);
export const pollWechat = (pairId: string, csrf: string, signal: AbortSignal, pin?: string) =>
  write(`${wechat}/poll`, poll, 'POST', csrf, signal, { pair_id: pairId, pin });
export const testWechat = (csrf: string, signal: AbortSignal) =>
  write(`${wechat}/test`, test, 'POST', csrf, signal);
export const unbindWechat = (csrf: string, signal: AbortSignal) =>
  write(wechat, binding, 'DELETE', csrf, signal);
export const readSubscription = (signal: AbortSignal) => read(`${news}/subscription`, subscription, signal);
export const writeSubscription = (body: NewsPreferences, csrf: string, signal: AbortSignal) =>
  write(`${news}/subscription`, subscription, 'PUT', csrf, signal, body);
export const readEditions = (signal: AbortSignal) => read(`${news}/editions`, editions, signal);
export const readEdition = (id: string, signal: AbortSignal) =>
  read(`${news}/editions/${uuid.parse(id)}`, detail, signal);

export function parseNewsTopics(text: string) {
  return preferences.shape.topics.safeParse(text.split(/[\n,，、]/).map((term) => term.trim()).filter(Boolean));
}
