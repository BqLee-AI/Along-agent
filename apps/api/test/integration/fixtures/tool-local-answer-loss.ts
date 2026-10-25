import { z } from 'zod';
import { Pool } from 'pg';
import { invokeTool } from '../../../src/modules/tools/gateway.js';
import { loadTimeContext } from '../../../src/modules/time/context.js';
import { ProposeTaskInputSchema } from '../../../src/modules/tools/schemas.js';

const fixture = z
  .object({
    ctx: z.object({
      ownerId: z.string().uuid(),
      conversationId: z.string().uuid(),
      runId: z.string().uuid(),
      attemptId: z.string().uuid(),
      requestId: z.string(),
      allowlist: z.array(z.string()),
      confirmedTimezone: z.string().nullable(),
      anchorReceivedAtUtc: z.string(),
      receivedAtUtc: z.string(),
      foldChoice: z.enum(['first', 'second', 'none']),
    }),
    input: z.object({
      invocationId: z.string().uuid(),
      toolId: z.literal('propose_task'),
      args: ProposeTaskInputSchema,
    }),
  })
  .parse(JSON.parse(process.argv[2] ?? 'null'));
const connectionString = z.string().url().parse(process.env.DATABASE_URL);
const pool = new Pool({ connectionString });
try {
  await invokeTool(
    pool,
    { ...fixture.ctx, timeContext: loadTimeContext('fixture-v1') },
    fixture.input,
  );
  // Parent receives a phase signal, never the accepted tool result. It kills
  // this caller before the result can be delivered to its consumer.
  process.send?.('accepted-without-answer');
  await new Promise<void>((resolve) =>
    process.on('message', (message) => {
      if (message === 'exit') resolve();
    }),
  );
} finally {
  await pool.end();
}
