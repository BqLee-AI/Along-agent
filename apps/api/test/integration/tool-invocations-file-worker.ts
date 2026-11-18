import { Pool } from 'pg';
import { z } from 'zod';
import { loadTimeContext } from '../../src/features/time/context.js';
import { executeNonTransactionalInvocation } from '../../src/agent/tools/invocations/invocations.js';
import { appendFileEffect } from './tool-invocations-file-effect.js';

const input = z
  .object({
    connectionString: z.string(),
    ownerId: z.string().uuid(),
    conversationId: z.string().uuid(),
    runId: z.string().uuid(),
    attemptId: z.string().uuid(),
    invocationId: z.string().uuid(),
    path: z.string(),
    mode: z.enum(['reserved', 'permitted', 'effected', 'success', 'not_applied']),
  })
  .parse(JSON.parse(process.env.INVOCATION_PROBE_INPUT ?? 'null'));
const pool = new Pool({ connectionString: input.connectionString, max: 1 });
const ctx = {
  ownerId: input.ownerId,
  conversationId: input.conversationId,
  runId: input.runId,
  attemptId: input.attemptId,
  requestId: `file-probe-${input.mode}`,
  allowlist: ['internal.file-probe'],
  confirmedTimezone: 'Asia/Shanghai',
  anchorReceivedAtUtc: '2026-10-17T00:00:00Z',
  receivedAtUtc: '2026-10-17T00:00:00Z',
  foldChoice: 'none' as const,
  timeContext: loadTimeContext('fixture-v1'),
};
async function pause(phase: string): Promise<never> {
  process.send?.({ phase });
  // The parent kills this process only after receiving the explicit IPC phase.
  process.on('message', () => {
    throw new Error('kill fixture accepts SIGKILL only');
  });
  return new Promise<never>(() => {});
}
try {
  if (input.mode === 'reserved') await pause('reserved');
  const outcome = await executeNonTransactionalInvocation(
    pool,
    ctx,
    {
      invocationId: input.invocationId,
      toolId: 'internal.file-probe',
      args: { action: 'append-fsync' },
    },
    {
      execute: async (binding) => {
        if (input.mode === 'permitted') await pause('permitted');
        if (input.mode === 'not_applied') {
          // A real OS open failure before any descriptor/write, not a synthetic
          // returned constant standing in for the native effect.
          try {
            await appendFileEffect(`${input.path}/missing/target`, binding);
          } catch (error) {
            if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
              return {
                ...binding,
                evidenceRef: `open-ENOENT:${binding.invocationId}`,
                notApplied: true,
              };
            }
            throw error;
          }
          throw new Error('expected native pre-write open failure');
        }
        const evidence = await appendFileEffect(input.path, binding);
        if (input.mode === 'effected') await pause('effected');
        return evidence;
      },
    },
  );
  process.send?.({ phase: 'accepted', outcome });
} finally {
  await pool.end();
  process.disconnect?.();
}
