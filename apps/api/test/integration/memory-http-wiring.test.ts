import { createFixtureConversation } from '../helpers/bot-conversation.js';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { handleRequest } from '../helpers/http-app.js';
import { createHostProductRoutes } from '../../src/bin/host-product-routes.js';
import { conversationMemorySources } from '../../src/features/conversations/public.js';
import { createMemoryService, type MemoryService } from '../../src/features/memory/public.js';
import { listen } from '../helpers/harness-consumer.js';
import {
  createIntegrationDatabase,
  databaseUrl,
  seedAdmittedSession,
  type IntegrationDatabase,
} from './setup.js';

const maybe = databaseUrl ? describe : describe.skip;
maybe('memory HTTP management', () => {
  let database: IntegrationDatabase;
  let server: Server;
  let base: string;
  let memoryService: MemoryService;
  beforeAll(async () => {
    database = await createIntegrationDatabase();
    memoryService = createMemoryService({
      pool: database.pool,
      sources: conversationMemorySources,
    });
    server = createServer((req, res) => {
      void handleRequest(req, res, {
        pool: database.pool,
        tzdbVersion: 'fixture-v1',
        memoryService,
      });
    });
    base = await listen(server);
  });
  afterAll(async () => {
    if (server) {
      const closed = once(server, 'close');
      server.closeAllConnections();
      server.close();
      await closed;
    }
    await database?.close();
  });
  it('allows only the owner to view and update sourced memories, with CSRF protection', async () => {
    const owner = await seedAdmittedSession(database.pool);
    const other = await seedAdmittedSession(database.pool);
    const conversationId = randomUUID();
    const messageId = randomUUID();
    await createFixtureConversation(database.pool, owner.userId, { id: conversationId });
    await database.pool.query(
      "INSERT INTO messages(id,owner_id,conversation_id,role,content) VALUES($1,$2,$3,'user','please remember tea')",
      [messageId, owner.userId, conversationId],
    );
    const memory = await memoryService.remember(owner.userId, {
      conversationId,
      messageIds: [messageId],
      content: 'tea',
      idempotencyKey: randomUUID(),
    });
    const headers = (actor: typeof owner) => ({
      cookie: `better-auth.session_token=${actor.token}`,
      'x-csrf-token': actor.csrfToken,
      'content-type': 'application/json',
    });
    const list = await fetch(`${base}/api/v1/memories`, { headers: headers(owner) });
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({
      data: { items: [{ id: memory.id, conversationId, messageIds: [messageId], category: null }] },
    });
    expect(
      (await fetch(`${base}/api/v1/memories/${memory.id}`, { headers: headers(other) })).status,
    ).toBe(404);
    expect(
      (
        await fetch(`${base}/api/v1/memories/${memory.id}/actions/correct-manual`, {
          method: 'POST',
          headers: headers(owner),
          body: JSON.stringify({ category: 'project', content: 'not manual', expectedRevision: 1 }),
        })
      ).status,
    ).toBe(409);
    const correction = JSON.stringify({
      conversationId,
      messageIds: [messageId],
      content: 'green tea',
      expectedRevision: 1,
    });
    const path = `${base}/api/v1/memories/${memory.id}/actions/correct`;
    expect(
      (
        await fetch(path, {
          method: 'POST',
          headers: { ...headers(owner), 'x-csrf-token': '' },
          body: correction,
        })
      ).status,
    ).toBe(403);
    expect(
      (await fetch(path, { method: 'POST', headers: headers(other), body: correction })).status,
    ).toBe(404);
    const updated = await fetch(path, {
      method: 'POST',
      headers: headers(owner),
      body: correction,
    });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({
      data: { content: 'green tea', revision: 2, messageIds: [messageId] },
    });
    const stopped = await fetch(`${base}/api/v1/memories/${memory.id}/actions/stop-recall`, {
      method: 'POST',
      headers: headers(owner),
      body: JSON.stringify({ expectedRevision: 2 }),
    });
    expect(stopped.status).toBe(200);
  });

  for (const transport of ['standalone', 'Host product'] as const) {
    it(`validates and manages owner-only manual entries over ${transport}`, async () => {
      const owner = await seedAdmittedSession(database.pool);
      const other = await seedAdmittedSession(database.pool);
      const root = '/api/v1/memories';
      const product = createHostProductRoutes({
        pool: database.pool,
        tzdbVersion: 'fixture-v1',
        memoryService,
      });
      const headers = (actor: typeof owner, csrf = actor.csrfToken) => ({
        cookie: `better-auth.session_token=${actor.token}`,
        'x-csrf-token': csrf,
        'content-type': 'application/json',
      });
      async function request(path: string, init?: RequestInit) {
        const url = `${base}${path}`;
        if (transport === 'standalone') return fetch(url, init);
        const response = await product(new Request(url, init));
        if (!response) throw new Error(`Host did not route ${path}`);
        return response;
      }
      const input = {
        category: 'preference',
        content: '  jasmine tea  ',
        idempotencyKey: randomUUID(),
      };
      const post = (path: string, actor: typeof owner, data: unknown, csrf?: string) =>
        request(path, {
          method: 'POST',
          headers: headers(actor, csrf),
          body: JSON.stringify(data),
        });

      if (transport === 'Host product') {
        expect(
          await product(new Request(`${base}${root}-unrelated`, { method: 'POST' })),
        ).toBeNull();
      }
      expect((await request(root, { method: 'POST', body: '{invalid' })).status).toBe(401);
      expect((await post(root, owner, input, '')).status).toBe(403);
      for (const invalid of [
        { ...input, category: 'other' },
        { ...input, content: ' \t\n' },
        { ...input, idempotencyKey: '' },
        { ...input, ownerId: other.userId },
        { ...input, conversationId: randomUUID() },
        { ...input, expiresAt: null },
      ]) {
        expect((await post(root, owner, invalid)).status).toBe(400);
      }
      const created = await post(root, owner, input);
      expect(created.status).toBe(200);
      const { data: saved } = (await created.json()) as { data: { id: string } };
      expect(saved).toMatchObject({
        ownerId: owner.userId,
        sourceKind: 'manual',
        conversationId: null,
        messageIds: [],
        summaryId: null,
        expiresAt: null,
        status: 'active',
        category: 'preference',
        content: input.content,
        revision: 1,
      });
      expect(await (await post(root, owner, input)).json()).toMatchObject({ data: saved });
      expect((await post(root, owner, { ...input, content: 'different' })).status).toBe(409);
      const detail = `${root}/${saved.id}`;
      const correction = `${detail}/actions/correct-manual`;
      const stop = `${detail}/actions/stop-recall`;
      expect(await (await request(root, { headers: headers(owner) })).json()).toMatchObject({
        data: { items: [saved], nextCursor: null },
      });
      expect(await (await request(root, { headers: headers(other) })).json()).toMatchObject({
        data: { items: [] },
      });
      expect((await request(detail, { headers: headers(other) })).status).toBe(404);
      const edit = { category: 'goal', content: 'drink less caffeine', expectedRevision: 1 };
      expect((await post(correction, owner, edit, '')).status).toBe(403);
      expect((await post(correction, other, edit)).status).toBe(404);
      expect((await post(correction, owner, { ...edit, messageIds: [] })).status).toBe(400);
      const corrected = await post(correction, owner, edit);
      expect(corrected.status).toBe(200);
      const { data: updated } = (await corrected.json()) as { data: unknown };
      expect(updated).toMatchObject({
        id: saved.id,
        revision: 2,
        category: edit.category,
        content: edit.content,
        sourceKind: 'manual',
        conversationId: null,
        messageIds: [],
      });
      expect(await (await request(detail, { headers: headers(owner) })).json()).toMatchObject({
        data: updated,
      });
      expect((await post(correction, owner, edit)).status).toBe(409);
      expect((await post(stop, other, { expectedRevision: 2 })).status).toBe(404);
      expect((await post(stop, owner, { expectedRevision: 1 })).status).toBe(409);
      expect((await post(stop, owner, { expectedRevision: 2 })).status).toBe(200);
      expect((await request(detail, { headers: headers(owner) })).status).toBe(404);
      expect((await post(correction, owner, { ...edit, expectedRevision: 2 })).status).toBe(404);
      expect((await post(root, owner, input)).status).toBe(409);
    });
  }
});
