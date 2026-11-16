import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { workspaceGrantSchema } from '@along/contracts';
import {
  resolveFrozenWorkspaceGrant,
  validateWorkspaceGrant,
  hashBytes,
  utf8Bytes,
  canonicalWorkspaceFilename,
  getWorkspaceOutputIdentity,
} from '../workspaces/service.js';
import { compileWorkspaceEdit } from '../workspaces/replace.js';
import {
  documentEvidenceLater,
  isDocumentApplied,
  matchingDocumentApply,
  verifiedDocumentRead,
} from '../approvals/document-rules.js';
import { getDocumentApproval, listDocumentApprovals } from '../approvals/document-query.js';
import { readRunDocumentEvidence } from './query.js';
import type { DocumentReadEvidence } from '../approvals/document-evidence.js';
import { isActiveOwner } from '../identity/preferences.js';
import { withTransaction } from '../../db/transaction.js';
import { forbidden, notFound, stateConflict, HttpError } from '../../http/errors.js';
import { readFrozenToolApproval } from '../approvals/tool-result.js';
import {
  assertToolRunBinding,
  lockToolRunBinding as lockConversationToolBinding,
  lockToolEffectAcceptanceBinding,
} from '../conversations/tool-binding.js';
import { withRunTransaction } from '../conversations/run-ownership.js';
import type {
  InvocationInput,
  ReservationInput,
  ToolContext,
  ToolOutcome,
  ToolResult,
} from './contracts.js';
import { parseResult, resultKind } from './result-schema.js';
import { bindDocumentApprovalApply } from '../approvals/document-service.js';
import { readDocumentApprovalReceipt } from '../approvals/decision.js';
import {
  ReadRunObservationInputSchema,
  WorkspaceApplyReplaceInputSchema,
  WorkspaceReplaceInputSchema,
  DELEGATED_WORKSPACE_READ_SCHEMAS,
  DelegatedWorkspaceProposeInputSchema,
  WorkspaceCreateInputSchema,
} from './schemas.js';
import { assertContextSourceAuthorized } from './context-source.js';
import { hydrateWorkspaceReadResult, readAcceptedInvocationResult } from './accepted-result.js';

const HASH_DOMAIN = 'along/tool-args/v1\0';
const frozenSchema = z
  .object({
    confirmedTimezone: z.string().nullable(),
    anchorReceivedAtUtc: z.string(),
    receivedAtUtc: z.string(),
    foldChoice: z.enum(['first', 'second', 'none']),
    rulesetId: z.string(),
    tzdbVersion: z.string(),
    aliasVersion: z.string(),
    available: z.boolean(),
    workspaceGrant: workspaceGrantSchema.nullable().optional(),
    documentApprovalId: z.string().uuid().optional(),
    authorizationRevision: z.literal('delegation/1').optional(),
    documentEdit: z
      .object({
        base_read_invocation_id: z.string().uuid(),
        relative_path: z.string(),
        base_version: z.string(),
        exact_new_content: z.string().optional(),
        new_version: z.string().optional(),
        operation_error: z
          .enum(['literal_not_found', 'literal_not_unique', 'unchanged'])
          .optional(),
        replaces_invocation_id: z.string().uuid().optional(),
      })
      .strict()
      .optional(),
    documentCreate: z
      .object({
        output_directory: z.string(),
        directory_identity: z.string(),
        relative_path: z.string(),
        content_base64: z
          .string()
          .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
        new_version: z.string(),
        replaces_invocation_id: z.string().uuid().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
const invocationSchema = z.object({
  invocation_id: z.string().uuid(),
  owner_id: z.string().uuid(),
  conversation_id: z.string().uuid(),
  run_id: z.string().uuid(),
  tool_id: z.string(),
  args_hash: z.string(),
  args_bytes: z.number().int(),
  execution_kind: z.enum(['local', 'read_only', 'non_transactional']),
  frozen_context: frozenSchema,
  state: z.enum(['reserved', 'unknown', 'completed']),
  outcome_kind: z.string().nullable(),
  accepted_result: z.unknown(),
  result_version: z.number().nullable(),
  approval_id: z.string().uuid().nullable(),
});
type Invocation = z.infer<typeof invocationSchema>;

// JSON identity is computed before tool schemas supply defaults. Nothing here
// trims strings, normalizes Unicode, or persists the original arguments.
function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (
    typeof value === 'object' &&
    value !== null &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    const entries: [string, unknown][] = Object.entries(value);
    entries.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
  }
  throw stateConflict('tool arguments must be JSON');
}
export function digestInvocationArgs(args: unknown): { argsHash: string; argsBytes: number } {
  const canonical = canonicalJson(args);
  return {
    argsHash: createHash('sha256').update(HASH_DOMAIN).update(canonical).digest('hex'),
    argsBytes: Buffer.byteLength(canonical, 'utf8'),
  };
}

// Only explicit, trusted domain failures become durable failed results. In
// particular pg errors and unknown exceptions must abort the whole transaction.
export class ToolExecutionError extends Error {
  constructor() {
    super('tool execution failed');
  }
}
const failed: ToolResult = {
  status: 'failed',
  error: { code: 'TOOL_ERROR', message: '工具执行失败；本次调用不会自动重试。' },
};
const unknown: ToolResult = {
  status: 'unknown',
  error: { code: 'TOOL_EFFECT_UNKNOWN', message: '工具效果尚未确认；不会自动再次执行。' },
};
const denied: ToolResult = {
  status: 'denied',
  error: { code: 'TOOL_FORBIDDEN', message: '当前无权访问此工具调用。' },
};
const permissionDenied: ToolResult = {
  status: 'denied',
  error: { code: 'TOOL_DENIED', message: 'tool not in allowlist' },
};

// Conversations owns execution qualification; tools owns the immutable result
// ledger. Keep the permission-stop check under the same Run lock as acceptance.
async function lockToolRunBinding(client: PoolClient, ctx: ToolContext) {
  const binding = await lockConversationToolBinding(client, ctx);
  if (!binding.canExecute || ctx.authorizationRevision !== 'delegation/1') return binding;
  const result = await client.query<{ denied: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM tool_invocations
       WHERE owner_id=$1 AND conversation_id=$2 AND run_id=$3
         AND (state='unknown' OR (state='completed'
           AND accepted_result->>'status'='denied'
           AND accepted_result->'error'->>'code' IN ('TOOL_FORBIDDEN','TOOL_DENIED')))
     ) AS denied`,
    [ctx.ownerId, ctx.conversationId, ctx.runId],
  );
  return { canExecute: !result.rows[0]!.denied };
}

function freezeContext(ctx: ToolContext): z.infer<typeof frozenSchema> {
  return {
    confirmedTimezone: ctx.confirmedTimezone,
    anchorReceivedAtUtc: ctx.anchorReceivedAtUtc,
    receivedAtUtc: ctx.receivedAtUtc,
    foldChoice: ctx.foldChoice,
    rulesetId: ctx.timeContext.ruleset_id,
    tzdbVersion: ctx.timeContext.tzdb_version,
    aliasVersion: ctx.timeContext.available ? ctx.timeContext.aliases.version : 'unavailable',
    available: ctx.timeContext.available,
    workspaceGrant: ctx.workspaceGrant ?? null,
    ...(ctx.authorizationRevision ? { authorizationRevision: ctx.authorizationRevision } : {}),
  };
}
function workspaceAuthorized(ctx: ToolContext, row: Invocation): boolean {
  if (!row.tool_id.startsWith('workspace_')) return true;
  const grant = row.frozen_context.workspaceGrant;
  if (
    !grant ||
    (ctx.authorizationRevision === 'delegation/1'
      ? !ctx.workspaceGrants?.some((item) => canonicalJson(item) === canonicalJson(grant))
      : canonicalJson(grant) !== canonicalJson(ctx.workspaceGrant ?? null))
  )
    return false;
  try {
    validateWorkspaceGrant(ctx.ownerId, grant);
    return true;
  } catch {
    return false;
  }
}

function executionContext(ctx: ToolContext, row: Invocation): ToolContext {
  const frozen = row.frozen_context;
  if (ctx.authorizationRevision !== frozen.authorizationRevision)
    throw forbidden('authorization revision differs from frozen invocation');
  if (
    frozen.workspaceGrant &&
    (ctx.authorizationRevision === 'delegation/1'
      ? !ctx.workspaceGrants?.some(
          (item) => canonicalJson(item) === canonicalJson(frozen.workspaceGrant),
        )
      : canonicalJson(frozen.workspaceGrant) !== canonicalJson(ctx.workspaceGrant ?? null))
  )
    throw forbidden('workspace grant differs from frozen invocation');
  if (frozen.workspaceGrant) validateWorkspaceGrant(ctx.ownerId, frozen.workspaceGrant);
  if (
    frozen.available &&
    (!ctx.timeContext.available ||
      ctx.timeContext.ruleset_id !== frozen.rulesetId ||
      ctx.timeContext.tzdb_version !== frozen.tzdbVersion ||
      ctx.timeContext.aliases.version !== frozen.aliasVersion)
  ) {
    throw new HttpError(503, 400006, 'TZDB_UNAVAILABLE', '预约的时间规则版本暂不可用。');
  }
  return {
    ...ctx,
    workspaceGrant: frozen.workspaceGrant ?? null,
    documentEdit: frozen.documentEdit,
    documentCreate: frozen.documentCreate,
    confirmedTimezone: frozen.confirmedTimezone,
    anchorReceivedAtUtc: frozen.anchorReceivedAtUtc,
    receivedAtUtc: frozen.receivedAtUtc,
    foldChoice: frozen.foldChoice,
    timeContext: frozen.available
      ? ctx.timeContext
      : {
          available: false,
          ruleset_id: frozen.rulesetId,
          tzdb_version: frozen.tzdbVersion,
          missing: [],
        },
  };
}

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

export function reserveInvocation(
  pool: Pool,
  ctx: ToolContext,
  input: ReservationInput,
): Promise<{ invocationId: string }>;
export function reserveInvocation(
  pool: Pool,
  ctx: ToolContext,
  input: ReservationInput,
  options: { deferOnPause: true },
): Promise<{ invocationId: string } | { pauseRequested: true }>;
export async function reserveInvocation(
  pool: Pool,
  ctx: ToolContext,
  input: ReservationInput,
  options?: { deferOnPause: true },
): Promise<{ invocationId: string } | { pauseRequested: true }> {
  const digest = digestInvocationArgs(input.args);
  if (input.callKey.length === 0 || input.callKey.length > 200)
    throw stateConflict('invalid tool call slot');
  return withRunTransaction(pool, ctx.ownership, async (client) => {
    const binding = await lockToolRunBinding(client, ctx);
    const existing = await client.query(
      'SELECT * FROM tool_invocations WHERE run_id = $1 AND call_key = $2 FOR UPDATE',
      [ctx.runId, input.callKey],
    );
    if (existing.rows[0]) {
      const row = invocationSchema.parse(existing.rows[0]);
      if (row.owner_id !== ctx.ownerId || row.conversation_id !== ctx.conversationId)
        throw forbidden();
      if (
        row.tool_id !== input.toolId ||
        row.args_hash !== digest.argsHash ||
        row.args_bytes !== digest.argsBytes ||
        row.execution_kind !== input.executionKind
      )
        throw stateConflict('tool call slot content conflict');
      return { invocationId: row.invocation_id };
    }
    if (!binding.canExecute) throw stateConflict('Run/attempt cannot reserve new tool execution');
    // Pause registration takes the same attempt → Run locks, so the
    // reservation and pause request have a single ordering.
    if (options?.deferOnPause) {
      const pending = await client.query(
        `SELECT 1 FROM harness_pauses WHERE owner_id=$1 AND run_id=$2 AND attempt_id=$3 AND state='pending'`,
        [ctx.ownerId, ctx.runId, ctx.attemptId],
      );
      if (pending.rowCount) return { pauseRequested: true };
    }
    if (input.toolId === 'workspace_create' && ctx.authorizationRevision !== 'delegation/1')
      throw forbidden();
    let selected = ctx.workspaceGrant ?? null;
    let documentEdit: ToolContext['documentEdit'];
    let documentCreate: ToolContext['documentCreate'];
    if (ctx.authorizationRevision === 'delegation/1' && input.toolId.startsWith('workspace_')) {
      const grants = ctx.workspaceGrants ?? [];
      if (
        input.toolId === 'workspace_list' ||
        input.toolId === 'workspace_grep' ||
        input.toolId === 'workspace_read'
      ) {
        const args = DELEGATED_WORKSPACE_READ_SCHEMAS[input.toolId].parse(input.args);
        selected = resolveFrozenWorkspaceGrant(ctx.ownerId, grants, args.workspace_id);
      } else if (input.toolId === 'workspace_apply_replace') {
        const args = WorkspaceApplyReplaceInputSchema.parse(input.args);
        const approval = await getDocumentApproval(client, ctx.ownerId, args.approval_id);
        if (approval.conversation_id !== ctx.conversationId || approval.run_id !== ctx.runId)
          throw forbidden();
        selected = resolveFrozenWorkspaceGrant(ctx.ownerId, grants, approval.workspace_id);
        if (canonicalJson(selected) !== canonicalJson(approval.workspace_grant)) throw forbidden();
      } else if (input.toolId === 'workspace_create') {
        if (!ctx.allowlist.includes(input.toolId) || input.executionKind !== 'non_transactional')
          throw forbidden();
        const args = WorkspaceCreateInputSchema.parse(input.args);
        selected = resolveFrozenWorkspaceGrant(ctx.ownerId, grants, args.workspace_id);
        const directoryIdentity = await getWorkspaceOutputIdentity(
          ctx.ownerId,
          selected,
          args.output_directory,
        );
        const filename = canonicalWorkspaceFilename(args.filename);
        const relativePath = args.output_directory
          ? `${args.output_directory}/${filename}`
          : filename;
        const bytes = utf8Bytes(args.content);
        const contentBase64 = bytes.toString('base64');
        const approvals = (
          await listDocumentApprovals(client, ctx.ownerId, ctx.conversationId, ctx.runId)
        ).filter(
          (item) => item.workspace_id === args.workspace_id && item.relative_path === relativePath,
        );
        const actions = await client.query(
          `SELECT 1 FROM tool_invocations WHERE owner_id=$1 AND conversation_id=$2 AND run_id=$3
           AND frozen_context->'workspaceGrant'->>'workspace_id'=$4
           AND ((tool_id IN ('workspace_replace','workspace_propose_replace')
             AND frozen_context->'documentEdit'->>'relative_path'=$5)
             OR (tool_id='workspace_create' AND frozen_context->'documentCreate'->>'relative_path'=$5))
           AND (state<>'completed' OR coalesce(accepted_result->'result'->>'kind','') NOT IN ('create_conflict','create_failed','operation_error'))`,
          [ctx.ownerId, ctx.conversationId, ctx.runId, args.workspace_id, relativePath],
        );
        if (approvals.length || actions.rowCount) {
          const evidence = await readRunDocumentEvidence(client, ctx);
          const read = evidence.reads
            .filter(
              (item) =>
                item.workspace_id === args.workspace_id &&
                item.relative_path === relativePath &&
                item.registration_digest === selected!.registration_digest,
            )
            .at(-1);
          if (!read) throw stateConflict('same-target action requires a fresh verified read');
          await assertDocumentTargetAvailable(client, ctx, read);
        }
        documentCreate = {
          output_directory: args.output_directory,
          directory_identity: directoryIdentity,
          relative_path: relativePath,
          content_base64: contentBase64,
          new_version: hashBytes(bytes),
        };
      } else if (
        input.toolId === 'workspace_replace' ||
        input.toolId === 'workspace_propose_replace'
      ) {
        const args = (
          input.toolId === 'workspace_replace'
            ? WorkspaceReplaceInputSchema
            : DelegatedWorkspaceProposeInputSchema
        ).parse(input.args);
        const evidence = await readRunDocumentEvidence(client, ctx);
        const read = evidence.reads.find((item) => item.invocation_id === args.read_invocation_id);
        if (!read) throw forbidden('edit requires accepted same-Run full read');
        selected = resolveFrozenWorkspaceGrant(ctx.ownerId, grants, read.workspace_id);
        const summary = validateWorkspaceGrant(ctx.ownerId, selected);
        if (
          read.registration_digest !== selected.registration_digest ||
          !summary.writable_paths.includes(read.relative_path) ||
          hashBytes(utf8Bytes(read.result.content)) !== read.result.version ||
          utf8Bytes(read.result.content).length !== read.result.byte_length
        )
          throw forbidden();
        const replaces = await assertDocumentTargetAvailable(client, ctx, read, {
          proposal: input.toolId === 'workspace_propose_replace',
        });
        const compiled = compileWorkspaceEdit(read.result.content, args.change);
        documentEdit = {
          base_read_invocation_id: read.invocation_id,
          relative_path: read.relative_path,
          base_version: read.result.version,
          ...(compiled.ok
            ? { exact_new_content: compiled.exact_new_content, new_version: compiled.new_version }
            : { operation_error: compiled.reason }),
          ...(replaces ? { replaces_invocation_id: replaces } : {}),
        };
      } else throw forbidden();
    }
    if (selected) validateWorkspaceGrant(ctx.ownerId, selected);
    const invocationId = randomUUID();
    await client.query(
      `INSERT INTO tool_invocations (invocation_id, owner_id, conversation_id, run_id, call_key,
        first_attempt_id, first_request_id, tool_id, args_hash, args_bytes, execution_kind, frozen_context)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)`,
      [
        invocationId,
        ctx.ownerId,
        ctx.conversationId,
        ctx.runId,
        input.callKey,
        ctx.attemptId,
        ctx.requestId,
        input.toolId,
        digest.argsHash,
        digest.argsBytes,
        input.executionKind,
        JSON.stringify({
          ...freezeContext({ ...ctx, workspaceGrant: selected }),
          ...(documentEdit ? { documentEdit } : {}),
          ...(documentCreate ? { documentCreate } : {}),
          ...(input.toolId === 'workspace_apply_replace'
            ? { documentApprovalId: WorkspaceApplyReplaceInputSchema.parse(input.args).approval_id }
            : {}),
        }),
      ],
    );
    if (input.toolId === 'workspace_apply_replace') {
      const args = WorkspaceApplyReplaceInputSchema.parse(input.args);
      if (!selected || input.executionKind !== 'non_transactional') throw forbidden();
      await bindDocumentApprovalApply(client, {
        ownerId: ctx.ownerId,
        conversationId: ctx.conversationId,
        runId: ctx.runId,
        workspaceGrant: selected,
        approvalId: args.approval_id,
        invocationId,
      });
    }
    return { invocationId };
  });
}

async function loadInvocation(
  client: PoolClient,
  ctx: ToolContext,
  input: InvocationInput,
  acceptingExternalFact = false,
): Promise<{ row: Invocation; canExecute: boolean }> {
  const binding = await (
    acceptingExternalFact ? lockToolEffectAcceptanceBinding : lockToolRunBinding
  )(client, ctx);
  const result = await client.query(
    `SELECT * FROM tool_invocations WHERE invocation_id = $1 AND owner_id = $2 AND run_id = $3 AND conversation_id = $4 FOR UPDATE`,
    [input.invocationId, ctx.ownerId, ctx.runId, ctx.conversationId],
  );
  if (!result.rows[0]) throw notFound('tool invocation not found');
  return { row: invocationSchema.parse(result.rows[0]), canExecute: binding.canExecute };
}
async function audit(
  client: PoolClient,
  ctx: ToolContext,
  row: Invocation,
  kind: string,
  result: ToolResult,
  hash = row.args_hash,
): Promise<void> {
  const approvalId =
    result.status === 'ok' && result.result.kind === 'approval'
      ? result.result.approval.approvalId
      : null;
  await client.query(
    `INSERT INTO tool_calls (id,owner_id,run_id,attempt_id,tool_id,args_hash,decision,approval_id,error_code,invocation_id,request_id,record_kind,outcome_kind)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      randomUUID(),
      ctx.ownerId,
      ctx.runId,
      ctx.attemptId,
      row.tool_id,
      hash,
      result.status === 'denied' ? 'deny' : 'allow',
      approvalId,
      result.status === 'ok'
        ? result.result.kind === 'time_error'
          ? result.result.error.code
          : null
        : result.error.code,
      row.invocation_id,
      ctx.requestId,
      kind,
      resultKind(result),
    ],
  );
}

export interface InvocationSnapshot {
  invocation_id: string;
  tool_id: string;
  result: ToolResult;
}

// Bootstrap reads accepted facts only. No invocation/attempt/Run locks are
// acquired here: callers may already hold attempt → Run locks, and historical
// reads remain valid after suspension or completion.
export async function readInvocationSnapshots(
  client: PoolClient,
  ctx: ToolContext,
  invocationIds: readonly string[],
): Promise<InvocationSnapshot[]> {
  await assertToolRunBinding(client, ctx);
  if (invocationIds.length === 0) return [];
  const { rows } = await client.query(
    `SELECT * FROM tool_invocations
     WHERE invocation_id = ANY($1::uuid[]) AND owner_id = $2
       AND conversation_id = $3 AND run_id = $4`,
    [invocationIds, ctx.ownerId, ctx.conversationId, ctx.runId],
  );
  const invocations = new Map(
    rows.map((row) => {
      const parsed = invocationSchema.parse(row);
      return [parsed.invocation_id, parsed] as const;
    }),
  );
  const snapshots: InvocationSnapshot[] = [];
  for (const invocationId of invocationIds) {
    const row = invocations.get(invocationId);
    if (!row) throw notFound('tool invocation not found');
    if (row.state !== 'completed') throw stateConflict('tool invocation has no accepted result');
    if (!workspaceAuthorized(ctx, row)) throw forbidden('workspace authorization revoked');
    const accepted = parseResult(await readAcceptedInvocationResult(client, ctx, row));
    if (resultKind(accepted) !== row.outcome_kind)
      throw stateConflict('invalid accepted tool result');
    snapshots.push({
      invocation_id: row.invocation_id,
      tool_id: row.tool_id,
      result: ctx.allowlist.includes(row.tool_id) ? accepted : permissionDenied,
    });
  }
  return snapshots;
}

const runInvocationStateSchema = z
  .object({
    invocation_id: z.string().uuid(),
    call_key: z.string(),
    tool_id: z.string(),
    approval_ref: z
      .object({
        kind: z.enum(['task', 'document']),
        approval_id: z.string().uuid(),
      })
      .strict()
      .nullable(),
    state: z.enum(['reserved', 'unknown', 'completed']),
    outcome_kind: z
      .enum(['success', 'approval_pending', 'clarification', 'time_error', 'denied', 'failed'])
      .nullable(),
    approval_id: z.string().uuid().nullable(),
  })
  .strict();
export type RunInvocationState = z.infer<typeof runInvocationStateSchema>;

export async function readRunInvocationStates(
  client: PoolClient,
  ctx: Pick<ToolContext, 'ownerId' | 'conversationId' | 'runId'>,
): Promise<RunInvocationState[]> {
  await assertToolRunBinding(client, ctx);
  const { rows } = await client.query(
    `SELECT invocation_id, call_key, tool_id, state, outcome_kind, approval_id FROM tool_invocations
     WHERE owner_id = $1 AND conversation_id = $2 AND run_id = $3
     ORDER BY created_at, invocation_id`,
    [ctx.ownerId, ctx.conversationId, ctx.runId],
  );
  return rows.map((row) => {
    const approvalRef =
      row.approval_id && row.outcome_kind === 'approval_pending'
        ? {
            kind: row.tool_id === 'workspace_propose_replace' ? 'document' : 'task',
            approval_id: row.approval_id,
          }
        : null;
    if (
      approvalRef?.kind === 'task' &&
      !['propose_task', 'request_cancel_task'].includes(row.tool_id)
    )
      throw stateConflict('invalid task approval tool reference');
    return runInvocationStateSchema.parse({ ...row, approval_ref: approvalRef });
  });
}
async function accept(
  client: PoolClient,
  ctx: ToolContext,
  row: Invocation,
  value: ToolResult,
  recordKind: string,
  evidenceRef: string | null = null,
  fileIdentity?: string,
): Promise<ToolResult> {
  const result = parseResult(value);
  if (result.status === 'unknown') throw stateConflict('unknown is not a completed tool result');
  if (
    result.status === 'ok' &&
    (result.result.kind === 'create_applied' ||
      result.result.kind === 'create_conflict' ||
      result.result.kind === 'create_failed')
  ) {
    const target = row.frozen_context.documentCreate;
    const grant = row.frozen_context.workspaceGrant;
    const payload = result.result;
    if (
      row.tool_id !== 'workspace_create' ||
      row.frozen_context.authorizationRevision !== 'delegation/1' ||
      !target ||
      !grant ||
      payload.workspace_id !== grant.workspace_id ||
      payload.path !== target.relative_path ||
      payload.invocation_id !== row.invocation_id ||
      payload.args_hash !== row.args_hash ||
      (payload.kind === 'create_applied' &&
        (!fileIdentity ||
          payload.version !== target.new_version ||
          payload.byte_length !== Buffer.from(target.content_base64, 'base64').length ||
          payload.evidence_ref !== `workspace-create:${row.invocation_id}:${target.new_version}` ||
          evidenceRef !== payload.evidence_ref))
    )
      throw stateConflict('invalid create effect evidence');
  }
  let stored: unknown = result;
  let approvalId: string | null = null;
  if (result.status === 'ok' && result.result.kind === 'create_applied')
    stored = { ...result, file_identity: fileIdentity };
  if (result.status === 'ok' && result.result.kind === 'approval') {
    const approval = result.result.approval;
    const receipt = {
      approvalId: approval.approvalId,
      fireAtUtc: approval.fireAtUtc,
      presentationHash: approval.presentationHash,
      presentationVersion: approval.presentationVersion,
    };
    const frozen = await readFrozenToolApproval(client, { ownerId: ctx.ownerId, ...receipt });
    if (canonicalJson(frozen) !== canonicalJson(result.result))
      throw stateConflict('tool approval differs from frozen receipt');
    stored = receipt;
    approvalId = approval.approvalId;
  }
  if (result.status === 'ok' && result.result.kind === 'document_approval') {
    if (row.tool_id !== 'workspace_propose_replace')
      throw stateConflict('invalid document proposal tool');
    const approval = await readDocumentApprovalReceipt(
      client,
      ctx.ownerId,
      result.result.approval.approval_id,
    );
    if (
      canonicalJson(approval) !== canonicalJson(result.result.approval) ||
      approval.run_id !== ctx.runId
    )
      throw stateConflict('document approval differs from frozen receipt');
    approvalId = approval.approval_id;
    stored = {
      kind: 'document_approval_receipt',
      approval_id: approvalId,
      presentation_hash: approval.presentation_hash,
    };
  }
  if (
    result.status === 'ok' &&
    (result.result.kind === 'context_slice' ||
      (result.result.kind === 'operation_error' &&
        result.result.reason === 'unsupported_source')) &&
    row.tool_id !== 'read_run_observation'
  )
    throw stateConflict('context result requires observation reader');
  const logical = JSON.stringify(stored);
  const logicalBytes = Buffer.byteLength(logical, 'utf8');
  const serialized = logical.includes('\\u0000')
    ? JSON.stringify({
        encoding: 'json-base64/1',
        data: Buffer.from(logical, 'utf8').toString('base64'),
      })
    : logical;
  if (logicalBytes > 240000) throw stateConflict('tool result exceeds safe snapshot bound');
  if (result.status === 'ok' && result.result.kind === 'context_slice' && logicalBytes > 16384)
    throw stateConflict('context page exceeds safe snapshot bound');
  await client.query(
    `UPDATE tool_invocations SET state = 'completed', outcome_kind = $2, result_version = 1,
       accepted_result = $3::jsonb, approval_id = $4, accepted_attempt_id = $5,
       accepted_request_id = $6, accepted_at = clock_timestamp(), evidence_ref = $7 WHERE invocation_id = $1`,
    [
      row.invocation_id,
      resultKind(result),
      serialized,
      approvalId,
      ctx.attemptId,
      ctx.requestId,
      evidenceRef,
    ],
  );
  await audit(client, ctx, row, recordKind, result);
  return result;
}
async function gate(
  client: PoolClient,
  ctx: ToolContext,
  row: Invocation,
  input: InvocationInput,
  canExecute: boolean,
): Promise<ToolOutcome | null> {
  const digest = digestInvocationArgs(input.args);
  if (
    !(await isActiveOwner(
      client,
      ctx.ownerId,
      ['create_reminder', 'cancel_reminder'].includes(row.tool_id) ? { lock: 'share' } : {},
    ))
  ) {
    await audit(client, ctx, row, 'denied', denied);
    return { ...denied, invocationId: row.invocation_id, replayed: false };
  }
  if (
    row.tool_id !== input.toolId ||
    row.args_hash !== digest.argsHash ||
    row.args_bytes !== digest.argsBytes
  ) {
    const conflict: ToolResult = {
      status: 'denied',
      error: { code: 'STATE_CONFLICT', message: '调用引用的工具或内容不一致。' },
    };
    await audit(client, ctx, row, 'denied', conflict, digest.argsHash);
    return { ...conflict, invocationId: row.invocation_id, replayed: false };
  }
  if (!workspaceAuthorized(ctx, row) || ctx.signal?.aborted) {
    await audit(client, ctx, row, 'denied', denied);
    return { ...denied, invocationId: row.invocation_id, replayed: false };
  }
  if (!ctx.allowlist.includes(row.tool_id)) {
    if (row.state === 'reserved') await accept(client, ctx, row, permissionDenied, 'denied');
    else await audit(client, ctx, row, 'denied', permissionDenied);
    return { ...permissionDenied, invocationId: row.invocation_id, replayed: false };
  }
  if (
    ['set_user_timezone', 'create_reminder', 'get_task', 'cancel_reminder'].includes(row.tool_id) &&
    (ctx.authorizationRevision !== 'delegation/1' ||
      row.frozen_context.authorizationRevision !== 'delegation/1')
  ) {
    if (row.state === 'reserved') await accept(client, ctx, row, denied, 'denied');
    else await audit(client, ctx, row, 'denied', denied);
    return { ...denied, invocationId: row.invocation_id, replayed: false };
  }
  if (row.tool_id === 'read_run_observation') {
    if (!canExecute || ctx.signal?.aborted) {
      await audit(client, ctx, row, 'denied', denied);
      return { ...denied, invocationId: row.invocation_id, replayed: false };
    }
    const parsed = ReadRunObservationInputSchema.safeParse(input.args);
    let authorized = parsed.success;
    if (parsed.success) {
      try {
        await assertContextSourceAuthorized(client, ctx, parsed.data.source_invocation_id);
      } catch (error) {
        if (!(error instanceof HttpError) || error.httpStatus !== 403) throw error;
        authorized = false;
      }
    }
    if (!authorized) {
      if (row.state === 'reserved') await accept(client, ctx, row, denied, 'denied');
      else await audit(client, ctx, row, 'denied', denied);
      return { ...denied, invocationId: row.invocation_id, replayed: false };
    }
  }
  if (row.state === 'completed') {
    const result = await readAcceptedInvocationResult(client, ctx, row);
    await audit(client, ctx, row, 'replayed', result);
    return { ...result, invocationId: row.invocation_id, replayed: true };
  }
  if (row.state === 'reserved' && !canExecute) {
    await audit(client, ctx, row, 'denied', denied);
    return { ...denied, invocationId: row.invocation_id, replayed: false };
  }
  return null;
}

export async function executeLocalInvocation(
  pool: Pool,
  ctx: ToolContext,
  input: InvocationInput,
  execute: (client: PoolClient, frozenContext: ToolContext) => Promise<ToolResult>,
): Promise<ToolOutcome> {
  return withRunTransaction(pool, ctx.ownership, async (client) => {
    const { row, canExecute } = await loadInvocation(client, ctx, input);
    const gated = await gate(client, ctx, row, input, canExecute);
    if (gated) return gated;
    if (row.execution_kind === 'non_transactional' || row.state !== 'reserved')
      throw stateConflict('invocation requires non-transactional coordinator');
    const frozenContext = executionContext(ctx, row);
    await client.query('SAVEPOINT tool_business');
    let result: ToolResult;
    try {
      result = await execute(client, frozenContext);
    } catch (error) {
      if (!(error instanceof ToolExecutionError)) throw error;
      result = failed;
    }
    if (result.status === 'failed') {
      await client.query('ROLLBACK TO SAVEPOINT tool_business');
      result = failed;
    }
    await client.query('RELEASE SAVEPOINT tool_business');
    const accepted = await accept(
      client,
      ctx,
      row,
      result,
      result.status === 'failed' ? 'failed' : 'accepted',
    );
    return { ...accepted, invocationId: row.invocation_id, replayed: false };
  });
}

// External reads hold no attempt, Run or invocation locks while waiting for IO.
// Concurrent reads may observe different versions; only the first acceptance is
// authoritative, and later readers return that immutable snapshot.
export async function executeReadOnlyInvocation(
  pool: Pool,
  ctx: ToolContext,
  input: InvocationInput,
  execute: (frozenContext: ToolContext) => Promise<ToolResult>,
): Promise<ToolOutcome> {
  const qualified = await withRunTransaction(pool, ctx.ownership, async (client) => {
    const { row, canExecute } = await loadInvocation(client, ctx, input);
    const gated = await gate(client, ctx, row, input, canExecute);
    if (gated) return { outcome: gated, frozen: null };
    if (row.execution_kind !== 'read_only' || row.state !== 'reserved')
      throw stateConflict('invocation is not a reserved read');
    return { outcome: null, frozen: executionContext(ctx, row) };
  });
  if (qualified.outcome) return qualified.outcome;
  let observed: ToolResult;
  try {
    ctx.signal?.throwIfAborted();
    observed = await execute(qualified.frozen!);
  } catch (error) {
    if (!(error instanceof ToolExecutionError) && !ctx.signal?.aborted) throw error;
    observed = failed;
  }
  return withRunTransaction(pool, ctx.ownership, async (client) => {
    const { row, canExecute } = await loadInvocation(client, ctx, input);
    // Revalidate before replay, too: a read which was already in flight must
    // not disclose its peer's accepted content after cancellation/revocation.
    if (!canExecute || ctx.signal?.aborted) {
      await audit(client, ctx, row, 'denied', denied);
      return { ...denied, invocationId: row.invocation_id, replayed: false };
    }
    const gated = await gate(client, ctx, row, input, canExecute);
    if (gated) return gated;
    executionContext(ctx, row);
    const accepted = await accept(client, ctx, row, observed, 'accepted');
    return { ...accepted, invocationId: row.invocation_id, replayed: false };
  }).catch((error: unknown) => {
    if (error instanceof HttpError && error.httpStatus === 403)
      return { ...denied, invocationId: input.invocationId, replayed: false };
    throw error;
  });
}

export interface EffectBinding {
  invocationId: string;
  argsHash: string;
}
export interface EffectEvidence extends EffectBinding {
  evidenceRef: string;
  result: ToolResult;
  fileIdentity?: string;
}
export interface NotAppliedEvidence extends EffectBinding {
  evidenceRef: string;
  notApplied: true;
}
export interface NonTransactionalCapabilities {
  validateDispatch?: (
    client: PoolClient,
    context: ToolContext,
    binding: EffectBinding,
  ) => Promise<void>;
  execute: (binding: EffectBinding) => Promise<EffectEvidence | NotAppliedEvidence>;
  reconcile?: (binding: EffectBinding) => Promise<EffectEvidence | NotAppliedEvidence | null>;
}
const evidenceSchema = z.union([
  z
    .object({
      invocationId: z.string().uuid(),
      argsHash: z.string().regex(/^[a-f0-9]{64}$/),
      evidenceRef: z.string().min(1).max(512),
      result: z.unknown(),
      fileIdentity: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      invocationId: z.string().uuid(),
      argsHash: z.string().regex(/^[a-f0-9]{64}$/),
      evidenceRef: z.string().min(1).max(512),
      notApplied: z.literal(true),
    })
    .strict(),
]);

// Only the stack receiving a successful reserved->unknown COMMIT may execute.
// Never retry a COMMIT, dispatch, or external action after an uncertain answer.
export async function executeNonTransactionalInvocation(
  pool: Pool,
  ctx: ToolContext,
  input: InvocationInput,
  capabilities: NonTransactionalCapabilities,
): Promise<ToolOutcome> {
  let permitPrepared = false;
  const dispatch = await withRunTransaction(pool, ctx.ownership, async (client) => {
    const { row, canExecute } = await loadInvocation(client, ctx, input);
    const gated = await gate(client, ctx, row, input, canExecute);
    if (gated)
      return {
        outcome: gated,
        permission: false,
        binding: { invocationId: row.invocation_id, argsHash: row.args_hash },
      };
    if (row.execution_kind !== 'non_transactional')
      throw stateConflict('invocation is not non-transactional');
    const binding = { invocationId: row.invocation_id, argsHash: row.args_hash };
    if (row.state === 'unknown') {
      await audit(client, ctx, row, 'unknown', unknown);
      return { outcome: null, permission: false, binding };
    }
    const frozen = executionContext(ctx, row);
    await capabilities.validateDispatch?.(client, frozen, binding);
    await client.query("UPDATE tool_invocations SET state = 'unknown' WHERE invocation_id = $1", [
      row.invocation_id,
    ]);
    await audit(client, ctx, row, 'dispatch', unknown);
    permitPrepared = true;
    return { outcome: null, permission: true, binding };
  }).catch((error: unknown) => {
    if (!permitPrepared) throw error;
    return {
      outcome: { ...unknown, invocationId: input.invocationId, replayed: false },
      permission: false,
      binding: {
        invocationId: input.invocationId,
        argsHash: digestInvocationArgs(input.args).argsHash,
      },
    };
  });
  if (dispatch.outcome) return dispatch.outcome;
  let observed: EffectEvidence | NotAppliedEvidence | null;
  if (dispatch.permission) {
    if (ctx.ownership) {
      await withRunTransaction(pool, ctx.ownership, async (client) => {
        const binding = await lockConversationToolBinding(client, ctx);
        if (!binding.canExecute) throw stateConflict('Run cannot dispatch tool execution');
      });
      ctx.signal?.throwIfAborted();
      ctx.ownership.signal.throwIfAborted();
    }
    try {
      observed = await capabilities.execute(dispatch.binding);
    } catch {
      observed = null;
    }
  } else if (capabilities.reconcile) {
    // Reconciliation capability is read-only, and cannot grant execution.
    observed = await capabilities.reconcile(dispatch.binding);
  } else observed = null;
  if (!observed)
    return { ...unknown, invocationId: input.invocationId, replayed: !dispatch.permission };
  const evidence = evidenceSchema.parse(observed);
  if (
    evidence.invocationId !== dispatch.binding.invocationId ||
    evidence.argsHash !== dispatch.binding.argsHash
  )
    throw stateConflict('effect evidence does not bind invocation/content');
  const result = 'notApplied' in evidence ? failed : parseResult(evidence.result);
  if (
    result.status === 'unknown' ||
    (result.status === 'ok' &&
      (result.result.kind === 'approval' || result.result.kind === 'document_approval'))
  )
    throw stateConflict('invalid external effect evidence');
  if (
    result.status === 'ok' &&
    (result.result.kind === 'applied' ||
      result.result.kind === 'conflict' ||
      result.result.kind === 'edit_applied' ||
      result.result.kind === 'edit_conflict' ||
      result.result.kind === 'create_applied' ||
      result.result.kind === 'create_conflict' ||
      result.result.kind === 'create_failed')
  ) {
    if (
      result.result.invocation_id !== dispatch.binding.invocationId ||
      result.result.args_hash !== dispatch.binding.argsHash
    )
      throw stateConflict('workspace effect payload does not bind invocation/content');
  }
  const accounted = await withTransaction(pool, async (client) => {
    const { row, canExecute } = await loadInvocation(client, ctx, input, true);
    const disclose =
      !ctx.ownership &&
      (await isActiveOwner(client, ctx.ownerId)) &&
      ctx.allowlist.includes(row.tool_id) &&
      workspaceAuthorized(ctx, row) &&
      (!row.tool_id.startsWith('workspace_') || (canExecute && !ctx.signal?.aborted));
    // Record external facts even after cancellation, but never disclose them
    // through a currently revoked allowlist.
    if (row.state === 'completed' && !disclose) {
      await audit(client, ctx, row, 'denied', permissionDenied);
      return { ...permissionDenied, invocationId: row.invocation_id, replayed: false };
    }
    if (row.state === 'completed') {
      const accepted = await readAcceptedInvocationResult(client, ctx, row);
      if (canonicalJson(accepted) !== canonicalJson(result))
        throw stateConflict('conflicting external effect evidence');
      await audit(client, ctx, row, 'replayed', accepted);
      return { ...accepted, invocationId: row.invocation_id, replayed: true };
    }
    if (row.state !== 'unknown') throw stateConflict('external effect was not dispatched');
    const accepted = await accept(
      client,
      ctx,
      row,
      result,
      dispatch.permission ? 'accepted' : 'reconciled',
      evidence.evidenceRef,
      'result' in evidence ? evidence.fileIdentity : undefined,
    );
    if (!disclose) {
      await audit(client, ctx, row, 'denied', permissionDenied);
      return { ...permissionDenied, invocationId: row.invocation_id, replayed: false };
    }
    return { ...accepted, invocationId: row.invocation_id, replayed: false };
  }).catch((error: unknown) => {
    if (
      error instanceof HttpError &&
      input.toolId !== 'workspace_replace' &&
      input.toolId !== 'workspace_create'
    )
      throw error;
    // A durable once-permit already committed. Acceptance/COMMIT failure does
    // not permit redispatch, nor can it turn external evidence into success.
    return { ...unknown, invocationId: input.invocationId, replayed: false };
  });
  if (!ctx.ownership || accounted.status === 'unknown') return accounted;
  try {
    return await withRunTransaction(pool, ctx.ownership, async (client) => {
      ctx.signal?.throwIfAborted();
      const { row, canExecute } = await loadInvocation(client, ctx, input);
      if (
        !canExecute ||
        row.state !== 'completed' ||
        !ctx.allowlist.includes(row.tool_id) ||
        !workspaceAuthorized(ctx, row)
      )
        return { ...permissionDenied, invocationId: row.invocation_id, replayed: false };
      const accepted = await readAcceptedInvocationResult(client, ctx, row);
      if (canonicalJson(accepted) !== canonicalJson(result))
        throw stateConflict('conflicting external effect evidence');
      return { ...accepted, invocationId: row.invocation_id, replayed: !dispatch.permission };
    });
  } catch {
    return { ...permissionDenied, invocationId: input.invocationId, replayed: false };
  }
}
