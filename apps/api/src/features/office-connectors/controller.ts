import { Elysia } from 'elysia';
import type { Pool } from 'pg';
import type { HttpAccess } from '../../http/access.js';
import { okEnvelope } from '../../http/errors.js';
import { ApplicationError, notFound } from '../../platform/errors.js';
import { createFeishuBotConnections } from './feishu-bot-connections.js';

const base = '/api/v1/office/feishu/bot';

export function createFeishuController(pool: Pool | null, access: HttpAccess) {
  const controller = new Elysia({ name: 'feishu-bot', strictPath: true });
  const bots = pool ? createFeishuBotConnections(pool) : null;
  const origin = process.env.APP_ORIGIN ?? 'http://localhost:3000';
  function botConnections() {
    if (!bots) throw notFound('Feishu is not configured');
    return bots;
  }

  async function signed(request: Request, write = false) {
    const actor = await access.requireActor(request);
    if (!actor.sessionId) throw new ApplicationError(403, 'FORBIDDEN', 'Signed session required');
    if (write) {
      if (request.headers.get('origin') !== origin)
        throw new ApplicationError(403, 'FORBIDDEN', 'Origin mismatch');
      access.csrf(request, actor);
    }
    return { ownerId: actor.ownerId, sessionId: actor.sessionId };
  }

  return controller
    .get(base, async ({ request, set }) => {
      set.headers['cache-control'] = 'no-store';
      const viewer = await signed(request);
      return okEnvelope(await botConnections().status(viewer), access.requestId(request));
    })
    .post(
      `${base}/scan`,
      async ({ request, set }) => {
        set.headers['cache-control'] = 'no-store';
        const viewer = await signed(request, true);
        const result = await botConnections().begin(viewer);
        return okEnvelope(result.status, access.requestId(request));
      },
      { parse: 'none' },
    )
    .post(
      `${base}/cancel`,
      async ({ request, set }) => {
        set.headers['cache-control'] = 'no-store';
        const viewer = await signed(request, true);
        return okEnvelope(
          await botConnections().remove(viewer, 'pending'),
          access.requestId(request),
        );
      },
      { parse: 'none' },
    )
    .post(
      `${base}/disconnect`,
      async ({ request, set }) => {
        set.headers['cache-control'] = 'no-store';
        const viewer = await signed(request, true);
        return okEnvelope(
          await botConnections().remove(viewer, 'connected'),
          access.requestId(request),
        );
      },
      { parse: 'none' },
    );
}
