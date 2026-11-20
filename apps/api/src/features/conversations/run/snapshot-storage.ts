import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { HARNESS_MAX_FRAME_BYTES } from '@along/contracts';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { lockViewerAccess } from '../../identity/public.js';
import {
  feishuBotDocxGrantSchema,
  loadFeishuBotDocxConfiguration,
  matchFeishuBotDocxGrant,
  readFeishuBotObservationKey,
} from '../../office-connectors/public.js';
import { forbidden, stateConflict } from '../../../platform/errors.js';

type SnapshotBinding = {
  ownerId: string;
  conversationId: string;
  runId: string;
  attemptId: string;
  id: string;
  kind: 'checkpoint' | 'pause' | 'compact-snapshot' | 'compact-context';
};

const encoding = 'feishu-snapshot-aead/1';
const nonceBytes = 12;
const tagBytes = 16;
const envelope = z
  .object({
    encoding: z.literal(encoding),
    ciphertext: z
      .string()
      .max(4 * Math.ceil((HARNESS_MAX_FRAME_BYTES + nonceBytes + tagBytes) / 3)),
  })
  .strict();

/** Resolve from the persisted Run while the caller holds the attempt -> Run locks.
 * Read-only release inspection may read legacy snapshots but cannot open private ones. */
async function snapshotAuthority(client: PoolClient, binding: SnapshotBinding) {
  const {
    rows: [run],
  } = await client.query<{
    grant: unknown;
    active: boolean;
    writable: boolean;
  }>(
    `SELECT r.frozen_context->'feishuDocx' AS grant,
      r.status IN ('running','paused','suspended_approval') AS active,
      current_setting('transaction_read_only')='off' AS writable
      FROM agent_runs r JOIN run_attempts a ON a.run_id=r.id AND a.owner_id=r.owner_id
      WHERE r.id=$1 AND r.owner_id=$2 AND r.conversation_id=$3 AND a.id=$4`,
    [binding.runId, binding.ownerId, binding.conversationId, binding.attemptId],
  );
  if (!run) throw stateConflict('snapshot Run binding unavailable');
  if (run.grant == null) return null;
  const parsed = feishuBotDocxGrantSchema.safeParse(run.grant);
  if (!parsed.success) throw stateConflict('invalid snapshot grant');
  const grant = parsed.data;
  const config = loadFeishuBotDocxConfiguration();
  const viewer = { ownerId: binding.ownerId, sessionId: grant.sessionId };
  if (
    !run.active ||
    !run.writable ||
    !config ||
    !(await lockViewerAccess(client, viewer.ownerId, viewer.sessionId)) ||
    !(await matchFeishuBotDocxGrant(client, config, viewer, grant))
  )
    throw forbidden('private snapshot authorization unavailable');
  const key = readFeishuBotObservationKey(config);
  if (!key) throw forbidden('private snapshot key unavailable');
  const aad = Buffer.from(
    JSON.stringify([
      encoding,
      binding.kind,
      binding.ownerId,
      binding.conversationId,
      binding.runId,
      binding.attemptId,
      binding.id,
      grant.kind,
      grant.connectionId,
      grant.revision,
      grant.generation,
      grant.appId,
      grant.sessionId,
      grant.url,
    ]),
  );
  return { key, aad };
}

export async function encodeRunSnapshot(
  client: PoolClient,
  binding: SnapshotBinding,
  payload: object,
): Promise<string> {
  const authority = await snapshotAuthority(client, binding);
  const json = JSON.stringify(payload);
  if (!authority) return json;
  if (Buffer.byteLength(json, 'utf8') > HARNESS_MAX_FRAME_BYTES)
    throw stateConflict('private snapshot exceeds safe bound');
  const nonce = randomBytes(nonceBytes);
  const cipher = createCipheriv('aes-256-gcm', authority.key, nonce);
  cipher.setAAD(authority.aad);
  return JSON.stringify({
    encoding,
    ciphertext: Buffer.concat([
      nonce,
      cipher.update(json, 'utf8'),
      cipher.final(),
      cipher.getAuthTag(),
    ]).toString('base64'),
  });
}

export async function decodeRunSnapshot(
  client: PoolClient,
  binding: SnapshotBinding,
  payload: unknown,
): Promise<unknown> {
  const authority = await snapshotAuthority(client, binding);
  const tagged = payload !== null && typeof payload === 'object' && 'encoding' in payload;
  if (!authority && !tagged) return payload;
  if (!authority || !tagged) throw stateConflict('invalid private snapshot encoding');
  const parsed = envelope.safeParse(payload);
  if (!parsed.success) throw stateConflict('invalid private snapshot encoding');
  const bytes = Buffer.from(parsed.data.ciphertext, 'base64');
  if (
    bytes.length <= nonceBytes + tagBytes ||
    bytes.length > HARNESS_MAX_FRAME_BYTES + nonceBytes + tagBytes ||
    bytes.toString('base64') !== parsed.data.ciphertext
  )
    throw stateConflict('invalid private snapshot encoding');
  try {
    const decipher = createDecipheriv('aes-256-gcm', authority.key, bytes.subarray(0, nonceBytes));
    decipher.setAAD(authority.aad);
    decipher.setAuthTag(bytes.subarray(-tagBytes));
    return JSON.parse(
      Buffer.concat([
        decipher.update(bytes.subarray(nonceBytes, -tagBytes)),
        decipher.final(),
      ]).toString('utf8'),
    );
  } catch {
    throw stateConflict('invalid private snapshot ciphertext');
  }
}
