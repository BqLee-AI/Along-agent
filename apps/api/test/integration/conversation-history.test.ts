import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Pool } from 'pg';
import {
  ConversationListPageSchema,
  ConversationMessagePageSchema,
  ConversationRunPageSchema,
} from '@along/contracts';
import type {
  ConversationListItem,
  MessageHistoryItem,
  ConversationRunHistoryItem,
} from '@along/contracts';
import { handleConversationRoute } from '../../src/modules/conversations/routes.js';
import { withTransaction } from '../../src/db/transaction.js';
import { appendCheckpoint, insertAttempt } from '../../src/modules/conversations/repository.js';
import { loadTimeContext } from '../../src/modules/time/context.js';
import { createIntegrationDatabase, databaseUrl } from './setup.js';
import type { IntegrationDatabase } from './setup.js';

const maybe = databaseUrl ? describe : describe.skip;
const timeContext = loadTimeContext('fixture-v1');
const base = '/api/v1/conversations';
interface Reply {
  status: number;
  headers: Record<string, string>;
  body: { data: unknown; error: { code: string; request_id: string } | null; request_id: string };
}

async function get(pool: Pool | null, ownerId: string | null, path: string): Promise<Reply> {
  const reply: Reply = {
    status: 0,
    headers: {},
    body: { data: null, error: null, request_id: '' },
  };
  const req = {
    method: 'GET',
    headers: { 'x-request-id': 'history-contract' },
  } as unknown as IncomingMessage;
  const res = {
    writeHead(status: number, headers: Record<string, string>) {
      reply.status = status;
      reply.headers = headers;
    },
    end(body: string) {
      reply.body = JSON.parse(body);
    },
  } as unknown as ServerResponse;
  const handled = await handleConversationRoute(req, res, new URL(path, 'http://localhost'), {
    pool,
    timeContext,
    resolveActor: async () =>
      ownerId ? { ownerId, sessionId: null, displayName: 'history', timezoneId: null } : null,
  });
  expect(handled).toBe(true);
  expect(reply.headers['cache-control']).toBe('no-store');
  return reply;
}

async function user(pool: Pool): Promise<string> {
  const id = randomUUID();
  await pool.query("INSERT INTO users(id,auth_email,display_name) VALUES ($1,$2,'history')", [
    id,
    `${id}@history.test`,
  ]);
  return id;
}
async function conversation(
  pool: Pool,
  owner: string,
  at = '2026-10-28T09:00:00.123456Z',
  id = randomUUID(),
): Promise<string> {
  await pool.query('INSERT INTO conversations(id,owner_id,title,created_at) VALUES ($1,$2,$3,$4)', [
    id,
    owner,
    'do not use stored title',
    at,
  ]);
  return id;
}
async function message(
  pool: Pool,
  owner: string,
  cid: string,
  content: string,
  at: string,
  role = 'user',
  id = randomUUID(),
): Promise<string> {
  await pool.query(
    'INSERT INTO messages(id,owner_id,conversation_id,role,content,created_at) VALUES ($1,$2,$3,$4,$5,$6)',
    [id, owner, cid, role, content, at],
  );
  return id;
}
async function run(
  pool: Pool,
  owner: string,
  cid: string,
  at: string,
  input: string | null = null,
  id = randomUUID(),
): Promise<string> {
  await pool.query(
    `INSERT INTO agent_runs(id,owner_id,conversation_id,agent_revision,mode,status,budget_max_iterations,budget_max_tokens,execution,input_message_id,created_at)
    VALUES ($1,$2,$3,'history/test','chat','running',10,8000,'business',$4,$5)`,
    [id, owner, cid, input, at],
  );
  return id;
}
async function reference(
  pool: Pool,
  owner: string,
  cid: string,
  rid: string,
  mid: string | null,
): Promise<void> {
  await pool.query(
    `INSERT INTO conversation_idempotency(owner_id,idempotency_key,request_hash,conversation_id,run_id,user_message_id,expires_at)
    VALUES ($1,$2,'history',$3,$4,$5,now()-interval '1 day')`,
    [owner, randomUUID(), cid, rid, mid],
  );
}
function paged(path: string, cursor: string | null, limit = 2): string {
  return `${path}?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
}

maybe('owner-scoped read-only conversation history HTTP', () => {
  let database: IntegrationDatabase;
  let pool: Pool;
  beforeAll(async () => {
    database = await createIntegrationDatabase();
    pool = database.pool;
  });
  afterAll(async () => {
    await database?.close();
  });

  it('discovers only owned conversations, derives Unicode titles and factual activities, and filters system/private data', async () => {
    const owner = await user(pool);
    const other = await user(pool);
    const cid = await conversation(pool, owner);
    const empty = await conversation(pool, owner, '2026-10-28T08:00:00.000001Z');
    await conversation(pool, other);
    const raw = ` \n \t${'😀'.repeat(41)}\n original tail \t`;
    const mid = await message(pool, owner, cid, raw, '2026-10-28T09:00:00.123457Z');
    await message(pool, owner, cid, 'private system', '2026-10-29T00:00:00.000000Z', 'system');
    await message(pool, other, cid, 'wrong owner row', '2026-10-29T00:00:00.000000Z');
    await message(
      pool,
      owner,
      cid,
      'archived assistant',
      '2026-10-28T09:00:00.123458Z',
      'assistant',
    );
    const rid = await run(pool, owner, cid, '2026-10-28T09:00:00.123459Z', mid);
    await pool.query(
      "UPDATE agent_runs SET status='done',ended_at='2026-10-28T09:00:00.123460Z' WHERE id=$1",
      [rid],
    );
    const list = ConversationListPageSchema.parse((await get(pool, owner, base)).body.data);
    expect(list.items.map((item) => item.conversation_id)).toEqual([cid, empty]);
    expect(list.items[0]).toMatchObject({
      title: `${'😀'.repeat(40)}…`,
      title_message_id: mid,
      created_at: '2026-10-28T09:00:00.123456Z',
      last_activity_at: '2026-10-28T09:00:00.123460Z',
    });
    expect(list.items[1]).toMatchObject({
      title: `会话 ${empty.slice(0, 8)}`,
      title_message_id: null,
      last_activity_at: null,
    });
    expect(
      ConversationMessagePageSchema.parse(
        (await get(pool, owner, `${base}/${empty}/messages`)).body.data,
      ),
    ).toEqual({ items: [], next_cursor: null });
    expect(
      ConversationRunPageSchema.parse((await get(pool, owner, `${base}/${empty}/runs`)).body.data),
    ).toEqual({ items: [], next_cursor: null });
    expect(
      ConversationListPageSchema.parse((await get(pool, await user(pool), base)).body.data),
    ).toEqual({ items: [], next_cursor: null });
    const messages = ConversationMessagePageSchema.parse(
      (await get(pool, owner, `${base}/${cid}/messages`)).body.data,
    );
    expect(messages.items.map((item) => item.content)).toEqual([raw, 'archived assistant']);
    expect(JSON.stringify({ list, messages })).not.toContain('private system');
    expect((await get(pool, other, `${base}/${cid}/messages`)).status).toBe(403);
    expect((await get(pool, owner, `${base}/${randomUUID()}/runs`)).status).toBe(404);
    expect((await get(pool, owner, `${base}/not-a-uuid/messages`)).status).toBe(404);
  });

  it('traverses all microsecond/tie pages with an immutable first upper while new facts and old state change', async () => {
    const owner = await user(pool);
    const cids: string[] = [];
    for (let i = 1; i <= 7; i++) {
      cids.push(
        await conversation(
          pool,
          owner,
          `2026-10-28T09:00:00.12345${Math.floor(i / 2)}Z`,
          `10000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
        ),
      );
    }
    const first = ConversationListPageSchema.parse(
      (await get(pool, owner, paged(base, null))).body.data,
    );
    const later = await conversation(pool, owner, '2026-10-28T09:00:00.123499Z');
    const oldRun = await run(pool, owner, cids[0]!, '2026-10-28T09:00:00.123451Z');
    await pool.query("UPDATE agent_runs SET status='done',ended_at=now() WHERE id=$1", [oldRun]);
    const items: ConversationListItem[] = [...first.items];
    let cursor = first.next_cursor;
    while (cursor) {
      const page = ConversationListPageSchema.parse(
        (await get(pool, owner, paged(base, cursor))).body.data,
      );
      items.push(...page.items);
      cursor = page.next_cursor;
    }
    expect(items.map((item) => item.conversation_id)).toEqual([...cids].reverse());
    expect(new Set(items.map((item) => item.conversation_id)).size).toBe(7);
    expect(
      ConversationListPageSchema.parse((await get(pool, owner, base)).body.data).items[0]
        ?.conversation_id,
    ).toBe(later);

    const cid = cids[0]!;
    const mids: string[] = [];
    const rids: string[] = [oldRun];
    for (let i = 1; i <= 7; i++) {
      const at = `2026-10-28T09:00:00.12346${Math.floor(i / 2)}Z`;
      mids.push(
        await message(
          pool,
          owner,
          cid,
          `message ${i}`,
          at,
          i % 2 ? 'user' : 'assistant',
          `20000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
        ),
      );
      rids.push(
        await run(
          pool,
          owner,
          cid,
          at,
          null,
          `30000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
        ),
      );
    }
    const mp = `${base}/${cid}/messages`;
    const rp = `${base}/${cid}/runs`;
    const mf = ConversationMessagePageSchema.parse(
      (await get(pool, owner, paged(mp, null))).body.data,
    );
    const rf = ConversationRunPageSchema.parse((await get(pool, owner, paged(rp, null))).body.data);
    await message(pool, owner, cid, 'after upper', '2026-10-28T09:00:00.123499Z');
    await run(pool, owner, cid, '2026-10-28T09:00:00.123499Z');
    const allMessages: MessageHistoryItem[] = [...mf.items];
    cursor = mf.next_cursor;
    while (cursor) {
      const p = ConversationMessagePageSchema.parse(
        (await get(pool, owner, paged(mp, cursor))).body.data,
      );
      allMessages.push(...p.items);
      cursor = p.next_cursor;
    }
    const allRuns: ConversationRunHistoryItem[] = [...rf.items];
    cursor = rf.next_cursor;
    while (cursor) {
      const p = ConversationRunPageSchema.parse(
        (await get(pool, owner, paged(rp, cursor))).body.data,
      );
      allRuns.push(...p.items);
      cursor = p.next_cursor;
    }
    expect(allMessages.map((m) => m.message_id)).toEqual(mids);
    expect(allRuns.map((r) => r.run_id)).toEqual(rids);
    expect((await get(pool, owner, paged(rp, mf.next_cursor))).status).toBe(400);
    expect(
      (await get(pool, owner, paged(`${base}/${cids[1]}/messages`, mf.next_cursor))).status,
    ).toBe(400);
    expect((await get(pool, await user(pool), paged(base, first.next_cursor))).status).toBe(400);
    const decoded = JSON.parse(Buffer.from(mf.next_cursor!, 'base64url').toString('utf8'));
    for (const patch of [
      { v: '2' },
      { kind: 'other' },
      { last_at: '2026-10-29T00:00:00.000000Z' },
      { extra: 'bad' },
    ]) {
      const invalid = Buffer.from(JSON.stringify({ ...decoded, ...patch })).toString('base64url');
      expect((await get(pool, owner, paged(mp, invalid))).status).toBe(400);
    }
  });

  it('continues beyond the maximum collection page size without truncating any collection', async () => {
    const owner = await user(pool);
    await pool.query(
      `INSERT INTO conversations(id,owner_id,created_at)
      SELECT gen_random_uuid(),$1,'2026-10-28T09:00:00Z'::timestamptz+g*interval '1 microsecond' FROM generate_series(1,51) g`,
      [owner],
    );
    const first = ConversationListPageSchema.parse(
      (await get(pool, owner, `${base}?limit=50`)).body.data,
    );
    expect(first.items).toHaveLength(50);
    expect(first.next_cursor).not.toBeNull();
    const last = ConversationListPageSchema.parse(
      (await get(pool, owner, paged(base, first.next_cursor, 50))).body.data,
    );
    expect(last.items).toHaveLength(1);
    expect(last.next_cursor).toBeNull();
    expect(new Set([...first.items, ...last.items].map((item) => item.conversation_id)).size).toBe(
      51,
    );
    const cid = first.items[0]!.conversation_id;
    await pool.query(
      `INSERT INTO messages(id,owner_id,conversation_id,role,content,created_at)
      SELECT gen_random_uuid(),$1,$2,'user',g::text,'2026-10-28T09:00:00Z'::timestamptz+g*interval '1 microsecond' FROM generate_series(1,51) g`,
      [owner, cid],
    );
    await pool.query(
      `INSERT INTO agent_runs(id,owner_id,conversation_id,agent_revision,mode,status,budget_max_iterations,budget_max_tokens,created_at)
      SELECT gen_random_uuid(),$1,$2,'history/test','chat','done',10,8000,'2026-10-28T09:00:00Z'::timestamptz+g*interval '1 microsecond' FROM generate_series(1,51) g`,
      [owner, cid],
    );
    const mp = `${base}/${cid}/messages`;
    const rp = `${base}/${cid}/runs`;
    const mf = ConversationMessagePageSchema.parse(
      (await get(pool, owner, `${mp}?limit=50`)).body.data,
    );
    const ml = ConversationMessagePageSchema.parse(
      (await get(pool, owner, paged(mp, mf.next_cursor, 50))).body.data,
    );
    expect(mf.items).toHaveLength(50);
    expect(ml.items).toHaveLength(1);
    expect(ml.next_cursor).toBeNull();
    expect([...mf.items, ...ml.items].map((item) => item.content)).toEqual(
      Array.from({ length: 51 }, (_, i) => String(i + 1)),
    );
    const rf = ConversationRunPageSchema.parse(
      (await get(pool, owner, `${rp}?limit=50`)).body.data,
    );
    const rl = ConversationRunPageSchema.parse(
      (await get(pool, owner, paged(rp, rf.next_cursor, 50))).body.data,
    );
    expect(rf.items).toHaveLength(50);
    expect(rl.items).toHaveLength(1);
    expect(rl.next_cursor).toBeNull();
    expect(new Set([...rf.items, ...rl.items].map((item) => item.run_id)).size).toBe(51);
  });

  it('discovers a delayed commit at an already-passed position only on explicit refresh', async () => {
    const owner = await user(pool);
    const known: string[] = [];
    for (const digit of [0, 2, 4, 6])
      known.push(await conversation(pool, owner, `2026-10-28T09:00:00.12346${digit}Z`));
    const delayed = await pool.connect();
    const lateId = randomUUID();
    try {
      await delayed.query('BEGIN');
      await delayed.query(
        `INSERT INTO conversations(id,owner_id,created_at) VALUES ($1,$2,'2026-10-28T09:00:00.123465Z')`,
        [lateId, owner],
      );
      const first = ConversationListPageSchema.parse(
        (await get(pool, owner, paged(base, null))).body.data,
      );
      expect(first.items.map((item) => item.conversation_id)).toEqual([known[3], known[2]]);
      await delayed.query('COMMIT');
      const second = ConversationListPageSchema.parse(
        (await get(pool, owner, paged(base, first.next_cursor))).body.data,
      );
      expect(second.items.map((item) => item.conversation_id)).toEqual([known[1], known[0]]);
      expect(second.next_cursor).toBeNull();
      const refreshed = ConversationListPageSchema.parse((await get(pool, owner, base)).body.data);
      expect(refreshed.items.map((item) => item.conversation_id)).toEqual([
        known[3],
        lateId,
        known[2],
        known[1],
        known[0],
      ]);
    } finally {
      await delayed.query('ROLLBACK');
      delayed.release();
    }
  });

  it('returns exact-run deep links and trustworthy originals, distinguishing legacy and corrupt references', async () => {
    const owner = await user(pool);
    const other = await user(pool);
    const cid = await conversation(pool, owner);
    const foreignCid = await conversation(pool, other);
    const at = '2026-10-28T09:00:00.123456Z';
    const mid = await message(pool, owner, cid, ' \n original\t ', at);
    const second = await message(pool, owner, cid, 'second original', at);
    const foreign = await message(pool, other, foreignCid, 'foreign', at);
    const system = await message(pool, owner, cid, 'system', at, 'system');
    const direct = await run(pool, owner, cid, at, mid);
    await reference(pool, owner, cid, direct, second);
    const fallback = await run(pool, owner, cid, at);
    await reference(pool, owner, cid, fallback, second);
    await reference(pool, owner, cid, fallback, second);
    const legacy = await run(pool, owner, cid, at);
    const corrupt = await run(pool, owner, cid, at, foreign);
    await reference(pool, owner, cid, corrupt, mid);
    const systemRef = await run(pool, owner, cid, at, system);
    const ambiguous = await run(pool, owner, cid, at);
    await reference(pool, owner, cid, ambiguous, mid);
    await reference(pool, owner, cid, ambiguous, second);
    const nullReference = await run(pool, owner, cid, at);
    await reference(pool, owner, cid, nullReference, null);
    const mismatch = await run(pool, owner, cid, at);
    await reference(pool, other, foreignCid, mismatch, foreign);
    for (const [rid, original] of [
      [
        direct,
        {
          state: 'available',
          source: 'input_message',
          message: { message_id: mid, content: ' \n original\t ', created_at: at },
        },
      ],
      [
        fallback,
        {
          state: 'available',
          source: 'idempotency_reference',
          message: { message_id: second, content: 'second original', created_at: at },
        },
      ],
      [legacy, { state: 'legacy_unavailable' }],
      [nullReference, { state: 'legacy_unavailable' }],
      ...[corrupt, systemRef, ambiguous, mismatch].map(
        (rid) => [rid, { state: 'invalid_reference' }] as const,
      ),
    ] as const) {
      const page = ConversationRunPageSchema.parse(
        (await get(pool, owner, `${base}/${cid}/runs?run_id=${rid}`)).body.data,
      );
      expect(page.items).toHaveLength(1);
      expect(page.next_cursor).toBeNull();
      expect(page.items[0]?.original).toEqual(original);
    }
    expect((await get(pool, owner, `${base}/${cid}/runs?run_id=${randomUUID()}`)).status).toBe(404);
    expect(
      (
        await get(
          pool,
          owner,
          `${base}/${cid}/runs?run_id=${await run(pool, other, foreignCid, at)}`,
        )
      ).status,
    ).toBe(404);
    expect((await get(pool, owner, `${base}/${cid}/runs?run_id=${direct}&cursor=abc`)).status).toBe(
      400,
    );
  });

  it('pages every externally visible event for one Run across attempts without snapshots or other Runs', async () => {
    const owner = await user(pool);
    const cid = await conversation(pool, owner);
    const rid = await run(pool, owner, cid, '2026-10-28T09:00:00.123456Z');
    const other = await run(pool, owner, cid, '2026-10-28T09:00:00.123457Z');
    await withTransaction(pool, async (client) => {
      for (const [runId, n] of [
        [rid, 1],
        [rid, 2],
        [other, 1],
      ] as const) {
        const attemptId = randomUUID();
        await insertAttempt(client, { ownerId: owner, runId, attemptId, attemptNo: n });
        for (let i = 1; i <= (runId === rid ? 251 : 3); i++) {
          await appendCheckpoint(client, {
            ownerId: owner,
            attemptId,
            seq: i,
            type: 'message.delta',
            payload: { conversation_id: cid, run_id: runId, delta: `${n}:${i}` },
            requestId: 'history',
          });
        }
        await appendCheckpoint(client, {
          ownerId: owner,
          attemptId,
          seq: 999,
          type: 'thinking',
          payload: { private: 'snapshot' },
          requestId: 'history',
        });
      }
    });
    const pageSizes: number[] = [];
    const deltas: string[] = [];
    let after: number | null = null;
    do {
      const response = await get(
        pool,
        owner,
        `${base}/${cid}?run_id=${rid}&limit=200${after === null ? '' : `&after_seq=${after}`}`,
      );
      expect(response.status).toBe(200);
      const data = response.body.data as {
        events: { seq: number; type: string; payload: { run_id: string; delta: string } }[];
        next_after_seq: number | null;
      };
      pageSizes.push(data.events.length);
      for (const event of data.events) {
        expect(event.type).toBe('message.delta');
        expect(event.payload.run_id).toBe(rid);
        deltas.push(event.payload.delta);
      }
      after = data.next_after_seq;
    } while (after !== null);
    expect(pageSizes).toEqual([200, 200, 102, 0]);
    expect(deltas).toHaveLength(502);
    expect(new Set(deltas).size).toBe(502);
    const defaultPage = (await get(pool, owner, `${base}/${cid}`)).body.data as {
      events: unknown[];
    };
    expect(defaultPage.events).toHaveLength(200);
    expect((await get(pool, owner, `${base}/${cid}?limit=500`)).body.data).toMatchObject({
      conversation_id: cid,
    });
    expect((await get(pool, owner, `${base}/${cid}?run_id=${randomUUID()}`)).status).toBe(404);
  });

  it('rejects strict malformed queries, preserves error categories and performs no historical writes', async () => {
    const owner = await user(pool);
    const cid = await conversation(pool, owner);
    const mid = await message(pool, owner, cid, 'read only', '2026-10-28T09:00:00.123456Z');
    const rid = await run(pool, owner, cid, '2026-10-28T09:00:00.123456Z', mid);
    await reference(pool, owner, cid, rid, mid);
    for (const path of [base, `${base}/${cid}/messages`, `${base}/${cid}/runs`]) {
      for (const query of [
        'limit=0',
        'limit=51',
        'limit=1e1',
        'limit=1&limit=2',
        'cursor=a&cursor=b',
        'cursor=',
        'owner_id=x',
        'cursor=not-json',
      ]) {
        const response = await get(pool, owner, `${path}?${query}`);
        expect(response.status).toBe(400);
        expect(response.body.error?.code).toBe('VALIDATION_ERROR');
      }
      expect((await get(null, owner, path)).status).toBe(503);
      expect((await get(pool, null, path)).status).toBe(401);
    }
    for (const query of [
      `run_id=${rid}&run_id=${rid}`,
      'run_id=no',
      'limit=501',
      'after_seq=1&after_seq=2',
      'unknown=x',
    ]) {
      expect((await get(pool, owner, `${base}/${cid}?${query}`)).status).toBe(400);
    }
    const snapshot = async () =>
      (
        await pool.query(`SELECT
      (SELECT count(*) FROM messages) AS messages,(SELECT count(*) FROM agent_runs) AS runs,
      (SELECT count(*) FROM run_attempts) AS attempts,(SELECT count(*) FROM run_checkpoints) AS checkpoints,
      (SELECT count(*) FROM approvals) AS approvals,(SELECT count(*) FROM conversation_idempotency) AS idempotency,
      (SELECT count(*) FROM tool_calls) AS audits,(SELECT count(*) FROM tool_invocations) AS invocations`)
      ).rows;
    const before = await snapshot();
    for (let i = 0; i < 3; i++) {
      await get(pool, owner, base);
      await get(pool, owner, `${base}/${cid}/messages`);
      await get(pool, owner, `${base}/${cid}/runs`);
      await get(pool, owner, `${base}/${cid}?run_id=${rid}`);
    }
    expect(await snapshot()).toEqual(before);
    const readOnly = await pool.connect();
    try {
      await readOnly.query('BEGIN READ ONLY');
      const readPool = { query: readOnly.query.bind(readOnly) } as unknown as Pool;
      for (const path of [
        base,
        `${base}/${cid}/messages`,
        `${base}/${cid}/runs`,
        `${base}/${cid}?run_id=${rid}`,
      ])
        expect((await get(readPool, owner, path)).status).toBe(200);
      await readOnly.query('ROLLBACK');
    } finally {
      readOnly.release();
    }
    const broken = database.connect();
    await broken.query(`SET search_path TO pg_catalog`);
    try {
      const response = await get(broken, owner, base);
      expect(response.status).toBe(500);
      expect(response.body.error?.code).toBe('INTERNAL_ERROR');
      expect(JSON.stringify(response.body)).not.toContain('relation');
    } finally {
      await broken.end();
    }
  });
});
