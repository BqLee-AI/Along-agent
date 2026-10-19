import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { createPool } from '../../src/db/pool.js';
import { computePresentationHash } from '../../src/modules/approvals/presentation.js';

export const databaseUrl = process.env.DATABASE_URL;

export function requirePool(): Pool {
  const pool = createPool(databaseUrl);
  if (!pool) throw new Error('DATABASE_URL is required for integration tests');
  return pool;
}

export interface SeedApproval {
  id: string;
  ownerId: string;
  presentationHash: string;
}

export async function seedApproval(
  pool: Pool,
  overrides: Partial<{
    ownerId: string;
    state: string;
    expiresInHours: number;
    fireInHours: number;
  }> = {},
): Promise<SeedApproval> {
  const id = randomUUID();
  const ownerId = overrides.ownerId ?? randomUUID();
  const fireAt = new Date(Date.now() + (overrides.fireInHours ?? 25) * 3600_000);
  const expiresAt = new Date(Date.now() + (overrides.expiresInHours ?? 23) * 3600_000);
  const presentationHash = computePresentationHash({
    originalText: '明天 9:20 喝水',
    localDatetime: '2026-10-17 09:20',
    timezoneId: 'Asia/Shanghai',
    fold: 0,
    offsetSeconds: 28800,
    occurrence: 'single',
    presentationVersion: 'v1',
  });
  await pool.query(
    `INSERT INTO approvals (id, owner_id, original_text, fire_at_utc, wall_time,
       timezone_id, fold, resolved_utc_offset_seconds, tzdb_version, occurrence,
       presentation_hash, presentation_version, state, expires_at)
     VALUES ($1,$2,'明天 9:20 喝水',$3,'2026-10-17 09:20','Asia/Shanghai',0,28800,
       '2024a','single',$4,'v1',$5,$6)`,
    [
      id,
      ownerId,
      fireAt.toISOString(),
      presentationHash,
      overrides.state ?? 'pending',
      expiresAt.toISOString(),
    ],
  );
  return { id, ownerId, presentationHash };
}
