import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { withTransaction } from '../../src/db/transaction.js';
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
      category: null,
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

  it('creates and corrects manual memories without authorizing a conversation source', async () => {
    const manualOwner = randomUUID();
    const foreignOwner = randomUUID();
    const input = {
      category: 'project' as const,
      content: 'manual original phrase',
      idempotencyKey: randomUUID(),
    };
    // Neither owner is authorized by the test's conversation source validator.
    const [saved, retry] = await Promise.all([
      memory.createManual(manualOwner, input),
      memory.createManual(manualOwner, input),
    ]);
    expect(retry).toEqual(saved);
    expect(saved).toMatchObject({
      ownerId: manualOwner,
      sourceKind: 'manual',
      category: 'project',
      conversationId: null,
      messageIds: [],
      summaryId: null,
      expiresAt: null,
      content: input.content,
      revision: 1,
    });
    await expect(
      memory.createManual(manualOwner, { ...input, category: 'goal' }),
    ).rejects.toMatchObject({ errorCode: 'STATE_CONFLICT' });
    expect(await memory.get(foreignOwner, saved.id)).toBeNull();
    expect((await memory.list(foreignOwner, {})).items).toEqual([]);
    expect((await memory.recall(foreignOwner, { query: input.content })).items).toEqual([]);
    expect((await memory.createManual(foreignOwner, input)).id).not.toBe(saved.id);
    expect(await memory.get(manualOwner, saved.id)).toEqual(saved);
    expect((await memory.list(manualOwner, {})).items).toEqual([saved]);
    expect((await memory.recall(manualOwner, { query: input.content })).items).toEqual([
      { ...saved, match: 'literal' },
    ]);

    const correction = {
      category: 'goal' as const,
      content: 'manual-only updated',
      expectedRevision: 1,
    };
    await expect(memory.correctManual(foreignOwner, saved.id, correction)).rejects.toMatchObject({
      errorCode: 'NOT_FOUND',
    });
    await expect(memory.stopRecall(foreignOwner, saved.id, 1)).rejects.toMatchObject({
      errorCode: 'NOT_FOUND',
    });
    await expect(
      memory.correct(manualOwner, saved.id, {
        conversationId: conversation,
        messageIds: [message],
        content: correction.content,
        expectedRevision: 1,
      }),
    ).rejects.toMatchObject({ errorCode: 'STATE_CONFLICT' });
    const attempts = await Promise.allSettled([
      memory.correctManual(manualOwner, saved.id, correction),
      memory.correctManual(manualOwner, saved.id, correction),
    ]);
    expect(attempts).toContainEqual({
      status: 'fulfilled',
      value: expect.objectContaining({ id: saved.id, revision: 2, category: 'goal' }),
    });
    expect(attempts).toContainEqual({
      status: 'rejected',
      reason: expect.objectContaining({ errorCode: 'STATE_CONFLICT' }),
    });
    const validate = (revision: number) =>
      withTransaction(pool, (client) =>
        memory.validateRecallInTransaction(client, manualOwner, [{ id: saved.id, revision }]),
      );
    await expect(validate(1)).rejects.toMatchObject({ errorCode: 'STATE_CONFLICT' });
    await validate(2);
    expect(
      (await memory.recall(manualOwner, { query: input.content }, undefined, false)).items,
    ).toEqual([]);
    await expect(memory.createManual(manualOwner, input)).rejects.toMatchObject({
      errorCode: 'STATE_CONFLICT',
    });

    const history = await pool.query(
      `SELECT revision, content, source_kind, category, conversation_id, message_ids
       FROM r3_memory_revisions WHERE owner_id=$1 AND memory_id=$2 ORDER BY revision`,
      [manualOwner, saved.id],
    );
    const provenance = { source_kind: 'manual', conversation_id: null, message_ids: [] };
    expect(history.rows).toEqual([
      { ...provenance, revision: 1, content: input.content, category: 'project' },
      { ...provenance, revision: 2, content: correction.content, category: 'goal' },
    ]);
    await expect(
      pool.query('UPDATE r3_memory_revisions SET content=$3 WHERE owner_id=$1 AND memory_id=$2', [
        manualOwner,
        saved.id,
        'illegal mutation',
      ]),
    ).rejects.toThrow('memory revisions are immutable');

    await expect(memory.stopRecall(manualOwner, saved.id, 1)).rejects.toMatchObject({
      errorCode: 'STATE_CONFLICT',
    });
    await memory.stopRecall(manualOwner, saved.id, 2);
    expect(await memory.get(manualOwner, saved.id)).toBeNull();
    expect((await memory.list(manualOwner, {})).items).toEqual([]);
    expect((await memory.recall(manualOwner, { query: correction.content })).items).toEqual([]);
    await expect(validate(2)).rejects.toMatchObject({ errorCode: 'STATE_CONFLICT' });
  });

  it('preserves an omitted expiry, clears null, and returns an expired written revision', async () => {
    const expiry = new Date(Date.now() + 60 * 60_000).toISOString();
    const saved = await memory.remember(owner, {
      conversationId: conversation,
      messageIds: [message],
      content: 'original expiring fact',
      idempotencyKey: randomUUID(),
      expiresAt: expiry,
    });
    expect(saved.expiresAt).toBe(expiry);

    const correctionInput = {
      conversationId: conversation,
      messageIds: [correction],
      content: 'corrected expiring fact',
    };
    const inherited = await memory.correct(owner, saved.id, {
      ...correctionInput,
      expectedRevision: saved.revision,
    });
    expect(inherited.expiresAt).toBe(expiry);
    const cleared = await memory.correct(owner, saved.id, {
      ...correctionInput,
      expectedRevision: inherited.revision,
      expiresAt: null,
    });
    expect(cleared.expiresAt).toBeNull();
    const expired = await memory.correct(owner, saved.id, {
      ...correctionInput,
      expectedRevision: cleared.revision,
      expiresAt: '2000-01-01T00:00:00.000Z',
    });
    expect(expired).toMatchObject({ revision: 4, expiresAt: '2000-01-01T00:00:00.000Z' });
    expect(await memory.get(owner, saved.id)).toBeNull();
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
