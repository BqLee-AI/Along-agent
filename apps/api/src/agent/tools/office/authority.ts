import { isDeepStrictEqual } from 'node:util';
import type { PoolClient } from 'pg';
import {
  assertOfficeInputs,
  readOfficeObservationKey,
} from '../../../features/native-office/public.js';
import type { OfficeExecution } from '../../../features/native-office/public.js';
import { forbidden } from '../../../platform/errors.js';
import type { OfficeToolId, ToolContext } from '../contracts.js';

export type OfficeAuthorityContext = Pick<
  ToolContext,
  | 'ownerId'
  | 'conversationId'
  | 'runId'
  | 'officeMaterials'
  | 'officeSessionId'
  | 'authorizationRevision'
>;

export function requireOfficeKey(): Buffer {
  const key = readOfficeObservationKey();
  if (!key) throw forbidden('office observation key unavailable');
  return key;
}

export function officeExecution(ctx: OfficeAuthorityContext): OfficeExecution {
  if (
    ctx.authorizationRevision !== 'delegation/1' ||
    !ctx.officeSessionId ||
    !ctx.officeMaterials?.length
  )
    throw forbidden('office authority unavailable');
  return {
    ownerId: ctx.ownerId,
    conversationId: ctx.conversationId,
    runId: ctx.runId,
    sessionId: ctx.officeSessionId,
  };
}

/** Call with the attempt/Run fence held for execution or handoff. Bootstrap may
 * already hold it while hydrating receipts originally accepted by another attempt. */
export async function assertOfficeToolAuthority(
  client: PoolClient,
  ctx: OfficeAuthorityContext,
  tool?: OfficeToolId,
): Promise<Buffer> {
  const key = requireOfficeKey();
  const binding = officeExecution(ctx);
  const {
    rows: [row],
  } = await client.query<{
    materials: unknown;
    session_id: string;
    allowed: boolean;
  }>(
    `SELECT frozen_context->'officeMaterials' AS materials,
            frozen_context->>'officeSessionId' AS session_id,
            ($4::text IS NULL OR tools_allowlist ? $4) AS allowed
       FROM agent_runs WHERE id=$1 AND owner_id=$2 AND conversation_id=$3
         AND execution='harness' AND frozen_context->>'authorization_revision'='delegation/1'
         AND frozen_context->>'execution_lifecycle'='server-owned'`,
    [ctx.runId, ctx.ownerId, ctx.conversationId, tool ?? null],
  );
  const role =
    tool === 'office_read_notes' ? 'notes' : tool === 'office_analyze_tasks' ? 'tasks' : undefined;
  if (
    !row?.allowed ||
    row.session_id !== binding.sessionId ||
    !isDeepStrictEqual(row.materials, ctx.officeMaterials) ||
    (role && !ctx.officeMaterials?.some((item) => item.role === role))
  )
    throw forbidden('office authority unavailable');
  await assertOfficeInputs(client, binding);
  return key;
}
