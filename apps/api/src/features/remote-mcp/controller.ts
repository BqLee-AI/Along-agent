import { Elysia } from 'elysia';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { HttpAccess } from '../../http/access.js';
import { okEnvelope } from '../../http/errors.js';
import { forbidden, notReady, validationError } from '../../platform/errors.js';
import { createMicrosoftLearnConnections } from './learn-connections.js';

const base = '/api/v1/connections/microsoft-learn';
const empty = z.object({}).strict();

export function createMicrosoftLearnController(pool: Pool | null, access: HttpAccess) {
  const connections = pool ? createMicrosoftLearnConnections(pool) : null;
  const origin = process.env.APP_ORIGIN ?? 'http://localhost:3000';
  async function signed(request: Request, write = false) {
    const actor = await access.requireActor(request);
    if (!actor.sessionId) throw forbidden('Signed session required');
    if (write) {
      if (request.headers.get('origin') !== origin) throw forbidden('Origin mismatch');
      access.csrf(request, actor);
      if (!empty.safeParse(await access.json(request)).success)
        throw validationError('This connection accepts no configuration');
    }
    if (!connections) throw notReady('connection storage unavailable');
    return { ownerId: actor.ownerId, sessionId: actor.sessionId };
  }
  return new Elysia({ name: 'microsoft-learn-connection', strictPath: true })
    .get(base, async ({ request, set }) => {
      set.headers['cache-control'] = 'no-store';
      const viewer = await signed(request);
      return okEnvelope(await connections!.status(viewer), access.requestId(request));
    })
    .post(
      `${base}/connect`,
      async ({ request, set }) => {
        set.headers['cache-control'] = 'no-store';
        const viewer = await signed(request, true);
        return okEnvelope(await connections!.connect(viewer), access.requestId(request));
      },
      { parse: 'none' },
    )
    .post(
      `${base}/disconnect`,
      async ({ request, set }) => {
        set.headers['cache-control'] = 'no-store';
        const viewer = await signed(request, true);
        return okEnvelope(await connections!.disconnect(viewer), access.requestId(request));
      },
      { parse: 'none' },
    );
}
