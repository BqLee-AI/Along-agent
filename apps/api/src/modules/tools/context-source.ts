import type { PoolClient } from 'pg';
import { HarnessObservationSchema, workspaceGrantSchema } from '@along/contracts';
import { HttpError, forbidden } from '../../http/errors.js';
import { assertToolRunBinding } from '../conversations/tool-binding.js';
import { validateWorkspaceGrant } from '../workspaces/service.js';
import { isActiveOwner } from '../identity/preferences.js';
import type { ToolContext } from './contracts.js';

export function contextSourceCorrupt(): HttpError {
  return new HttpError(422, 422, 'HARNESS_PROTOCOL_ERROR', '原接受工具来源缺失或损坏。');
}

export interface ContextSourceMetadata {
  invocation_id: string;
  tool_id: string;
  state: string;
  result_version: number | null;
  outcome_kind: string | null;
  frozen_context: { workspaceGrant?: unknown };
  result_status: string | null;
  kind: string | null;
  source: unknown;
  shape_valid: boolean;
  slice_length: number | null;
}

// These predicates inspect JSON in PostgreSQL. Only scalar metadata/counts cross
// the boundary; bootstrap never materializes the omitted arrays or text in JS.
const validFailures = `NOT EXISTS (
  SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p->'failures')='array' THEN p->'failures' ELSE '[]'::jsonb END) AS f(v)
  WHERE CASE WHEN jsonb_typeof(v)='object' THEN (v - ARRAY['kind','path','reason']) <> '{}'::jsonb ELSE true END
    OR v->>'kind' IS DISTINCT FROM 'operation_error'
    OR jsonb_typeof(v->'path') IS DISTINCT FROM 'string'
    OR jsonb_typeof(v->'reason') IS DISTINCT FROM 'string'
    OR v->>'reason' NOT IN ('not_found','unreadable','invalid_utf8','range_too_large','literal_not_found','literal_not_unique','unchanged','version_changed','unsupported_source')
)`;

export async function readContextSourceMetadata(
  client: PoolClient,
  ctx: ToolContext,
  invocationIds: readonly string[],
): Promise<Map<string, ContextSourceMetadata>> {
  await assertToolRunBinding(client, ctx);
  if (ctx.signal?.aborted) throw forbidden();
  if (invocationIds.length === 0) return new Map();
  const { rows } = await client.query<ContextSourceMetadata>(
    `SELECT invocation_id,tool_id,state,result_version,outcome_kind,frozen_context,
       accepted_result->>'status' AS result_status,p->>'kind' AS kind,
       CASE p->>'kind'
         WHEN 'read' THEN (p-'content') || jsonb_build_object('content_total',char_length(p->>'content'))
         WHEN 'list' THEN (p-ARRAY['entries','failures']) || jsonb_build_object(
           'entries_total',CASE WHEN jsonb_typeof(p->'entries')='array' THEN jsonb_array_length(p->'entries') END,
           'failures_total',CASE WHEN jsonb_typeof(p->'failures')='array' THEN jsonb_array_length(p->'failures') END)
         WHEN 'search' THEN (p-ARRAY['matches','failures']) || jsonb_build_object(
           'matches_total',CASE WHEN jsonb_typeof(p->'matches')='array' THEN jsonb_array_length(p->'matches') END,
           'failures_total',CASE WHEN jsonb_typeof(p->'failures')='array' THEN jsonb_array_length(p->'failures') END)
         WHEN 'context_slice' THEN p-ARRAY['content','items']
         ELSE NULL END AS source,
       CASE WHEN p->>'kind'='context_slice' THEN
         CASE WHEN jsonb_typeof(p->'content')='string' THEN char_length(p->>'content')
           WHEN jsonb_typeof(p->'items')='array' THEN jsonb_array_length(p->'items') END END AS slice_length,
       coalesce((CASE WHEN p->>'kind' IN ('read','list','search','context_slice')
         THEN (accepted_result - ARRAY['status','result'])='{}'::jsonb ELSE true END) AND CASE p->>'kind'
         WHEN 'read' THEN jsonb_typeof(p->'content')='string'
         WHEN 'list' THEN jsonb_typeof(p->'entries')='array' AND jsonb_typeof(p->'failures')='array'
           AND ${validFailures}
           AND NOT EXISTS (
             SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p->'entries')='array' THEN p->'entries' ELSE '[]'::jsonb END) AS e(v)
             WHERE CASE WHEN jsonb_typeof(v)='object' THEN (v-ARRAY['path','kind']) <> '{}'::jsonb ELSE true END
               OR jsonb_typeof(v->'path') IS DISTINCT FROM 'string' OR v->>'kind' NOT IN ('file','directory')
               OR jsonb_typeof(v->'kind') IS DISTINCT FROM 'string')
         WHEN 'search' THEN jsonb_typeof(p->'matches')='array' AND jsonb_typeof(p->'failures')='array'
           AND ${validFailures}
           AND NOT EXISTS (
             SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p->'matches')='array' THEN p->'matches' ELSE '[]'::jsonb END) AS m(v)
             WHERE CASE WHEN jsonb_typeof(v)='object' THEN (v-ARRAY['path','line','text','version']) <> '{}'::jsonb ELSE true END
               OR jsonb_typeof(v->'path') IS DISTINCT FROM 'string' OR jsonb_typeof(v->'text') IS DISTINCT FROM 'string'
               OR jsonb_typeof(v->'version') IS DISTINCT FROM 'string'
               OR CASE WHEN jsonb_typeof(v->'line')='number' THEN (v->>'line')::numeric < 1 OR trunc((v->>'line')::numeric) <> (v->>'line')::numeric ELSE true END)
         WHEN 'context_slice' THEN
           CASE WHEN p->>'source_kind'='read' THEN
             p->>'field'='content' AND p->>'unit'='unicode_scalar' AND jsonb_typeof(p->'content')='string' AND NOT (p ? 'items')
           ELSE p->>'unit'='items' AND jsonb_typeof(p->'items')='array' AND NOT (p ? 'content') END
         ELSE true END,false) AS shape_valid
     FROM tool_invocations CROSS JOIN LATERAL (SELECT accepted_result->'result' AS p) AS payload
     WHERE invocation_id=ANY($1::uuid[]) AND owner_id=$2 AND conversation_id=$3 AND run_id=$4`,
    [invocationIds, ctx.ownerId, ctx.conversationId, ctx.runId],
  );
  return new Map(rows.map((row) => [row.invocation_id, row]));
}

export function authorizeContextSource(ctx: ToolContext, row: ContextSourceMetadata): void {
  if (ctx.signal?.aborted || !ctx.allowlist.includes(row.tool_id)) throw forbidden();
  if (row.tool_id.startsWith('workspace_')) {
    const parsed = workspaceGrantSchema.safeParse(row.frozen_context.workspaceGrant);
    const current = ctx.workspaceGrant;
    if (!parsed.success || !current) throw forbidden();
    const grant = parsed.data;
    if (
      grant.workspace_id !== current.workspace_id ||
      grant.owner_id !== current.owner_id ||
      grant.registration_digest !== current.registration_digest ||
      grant.root_identity !== current.root_identity
    )
      throw forbidden();
    validateWorkspaceGrant(ctx.ownerId, grant);
  }
}

export async function authorizeSliceOrigin(
  client: PoolClient,
  ctx: ToolContext,
  row: ContextSourceMetadata,
  knownSources?: ReadonlyMap<string, ContextSourceMetadata>,
): Promise<void> {
  if (row.kind !== 'context_slice') return;
  if (row.tool_id !== 'read_run_observation') throw contextSourceCorrupt();
  const parsed = HarnessObservationSchema.safeParse({
    view: 'projected',
    invocation_id: row.invocation_id,
    tool_id: row.tool_id,
    outcome: 'ok',
    source: { ...(row.source as object), result_version: 1, omitted: true },
  });
  if (
    !parsed.success ||
    parsed.data.view !== 'projected' ||
    parsed.data.source.kind !== 'context_slice'
  )
    throw contextSourceCorrupt();
  const source = parsed.data.source;
  const origin =
    knownSources?.get(source.source_invocation_id) ??
    (await readContextSourceMetadata(client, ctx, [source.source_invocation_id])).get(
      source.source_invocation_id,
    );
  if (!origin || origin.state !== 'completed') throw forbidden();
  authorizeContextSource(ctx, origin);
  if (
    !origin.shape_valid ||
    origin.result_status !== 'ok' ||
    origin.outcome_kind !== 'success' ||
    origin.kind !== source.source_kind ||
    origin.tool_id !== source.source_tool_id ||
    origin.result_version !== source.source_result_version
  )
    throw contextSourceCorrupt();
  const original = HarnessObservationSchema.safeParse({
    view: 'projected',
    invocation_id: origin.invocation_id,
    tool_id: origin.tool_id,
    outcome: 'ok',
    source: { ...(origin.source as object), result_version: 1, omitted: true },
  });
  if (!original.success || original.data.view !== 'projected') throw contextSourceCorrupt();
  const fact = original.data.source;
  let total: number;
  if (
    fact.kind === 'read' &&
    source.field === 'content' &&
    source.unit === 'unicode_scalar' &&
    source.path === fact.path &&
    source.version === fact.version &&
    source.byte_length === fact.byte_length
  ) {
    total = fact.content_total;
  } else if (fact.kind === 'list' && source.unit === 'items' && source.field === 'entries') {
    total = fact.entries_total;
  } else if (fact.kind === 'search' && source.unit === 'items' && source.field === 'matches') {
    total = fact.matches_total;
  } else if (
    (fact.kind === 'list' || fact.kind === 'search') &&
    source.unit === 'items' &&
    source.field === 'failures'
  ) {
    total = fact.failures_total;
  } else throw contextSourceCorrupt();
  if (
    source.total !== total ||
    source.end < source.offset ||
    source.end - source.offset !== row.slice_length ||
    source.has_more !== source.end < total ||
    (source.offset < total && (source.end === source.offset || source.end > total)) ||
    (source.offset >= total && (source.end !== source.offset || source.has_more))
  )
    throw contextSourceCorrupt();
}

// Used before both initial acceptance and completed-page replay. No pool or
// locks: the caller supplies its existing transaction/Run authority boundary.
export async function assertContextSourceAuthorized(
  client: PoolClient,
  ctx: ToolContext,
  invocationId: string,
): Promise<ContextSourceMetadata> {
  if (!(await isActiveOwner(client, ctx.ownerId))) throw forbidden('owner authorization revoked');
  const row = (await readContextSourceMetadata(client, ctx, [invocationId])).get(invocationId);
  if (!row || row.state !== 'completed') throw forbidden();
  authorizeContextSource(ctx, row);
  if (row.result_version !== 1 || !row.shape_valid) throw contextSourceCorrupt();
  await authorizeSliceOrigin(client, ctx, row);
  return row;
}
