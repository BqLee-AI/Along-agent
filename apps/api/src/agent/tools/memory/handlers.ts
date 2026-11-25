import { httpStatusForError } from '@along/contracts';
import type { Pool, PoolClient } from 'pg';
import { isDeepStrictEqual } from 'node:util';
import { ApplicationError } from '../../../platform/errors.js';
import {
  createMemoryService,
  type MemoryService,
  loadMemorySemanticConfig,
  saveRecallReceipt,
  validateRecallReceipt,
} from '../../../features/memory/public.js';
import {
  conversationMemorySources,
  readMemoryRunSource,
} from '../../../features/conversations/public.js';
import { TOOL_INPUT_SCHEMAS } from '../schemas.js';
import type { MemoryRecallPayload, ToolContext, ToolOutcome, ToolResult } from '../contracts.js';
import { executeLocalInvocation, executeReadOnlyInvocation } from '../invocations/invocations.js';
import { readMemorySourceForRecall } from '../invocations/accepted-result.js';
import { workspaceDenied } from '../handler-common.js';

export function invokeMemorySource(
  pool: Pool,
  ctx: ToolContext,
  input: { invocationId: string; toolId: string; args: unknown },
): Promise<ToolOutcome> {
  const memory = createMemoryService({ pool, sources: conversationMemorySources });
  const parsed = TOOL_INPUT_SCHEMAS.read_memory_source.safeParse(input.args);
  return executeLocalInvocation(
    pool,
    ctx,
    input,
    async (client, frozen) => {
      if (!parsed.success) return workspaceDenied();
      try {
        return {
          status: 'ok',
          result: await readMemorySourceForRecall(client, frozen, memory, parsed.data),
        };
      } catch (error) {
        if (
          error instanceof ApplicationError &&
          [400, 403, 404, 409].includes(httpStatusForError(error.code))
        )
          return workspaceDenied();
        throw error;
      }
    },
    async (client, accepted) => {
      if (accepted.status !== 'ok') return true;
      if (!parsed.success || accepted.result.kind !== 'memory_source') return false;
      try {
        const current = await readMemorySourceForRecall(client, ctx, memory, parsed.data);
        return isDeepStrictEqual(current, accepted.result);
      } catch (error) {
        if (
          error instanceof ApplicationError &&
          [400, 403, 404, 409].includes(httpStatusForError(error.code))
        )
          return false;
        throw error;
      }
    },
  );
}

export function invokeMemoryRecall(
  pool: Pool,
  ctx: ToolContext,
  input: { invocationId: string; toolId: string; args: unknown },
): Promise<ToolOutcome> {
  let memory: MemoryService | undefined;
  const revisions: { id: string; revision: number }[] = [];
  return executeReadOnlyInvocation(
    pool,
    ctx,
    input,
    async (frozen) => {
      const parsed = TOOL_INPUT_SCHEMAS.recall_memories.safeParse(input.args);
      if (!parsed.success) return workspaceDenied();
      const binding = await pool.query<{ profile: string | null }>(
        `SELECT frozen_context->>'execution_profile' AS profile FROM agent_runs
           WHERE id=$1 AND owner_id=$2 AND conversation_id=$3`,
        [frozen.runId, frozen.ownerId, frozen.conversationId],
      );
      const compactMemory = binding.rows[0]?.profile === 'compact-memory/1';
      memory = createMemoryService({
        pool,
        sources: conversationMemorySources,
        ...(compactMemory ? { semantic: loadMemorySemanticConfig(process.env) } : {}),
      });
      const result = await memory.recall(frozen.ownerId, parsed.data, ctx.signal, compactMemory);
      const items: MemoryRecallPayload['items'] = [];
      let bytes = 0;
      for (const item of result.items) {
        const projected = {
          memory_id: item.id,
          content: item.content,
          ...(compactMemory ? { match: item.match } : {}),
          conversation_id: item.conversationId,
          message_ids: item.messageIds,
          created_at: item.createdAt,
          updated_at: item.updatedAt,
        };
        const size = Buffer.byteLength(JSON.stringify(projected), 'utf8') + 1;
        if (bytes + size > 220_000) break;
        bytes += size;
        items.push(projected);
        revisions.push({ id: item.id, revision: item.revision });
      }
      return {
        status: 'ok',
        result: {
          kind: 'memory_recall',
          completeness: items.length < result.items.length ? 'incomplete' : result.completeness,
          items,
        },
      };
    },
    async (client, observed) => {
      if (observed.status !== 'ok' || observed.result.kind !== 'memory_recall') return;
      if (!memory) throw new Error('memory recall context unavailable');
      await saveRecallReceipt(client, ctx.ownerId, input.invocationId, revisions);
      await validateRecallReceipt(
        client,
        memory,
        ctx.ownerId,
        input.invocationId,
        observed.result.items.map((item) => item.memory_id),
      );
    },
    async (client, accepted) => {
      if (accepted.status !== 'ok') return true;
      if (accepted.result.kind !== 'memory_recall') return false;
      try {
        await validateRecallReceipt(
          client,
          createMemoryService({ pool, sources: conversationMemorySources }),
          ctx.ownerId,
          input.invocationId,
          accepted.result.items.map((item) => item.memory_id),
        );
        return true;
      } catch (error) {
        if (
          error instanceof ApplicationError &&
          [403, 404, 409].includes(httpStatusForError(error.code))
        )
          return false;
        throw error;
      }
    },
  );
}

export async function runRememberMemory(
  pool: Pool,
  client: PoolClient,
  frozen: ToolContext,
  input: { invocationId: string; args: unknown },
): Promise<ToolResult> {
  const parsed = TOOL_INPUT_SCHEMAS.remember_memory.safeParse(input.args);
  if (!parsed.success) return workspaceDenied();
  const source = await readMemoryRunSource(client, frozen);
  const memory = await createMemoryService({
    pool,
    sources: conversationMemorySources,
  }).rememberInTransaction(client, frozen.ownerId, {
    conversationId: frozen.conversationId,
    messageIds: [source],
    content: parsed.data.content,
    idempotencyKey: input.invocationId,
  });
  return {
    status: 'ok',
    result: { kind: 'memory_saved', memory_id: memory.id, content: memory.content },
  };
}
