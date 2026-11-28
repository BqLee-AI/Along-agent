import { ConversationMessagePageSchema } from '@along/contracts';
import { z } from 'zod';
import { readEnvelope } from '@/shared/http/client';
import { api, writeOptions } from '@/shared/http/eden';
import { MeSchema } from '@/shared/session/identity';

const ManualCategorySchema = z.enum(['project', 'preference', 'goal']);
const memoryFields = {
  id: z.string().uuid(),
  ownerId: z.string().uuid(),
  content: z.string(),
  revision: z.number().int().positive(),
  status: z.enum(['active', 'stopped']),
  expiresAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
};
const ManualMemorySchema = z
  .object({
    ...memoryFields,
    sourceKind: z.literal('manual'),
    category: ManualCategorySchema,
    conversationId: z.null(),
    messageIds: z.tuple([]),
    summaryId: z.null(),
  })
  .strict();
const ConversationMemorySchema = z
  .object({
    ...memoryFields,
    sourceKind: z.enum(['explicit', 'compact']),
    category: z.null(),
    conversationId: z.string().uuid(),
    messageIds: z.array(z.string().uuid()).min(1),
    summaryId: z.string().uuid().nullable(),
  })
  .strict();
export const MemorySchema = z.discriminatedUnion('sourceKind', [
  ManualMemorySchema,
  ConversationMemorySchema,
]);
export const MemoryPageSchema = z
  .object({
    items: z.array(MemorySchema),
    nextCursor: z.string().nullable(),
  })
  .strict();
export type Memory = z.infer<typeof MemorySchema>;
export type ManualMemory = z.infer<typeof ManualMemorySchema>;
export type ConversationMemory = z.infer<typeof ConversationMemorySchema>;
export type ManualMemoryInput = { category: ManualMemory['category']; content: string };

export async function readMemories(cursor: string | null, signal: AbortSignal) {
  const query = { limit: '20', ...(cursor !== null ? { cursor } : {}) };
  return MemoryPageSchema.parse(
    await readEnvelope(await api.api.v1.memories.get({ query, fetch: { signal } })),
  );
}

export async function readMemory(id: string, signal: AbortSignal) {
  const value = MemorySchema.parse(
    await readEnvelope(
      await api.api.v1.memories({ id: encodeURIComponent(id) }).get({ fetch: { signal } }),
    ),
  );
  if (value.id !== id) throw new Error('记忆身份不匹配，未接纳读取结果。');
  return value;
}

export async function readSourceMessages(
  conversationId: string,
  cursor: string | null,
  signal: AbortSignal,
) {
  const query = { limit: '50', ...(cursor !== null ? { cursor } : {}) };
  return ConversationMessagePageSchema.parse(
    await readEnvelope(
      await api.api.v1
        .conversations({ id: encodeURIComponent(conversationId) })
        .messages.get({ query, fetch: { signal } }),
    ),
  );
}

async function memoryWriteOptions(signal: AbortSignal) {
  const me = MeSchema.parse(await readEnvelope(await api.api.v1.me.get({ fetch: { signal } })));
  if (!me.csrf_token) throw new Error('当前会话没有 CSRF 凭据，请重新登录。');
  return writeOptions(me.csrf_token, signal);
}

export async function createMemory(
  input: ManualMemoryInput & { idempotencyKey: string },
  signal: AbortSignal,
) {
  const result = ManualMemorySchema.parse(
    await readEnvelope(await api.api.v1.memories.post(input, await memoryWriteOptions(signal))),
  );
  if (
    result.category !== input.category ||
    result.content !== input.content ||
    result.revision !== 1 ||
    result.status !== 'active'
  )
    throw new Error('添加回执与提交内容不匹配，未确认保存结果。');
  return result;
}

export async function correctManualMemory(
  memory: ManualMemory,
  input: ManualMemoryInput,
  signal: AbortSignal,
) {
  const result = ManualMemorySchema.parse(
    await readEnvelope(
      await api.api.v1
        .memories({ id: encodeURIComponent(memory.id) })
        .actions['correct-manual'].post(
          { ...input, expectedRevision: memory.revision },
          await memoryWriteOptions(signal),
        ),
    ),
  );
  if (
    result.id !== memory.id ||
    result.revision !== memory.revision + 1 ||
    result.category !== input.category ||
    result.content !== input.content ||
    result.status !== 'active'
  )
    throw new Error('更正回执与原记忆不匹配，请重新读取。');
  return result;
}

export async function stopMemory(memory: Memory, signal: AbortSignal) {
  const result = z
    .object({ id: z.string().uuid(), status: z.literal('stopped') })
    .strict()
    .parse(
      await readEnvelope(
        await api.api.v1
          .memories({ id: encodeURIComponent(memory.id) })
          .actions['stop-recall'].post(
            { expectedRevision: memory.revision },
            await memoryWriteOptions(signal),
          ),
      ),
    );
  if (result.id !== memory.id) throw new Error('停止回执身份不匹配，请重新读取。');
  return result;
}

export async function correctMemory(
  memory: ConversationMemory,
  source: { message_id: string; role: 'user'; content: string },
  signal: AbortSignal,
) {
  const result = ConversationMemorySchema.parse(
    await readEnvelope(
      await api.api.v1.memories({ id: encodeURIComponent(memory.id) }).actions.correct.post(
        {
          content: source.content,
          conversationId: memory.conversationId,
          messageIds: [source.message_id],
          expectedRevision: memory.revision,
          expiresAt: memory.expiresAt,
        },
        await memoryWriteOptions(signal),
      ),
    ),
  );
  if (result.id !== memory.id || result.revision <= memory.revision)
    throw new Error('更正回执与原记忆不匹配，请重新读取。');
  return result;
}
