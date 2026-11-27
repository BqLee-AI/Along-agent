import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { withTransaction } from '../../db/transaction.js';
import { notReady } from '../../platform/errors.js';
import {
  createWechatProvider,
  openWechatPairing,
  sealWechatBinding,
  sealWechatPairing,
  sendWechat,
  WECHAT_POLL_TIMEOUT_MS,
  type WechatPairing,
  type WechatPoll,
  type WechatSendResult,
} from './wechat-provider.js';

const pairingTtlMs = 8 * 60_000;
const leaseTtlMs = WECHAT_POLL_TIMEOUT_MS + 10_000;
const testText = '这是一条 Along 微信连接测试消息。';

type PollResult =
  | { status: WechatPairing['status'] | 'expired' }
  | { status: 'bound'; binding_id: string };

type PairRow = { secret_ciphertext: string; polling: boolean };
type ActiveBinding = { id: string; credential_ciphertext: string; platform_user_id: string };

const provider = createWechatProvider((input, init) => fetch(input, init));

async function lockOwner(client: PoolClient, owner: string): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('news-wechat:' || $1, 0))", [
    owner,
  ]);
}

async function revoke(client: PoolClient, owner: string): Promise<void> {
  await client.query(
    'UPDATE news_wechat_bindings SET revoked_at = clock_timestamp() WHERE owner_id = $1 AND revoked_at IS NULL',
    [owner],
  );
}

async function terminal(client: PoolClient, owner: string, id: string): Promise<PollResult> {
  // The completed pairing ID is also the binding generation, so lost response retries are safe.
  const { rowCount } = await client.query(
    'SELECT 1 FROM news_wechat_bindings WHERE owner_id = $1 AND id = $2 AND revoked_at IS NULL',
    [owner, id],
  );
  return rowCount ? { status: 'bound', binding_id: id } : { status: 'expired' };
}

function decodePairing(owner: string, id: string, ciphertext: string): WechatPairing {
  try {
    return openWechatPairing(owner, id, ciphertext);
  } catch {
    throw notReady('WeChat pairing unavailable');
  }
}

export function createWechatBindings(pool: Pool) {
  async function finish(
    owner: string,
    id: string,
    lease: string,
    result: WechatPoll,
  ): Promise<PollResult> {
    return withTransaction(pool, async (client) => {
      await lockOwner(client, owner);
      const fence = [owner, id, lease];
      const { rowCount } = await client.query(
        `SELECT 1 FROM news_wechat_pairings
         WHERE owner_id = $1 AND id = $2 AND poll_lease_id = $3 AND expires_at > clock_timestamp()
         FOR UPDATE`,
        fence,
      );
      if (!rowCount) return terminal(client, owner, id);
      if (result.status === 'bound' || result.status === 'expired') {
        if (result.status === 'bound') {
          const ciphertext = sealWechatBinding(owner, id, result.credential);
          await revoke(client, owner);
          await client.query(
            `INSERT INTO news_wechat_bindings (owner_id, id, platform_user_id, credential_ciphertext)
             VALUES ($1, $2, $3, $4)`,
            [owner, id, result.credential.recipient, ciphertext],
          );
        }
        await client.query('DELETE FROM news_wechat_pairings WHERE owner_id = $1', [owner]);
        return result.status === 'bound' ? { status: 'bound', binding_id: id } : result;
      }
      await client.query(
        `UPDATE news_wechat_pairings SET secret_ciphertext = $2,
         poll_lease_id = NULL, poll_lease_expires_at = NULL WHERE owner_id = $1`,
        [owner, sealWechatPairing(owner, id, result.pairing)],
      );
      return { status: result.status };
    });
  }

  return {
    async status(owner: string): Promise<{ binding_id: string | null }> {
      const { rows } = await pool.query<{ id: string }>(
        'SELECT id FROM news_wechat_bindings WHERE owner_id = $1 AND revoked_at IS NULL',
        [owner],
      );
      return { binding_id: rows[0]?.id ?? null };
    },

    async begin(owner: string) {
      const id = randomUUID();
      const { pairing, qrDataUrl } = await provider.begin();
      let ciphertext: string;
      try {
        ciphertext = sealWechatPairing(owner, id, pairing);
      } catch {
        throw notReady('WeChat pairing unavailable');
      }
      await withTransaction(pool, async (client) => {
        await lockOwner(client, owner);
        await client.query(
          `INSERT INTO news_wechat_pairings (owner_id, id, secret_ciphertext, expires_at)
           VALUES ($1, $2, $3, clock_timestamp() + $4 * interval '1 millisecond')
           ON CONFLICT (owner_id) DO UPDATE SET id = EXCLUDED.id,
             secret_ciphertext = EXCLUDED.secret_ciphertext, expires_at = EXCLUDED.expires_at,
             poll_lease_id = NULL, poll_lease_expires_at = NULL`,
          [owner, id, ciphertext, pairingTtlMs],
        );
      });
      return { pair_id: id, qr_data_url: qrDataUrl };
    },

    async poll(owner: string, id: string, pin?: string): Promise<PollResult> {
      const lease = randomUUID();
      const acquired = await withTransaction<PollResult | { pairing: WechatPairing }>(
        pool,
        async (client) => {
          await lockOwner(client, owner);
          const { rows } = await client.query<PairRow>(
            `SELECT secret_ciphertext, COALESCE(poll_lease_expires_at > clock_timestamp(), false) AS polling
           FROM news_wechat_pairings WHERE owner_id = $1 AND id = $2 AND expires_at > clock_timestamp()`,
            [owner, id],
          );
          const row = rows[0];
          if (!row) return terminal(client, owner, id);
          const pairing = decodePairing(owner, id, row.secret_ciphertext);
          if (row.polling || (pairing.status === 'pin_required' && pin === undefined)) {
            return { status: pairing.status };
          }
          await client.query(
            `UPDATE news_wechat_pairings SET poll_lease_id = $2,
           poll_lease_expires_at = clock_timestamp() + $3 * interval '1 millisecond' WHERE owner_id = $1`,
            [owner, lease, leaseTtlMs],
          );
          return { pairing };
        },
      );
      if (!('pairing' in acquired)) return acquired;
      return finish(owner, id, lease, await provider.poll(acquired.pairing, pin));
    },

    async test(owner: string): Promise<WechatSendResult> {
      const binding = await withTransaction(pool, async (client) => {
        await lockOwner(client, owner);
        const { rows } = await client.query<ActiveBinding>(
          `SELECT id, credential_ciphertext, platform_user_id FROM news_wechat_bindings
           WHERE owner_id = $1 AND revoked_at IS NULL FOR UPDATE`,
          [owner],
        );
        return rows[0];
      });
      if (!binding) return { status: 'failed' };
      return sendWechat(
        binding.credential_ciphertext,
        owner,
        binding.id,
        binding.platform_user_id,
        testText,
      );
    },

    async remove(owner: string): Promise<{ binding_id: null }> {
      await withTransaction(pool, async (client) => {
        await lockOwner(client, owner);
        await client.query('DELETE FROM news_wechat_pairings WHERE owner_id = $1', [owner]);
        await revoke(client, owner);
      });
      return { binding_id: null };
    },
  };
}
