import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { LearnDocsQuerySchema } from '@along/contracts';
import { withTransaction } from '../../db/transaction.js';
import { isActiveOwner, lockViewerAccess } from '../identity/public.js';
import { forbidden } from '../../platform/errors.js';

export const microsoftLearnGrantSchema = z
  .object({
    generation: z.string().uuid(),
    query: LearnDocsQuerySchema,
  })
  .strict();
export type MicrosoftLearnGrant = z.infer<typeof microsoftLearnGrantSchema>;
type Viewer = { ownerId: string; sessionId: string };
type Status = { state: 'idle' | 'connected' };

/** A generation is local opt-in, not a Microsoft identity or a health check. */
export async function readMicrosoftLearnGrant(
  client: PoolClient,
  ownerId: string,
  expected?: Pick<MicrosoftLearnGrant, 'generation'>,
): Promise<{ generation: string } | null> {
  if (!(await isActiveOwner(client, ownerId, { lock: 'share' }))) return null;
  const { rows } = await client.query<{ generation: string }>(
    `SELECT generation FROM microsoft_learn_connections
     WHERE owner_id=$1 AND ($2::uuid IS NULL OR generation=$2) FOR SHARE`,
    [ownerId, expected?.generation ?? null],
  );
  return rows[0] ?? null;
}

export function createMicrosoftLearnConnections(pool: Pool) {
  async function signed<T>(viewer: Viewer, action: (client: PoolClient) => Promise<T>) {
    return withTransaction(pool, async (client) => {
      if (!(await lockViewerAccess(client, viewer.ownerId, viewer.sessionId))) throw forbidden();
      return action(client);
    });
  }
  return {
    status(viewer: Viewer): Promise<Status> {
      return signed(viewer, async (client) => ({
        state: (await readMicrosoftLearnGrant(client, viewer.ownerId)) ? 'connected' : 'idle',
      }));
    },
    connect(viewer: Viewer): Promise<Status> {
      return signed(viewer, async (client) => {
        await client.query(
          `INSERT INTO microsoft_learn_connections(owner_id,generation) VALUES($1,$2)
           ON CONFLICT(owner_id) DO NOTHING`,
          [viewer.ownerId, randomUUID()],
        );
        return { state: 'connected' };
      });
    },
    disconnect(viewer: Viewer): Promise<Status> {
      return signed(viewer, async (client) => {
        await client.query('DELETE FROM microsoft_learn_connections WHERE owner_id=$1', [
          viewer.ownerId,
        ]);
        return { state: 'idle' };
      });
    },
  };
}
