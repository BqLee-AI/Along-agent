import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createFeishuBotConnections } from '../../src/features/office-connectors/feishu-bot-connections.js';
import { readActiveFeishuConnection } from '../../src/features/office-connectors/public.js';
import { createIntegrationDatabase, databaseUrl, seedAdmittedSession } from './setup.js';

const integrationTest = databaseUrl ? test : test.skip;
const launcher = 'https://open.feishu.cn/page/launcher?user_code=synthetic';

integrationTest(
  'pairs a bot without changing an existing user document grant',
  async () => {
    const database = await createIntegrationDatabase();
    try {
      const { pool } = database;
      const owner = await seedAdmittedSession(pool);
      const viewer = { ownerId: owner.userId, sessionId: owner.sessionId };
      const {
        rows: [other],
      } = await pool.query<{ id: string }>(
        `INSERT INTO sessions (user_id, token_hash, expires_at)
       VALUES ($1, $2, clock_timestamp() + interval '1 hour') RETURNING id`,
        [viewer.ownerId, randomUUID()],
      );
      const otherSession = { ...viewer, sessionId: other!.id };
      const legacyId = randomUUID();
      const legacy = {
        appId: 'cli_legacyfixture',
        redirectUri: 'http://localhost:3000/api/v1/office/feishu/callback',
        key: Buffer.alloc(32, 0x42),
      };
      const { rows: before } = await pool.query(
        `INSERT INTO feishu_docx_connections
         (owner_id, session_id, id, app_id, redirect_uri, phase, expires_at, secret_box)
       VALUES ($1, $2, $3, $4, $5, 'active', clock_timestamp() + interval '1 hour', $6)
       RETURNING *`,
        [
          viewer.ownerId,
          viewer.sessionId,
          legacyId,
          legacy.appId,
          legacy.redirectUri,
          'synthetic-ciphertext',
        ],
      );
      const grants: Array<
        ReturnType<typeof Promise.withResolvers<{ client_id: string; client_secret: string }>>
      > = [];
      const calls: string[] = [];
      const request = Object.assign(
        async (input: string | URL | Request, init?: RequestInit) => {
          const url = String(input);
          calls.push(url);
          if (url.endsWith('/tenant_access_token/internal')) {
            return Response.json({
              code: 0,
              tenant_access_token: 'synthetic-bot-token',
              expire: 7200,
            });
          }
          if (
            url.endsWith('/bot/v3/info') &&
            new Headers(init?.headers).get('authorization') === 'Bearer synthetic-bot-token'
          ) {
            return Response.json({
              code: 0,
              bot: { activate_status: 2, open_id: 'synthetic-bot', app_name: 'Test Robot' },
            });
          }
          throw new Error('Unexpected Feishu endpoint');
        },
        {
          preconnect() {
            throw new Error('No external request allowed');
          },
        },
      );
      const bots = createFeishuBotConnections(
        pool,
        async (options) => {
          const grant = Promise.withResolvers<{ client_id: string; client_secret: string }>();
          grants.push(grant);
          options.onQRCodeReady({ url: launcher, expireIn: 300 });
          return grant.promise;
        },
        request,
      );
      const credentials = { client_id: 'cli_abcdefghijkl', client_secret: 'synthetic-secret' };

      const canceled = await bots.begin(viewer);
      expect(await bots.begin(viewer)).toEqual({ status: await bots.status(viewer) });
      expect(await bots.begin(otherSession)).toEqual({ status: { state: 'other_session' } });
      expect(await bots.remove(otherSession, 'pending')).toEqual({ state: 'idle' });
      grants[0]!.resolve(credentials);
      await canceled.completion;
      const accepted = await bots.begin(viewer);
      grants[1]!.resolve(credentials);
      await accepted.completion;
      expect(await bots.status(viewer)).toEqual({ state: 'connected', name: 'Test Robot' });
      expect(calls).toHaveLength(2);
      expect(await bots.remove(viewer, 'pending')).toEqual({
        state: 'connected',
        name: 'Test Robot',
      });
      expect(await bots.remove(viewer, 'connected')).toEqual({ state: 'idle' });
      const { rows: after } = await pool.query(
        'SELECT * FROM feishu_docx_connections WHERE owner_id=$1',
        [viewer.ownerId],
      );
      expect(after).toEqual(before);
      const client = await pool.connect();
      try {
        expect(await readActiveFeishuConnection(client, viewer, legacy, legacyId)).toEqual({
          id: legacyId,
        });
        expect(await readActiveFeishuConnection(client, otherSession, legacy, legacyId)).toBeNull();
      } finally {
        client.release();
      }
    } finally {
      await database.close();
    }
  },
  15_000,
);
