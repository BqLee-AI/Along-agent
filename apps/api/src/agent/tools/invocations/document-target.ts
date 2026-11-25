import type { PoolClient } from 'pg';
import { stateConflict } from '../../../platform/errors.js';
import { utf8Bytes } from '../../../features/workspaces/public.js';
import {
  documentEvidenceLater,
  isDocumentApplied,
  matchingDocumentApply,
  verifiedDocumentRead,
  listDocumentApprovals,
  type DocumentReadEvidence,
} from '../../../features/approvals/public.js';
import type { ToolContext } from '../contracts.js';
import { readRunDocumentEvidence } from '../evidence/run-evidence.js';
import { parseResult } from '../result-schema.js';
import { hydrateWorkspaceReadResult } from './accepted-result.js';

// The caller holds the Run lock. Every cross-path target decision is serialized
// with reservation, including conflict successors and unattempted approvals.
export async function assertDocumentTargetAvailable(
  client: PoolClient,
  ctx: ToolContext,
  read: DocumentReadEvidence,
  options: { proposal?: boolean } = {},
): Promise<string | undefined> {
  const creates = await client.query<{
    state: string;
    accepted_result: unknown;
    frozen_context: { documentCreate?: NonNullable<ToolContext['documentCreate']> };
    accepted_at: string;
  }>(
    `SELECT state,accepted_result,frozen_context,
      coalesce(to_char(accepted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'') accepted_at
     FROM tool_invocations WHERE owner_id=$1 AND conversation_id=$2 AND run_id=$3
       AND tool_id='workspace_create' AND frozen_context->'workspaceGrant'->>'workspace_id'=$4
       AND frozen_context->'documentCreate'->>'relative_path'=$5`,
    [ctx.ownerId, ctx.conversationId, ctx.runId, read.workspace_id, read.relative_path],
  );
  for (const create of creates.rows) {
    if (create.state !== 'completed') throw stateConflict('same-target create not settled');
    const result = hydrateWorkspaceReadResult(create.accepted_result);
    if (result.status !== 'ok') throw stateConflict('same-target create not settled');
    if (result.result.kind === 'create_conflict' || result.result.kind === 'create_failed')
      continue;
    if (
      result.result.kind !== 'create_applied' ||
      !documentEvidenceLater(read.created_at, create.accepted_at) ||
      !documentEvidenceLater(read.accepted_at, create.accepted_at) ||
      read.result.version !== result.result.version ||
      utf8Bytes(read.result.content).toString('base64') !==
        create.frozen_context.documentCreate?.content_base64 ||
      read.result.byte_length !== result.result.byte_length
    )
      throw stateConflict('same-target create requires a fresh verified read');
  }
  const approvals = await listDocumentApprovals(client, ctx.ownerId, ctx.conversationId, ctx.runId);
  const matching = approvals.filter(
    (a) => a.workspace_id === read.workspace_id && a.relative_path === read.relative_path,
  );
  if (!options.proposal && matching.length) {
    const evidence = await readRunDocumentEvidence(client, ctx);
    const replaced = new Set(
      matching.flatMap((item) => (item.replaces_approval_id ? [item.replaces_approval_id] : [])),
    );
    const tails = matching.filter((item) => !replaced.has(item.id));
    if (tails.length !== 1) throw stateConflict('ambiguous approval chain');
    const approval = tails[0]!;
    const apply = matchingDocumentApply(approval, evidence.applies);
    const verified =
      apply && isDocumentApplied(approval, apply)
        ? verifiedDocumentRead(approval, apply, evidence.reads)
        : null;
    if (
      !verified ||
      !apply ||
      read.result.version !== approval.new_version ||
      read.result.content !== approval.exact_new_content ||
      !documentEvidenceLater(read.created_at, apply.accepted_at) ||
      !documentEvidenceLater(read.accepted_at, apply.accepted_at)
    )
      throw stateConflict('same-target approval requires a verified completed action');
  }
  const pendingProposals = await client.query(
    `SELECT 1 FROM tool_invocations WHERE owner_id=$1 AND conversation_id=$2 AND run_id=$3
       AND tool_id='workspace_propose_replace' AND state<>'completed'
       AND frozen_context->'workspaceGrant'->>'workspace_id'=$4
       AND frozen_context->'documentEdit'->>'relative_path'=$5`,
    [ctx.ownerId, ctx.conversationId, ctx.runId, read.workspace_id, read.relative_path],
  );
  if (pendingProposals.rowCount) throw stateConflict('same-target proposal not settled');
  const { rows } = await client.query<{
    invocation_id: string;
    state: string;
    accepted_result: unknown;
    frozen_context: { documentEdit?: NonNullable<ToolContext['documentEdit']> };
    accepted_at: string;
  }>(
    `SELECT invocation_id,state,accepted_result,frozen_context,
      coalesce(to_char(accepted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'') accepted_at
      FROM tool_invocations WHERE owner_id=$1 AND conversation_id=$2 AND run_id=$3
      AND tool_id='workspace_replace' AND frozen_context->'workspaceGrant'->>'workspace_id'=$4
      AND frozen_context->'documentEdit'->>'relative_path'=$5
      AND (state <> 'completed' OR accepted_result->'result'->>'kind' IS DISTINCT FROM 'operation_error')
      ORDER BY created_at,invocation_id`,
    [ctx.ownerId, ctx.conversationId, ctx.runId, read.workspace_id, read.relative_path],
  );
  const predecessors = new Set(
    rows.flatMap((row) =>
      row.frozen_context.documentEdit?.replaces_invocation_id
        ? [row.frozen_context.documentEdit.replaces_invocation_id]
        : [],
    ),
  );
  const { rows: proposalLinks } = await client.query<{ predecessor: string }>(
    `SELECT frozen_context->'documentEdit'->>'replaces_invocation_id' AS predecessor
     FROM tool_invocations WHERE owner_id=$1 AND conversation_id=$2 AND run_id=$3
       AND tool_id='workspace_propose_replace' AND state='completed' AND approval_id IS NOT NULL
       AND frozen_context->'documentEdit'->>'replaces_invocation_id' IS NOT NULL`,
    [ctx.ownerId, ctx.conversationId, ctx.runId],
  );
  for (const link of proposalLinks) predecessors.add(link.predecessor);
  const tails = rows.filter((row) => !predecessors.has(row.invocation_id));
  if (tails.length > 1) throw stateConflict('ambiguous document edit chain');
  const prior = tails[0];
  if (!prior) return undefined;
  if (prior.state !== 'completed') throw stateConflict('same-target edit not settled');
  const result = parseResult(prior.accepted_result);
  if (result.status !== 'ok') throw stateConflict('same-target edit not settled');
  if (result.result.kind === 'operation_error') return undefined;
  if (
    result.result.kind === 'edit_conflict' &&
    result.result.zero_write &&
    result.result.reason === 'version_changed' &&
    documentEvidenceLater(read.created_at, prior.accepted_at) &&
    documentEvidenceLater(read.accepted_at, prior.accepted_at)
  )
    return prior.invocation_id;
  if (
    result.result.kind === 'edit_applied' &&
    documentEvidenceLater(read.created_at, prior.accepted_at) &&
    documentEvidenceLater(read.accepted_at, prior.accepted_at) &&
    read.result.version === result.result.version &&
    read.result.content === prior.frozen_context.documentEdit?.exact_new_content &&
    read.result.byte_length === result.result.byte_length
  )
    return prior.invocation_id;
  throw stateConflict('same-target edit requires a fresh verified read');
}
