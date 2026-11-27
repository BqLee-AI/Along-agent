import { Elysia } from 'elysia';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { withTransaction } from '../../db/transaction.js';
import type { HttpAccess } from '../../http/access.js';
import { okEnvelope } from '../../http/errors.js';
import { literalUuidAt } from '../../http/request/path.js';
import { forbidden, notReady, validationError } from '../../platform/errors.js';
import { isActiveOwner, readUserPreferences } from '../identity/public.js';
import { readEdition } from './public.js';

const base = '/api/v1/news';
const preferences = z
  .object({
    topics: z.array(z.string().trim().min(1).max(80)).max(12),
    region: z.string().trim().min(1).max(80).nullable(),
    enabled: z.boolean(),
    binding_id: z.string().uuid().nullable(),
  })
  .strict();
type Preferences = z.infer<typeof preferences>;

async function readSubscription(client: PoolClient, owner: string) {
  const { timezone_id } = await readUserPreferences(client, owner);
  const {
    rows: [row],
  } = await client.query<Preferences>(
    `SELECT s.topics,s.region,s.enabled AND b.id IS NOT NULL AND $2::text IS NOT NULL AS enabled,
      b.id AS binding_id FROM news_subscriptions s LEFT JOIN news_wechat_bindings b
      ON b.id=s.binding_id AND b.revoked_at IS NULL WHERE s.owner_id=$1`,
    [owner, timezone_id],
  );
  return {
    ...(row ?? { topics: [], region: null, enabled: false, binding_id: null }),
    timezone_id,
  };
}

export function createNewsController(pool: Pool | null, access: HttpAccess) {
  function db() {
    if (!pool) throw notReady();
    return pool;
  }
  return new Elysia({ name: 'news-briefings', strictPath: true })
    .resolve({ as: 'local' }, async ({ request }) => ({
      actor: await access.requireActor(request),
      requestId: access.requestId(request),
    }))
    .get(`${base}/subscription`, async ({ actor, requestId }) =>
      okEnvelope(
        await withTransaction(db(), (client) => readSubscription(client, actor.ownerId)),
        requestId,
      ),
    )
    .put(
      `${base}/subscription`,
      async ({ actor, body, requestId }) => {
        const owner = actor.ownerId;
        const value = await withTransaction(db(), async (client) => {
          if (!(await isActiveOwner(client, owner, { lock: 'share' })))
            throw forbidden('owner authorization revoked');
          const { timezone_id } = await readUserPreferences(client, owner);
          if (
            body.enabled &&
            (!timezone_id || !body.binding_id || (!body.topics.length && !body.region))
          )
            throw validationError('启用订阅需要账户时区、微信绑定，以及至少一个关注主题或地区。');
          await client.query(
            'SELECT owner_id FROM news_subscriptions WHERE owner_id=$1 FOR UPDATE',
            [owner],
          );
          if (body.binding_id) {
            const bound = await client.query(
              `SELECT id FROM news_wechat_bindings
            WHERE owner_id=$1 AND id=$2 AND revoked_at IS NULL FOR SHARE`,
              [owner, body.binding_id],
            );
            if (!bound.rowCount) throw validationError('请选择有效的本人微信绑定。');
          }
          await client.query(
            `INSERT INTO news_subscriptions(owner_id,binding_id,topics,region,enabled,enabled_at)
          VALUES ($1,$2,$3,$4,$5,clock_timestamp()) ON CONFLICT(owner_id) DO UPDATE SET
          binding_id=EXCLUDED.binding_id,topics=EXCLUDED.topics,region=EXCLUDED.region,enabled=EXCLUDED.enabled,
          enabled_at=CASE WHEN NOT news_subscriptions.enabled OR news_subscriptions.binding_id IS DISTINCT FROM EXCLUDED.binding_id
            THEN EXCLUDED.enabled_at ELSE news_subscriptions.enabled_at END`,
            [owner, body.binding_id, [...new Set(body.topics)], body.region, body.enabled],
          );
          return readSubscription(client, owner);
        });
        return okEnvelope(value, requestId);
      },
      { parse: access.parser(), body: preferences },
    )
    .get(`${base}/editions`, async ({ actor, requestId }) => {
      const { rows: items } = await db().query(
        `SELECT e.id,e.local_date::text,e.coverage,
        COALESCE(d.status,'pending') AS delivery FROM news_editions e LEFT JOIN news_deliveries d ON d.edition_id=e.id
        WHERE e.owner_id=$1 AND e.coverage IS NOT NULL ORDER BY e.local_date DESC`,
        [actor.ownerId],
      );
      return okEnvelope({ items }, requestId);
    })
    .get(`${base}/editions/:id`, async ({ actor, path, requestId }) =>
      okEnvelope(
        await readEdition(db(), actor.ownerId, literalUuidAt(path, 4, 'news edition not found')),
        requestId,
      ),
    );
}
