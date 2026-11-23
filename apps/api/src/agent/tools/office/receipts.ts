import { isDeepStrictEqual } from 'node:util';
import type { PoolClient } from 'pg';
import { OfficeCreateArtifactsResultSchema } from '@along/contracts';
import { stateConflict } from '../../../platform/errors.js';
import type { OfficeToolId, ToolContext } from '../contracts.js';
import { parseResult, resultKind } from '../result-schema.js';
import { assertOfficeToolAuthority, type OfficeAuthorityContext } from './authority.js';
import { isPrivateOfficeObservation, openOfficeObservation } from './observations.js';

type ReceiptBinding = Pick<ToolContext, 'ownerId' | 'runId'> & Partial<OfficeAuthorityContext>;
export type OfficeReceiptRow = {
  invocation_id: string;
  tool_id: string;
  approval_id: string | null;
  accepted_attempt_id?: string | null;
  accepted_result?: unknown;
  outcome_kind: string | null;
  result_version: number | null;
};

function openBoundObservation(key: Buffer, ctx: OfficeAuthorityContext, row: OfficeReceiptRow) {
  if (
    row.result_version !== 1 ||
    row.outcome_kind !== 'success' ||
    row.approval_id !== null ||
    !row.accepted_attempt_id
  )
    throw stateConflict('invalid office observation receipt');
  return openOfficeObservation(
    key,
    {
      ownerId: ctx.ownerId,
      conversationId: ctx.conversationId,
      runId: ctx.runId,
      attemptId: row.accepted_attempt_id,
      invocationId: row.invocation_id,
      toolId: row.tool_id,
    },
    row.accepted_result,
  );
}

/** Caller holds the active office authority lock; references never cross Run boundaries. */
export async function readOfficeSourceReceipts(
  client: PoolClient,
  ctx: OfficeAuthorityContext,
  key: Buffer,
  tool: 'office_read_notes' | 'office_analyze_tasks',
  ids: readonly string[],
) {
  const { rows } = await client.query<OfficeReceiptRow>(
    `SELECT invocation_id,tool_id,approval_id,accepted_attempt_id,accepted_result,outcome_kind,result_version
       FROM tool_invocations WHERE owner_id=$1 AND conversation_id=$2 AND run_id=$3
         AND tool_id=$4 AND invocation_id=ANY($5::uuid[]) AND state='completed' AND outcome_kind='success'`,
    [ctx.ownerId, ctx.conversationId, ctx.runId, tool, ids],
  );
  const byId = new Map(rows.map((row) => [row.invocation_id, row]));
  return ids.map((id) => {
    const row = byId.get(id.toLowerCase());
    if (!row) throw stateConflict('invalid office source receipt');
    return openBoundObservation(key, ctx, row);
  });
}

export async function readAcceptedOfficeResult(
  client: PoolClient,
  ctx: ReceiptBinding,
  tool: OfficeToolId,
  row: OfficeReceiptRow,
) {
  if (!ctx.conversationId || row.result_version !== 1 || row.approval_id !== null)
    throw stateConflict('invalid office receipt binding');
  const binding = { ...ctx, conversationId: ctx.conversationId };
  const key = await assertOfficeToolAuthority(client, binding, tool);
  if (row.outcome_kind === 'success' && isPrivateOfficeObservation(tool))
    return openBoundObservation(key, binding, row).value;
  const value = parseResult(row.accepted_result);
  if (value.status === 'unknown' || resultKind(value) !== row.outcome_kind)
    throw stateConflict('invalid accepted office result');
  if (value.status !== 'ok') return value;
  if (tool !== 'office_create_artifacts' || value.result.kind !== tool)
    throw stateConflict('unexpected office observation encoding');
  await assertOfficeManifest(client, binding, value.result);
  return value;
}

export async function assertOfficeManifest(
  client: PoolClient,
  ctx: Pick<OfficeAuthorityContext, 'ownerId' | 'conversationId' | 'runId'>,
  manifest: unknown,
): Promise<void> {
  // No bytes in this projection: require their existence and match the entire
  // immutable manifest, not individual plausible UUIDs supplied by the model.
  const {
    rows: [delivery],
  } = await client.query<{ manifest: unknown }>(
    `SELECT jsonb_agg(jsonb_build_object('artifact_id',a.id,'filename',a.filename,
                'format',a.format,'size_bytes',a.size_bytes) ORDER BY a.format) AS manifest
       FROM office_run_materials m
       JOIN office_run_materials d ON d.run_id=m.scope_run_id
         AND d.owner_id=m.owner_id AND d.conversation_id=m.conversation_id
       JOIN office_artifacts a ON a.scope_run_id=d.run_id
       WHERE m.owner_id=$1 AND m.conversation_id=$2 AND m.run_id=$3
         AND d.delivery_run_id IS NOT NULL
       HAVING bool_and(a.expires_at > statement_timestamp() AND a.content IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM office_attachments u
           WHERE u.scope_run_id=a.scope_run_id AND u.revoked_at IS NOT NULL
             AND (NOT a.sources_known OR (u.role='notes' AND a.uses_notes)
               OR (u.role='tasks' AND a.uses_tasks))
         ))`,
    [ctx.ownerId, ctx.conversationId, ctx.runId],
  );
  if (
    !isDeepStrictEqual(
      OfficeCreateArtifactsResultSchema.parse(manifest).artifacts,
      delivery?.manifest,
    )
  )
    throw stateConflict('office delivery receipt has no available matching manifest');
}
