import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { createPool } from '../db/pool.js';
import { readReleaseWaitingDetail } from '../bootstrap/release.js';

const id = z
  .string()
  .uuid()
  .parse(JSON.parse(readFileSync(0, 'utf8')).runId);
const pool = createPool();
if (!pool) throw new Error('DATABASE_REQUIRED');
try {
  console.log(JSON.stringify(await readReleaseWaitingDetail(pool, id)));
} finally {
  await pool.end();
}
