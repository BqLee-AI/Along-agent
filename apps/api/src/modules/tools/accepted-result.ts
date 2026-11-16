import type { PoolClient } from 'pg';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { HarnessMemorySourceSchema, ReadMemorySourceInputSchema } from '@along/contracts';
import { forbidden, stateConflict, validationError } from '../../http/errors.js';
import { readDocumentApprovalReceipt } from '../approvals/decision.js';
import { readFrozenToolApproval } from '../approvals/tool-result.js';
import { readCreatedTaskReceipt } from '../tasks/create.js';
import { hashBytes, strictUtf8 } from '../workspaces/service.js';
import type { ToolContext, ToolResult } from './contracts.js';
import { approvalReceiptSchema, parseResult, resultKind } from './result-schema.js';
import { conversationMemorySources, readMemorySource } from '../conversations/memory-sources.js';
import { validateMemoryRevisions } from '../memory/authorization.js';
import { validateRecallReceipt } from '../memory/recall-receipt.js';
import type { MemoryService } from '../memory/service.js';

/** Revalidate the accepted recall and source ownership within the caller's transaction. */
export async function readMemorySourceForRecall(
  client: PoolClient,
  ctx: Pick<ToolContext, 'ownerId' | 'conversationId' | 'runId'>,
  service: Pick<MemoryService, 'validateRecallInTransaction'>,
  rawInput: z.infer<typeof ReadMemorySourceInputSchema>,
): Promise<z.infer<typeof HarnessMemorySourceSchema>> {
  const profile = await client.query<{ profile: string | null }>(
    `SELECT frozen_context->>'execution_profile' AS profile FROM agent_runs
     WHERE id=$1 AND owner_id=$2 AND conversation_id=$3 FOR SHARE`,
    [ctx.runId, ctx.ownerId, ctx.conversationId],
  );
  if (profile.rows[0]?.profile !== 'compact-memory/1') throw forbidden('memory source unavailable');
  const input = ReadMemorySourceInputSchema.parse(rawInput);
  const rows = await client.query<{
    invocation_id: string;
    tool_id: string;
    result_version: number | null;
    approval_id: string | null;
    outcome_kind: string | null;
    accepted_result: unknown;
  }>(
    `SELECT invocation_id,tool_id,result_version,approval_id,outcome_kind,accepted_result FROM tool_invocations
     WHERE invocation_id=$1 AND owner_id=$2 AND conversation_id=$3 AND run_id=$4
       AND tool_id='recall_memories' AND state='completed' FOR SHARE`,
    [input.recall_invocation_id, ctx.ownerId, ctx.conversationId, ctx.runId],
  );
  const row = rows.rows[0];
  if (!row) throw forbidden('memory source unavailable');
  const accepted = await readAcceptedInvocationResult(client, ctx, row);
  if (accepted.status !== 'ok' || accepted.result.kind !== 'memory_recall')
    throw forbidden('memory source unavailable');
  await validateRecallReceipt(
    client,
    service,
    ctx.ownerId,
    input.recall_invocation_id,
    accepted.result.items.map((item) => item.memory_id),
  );
  const item = accepted.result.items.find((candidate) => candidate.memory_id === input.memory_id);
  if (!item || !item.message_ids.includes(input.message_id))
    throw forbidden('memory source unavailable');
  const source = await readMemorySource(client, {
    ownerId: ctx.ownerId,
    conversationId: item.conversation_id,
    messageId: input.message_id,
  });
  let total = 0;
  let content = '';
  for (const scalar of source.content) {
    if (total >= input.offset && total - input.offset < input.limit) content += scalar;
    total++;
  }
  if (input.offset > total) throw validationError('memory source offset out of range');
  const end = Math.min(total, input.offset + input.limit);
  return HarnessMemorySourceSchema.parse({
    kind: 'memory_source',
    recall_invocation_id: input.recall_invocation_id,
    memory_id: input.memory_id,
    conversation_id: item.conversation_id,
    message_id: input.message_id,
    role: source.role,
    content,
    offset: input.offset,
    end,
    total,
    has_more: end < total,
  });
}

export async function validateAcceptedMemoryObservation(
  client: PoolClient,
  ctx: Pick<ToolContext, 'ownerId' | 'conversationId' | 'runId'>,
  invocationId: string,
  result: ToolResult,
): Promise<void> {
  if (result.status !== 'ok') return;
  const verifier = {
    validateRecallInTransaction: (
      transaction: PoolClient,
      ownerId: string,
      items: { id: string; revision: number }[],
    ) => validateMemoryRevisions(transaction, conversationMemorySources, ownerId, items),
  };
  if (result.result.kind === 'memory_recall') {
    await validateRecallReceipt(
      client,
      verifier,
      ctx.ownerId,
      invocationId,
      result.result.items.map((item) => item.memory_id),
    );
  } else if (result.result.kind === 'memory_source') {
    const source = result.result;
    const current = await readMemorySourceForRecall(client, ctx, verifier, {
      recall_invocation_id: source.recall_invocation_id,
      memory_id: source.memory_id,
      message_id: source.message_id,
      offset: source.offset,
      limit: Math.max(1, source.end - source.offset),
    });
    if (!isDeepStrictEqual(source, current)) throw stateConflict('memory source changed');
  }
}

const documentReceiptSchema = z
  .object({
    kind: z.literal('document_approval_receipt'),
    approval_id: z.string().uuid(),
    presentation_hash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export function decodeWorkspaceContent(encoded: string): { bytes: Buffer; content: string } {
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded)
    throw stateConflict('invalid encoded workspace content');
  try {
    const content = strictUtf8(bytes);
    if (!Buffer.from(content, 'utf8').equals(bytes)) throw new Error('invalid UTF-8');
    return { bytes, content };
  } catch {
    throw stateConflict('invalid encoded workspace content');
  }
}

// PostgreSQL jsonb cannot represent U+0000. Only the private ledger encoding
// differs; all tool results returned to callers retain the ordinary schema.
export function hydrateWorkspaceReadResult(value: unknown): ToolResult {
  const encoded = z
    .object({
      encoding: z.literal('json-base64/1'),
      data: z.string(),
    })
    .strict()
    .safeParse(value);
  if (encoded.success) {
    const { content } = decodeWorkspaceContent(encoded.data.data);
    try {
      value = JSON.parse(content) as unknown;
    } catch {
      throw stateConflict('invalid encoded tool result');
    }
  }
  const created = z
    .object({
      status: z.literal('ok'),
      result: z.unknown(),
      file_identity: z.string().min(1),
    })
    .strict()
    .safeParse(value);
  if (created.success) {
    const result = parseResult({ status: 'ok', result: created.data.result });
    if (result.status !== 'ok' || result.result.kind !== 'create_applied')
      throw stateConflict('invalid private creation identity');
    return result;
  }
  const result = parseResult(value);
  if (result.status === 'ok' && result.result.kind === 'create_applied')
    throw stateConflict('missing private creation identity');
  return result;
}

// Callers authorize content reads. Internal terminal accounting may hydrate
// already-bound facts after revocation, without authorizing any disclosure.
export async function readAcceptedInvocationResult(
  client: PoolClient,
  ctx: Pick<ToolContext, 'ownerId' | 'runId'>,
  row: {
    invocation_id: string;
    args_hash?: string;
    frozen_context?: unknown;
    result_version: number | null;
    tool_id: string;
    approval_id: string | null;
    accepted_result?: unknown;
    outcome_kind: string | null;
  },
): Promise<ToolResult> {
  if (row.result_version !== 1) throw stateConflict('unsupported tool result version');
  if (row.approval_id && row.tool_id === 'workspace_propose_replace') {
    const receipt = documentReceiptSchema.parse(row.accepted_result);
    if (receipt.approval_id !== row.approval_id)
      throw stateConflict('document receipt reference conflict');
    const approval = await readDocumentApprovalReceipt(client, ctx.ownerId, row.approval_id);
    if (approval.presentation_hash !== receipt.presentation_hash || approval.run_id !== ctx.runId)
      throw stateConflict('document receipt differs from frozen approval');
    return { status: 'ok', result: { kind: 'document_approval', approval } };
  }
  if (row.approval_id && row.tool_id !== 'workspace_apply_replace') {
    const receipt = approvalReceiptSchema.parse(row.accepted_result);
    if (receipt.approvalId !== row.approval_id)
      throw stateConflict('approval result reference conflict');
    return {
      status: 'ok',
      result: await readFrozenToolApproval(client, { ownerId: ctx.ownerId, ...receipt }),
    };
  }
  const result = hydrateWorkspaceReadResult(row.accepted_result);
  if (result.status === 'unknown' || resultKind(result) !== row.outcome_kind)
    throw stateConflict('invalid accepted tool result');
  if (
    result.status === 'ok' &&
    (result.result.kind === 'create_applied' ||
      result.result.kind === 'create_conflict' ||
      result.result.kind === 'create_failed')
  ) {
    const frozen = z
      .object({
        authorizationRevision: z.literal('delegation/1'),
        workspaceGrant: z.object({ workspace_id: z.string() }).passthrough(),
        documentCreate: z
          .object({
            relative_path: z.string(),
            content_base64: z.string(),
            new_version: z.string(),
          })
          .passthrough(),
      })
      .passthrough()
      .safeParse(row.frozen_context);
    const payload = result.result;
    if (
      !frozen.success ||
      row.tool_id !== 'workspace_create' ||
      row.approval_id !== null ||
      payload.invocation_id !== row.invocation_id ||
      (row.args_hash !== undefined && payload.args_hash !== row.args_hash) ||
      payload.workspace_id !== frozen.data.workspaceGrant.workspace_id ||
      payload.path !== frozen.data.documentCreate.relative_path
    )
      throw stateConflict('invalid accepted workspace creation');
    const target = frozen.data.documentCreate;
    const { bytes } = decodeWorkspaceContent(target.content_base64);
    if (
      hashBytes(bytes) !== target.new_version ||
      (payload.kind === 'create_applied' &&
        (payload.version !== target.new_version ||
          payload.byte_length !== bytes.length ||
          payload.evidence_ref !== `workspace-create:${row.invocation_id}:${target.new_version}`))
    )
      throw stateConflict('invalid accepted workspace creation evidence');
  }
  if (result.status === 'ok' && result.result.kind === 'task_created') {
    const payload = result.result;
    const frozen = row.frozen_context as { authorizationRevision?: unknown } | null;
    const task = await readCreatedTaskReceipt(client, {
      ownerId: ctx.ownerId,
      invocationId: row.invocation_id,
    });
    if (
      row.tool_id !== 'create_reminder' ||
      row.approval_id !== null ||
      frozen?.authorizationRevision !== 'delegation/1' ||
      !task ||
      Object.entries(task).some(
        ([key, value]) => !isDeepStrictEqual(value, payload[key as keyof typeof task]),
      )
    )
      throw stateConflict('invalid accepted reminder creation');
  }
  return result;
}
