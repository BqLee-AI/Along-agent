import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { forbidden } from '../../src/platform/errors.js';
import { createMemoryService, type MemoryService } from '../../src/features/memory/service.js';
import type { MemorySources } from '../../src/features/memory/types.js';
import { createIntegrationDatabase, databaseUrl, type IntegrationDatabase } from './setup.js';

const maybe = databaseUrl ? describe : describe.skip;

maybe('owner memory service', () => {
  let database: IntegrationDatabase;
  let pool: Pool;
  const owner = randomUUID();
  const other = randomUUID();
  const conversation = randomUUID();
  const message = randomUUID();
  const correction = randomUUID();
  const summary = randomUUID();
  let readable = true;
  let compactAuthorized = false;
  const sources: MemorySources = {
    async validate(_client, input) {
      if (
        !readable ||
        input.ownerId !== owner ||
        input.conversationId !== conversation ||
        input.messageIds.some((id) => id !== message && id !== correction) ||
        (input.purpose === 'compact' && (!compactAuthorized || input.summaryId !== summary))
      )
        throw forbidden();
    },
  };
  let memory: MemoryService;
  beforeAll(async () => {
    database = await createIntegrationDatabase();
    pool = database.pool;
    memory = createMemoryService({ pool, sources });
  });
  afterAll(async () => {
    await database?.close();
  });

  it('persists only authorized sources, isolates owners, replays, and searches literally', async () => {
    const input = {
      conversationId: conversation,
      messageIds: [message],
      content: '编号 XQ-4792',
      idempotencyKey: randomUUID(),
    };
    const saved = await memory.remember(owner, input);
    expect(saved).toMatchObject({
      ownerId: owner,
      messageIds: [message],
      content: input.content,
      revision: 1,
      sourceKind: 'explicit',
    });
    expect((await memory.remember(owner, input)).id).toBe(saved.id);
    await expect(memory.remember(owner, { ...input, content: 'changed' })).rejects.toThrow();
    await expect(
      memory.remember(other, { ...input, idempotencyKey: randomUUID() }),
    ).rejects.toThrow();
    await expect(
      memory.remember(owner, {
        ...input,
        messageIds: [randomUUID()],
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toThrow();
    expect(await memory.get(other, saved.id)).toBeNull();
    expect(await memory.recall(other, { query: 'XQ-4792' })).toEqual({
      items: [],
      completeness: 'degraded',
      candidateOnly: true,
    });
    expect(
      (await memory.recall(owner, { query: 'XQ-4792' })).items.map((item) => item.id),
    ).toContain(saved.id);
    const unmatched = await memory.recall(owner, { query: 'XQ-4793' });
    expect(unmatched).toMatchObject({ completeness: 'degraded', candidateOnly: true });
    expect(unmatched.items).toContainEqual(
      expect.objectContaining({ id: saved.id, match: 'unfiltered' }),
    );
    readable = false;
    expect(await memory.get(owner, saved.id)).toBeNull();
    expect((await memory.recall(owner, { query: 'XQ-4792' })).items).toEqual([]);
    readable = true;
  });

  it('keeps correction history, rejects stale revisions and removes stopped memories', async () => {
    const saved = await memory.remember(owner, {
      conversationId: conversation,
      messageIds: [message],
      content: 'old value',
      idempotencyKey: randomUUID(),
    });
    const revised = await memory.correct(owner, saved.id, {
      conversationId: conversation,
      messageIds: [correction],
      content: 'new value',
      expectedRevision: 1,
    });
    expect(revised).toMatchObject({ revision: 2, content: 'new value', messageIds: [correction] });
    await expect(
      memory.correct(owner, saved.id, {
        conversationId: conversation,
        messageIds: [message],
        content: 'stale',
        expectedRevision: 1,
      }),
    ).rejects.toThrow();
    expect((await memory.recall(owner, { query: 'old value' })).items).not.toContainEqual(
      expect.objectContaining({ id: saved.id, revision: 1 }),
    );
    const history = await pool.query(
      'SELECT content, message_ids FROM r3_memory_revisions WHERE owner_id=$1 AND memory_id=$2 ORDER BY revision',
      [owner, saved.id],
    );
    expect(history.rows).toEqual([
      { content: 'old value', message_ids: [message] },
      { content: 'new value', message_ids: [correction] },
    ]);
    await memory.stopRecall(owner, saved.id, 2);
    expect(await memory.get(owner, saved.id)).toBeNull();
    expect(
      (await memory.recall(owner, { query: 'new value' })).items.some(
        (item) => item.id === saved.id,
      ),
    ).toBe(false);
  });

  it('requires compact qualification and respects expiry', async () => {
    const input = {
      conversationId: conversation,
      messageIds: [message],
      content: 'compact fact',
      idempotencyKey: randomUUID(),
      summaryId: summary,
    };
    await expect(memory.rememberCompact(owner, input)).rejects.toThrow();
    compactAuthorized = true;
    const saved = await memory.rememberCompact(owner, input);
    expect(saved).toMatchObject({ sourceKind: 'compact', summaryId: summary });
    compactAuthorized = false;
    const expired = await memory.remember(owner, {
      conversationId: conversation,
      messageIds: [message],
      content: 'expired fact',
      idempotencyKey: randomUUID(),
      expiresAt: '2000-01-01T00:00:00.000Z',
    });
    expect(await memory.get(owner, expired.id)).toBeNull();
    expect(
      (await memory.recall(owner, { query: 'expired fact' })).items.some(
        (item) => item.id === expired.id,
      ),
    ).toBe(false);
  });

  it('offers bounded recent unfiltered candidates on an unmatched general query', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) {
      const saved = await memory.remember(owner, {
        conversationId: conversation,
        messageIds: [message],
        content: i === 6 ? '我喜欢无糖茉莉花茶' : `无关资料 ${i}`,
        idempotencyKey: randomUUID(),
      });
      ids.push(saved.id);
      await pool.query('UPDATE r3_memories SET updated_at=$2 WHERE id=$1', [
        saved.id,
        new Date(Date.now() + i * 1000),
      ]);
    }
    const result = await memory.recall(owner, { query: '饮品偏好' });
    expect(result).toMatchObject({ completeness: 'degraded', candidateOnly: true });
    expect(result.items).toHaveLength(5);
    expect(result.items.map((item) => item.id)).toEqual(ids.slice(2).reverse());
    expect(result.items.every((item) => item.match === 'unfiltered')).toBe(true);
    expect((await memory.recall(other, { query: '饮品偏好' })).items).toEqual([]);
    for (const id of ids) await memory.stopRecall(owner, id, 1);
  });

  it('revalidates the current owner revision and its source before disclosure', async () => {
    const saved = await memory.remember(owner, {
      conversationId: conversation,
      messageIds: [message],
      content: 'source-bound value',
      idempotencyKey: randomUUID(),
    });
    const validate = async (ownerId: string, revision: number) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await memory.validateRecallInTransaction(client, ownerId, [{ id: saved.id, revision }]);
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    };
    await validate(owner, 1);
    await expect(validate(other, 1)).rejects.toThrow();
    const corrected = await memory.correct(owner, saved.id, {
      conversationId: conversation,
      messageIds: [correction],
      content: 'corrected source-bound value',
      expectedRevision: 1,
    });
    await expect(validate(owner, 1)).rejects.toThrow();
    await validate(owner, corrected.revision);
    readable = false;
    try {
      await expect(validate(owner, corrected.revision)).rejects.toThrow();
    } finally {
      readable = true;
    }
    await memory.stopRecall(owner, saved.id, corrected.revision);
    await expect(validate(owner, corrected.revision)).rejects.toThrow();
  });

  it('joins the caller transaction and does not confirm a rolled-back write', async () => {
    const client = await pool.connect();
    let id = '';
    try {
      await client.query('BEGIN');
      const saved = await memory.rememberInTransaction(client, owner, {
        conversationId: conversation,
        messageIds: [message],
        content: 'rolled back fact',
        idempotencyKey: randomUUID(),
      });
      id = saved.id;
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    expect(await memory.get(owner, id)).toBeNull();
  });
});
