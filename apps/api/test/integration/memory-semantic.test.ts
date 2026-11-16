import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { forbidden } from '../../src/http/errors.js';
import type { MemorySources } from '../../src/modules/memory/types.js';
import { createMemoryService, type MemoryService } from '../../src/modules/memory/service.js';
import { createIntegrationDatabase, databaseUrl, type IntegrationDatabase } from './setup.js';

const maybe = databaseUrl ? describe : describe.skip;
const binding = 'a'.repeat(64);

const conversationMemorySources: MemorySources = {
  async validate(client, input) {
    if (input.purpose === 'compact') throw forbidden();
    const result = await client.query(
      `SELECT m.id FROM messages m JOIN conversations c
       ON c.id=m.conversation_id AND c.owner_id=m.owner_id
       WHERE m.owner_id=$1 AND m.conversation_id=$2 AND m.id=ANY($3::uuid[])
         AND m.role='user'`,
      [input.ownerId, input.conversationId, input.messageIds],
    );
    if (result.rowCount !== input.messageIds.length) throw forbidden();
  },
};

maybe('memory semantic retrieval', () => {
  let database: IntegrationDatabase;
  let service: MemoryService;
  const owner = randomUUID();
  const other = randomUUID();
  const conversation = randomUUID();
  const message = randomUUID();
  let vectorAvailable = false;
  beforeAll(async () => {
    database = await createIntegrationDatabase();
    const extension = await database.pool.query(
      "SELECT 1 FROM pg_extension WHERE extname='vector'",
    );
    vectorAvailable = Boolean(extension.rowCount);
    await database.pool.query('INSERT INTO conversations(id,owner_id) VALUES($1,$2)', [
      conversation,
      owner,
    ]);
    await database.pool.query(
      "INSERT INTO messages(id,owner_id,conversation_id,role,content) VALUES($1,$2,$3,'user','original')",
      [message, owner, conversation],
    );
    service = createMemoryService({
      pool: database.pool,
      sources: conversationMemorySources,
      semantic: {
        encoderUrl: 'http://localhost:9000',
        bindingSha256: binding,
        deadlineMs: 1000,
        fetch: async (_url, init) => {
          const body = JSON.parse(String(init.body));
          const vector = Array.from({ length: 512 }, (_, i) =>
            i === (String(body.text).includes('alternate') ? 1 : 0) ? 1 : 0,
          );
          return Response.json({ binding_sha256: binding, token_count: 2, dimension: 512, vector });
        },
      },
    });
  });
  afterAll(async () => {
    await database?.close();
  });
  it('indexes new and corrected revisions on recall without exposing other owners', async () => {
    if (!vectorAvailable) return;
    const isolatedOwner = randomUUID();
    const isolatedConversation = randomUUID();
    const isolatedMessage = randomUUID();
    await database.pool.query('INSERT INTO conversations(id,owner_id) VALUES($1,$2)', [
      isolatedConversation,
      isolatedOwner,
    ]);
    await database.pool.query(
      "INSERT INTO messages(id,owner_id,conversation_id,role,content) VALUES($1,$2,$3,'user','我喜欢无糖茉莉花茶')",
      [isolatedMessage, isolatedOwner, isolatedConversation],
    );
    const saved = await service.remember(isolatedOwner, {
      conversationId: isolatedConversation,
      messageIds: [isolatedMessage],
      content: '我喜欢无糖茉莉花茶',
      idempotencyKey: randomUUID(),
    });
    const first = await service.recall(isolatedOwner, { query: '饮品偏好' });
    expect(first).toMatchObject({ candidateOnly: true, completeness: 'incomplete' });
    expect(first.items).toContainEqual(
      expect.objectContaining({ id: saved.id, revision: 1, match: 'semantic' }),
    );
    expect((await service.recall(other, { query: '饮品偏好' })).items).toEqual([]);
    const corrected = await service.correct(isolatedOwner, saved.id, {
      conversationId: isolatedConversation,
      messageIds: [isolatedMessage],
      content: '我喜欢无糖桂花茶',
      expectedRevision: 1,
    });
    const next = await service.recall(isolatedOwner, { query: '饮品偏好' });
    expect(next.items).toContainEqual(expect.objectContaining({ id: saved.id, revision: 2 }));
    expect(next.items.some((item) => item.id === saved.id && item.revision === 1)).toBe(false);
    await service.stopRecall(isolatedOwner, saved.id, corrected.revision);
    expect((await service.recall(isolatedOwner, { query: '饮品偏好' })).items).toEqual([]);
  });
  it('bounds a stalled indexing attempt and still returns literal results as degraded', async () => {
    let calls = 0;
    let aborted = false;
    const stalled = createMemoryService({
      pool: database.pool,
      sources: conversationMemorySources,
      semantic: {
        encoderUrl: 'http://localhost:9000',
        bindingSha256: binding,
        deadlineMs: 10000,
        fetch: async (_url, init) => {
          calls++;
          if (calls > 1) {
            return Response.json({
              binding_sha256: binding,
              token_count: 2,
              dimension: 512,
              vector: Array.from({ length: 512 }, (_, i) => (i === 0 ? 1 : 0)),
            });
          }
          const { promise, reject } = Promise.withResolvers<Response>();
          init.signal?.addEventListener(
            'abort',
            () => {
              aborted = true;
              reject(new Error('aborted'));
            },
            { once: true },
          );
          return promise;
        },
      },
    });
    const saved = await stalled.remember(owner, {
      conversationId: conversation,
      messageIds: [message],
      content: '索引超时仍可字面回查',
      idempotencyKey: randomUUID(),
    });
    const start = Date.now();
    const result = await stalled.recall(owner, { query: '索引超时仍可字面回查' });
    expect(Date.now() - start).toBeLessThan(4000);
    expect(calls).toBe(2);
    expect(aborted).toBe(true);
    expect(result).toMatchObject({ completeness: 'degraded', candidateOnly: true });
    expect(result.items).toContainEqual(
      expect.objectContaining({ id: saved.id, match: 'literal' }),
    );
    await stalled.stopRecall(owner, saved.id, saved.revision);
  });

  it('aborts the encoder when the recall caller is cancelled', async () => {
    const started = Promise.withResolvers<void>();
    let aborted = false;
    const cancelling = createMemoryService({
      pool: database.pool,
      sources: conversationMemorySources,
      semantic: {
        encoderUrl: 'http://localhost:9000',
        bindingSha256: binding,
        deadlineMs: 10000,
        fetch: async (_url, init) => {
          const { promise, reject } = Promise.withResolvers<Response>();
          init.signal?.addEventListener(
            'abort',
            () => {
              aborted = true;
              reject(new Error('aborted'));
            },
            { once: true },
          );
          started.resolve();
          return promise;
        },
      },
    });
    const controller = new AbortController();
    const pending = cancelling.recall(owner, { query: '需要检索' }, controller.signal);
    await started.promise;
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(aborted).toBe(true);
  });

  it('still searches existing vectors when one missing revision cannot be encoded', async () => {
    if (!vectorAvailable) return;
    const isolatedOwner = randomUUID();
    const isolatedConversation = randomUUID();
    const isolatedMessage = randomUUID();
    await database.pool.query('INSERT INTO conversations(id,owner_id) VALUES($1,$2)', [
      isolatedConversation,
      isolatedOwner,
    ]);
    await database.pool.query(
      "INSERT INTO messages(id,owner_id,conversation_id,role,content) VALUES($1,$2,$3,'user','原始资料')",
      [isolatedMessage, isolatedOwner, isolatedConversation],
    );
    const selective = createMemoryService({
      pool: database.pool,
      sources: conversationMemorySources,
      semantic: {
        encoderUrl: 'http://localhost:9000',
        bindingSha256: binding,
        deadlineMs: 1000,
        fetch: async (_url, init) => {
          if (JSON.parse(String(init.body)).text === 'cannot encode')
            throw new Error('unavailable');
          return Response.json({
            binding_sha256: binding,
            token_count: 2,
            dimension: 512,
            vector: Array.from({ length: 512 }, (_, i) => (i === 0 ? 1 : 0)),
          });
        },
      },
    });
    const saved = await selective.remember(isolatedOwner, {
      conversationId: isolatedConversation,
      messageIds: [isolatedMessage],
      content: '我喜欢茉莉花茶',
      idempotencyKey: randomUUID(),
    });
    await selective.rebuildIndex(isolatedOwner, { limit: 10 });
    await selective.remember(isolatedOwner, {
      conversationId: isolatedConversation,
      messageIds: [isolatedMessage],
      content: 'cannot encode',
      idempotencyKey: randomUUID(),
    });
    const result = await selective.recall(isolatedOwner, { query: '饮品偏好' });
    expect(result).toMatchObject({ completeness: 'degraded', candidateOnly: true });
    expect(result.items).toContainEqual(
      expect.objectContaining({ id: saved.id, match: 'semantic' }),
    );
  });

  it('continues past a persistent indexing failure without bypassing deadlines or cancellation', async () => {
    if (!vectorAvailable) return;
    const isolatedOwner = randomUUID();
    const isolatedConversation = randomUUID();
    const isolatedMessage = randomUUID();
    await database.pool.query('INSERT INTO conversations(id,owner_id) VALUES($1,$2)', [
      isolatedConversation,
      isolatedOwner,
    ]);
    await database.pool.query(
      "INSERT INTO messages(id,owner_id,conversation_id,role,content) VALUES($1,$2,$3,'user','原始资料')",
      [isolatedMessage, isolatedOwner, isolatedConversation],
    );

    let failingContent = '';
    let mode: 'deadline' | 'cancel' | 'fail' = 'cancel';
    const started = Promise.withResolvers<void>();
    const selective = createMemoryService({
      pool: database.pool,
      sources: conversationMemorySources,
      semantic: {
        encoderUrl: 'http://localhost:9000',
        bindingSha256: binding,
        deadlineMs: 10000,
        fetch: async (_url, init) => {
          if (JSON.parse(String(init.body)).text === failingContent) {
            if (mode === 'fail') throw new Error('unavailable');
            const { promise, reject } = Promise.withResolvers<Response>();
            init.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
              once: true,
            });
            if (mode === 'cancel') started.resolve();
            return promise;
          }
          return Response.json({
            binding_sha256: binding,
            token_count: 2,
            dimension: 512,
            vector: Array.from({ length: 512 }, (_, i) => (i === 0 ? 1 : 0)),
          });
        },
      },
    });
    const memories = await Promise.all(
      ['茉莉花茶', '桂花乌龙'].map((content) =>
        selective.remember(isolatedOwner, {
          conversationId: isolatedConversation,
          messageIds: [isolatedMessage],
          content,
          idempotencyKey: randomUUID(),
        }),
      ),
    );
    memories.sort((a, b) => a.id.localeCompare(b.id));
    failingContent = memories[0]!.content;
    const healthy = memories[1]!;

    const controller = new AbortController();
    const cancelled = selective.recall(isolatedOwner, { query: '饮品偏好' }, controller.signal);
    await started.promise;
    controller.abort();
    await expect(cancelled).rejects.toThrow();
    mode = 'deadline';
    const start = Date.now();
    const timed = await selective.recall(isolatedOwner, { query: '饮品偏好' }, undefined, false);
    expect(Date.now() - start).toBeLessThan(4000);
    expect(timed).toMatchObject({ completeness: 'degraded', candidateOnly: true });
    expect(timed.items.some((item) => item.id === healthy.id)).toBe(false);

    mode = 'fail';
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await selective.recall(isolatedOwner, { query: '饮品偏好' });
      expect(result).toMatchObject({ completeness: 'degraded', candidateOnly: true });
      expect(result.items).toContainEqual(
        expect.objectContaining({ id: healthy.id, match: 'semantic' }),
      );
    }
  });

  it('advances past a full failing batch across recreated services and wraps to retry', async () => {
    if (!vectorAvailable) return;
    const isolatedOwner = randomUUID();
    const isolatedConversation = randomUUID();
    const isolatedMessage = randomUUID();
    await database.pool.query('INSERT INTO conversations(id,owner_id) VALUES($1,$2)', [
      isolatedConversation,
      isolatedOwner,
    ]);
    await database.pool.query(
      "INSERT INTO messages(id,owner_id,conversation_id,role,content) VALUES($1,$2,$3,'user','原始资料')",
      [isolatedMessage, isolatedOwner, isolatedConversation],
    );
    const failures = new Set<string>();
    const makeService = () =>
      createMemoryService({
        pool: database.pool,
        sources: conversationMemorySources,
        semantic: {
          encoderUrl: 'http://localhost:9000',
          bindingSha256: binding,
          deadlineMs: 1000,
          fetch: async (_url, init) => {
            if (failures.has(JSON.parse(String(init.body)).text)) throw new Error('unavailable');
            return Response.json({
              binding_sha256: binding,
              token_count: 2,
              dimension: 512,
              vector: Array.from({ length: 512 }, (_, i) => (i === 0 ? 1 : 0)),
            });
          },
        },
      });
    const memories = await Promise.all(
      Array.from({ length: 22 }, (_, i) =>
        makeService().remember(isolatedOwner, {
          conversationId: isolatedConversation,
          messageIds: [isolatedMessage],
          content: `饮品记录${i}`,
          idempotencyKey: randomUUID(),
        }),
      ),
    );
    memories.sort((a, b) => a.id.localeCompare(b.id));
    for (const memory of memories.slice(0, -1)) failures.add(memory.content);
    const healthy = memories[memories.length - 1]!;
    const overlapping = await Promise.all(
      Array.from({ length: 2 }, () =>
        makeService().recall(isolatedOwner, { query: '口味偏好', limit: 100 }, undefined, false),
      ),
    );
    for (const result of overlapping) expect(result.completeness).toBe('degraded');
    expect(
      (await makeService().recall(other, { query: '口味偏好' }, undefined, false)).items,
    ).toEqual([]);
    let found = false;
    for (let attempt = 0; attempt < 30 && !found; attempt++) {
      const result = await makeService().recall(
        isolatedOwner,
        { query: '口味偏好', limit: 100 },
        undefined,
        false,
      );
      expect(result.completeness).toBe('degraded');
      found = result.items.some((item) => item.id === healthy.id && item.match === 'semantic');
    }
    expect(found).toBe(true);

    failures.clear();
    let recovered = false;
    for (let attempt = 0; attempt < 30 && !recovered; attempt++) {
      const result = await makeService().recall(
        isolatedOwner,
        { query: '口味偏好', limit: 100 },
        undefined,
        false,
      );
      recovered = result.items.some(
        (item) => item.id === memories[0]!.id && item.match === 'semantic',
      );
    }
    expect(recovered).toBe(true);
  });

  it('indexes explicitly, isolates owners, and never promotes an uncalibrated result to a fact', async () => {
    const exact = await service.remember(owner, {
      conversationId: conversation,
      messageIds: [message],
      content: '记录 XQ-4792 原值',
      idempotencyKey: randomUUID(),
    });
    await service.remember(owner, {
      conversationId: conversation,
      messageIds: [message],
      content: 'alternate XQ-47920',
      idempotencyKey: randomUUID(),
    });
    expect(await service.rebuildIndex(owner, { limit: 10 })).toMatchObject({
      indexed: 2,
      failed: 0,
      nextCursor: null,
    });
    const result = await service.recall(owner, { query: 'XQ-4792 是什么', limit: 10 });
    expect(result.candidateOnly).toBe(true);
    expect(result.items[0]).toMatchObject({ id: exact.id, match: 'literal' });
    expect(result.completeness).toBe(vectorAvailable ? 'incomplete' : 'degraded');
    expect((await service.recall(other, { query: 'unrelated', limit: 10 })).items).toEqual([]);
    if (vectorAvailable) {
      const semantic = await service.recall(owner, { query: '无字面命中', limit: 10 });
      expect(semantic.completeness).toBe('incomplete');
      expect(semantic.items.some((item) => item.match === 'semantic')).toBe(true);
    }
    const revised = await service.correct(owner, exact.id, {
      conversationId: conversation,
      messageIds: [message],
      content: 'corrected',
      expectedRevision: 1,
    });
    const client = await database.pool.connect();
    try {
      await client.query('BEGIN');
      await expect(
        service.validateRecallInTransaction(client, owner, [{ id: exact.id, revision: 1 }]),
      ).rejects.toThrow();
      await service.validateRecallInTransaction(client, owner, []);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
    const after = await service.recall(owner, { query: '原值', limit: 10 });
    expect(after.items.some((item) => item.id === exact.id && item.revision === 1)).toBe(false);
    await service.stopRecall(owner, exact.id, revised.revision);
    expect(
      (await service.recall(owner, { query: 'corrected', limit: 10 })).items.some(
        (item) => item.id === exact.id,
      ),
    ).toBe(false);
  });
});
