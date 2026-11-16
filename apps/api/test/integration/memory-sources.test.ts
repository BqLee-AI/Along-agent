import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { withTransaction } from '../../src/db/transaction.js';
import {
  conversationMemorySources,
  readMemoryRunSource,
  readMemorySource,
} from '../../src/modules/conversations/memory-sources.js';
import { createIntegrationDatabase, databaseUrl, type IntegrationDatabase } from './setup.js';

const maybe = databaseUrl ? describe : describe.skip;

maybe('conversation memory sources', () => {
  let database: IntegrationDatabase;
  const ownerId = randomUUID();
  const otherOwner = randomUUID();
  const conversationId = randomUUID();
  const otherConversation = randomUUID();
  const user = randomUUID();
  const assistant = randomUUID();
  const system = randomUUID();
  const foreignOwnerMessage = randomUUID();
  const foreignConversationMessage = randomUUID();
  const runId = randomUUID();
  const assistantRun = randomUUID();
  const foreignRun = randomUUID();
  const missingInputRun = randomUUID();
  const binding = { ownerId, conversationId };

  beforeAll(async () => {
    database = await createIntegrationDatabase();
    const pool = database.pool;
    await pool.query('INSERT INTO conversations(id,owner_id) VALUES($1,$2),($3,$2)', [
      conversationId,
      ownerId,
      otherConversation,
    ]);
    await pool.query(
      `INSERT INTO messages(id,owner_id,conversation_id,role,content) VALUES
       ($1,$6,$7,'user','本人原话'),($2,$6,$7,'assistant','回复'),
       ($3,$6,$7,'system','hidden'),($4,$8,$7,'user','foreign owner'),
       ($5,$6,$9,'user','other conversation')`,
      [
        user,
        assistant,
        system,
        foreignOwnerMessage,
        foreignConversationMessage,
        ownerId,
        conversationId,
        otherOwner,
        otherConversation,
      ],
    );
    await pool.query(
      `INSERT INTO agent_runs(id,owner_id,conversation_id,agent_revision,mode,
         budget_max_iterations,budget_max_tokens,input_message_id)
       VALUES ($1,$5,$6,'test','chat',1,100,$7),
         ($2,$5,$6,'test','chat',1,100,$8),
         ($3,$9,$6,'test','chat',1,100,$7),
         ($4,$5,$6,'test','chat',1,100,NULL)`,
      [
        runId,
        assistantRun,
        foreignRun,
        missingInputRun,
        ownerId,
        conversationId,
        user,
        assistant,
        otherOwner,
      ],
    );
  });

  afterAll(async () => {
    await database?.close();
  });

  it('authorizes explicit and correction sources only for owner user messages', async () => {
    await withTransaction(database.pool, async (client) => {
      for (const purpose of ['explicit', 'correction'] as const) {
        const validate = (messageIds: string[], overrides = {}) =>
          conversationMemorySources.validate(client, {
            ...binding,
            messageIds,
            purpose,
            ...overrides,
          });
        await expect(validate([user, user])).resolves.toBeUndefined();
        for (const ids of [
          [],
          [assistant],
          [system],
          [foreignOwnerMessage],
          [foreignConversationMessage],
          [user, randomUUID()],
        ]) {
          await expect(validate(ids)).rejects.toThrow('memory source not found');
        }
        await expect(validate([user], { ownerId: otherOwner })).rejects.toThrow(
          'memory source not found',
        );
        await expect(validate([user], { conversationId: otherConversation })).rejects.toThrow(
          'memory source not found',
        );
      }
    });
  });

  it('allows owner-visible user and assistant reads but never compact qualification', async () => {
    await withTransaction(database.pool, async (client) => {
      const validate = (messageIds: string[]) =>
        conversationMemorySources.validate(client, { ...binding, messageIds, purpose: 'read' });
      await expect(validate([user, assistant])).resolves.toBeUndefined();
      for (const id of [system, foreignOwnerMessage, foreignConversationMessage, randomUUID()])
        await expect(validate([id])).rejects.toThrow('memory source not found');
      await expect(
        conversationMemorySources.validate(client, {
          ...binding,
          messageIds: [user],
          purpose: 'compact',
          summaryId: randomUUID(),
        }),
      ).rejects.toThrow('compact source is not published');
      await expect(readMemorySource(client, { ...binding, messageId: user })).resolves.toEqual({
        role: 'user',
        content: '本人原话',
      });
      await expect(readMemorySource(client, { ...binding, messageId: assistant })).resolves.toEqual(
        { role: 'assistant', content: '回复' },
      );
      for (const messageId of [
        system,
        foreignOwnerMessage,
        foreignConversationMessage,
        randomUUID(),
      ])
        await expect(readMemorySource(client, { ...binding, messageId })).rejects.toThrow(
          'memory source not found',
        );
      await expect(
        readMemorySource(client, { ...binding, ownerId: otherOwner, messageId: user }),
      ).rejects.toThrow('memory source not found');
      await expect(
        readMemorySource(client, {
          ...binding,
          conversationId: otherConversation,
          messageId: user,
        }),
      ).rejects.toThrow('memory source not found');
    });
  });

  it('binds Run sources to the accepted user message in the same owner conversation', async () => {
    await withTransaction(database.pool, async (client) => {
      await expect(readMemoryRunSource(client, { ...binding, runId })).resolves.toBe(user);
      for (const id of [assistantRun, foreignRun, missingInputRun, randomUUID()])
        await expect(readMemoryRunSource(client, { ...binding, runId: id })).rejects.toThrow(
          'Run source not found',
        );
      await expect(
        readMemoryRunSource(client, { ...binding, ownerId: otherOwner, runId }),
      ).rejects.toThrow('Run source not found');
      await expect(
        readMemoryRunSource(client, { ...binding, conversationId: otherConversation, runId }),
      ).rejects.toThrow('Run source not found');
    });
  });

  it('holds conversation and message locks through the caller transaction', async () => {
    const reader = await database.pool.connect();
    const writer = await database.pool.connect();
    try {
      await reader.query('BEGIN');
      await readMemorySource(reader, { ...binding, messageId: user });
      await writer.query('BEGIN');
      await writer.query("SET LOCAL lock_timeout='100ms'");
      await expect(
        writer.query('UPDATE messages SET content=$2 WHERE id=$1', [user, 'changed']),
      ).rejects.toMatchObject({ code: '55P03' });
      await writer.query('ROLLBACK');
      await writer.query('BEGIN');
      await writer.query("SET LOCAL lock_timeout='100ms'");
      await expect(
        writer.query('UPDATE conversations SET title=$2 WHERE id=$1', [conversationId, 'changed']),
      ).rejects.toMatchObject({ code: '55P03' });
    } finally {
      await writer.query('ROLLBACK');
      await reader.query('ROLLBACK');
      writer.release();
      reader.release();
    }
  });
});
