import { Elysia } from 'elysia';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { HttpAccess } from '../../http/access.js';
import { okEnvelope } from '../../http/errors.js';
import { forbidden, notReady, validationError } from '../../platform/errors.js';
import { createWechatBindings } from './wechat-bindings.js';

const base = '/api/v1/channels/wechat';
const pollBody = z
  .object({
    pair_id: z
      .string()
      .uuid()
      .transform((id) => id.toLowerCase()),
    pin: z
      .string()
      .regex(/^\d{1,16}$/)
      .optional(),
  })
  .strict();

export function createWechatController(pool: Pool | null, access: HttpAccess) {
  const controller = new Elysia({ name: 'wechat-bindings', strictPath: true });
  const bindings = pool ? createWechatBindings(pool) : null;
  const origin = process.env.APP_ORIGIN ?? 'http://localhost:3000';

  async function admitted(request: Request, write = false) {
    const actor = await access.requireActor(request);
    if (!actor.sessionId) throw forbidden('Signed session required');
    if (write) {
      if (request.headers.get('origin') !== origin) throw forbidden('Origin mismatch');
      access.csrf(request, actor);
    }
    if (!bindings) throw notReady();
    return { owner: actor.ownerId, bindings };
  }

  return controller
    .get(base, async ({ request, set }) => {
      set.headers['cache-control'] = 'no-store';
      const { owner, bindings } = await admitted(request);
      return okEnvelope(await bindings.status(owner), access.requestId(request));
    })
    .post(
      `${base}/pair`,
      async ({ request, set }) => {
        set.headers['cache-control'] = 'no-store';
        const { owner, bindings } = await admitted(request, true);
        return okEnvelope(await bindings.begin(owner), access.requestId(request));
      },
      { parse: 'none' },
    )
    .post(
      `${base}/poll`,
      async ({ request, set }) => {
        set.headers['cache-control'] = 'no-store';
        const { owner, bindings } = await admitted(request, true);
        const body = pollBody.safeParse(await access.json(request));
        if (!body.success) throw validationError('Invalid WeChat pairing request');
        return okEnvelope(
          await bindings.poll(owner, body.data.pair_id, body.data.pin),
          access.requestId(request),
        );
      },
      { parse: 'none' },
    )
    .post(
      `${base}/test`,
      async ({ request, set }) => {
        set.headers['cache-control'] = 'no-store';
        const { owner, bindings } = await admitted(request, true);
        return okEnvelope(await bindings.test(owner), access.requestId(request));
      },
      { parse: 'none' },
    )
    .delete(
      base,
      async ({ request, set }) => {
        set.headers['cache-control'] = 'no-store';
        const { owner, bindings } = await admitted(request, true);
        return okEnvelope(await bindings.remove(owner), access.requestId(request));
      },
      { parse: 'none' },
    );
}
