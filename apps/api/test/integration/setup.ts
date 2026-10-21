import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { createPool } from '../../src/db/pool.js';
import { computePresentationHash } from '../../src/modules/approvals/presentation.js';

export const databaseUrl = process.env.DATABASE_URL;

export interface IntegrationDatabase {
  pool: Pool;
  connectionString: string;
  connect(): Pool;
  close(): Promise<void>;
}

export async function createIntegrationDatabase(): Promise<IntegrationDatabase> {
  if (!databaseUrl) throw new Error('DATABASE_URL is required for integration tests');

  const schema = `integration_${randomUUID().replaceAll('-', '')}`;
  const url = new URL(databaseUrl);
  // Keep connection options (for example statement_timeout), but override any
  // inherited search_path. Never fall back to public business tables/functions.
  const options = url.searchParams.getAll('options').join(' ');
  url.searchParams.set(
    'options',
    `${options ? `${options} ` : ''}-csearch_path=${schema},pg_catalog`,
  );
  const connectionString = url.toString();
  const managementPool = new Pool({ connectionString: databaseUrl, max: 1 });
  let pool: Pool | undefined;
  let schemaCreated = false;
  let closing: Promise<void> | undefined;

  async function cleanup(): Promise<void> {
    try {
      await pool?.end();
    } finally {
      try {
        if (schemaCreated) await managementPool.query(`DROP SCHEMA "${schema}" CASCADE`);
      } finally {
        await managementPool.end();
      }
    }
  }

  try {
    await managementPool.query(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    const fixturePool = createPool(connectionString);
    if (!fixturePool) throw new Error('Integration database pool was not created');
    pool = fixturePool;

    // Run the original files, including their transaction boundaries, on one
    // schema-bound connection. PG16 provides gen_random_uuid in pg_catalog.
    const migrations = new URL('../../../../infra/migrations/', import.meta.url);
    const filenames = (await readdir(migrations)).filter((name) => name.endsWith('.sql')).sort();
    const client = await pool.connect();
    try {
      for (const filename of filenames) {
        await client.query(await readFile(new URL(filename, migrations), 'utf8'));
      }
    } finally {
      client.release();
    }

    return {
      pool: fixturePool,
      connectionString,
      // Callers own and end these independent pools before closing the fixture.
      connect() {
        if (closing) throw new Error('Integration database is closing');
        const freshPool = createPool(connectionString);
        if (!freshPool) throw new Error('Integration database pool was not created');
        return freshPool;
      },
      close() {
        closing ??= cleanup();
        return closing;
      },
    };
  } catch (error) {
    try {
      await cleanup();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Integration database setup and cleanup failed',
      );
    }
    throw error;
  }
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
