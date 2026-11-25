import { httpStatusForError } from '@along/contracts';
import type { Pool } from 'pg';
import { ApplicationError } from '../../../platform/errors.js';
import type { ToolContext, ToolOutcome } from '../contracts.js';
import { TOOL_INPUT_SCHEMAS } from '../schemas.js';
import { executeReadOnlyInvocation } from '../invocations/invocations.js';
import { readObservationPage } from './page.js';
import { workspaceDenied } from '../handler-common.js';

export function invokeRunObservation(
  pool: Pool,
  ctx: ToolContext,
  input: { invocationId: string; toolId: string; args: unknown },
): Promise<ToolOutcome> {
  return executeReadOnlyInvocation(pool, ctx, input, async (frozen) => {
    const parsed = TOOL_INPUT_SCHEMAS.read_run_observation.safeParse(input.args);
    if (!parsed.success) return workspaceDenied();
    const client = await pool.connect();
    try {
      return await readObservationPage(client, frozen, parsed.data);
    } catch (error) {
      if (error instanceof ApplicationError && httpStatusForError(error.code) === 403)
        return workspaceDenied();
      throw error;
    } finally {
      client.release();
    }
  }).catch((error: unknown) => {
    if (error instanceof ApplicationError && httpStatusForError(error.code) === 403)
      return { ...workspaceDenied(), invocationId: input.invocationId, replayed: false };
    throw error;
  });
}
