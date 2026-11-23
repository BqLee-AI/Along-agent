import {
  httpStatusForError,
  HarnessObservationSchema,
  type HarnessObservation,
} from '@along/contracts';
import type { PoolClient } from 'pg';
import { ApplicationError, forbidden } from '../../../platform/errors.js';
import type { ToolContext } from '../contracts.js';
import { isOfficeToolId } from '../contracts.js';
import { resultKind } from '../result-schema.js';
import {
  readAcceptedInvocationResult,
  validateAcceptedMemoryObservation,
} from './accepted-result.js';
import {
  authorizeSliceOrigin,
  authorizeContextSource,
  contextSourceCorrupt,
  readContextSourceMetadata,
} from './context-source.js';

// Metadata is fetched/projected in PostgreSQL before any large body is read.
// A frozen Run without the retrieval tool keeps its only original full view.
export async function readRunContextObservations(
  client: PoolClient,
  ctx: ToolContext,
  invocationIds: readonly string[],
  options: { project: boolean },
): Promise<HarnessObservation[]> {
  const metadata = await readContextSourceMetadata(client, ctx, invocationIds);
  let officeLeaseVerified = false;
  const observations: HarnessObservation[] = [];
  for (const invocationId of invocationIds) {
    const row = metadata.get(invocationId);
    if (!row || row.state !== 'completed') throw contextSourceCorrupt();
    if (isOfficeToolId(row.tool_id) && !officeLeaseVerified) {
      if (!ctx.ownership) throw forbidden('office Run ownership required');
      // Resume admission validates the snapshot before inserting its next
      // attempt. The transaction already owns the Run's advisory lease.
      await ctx.ownership.assert(client, ctx.runId);
      officeLeaseVerified = true;
    }
    authorizeContextSource(ctx, row);
    if (row.result_version !== 1 || !row.shape_valid) throw contextSourceCorrupt();
    await authorizeSliceOrigin(client, ctx, row, metadata);
    if (
      options.project &&
      ctx.allowlist.includes('read_run_observation') &&
      row.result_status === 'ok' &&
      ['read', 'list', 'search', 'context_slice'].includes(row.kind ?? '')
    ) {
      if (row.outcome_kind !== 'success') throw contextSourceCorrupt();
      const view = HarnessObservationSchema.safeParse({
        view: 'projected',
        invocation_id: invocationId,
        tool_id: row.tool_id,
        outcome: 'ok',
        source: { ...(row.source as object), result_version: 1, omitted: true },
      });
      if (!view.success) throw contextSourceCorrupt();
      observations.push(view.data);
    } else {
      try {
        const accepted = (
          await client.query<{
            accepted_result: unknown;
            approval_id: string | null;
            accepted_attempt_id: string | null;
          }>(
            `SELECT accepted_result,approval_id,accepted_attempt_id FROM tool_invocations
           WHERE invocation_id=$1 AND owner_id=$2 AND conversation_id=$3 AND run_id=$4
             AND state='completed'`,
            [invocationId, ctx.ownerId, ctx.conversationId, ctx.runId],
          )
        ).rows[0];
        if (!accepted) throw contextSourceCorrupt();
        const result = await readAcceptedInvocationResult(client, ctx, { ...row, ...accepted });
        if (result.status === 'unknown' || resultKind(result) !== row.outcome_kind)
          throw contextSourceCorrupt();
        await validateAcceptedMemoryObservation(client, ctx, invocationId, result);
        observations.push(
          HarnessObservationSchema.parse({
            view: 'full',
            invocation_id: invocationId,
            tool_id: row.tool_id,
            result,
          }),
        );
      } catch (error) {
        if (error instanceof ApplicationError && httpStatusForError(error.code) === 403)
          throw error;
        throw contextSourceCorrupt();
      }
    }
  }
  // Revocation/abort during asynchronous receipt hydration cannot disclose a
  // previously authorized prefix. Reuse the same client; never reacquire locks.
  const current = await readContextSourceMetadata(client, ctx, invocationIds);
  for (const invocationId of invocationIds) {
    const row = current.get(invocationId);
    if (!row) throw contextSourceCorrupt();
    authorizeContextSource(ctx, row);
    await authorizeSliceOrigin(client, ctx, row, current);
  }
  return observations;
}

export async function readRunContextSource(
  client: PoolClient,
  ctx: ToolContext,
  invocationId: string,
  view: 'full' | 'projected',
): Promise<HarnessObservation> {
  const observations = await readRunContextObservations(client, ctx, [invocationId], {
    project: view === 'projected',
  });
  const observation = observations[0];
  if (!observation) throw contextSourceCorrupt();
  return observation;
}
