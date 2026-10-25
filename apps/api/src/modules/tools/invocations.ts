import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { withTransaction } from '../../db/transaction.js';
import { forbidden, notFound, stateConflict, HttpError } from '../../http/errors.js';
import { readFrozenToolApproval } from '../approvals/tool-result.js';
import { lockToolRunBinding } from '../conversations/tool-binding.js';
import type {
  InvocationInput,
  ReservationInput,
  ToolContext,
  ToolOutcome,
  ToolResult,
} from './contracts.js';
import { approvalReceiptSchema, parseResult, resultKind } from './result-schema.js';

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
  };
}
function executionContext(ctx: ToolContext, row: Invocation): ToolContext {
  const frozen = row.frozen_context;
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

export async function reserveInvocation(
  pool: Pool,
  ctx: ToolContext,
  input: ReservationInput,
): Promise<{ invocationId: string }> {
  const digest = digestInvocationArgs(input.args);
  if (input.callKey.length === 0 || input.callKey.length > 200)
    throw stateConflict('invalid tool call slot');
  return withTransaction(pool, async (client) => {
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
        JSON.stringify(freezeContext(ctx)),
      ],
    );
    return { invocationId };
  });
}

async function loadInvocation(
  client: PoolClient,
  ctx: ToolContext,
  input: InvocationInput,
): Promise<{ row: Invocation; canExecute: boolean }> {
  const binding = await lockToolRunBinding(client, ctx);
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
async function replay(client: PoolClient, ctx: ToolContext, row: Invocation): Promise<ToolResult> {
  if (row.result_version !== 1) throw stateConflict('unsupported tool result version');
  if (row.approval_id) {
    const receipt = approvalReceiptSchema.parse(row.accepted_result);
    if (receipt.approvalId !== row.approval_id)
      throw stateConflict('approval result reference conflict');
    return {
      status: 'ok',
      result: await readFrozenToolApproval(client, { ownerId: ctx.ownerId, ...receipt }),
    };
  }
  const result = parseResult(row.accepted_result);
  if (result.status === 'unknown' || resultKind(result) !== row.outcome_kind)
    throw stateConflict('invalid accepted tool result');
  return result;
}
async function accept(
  client: PoolClient,
  ctx: ToolContext,
  row: Invocation,
  value: ToolResult,
  recordKind: string,
  evidenceRef: string | null = null,
): Promise<ToolResult> {
  const result = parseResult(value);
  if (result.status === 'unknown') throw stateConflict('unknown is not a completed tool result');
  let stored: unknown = result;
  let approvalId: string | null = null;
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
  const serialized = JSON.stringify(stored);
  if (Buffer.byteLength(serialized, 'utf8') > 240000)
    throw stateConflict('tool result exceeds safe snapshot bound');
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
  if (!ctx.allowlist.includes(row.tool_id)) {
    if (row.state === 'reserved') await accept(client, ctx, row, permissionDenied, 'denied');
    else await audit(client, ctx, row, 'denied', permissionDenied);
    return { ...permissionDenied, invocationId: row.invocation_id, replayed: false };
  }
  if (row.state === 'completed') {
    const result = await replay(client, ctx, row);
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
  return withTransaction(pool, async (client) => {
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

export interface EffectBinding {
  invocationId: string;
  argsHash: string;
}
export interface EffectEvidence extends EffectBinding {
  evidenceRef: string;
  result: ToolResult;
}
export interface NotAppliedEvidence extends EffectBinding {
  evidenceRef: string;
  notApplied: true;
}
export interface NonTransactionalCapabilities {
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
  const dispatch = await withTransaction(pool, async (client) => {
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
    executionContext(ctx, row);
    await client.query("UPDATE tool_invocations SET state = 'unknown' WHERE invocation_id = $1", [
      row.invocation_id,
    ]);
    await audit(client, ctx, row, 'dispatch', unknown);
    return { outcome: null, permission: true, binding };
  });
  if (dispatch.outcome) return dispatch.outcome;
  let observed: EffectEvidence | NotAppliedEvidence | null;
  if (dispatch.permission) {
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
  if (result.status === 'unknown' || (result.status === 'ok' && result.result.kind === 'approval'))
    throw stateConflict('invalid external effect evidence');
  return withTransaction(pool, async (client) => {
    const { row } = await loadInvocation(client, ctx, input);
    // Record external facts even after cancellation, but never disclose them
    // through a currently revoked allowlist.
    if (row.state === 'completed' && !ctx.allowlist.includes(row.tool_id)) {
      await audit(client, ctx, row, 'denied', permissionDenied);
      return { ...permissionDenied, invocationId: row.invocation_id, replayed: false };
    }
    if (row.state === 'completed') {
      const accepted = await replay(client, ctx, row);
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
    );
    if (!ctx.allowlist.includes(row.tool_id)) {
      await audit(client, ctx, row, 'denied', permissionDenied);
      return { ...permissionDenied, invocationId: row.invocation_id, replayed: false };
    }
    return { ...accepted, invocationId: row.invocation_id, replayed: false };
  });
}
