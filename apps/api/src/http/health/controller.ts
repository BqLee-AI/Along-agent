import { Elysia } from 'elysia';
import { z } from 'zod';
import type { Pool } from 'pg';
import type { TimeContext } from '../../features/time/public.js';
import { readiness } from './model.js';
const HealthSchema = z.object({ status: z.literal('ok') });
const NotReadySchema = z.object({
  status: z.literal('not_ready'),
  reason: z.string(),
  details: z.object({ missing: z.array(z.string()) }).optional(),
});
export function createHealthController(pool: Pool | null, timeContext: TimeContext) {
  return new Elysia({ name: 'health', strictPath: true })
    .get('/healthz', () => ({ status: 'ok' as const }), { response: { 200: HealthSchema } })
    .get(
      '/readyz',
      async ({ status }) => {
        const body = await readiness(pool, timeContext);
        return body.status === 'ok' ? status(200, { status: 'ok' as const }) : status(503, body);
      },
      { response: { 200: HealthSchema, 503: NotReadySchema } },
    );
}
