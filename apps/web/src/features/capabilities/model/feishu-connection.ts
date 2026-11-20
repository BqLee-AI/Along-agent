import { z } from 'zod';
import { MeSchema } from '@/shared/session/identity';

const base = '/api/v1/office/feishu/bot';
const status = z.object({
  data: z.discriminatedUnion('state', [
    z.object({ state: z.literal('idle') }),
    z.object({ state: z.literal('preparing') }),
    z.object({ state: z.literal('failed') }),
    z.object({ state: z.literal('other_session') }),
    z.object({
      state: z.literal('waiting'),
      scan: z.object({
        url: z.string().refine((value) => {
          const target = URL.parse(value);
          return (
            target?.origin === 'https://open.feishu.cn' &&
            target.pathname === '/page/launcher' &&
            !target.username &&
            !target.password
          );
        }),
        qr: z.string().regex(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/),
      }),
    }),
    z.object({ state: z.literal('connected'), name: z.string() }),
  ]),
});

export type FeishuBotStatus = z.infer<typeof status>['data'];
export type FeishuBotAction = 'scan' | 'cancel' | 'disconnect';

async function readStatus(response: Response, message: string): Promise<FeishuBotStatus> {
  if (!response.ok) throw new Error(message);
  return status.parse(await response.json()).data;
}

export async function readFeishuBotStatus(signal: AbortSignal) {
  return readStatus(
    await fetch(base, { signal, cache: 'no-store' }),
    '无法查看机器人连接，请重试。',
  );
}

export async function changeFeishuBotConnection(action: FeishuBotAction) {
  const me = await fetch('/api/v1/me');
  if (!me.ok) throw new Error('请先登录 Along。');
  const { data: actor } = z.object({ data: MeSchema }).parse(await me.json());
  if (!actor.csrf_token) throw new Error('请先登录 Along。');
  return readStatus(
    await fetch(`${base}/${action}`, {
      method: 'POST',
      headers: { 'x-csrf-token': actor.csrf_token },
    }),
    '操作失败，请重试。',
  );
}
