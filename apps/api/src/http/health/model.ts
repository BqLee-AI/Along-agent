import type { Pool } from 'pg';
import type { TimeContext } from '../../features/time/public.js';

export async function readiness(pool: Pool | null, time: TimeContext) {
  if (!time.available)
    return {
      status: 'not_ready',
      reason: 'TZDB_UNAVAILABLE',
      ...(time.missing.length ? { details: { missing: [...time.missing] } } : {}),
    } as const;
  try {
    if (!pool) throw new Error('database unavailable');
    await pool.query('SELECT 1');
  } catch {
    return { status: 'not_ready', reason: 'NOT_READY' } as const;
  }
  return { status: 'ok' } as const;
}
