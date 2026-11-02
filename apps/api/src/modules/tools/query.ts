import type { PoolClient } from 'pg';
import {
  HarnessObservationSchema,
  workspaceGrantSchema,
  type HarnessObservation,
} from '@along/contracts';
import { readDocumentApprovalReceipt } from '../approvals/decision.js';
import {
  assertToolRunBinding,
  assertToolRunInterruptionBinding,
} from '../conversations/tool-binding.js';
import type { DocumentRunEvidence } from '../approvals/document-evidence.js';
import type { ToolContext, TimezoneSettingPayload } from './contracts.js';
import { parseResult, resultKind } from './result-schema.js';
import { readAcceptedInvocationResult } from './accepted-result.js';
import {
  authorizeSliceOrigin,
  authorizeContextSource,
  contextSourceCorrupt,
  readContextSourceMetadata,
} from './context-source.js';
import { HttpError, stateConflict } from '../../http/errors.js';

type RunBinding = Pick<ToolContext, 'ownerId' | 'conversationId' | 'runId'>;

// Immutable same-Run setting receipts, not a projection of today's preference.
// A clear is a real accepted null fact; later writes never erase this receipt.
export async function readRunTimezoneSettings(
  client: PoolClient,
  binding: RunBinding,
): Promise<Array<{ invocation_id: string } & Omit<TimezoneSettingPayload, 'kind'>>> {
  await assertToolRunBinding(client, binding);
  return readTimezoneSettings(client, binding);
}

// Internal terminal projection, never a content/observation read boundary.
// Binding is checked before reading any receipts; hydration retains the same
// accepted-result version, outcome, payload and frozen-profile integrity checks.
export async function readRunInterruptionEvidence(client: PoolClient, binding: RunBinding) {
  await assertToolRunInterruptionBinding(client, binding);
  const { rows } = await client.query<{ has_unknown: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM tool_invocations
       WHERE owner_id=$1 AND conversation_id=$2 AND run_id=$3 AND state='unknown'
     ) AS has_unknown`,
    [binding.ownerId, binding.conversationId, binding.runId],
  );
  const settings = await readTimezoneSettings(client, binding);
  return { hasUnknown: rows[0]!.has_unknown, settings };
}

async function readTimezoneSettings(
  client: PoolClient,
  binding: RunBinding,
): Promise<Array<{ invocation_id: string } & Omit<TimezoneSettingPayload, 'kind'>>> {
  const { rows } = await client.query<{
    invocation_id: string;
    tool_id: string;
    result_version: number | null;
    outcome_kind: string | null;
    approval_id: string | null;
    accepted_result: unknown;
    frozen_context: { authorizationRevision?: unknown };
  }>(
    `SELECT invocation_id,tool_id,result_version,outcome_kind,approval_id,accepted_result,frozen_context
     FROM tool_invocations
     WHERE owner_id=$1 AND conversation_id=$2 AND run_id=$3
       AND tool_id='set_user_timezone' AND state='completed'
     ORDER BY accepted_at,invocation_id`,
    [binding.ownerId, binding.conversationId, binding.runId],
  );
  const settings: Array<{ invocation_id: string } & Omit<TimezoneSettingPayload, 'kind'>> = [];
  for (const row of rows) {
    const result = await readAcceptedInvocationResult(client, binding, row);
    if (result.status !== 'ok') continue;
    if (
      result.result.kind !== 'timezone_setting' ||
      row.approval_id !== null ||
      row.frozen_context.authorizationRevision !== 'delegation/1'
    )
      throw stateConflict('invalid accepted timezone setting');
    const { timezone_id, previous_timezone_id, alias_version } = result.result;
    settings.push({
      invocation_id: row.invocation_id,
      timezone_id,
      previous_timezone_id,
      alias_version,
    });
  }
  return settings;
}

// This is the only document-effect projection. Approvals/conversations consume
// explicit accepted facts rather than reaching into the tools result ledger.
export async function readRunDocumentEvidence(
  client: PoolClient,
  binding: RunBinding,
): Promise<DocumentRunEvidence> {
  await assertToolRunBinding(client, binding);
  const { rows } = await client.query<{
    invocation_id: string;
    owner_id: string;
    conversation_id: string;
    run_id: string;
    tool_id: string;
    state: 'reserved' | 'unknown' | 'completed';
    approval_id: string | null;
    frozen_context: { workspaceGrant?: unknown; documentApprovalId?: string };
    accepted_result: unknown;
    created_at: string;
    accepted_at: string;
  }>(
    `SELECT invocation_id,owner_id,conversation_id,run_id,tool_id,state,approval_id,
      frozen_context,accepted_result,
      to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
      coalesce(to_char(accepted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'') AS accepted_at
     FROM tool_invocations
     WHERE owner_id=$1 AND conversation_id=$2 AND run_id=$3
       AND tool_id IN ('workspace_read','workspace_apply_replace')
     ORDER BY created_at,invocation_id`,
    [binding.ownerId, binding.conversationId, binding.runId],
  );
  const reads: DocumentRunEvidence['reads'][number][] = [];
  const applies: DocumentRunEvidence['applies'][number][] = [];
  for (const row of rows) {
    const grant = workspaceGrantSchema.parse(row.frozen_context.workspaceGrant);
    const identity = {
      invocation_id: row.invocation_id,
      owner_id: row.owner_id,
      conversation_id: row.conversation_id,
      run_id: row.run_id,
      workspace_id: grant.workspace_id,
      registration_digest: grant.registration_digest,
      created_at: row.created_at,
      accepted_at: row.accepted_at,
    };
    if (row.tool_id === 'workspace_read') {
      if (row.state !== 'completed') continue;
      const accepted = parseResult(row.accepted_result);
      if (accepted.status === 'ok' && accepted.result.kind === 'read')
        reads.push({
          ...identity,
          kind: 'read',
          relative_path: accepted.result.path,
          result: accepted.result,
        });
      continue;
    }
    const approvalId = row.frozen_context.documentApprovalId;
    if (!approvalId) continue;
    const receipt = await readDocumentApprovalReceipt(client, binding.ownerId, approvalId);
    const accepted = row.state === 'completed' ? parseResult(row.accepted_result) : null;
    const result =
      accepted?.status === 'ok' &&
      (accepted.result.kind === 'applied' || accepted.result.kind === 'conflict')
        ? accepted.result
        : null;
    applies.push({
      ...identity,
      kind: 'apply',
      relative_path: receipt.relative_path,
      approval_id: approvalId,
      state: row.state,
      result,
    });
  }
  return { reads, applies };
}

// Metadata is fetched/projected in PostgreSQL before any large body is read.
// A frozen Run without the retrieval tool keeps its only original full view.
export async function readRunContextObservations(
  client: PoolClient,
  ctx: ToolContext,
  invocationIds: readonly string[],
  options: { project: boolean },
): Promise<HarnessObservation[]> {
  const metadata = await readContextSourceMetadata(client, ctx, invocationIds);
  const observations: HarnessObservation[] = [];
  for (const invocationId of invocationIds) {
    const row = metadata.get(invocationId);
    if (!row || row.state !== 'completed') throw contextSourceCorrupt();
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
          await client.query<{ accepted_result: unknown; approval_id: string | null }>(
            `SELECT accepted_result,approval_id FROM tool_invocations
           WHERE invocation_id=$1 AND owner_id=$2 AND conversation_id=$3 AND run_id=$4
             AND state='completed'`,
            [invocationId, ctx.ownerId, ctx.conversationId, ctx.runId],
          )
        ).rows[0];
        if (!accepted) throw contextSourceCorrupt();
        const result = await readAcceptedInvocationResult(client, ctx, { ...row, ...accepted });
        if (result.status === 'unknown' || resultKind(result) !== row.outcome_kind)
          throw contextSourceCorrupt();
        observations.push(
          HarnessObservationSchema.parse({
            view: 'full',
            invocation_id: invocationId,
            tool_id: row.tool_id,
            result,
          }),
        );
      } catch (error) {
        if (error instanceof HttpError && error.httpStatus === 403) throw error;
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
