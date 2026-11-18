import type { PoolClient } from 'pg';
import { z } from 'zod';
import { stateConflict } from '../../../platform/errors.js';
import type { MemoryService } from '../service.js';

const revisionsSchema = z
  .array(z.object({ id: z.string().uuid(), revision: z.number().int().positive().safe() }).strict())
  .max(100);

/** Store only inside the same transaction that accepts the corresponding observation. */
export async function saveRecallReceipt(
  client: PoolClient,
  ownerId: string,
  invocationId: string,
  revisions: { id: string; revision: number }[],
): Promise<void> {
  const parsed = revisionsSchema.parse(revisions);
  await client.query(
    'INSERT INTO r3_memory_recall_receipts(invocation_id,owner_id,revisions) VALUES($1,$2,$3::jsonb)',
    [invocationId, ownerId, JSON.stringify(parsed)],
  );
}

/** Match the actual persisted observation, not another concurrent caller's candidate set. */
export async function validateRecallReceipt(
  client: PoolClient,
  service: Pick<MemoryService, 'validateRecallInTransaction'>,
  ownerId: string,
  invocationId: string,
  acceptedIds: string[],
): Promise<void> {
  const result = await client.query<{ revisions: unknown }>(
    'SELECT revisions FROM r3_memory_recall_receipts WHERE invocation_id=$1 AND owner_id=$2',
    [invocationId, ownerId],
  );
  const parsed = revisionsSchema.safeParse(result.rows[0]?.revisions);
  if (
    !parsed.success ||
    parsed.data.length !== acceptedIds.length ||
    parsed.data.some((item, index) => item.id !== acceptedIds[index]) ||
    new Set(parsed.data.map((item) => item.id)).size !== parsed.data.length
  ) {
    throw stateConflict('memory recall receipt unavailable or inconsistent');
  }
  await service.validateRecallInTransaction(client, ownerId, parsed.data);
}
