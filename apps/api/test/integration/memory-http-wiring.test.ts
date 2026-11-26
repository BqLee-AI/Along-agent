import { createFixtureConversation } from '../helpers/bot-conversation.js';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { handleRequest } from '../helpers/http-app.js';
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
      data: { items: [{ id: memory.id, conversationId, messageIds: [messageId] }] },
    });
    expect(
      (await fetch(`${base}/api/v1/memories/${memory.id}`, { headers: headers(other) })).status,
    ).toBe(404);
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
});
