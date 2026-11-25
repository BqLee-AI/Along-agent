import { randomUUID } from 'node:crypto';
import { registerApp } from '@larksuiteoapi/node-sdk';
import type { Pool, PoolClient } from 'pg';
import QRCode from 'qrcode';
import { z } from 'zod';
import { withTransaction } from '../../../../db/transaction.js';
import { ApplicationError, unauthorized } from '../../../../platform/errors.js';
import { lockViewerAccess } from '../../../identity/public.js';
import { issueFeishuTenantToken } from './tenant-token.js';

type Viewer = { ownerId: string; sessionId: string };
type Row = {
  attempt_id: string;
  session_id: string | null;
  bot_name: string | null;
  live: boolean;
};
type Scan = { url: string; qr: string };
type Status =
  | { state: 'idle' | 'preparing' | 'failed' | 'other_session' }
  | { state: 'waiting'; scan: Scan }
  | { state: 'connected'; name: string };
const scanLifetime = 5 * 60_000;
const botSchema = z.object({
  code: z.literal(0),
  bot: z.object({
    activate_status: z.literal(2),
    open_id: z.string().min(1),
    app_name: z.string().trim().min(1).max(256),
  }),
});

export function createFeishuBotConnections(pool: Pool, register = registerApp, request = fetch) {
  const pending = new Map<string, { abort: AbortController; scan?: Scan }>();

  async function signed<T>(viewer: Viewer, fn: (client: PoolClient) => Promise<T>) {
    return withTransaction(pool, async (client) => {
      if (!(await lockViewerAccess(client, viewer.ownerId, viewer.sessionId))) throw unauthorized();
      return fn(client);
    });
  }

  async function enroll(
    viewer: Viewer,
    id: string,
    entry: { abort: AbortController; scan?: Scan },
  ) {
    const { abort } = entry;
    const timer = setTimeout(() => abort.abort(), scanLifetime);
    let qrReady: Promise<void> | undefined;
    try {
      const credentials = await register({
        source: 'along',
        signal: abort.signal,
        addons: { preset: false },
        onQRCodeReady({ url }) {
          const target = URL.parse(url);
          if (
            target?.origin !== 'https://open.feishu.cn' ||
            target.pathname !== '/page/launcher' ||
            target.username ||
            target.password ||
            url.length > 4096
          ) {
            abort.abort();
            return;
          }
          qrReady = QRCode.toDataURL(url, { width: 256 }).then(
            (qr) => {
              entry.scan = { url, qr };
            },
            () => abort.abort(),
          );
        },
      });
      await qrReady;
      abort.signal.throwIfAborted();
      const appId = credentials.client_id;
      if (!entry.scan || !/^cli_[a-z0-9]{12,64}$/i.test(appId) || !credentials.client_secret)
        return;
      const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(8_000)]);
      const token = await issueFeishuTenantToken(
        {
          appId,
          appSecret: credentials.client_secret,
          signal,
        },
        request,
      );
      if (!token) return;
      const botResponse = await request('https://open.feishu.cn/open-apis/bot/v3/info', {
        redirect: 'error',
        signal,
        headers: { authorization: `Bearer ${token.token}` },
      });
      if (!botResponse.ok) return;
      const bot = botSchema.safeParse(await botResponse.json());
      if (!bot.success || abort.signal.aborted) return;
      await signed(viewer, (client) =>
        client.query(
          `UPDATE feishu_bot_connections SET app_id=$4, bot_name=$5, session_id=NULL
         WHERE owner_id=$1 AND session_id=$2 AND attempt_id=$3 AND expires_at > clock_timestamp()`,
          [viewer.ownerId, viewer.sessionId, id, appId, bot.data.bot.app_name],
        ),
      );
    } catch {
      // Raw provider errors can carry credential material; status exposes only failure.
    } finally {
      clearTimeout(timer);
      await pool
        .query(
          'UPDATE feishu_bot_connections SET expires_at=clock_timestamp() WHERE attempt_id=$1 AND app_id IS NULL',
          [id],
        )
        .catch(() => {});
      pending.delete(id);
    }
  }

  async function status(viewer: Viewer): Promise<Status> {
    const {
      rows: [row],
    } = await signed(viewer, (client) =>
      client.query<Row>(
        `SELECT attempt_id, session_id, bot_name, expires_at > clock_timestamp() AS live
         FROM feishu_bot_connections WHERE owner_id=$1`,
        [viewer.ownerId],
      ),
    );
    if (!row) return { state: 'idle' };
    if (row.bot_name) return { state: 'connected', name: row.bot_name };
    if (row.session_id !== viewer.sessionId) return { state: row.live ? 'other_session' : 'idle' };
    const entry = row.live ? pending.get(row.attempt_id) : undefined;
    if (!entry || entry.abort.signal.aborted) return { state: 'failed' };
    return entry.scan ? { state: 'waiting', scan: entry.scan } : { state: 'preparing' };
  }

  return {
    status,
    async begin(viewer: Viewer): Promise<{ status: Status; completion?: Promise<void> }> {
      if (pending.size >= 16)
        throw new ApplicationError(429, 'BUDGET_EXCEEDED', 'Too many Feishu scans');
      const id = randomUUID();
      const entry = { abort: new AbortController() };
      pending.set(id, entry);
      let claimed;
      try {
        claimed = await signed(viewer, (client) =>
          client.query(
            `INSERT INTO feishu_bot_connections (owner_id, session_id, attempt_id, expires_at)
           VALUES ($1, $2, $3, clock_timestamp() + $4::integer * interval '1 millisecond')
           ON CONFLICT (owner_id) DO UPDATE SET session_id=EXCLUDED.session_id,
             attempt_id=EXCLUDED.attempt_id, expires_at=EXCLUDED.expires_at
           WHERE feishu_bot_connections.app_id IS NULL AND
             feishu_bot_connections.expires_at <= clock_timestamp() RETURNING attempt_id`,
            [viewer.ownerId, viewer.sessionId, id, scanLifetime],
          ),
        );
      } finally {
        if (!claimed?.rowCount) pending.delete(id);
      }
      if (!claimed.rowCount) return { status: await status(viewer) };
      return { status: { state: 'preparing' }, completion: enroll(viewer, id, entry) };
    },
    async remove(viewer: Viewer, kind: 'pending' | 'connected') {
      const {
        rows: [row],
      } = await signed(viewer, (client) =>
        client.query<{ attempt_id: string }>(
          `DELETE FROM feishu_bot_connections WHERE owner_id=$1 AND (app_id IS NULL)=$2
         RETURNING attempt_id`,
          [viewer.ownerId, kind === 'pending'],
        ),
      );
      if (row) pending.get(row.attempt_id)?.abort.abort();
      return status(viewer);
    },
  };
}
