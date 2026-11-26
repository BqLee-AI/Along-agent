import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { networkInterfaces, tmpdir } from 'node:os';
import type { NextRequest } from 'next/server';
import { join } from 'node:path';
import {
  addModel,
  createProvider,
  setDefault,
  updateProvider,
} from '../../apps/api/src/features/model-providers/public.js';
import {
  frames,
  jsonBody,
  listen,
  pending,
  sendModelSse,
  started,
} from '../../apps/api/test/helpers/harness-consumer.js';
import { conversationMemorySources } from '../../apps/api/src/features/conversations/public.js';
import { createMemoryService } from '../../apps/api/src/features/memory/public.js';
import {
  createIntegrationDatabase,
  seedAdmittedSession,
} from '../../apps/api/test/integration/setup.js';

const database = await createIntegrationDatabase();
const owner = await seedAdmittedSession(database.pool);
const workspace = await mkdtemp(join(tmpdir(), 'along-product-proof-'));
const document = join(workspace, 'brief.txt');
const registry = join(workspace, 'registry.json');
const original = 'Original brief.\n';
const workspaceId = randomUUID();
const updated = 'Updated brief.\n';
await writeFile(document, original);
await writeFile(
  registry,
  JSON.stringify([
    {
      owner_id: owner.userId,
      workspace_id: workspaceId,
      label: 'Documents',
      root: workspace,
      readable_paths: ['brief.txt'],
      writable_paths: ['brief.txt'],
    },
  ]),
);
let documentCalls = 0;
let approvalId: string;
const apiOrigin = 'http://127.0.0.1:3002';
const appOrigin = 'http://localhost:3000';
const proxyToken = randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '');
const upstream = createServer(async (request, response) => {
  try {
    const { messages } = (await jsonBody(request)) as { messages: { content?: string }[] };
    if (!messages.some(({ content }) => content?.includes('Document approval fixture'))) {
      sendModelSse(response, {
        message: { content: '会议摘要：周五确认交付。', tool_calls: [] },
        usage: { total_tokens: 25 },
      });
      return;
    }
    const round = ++documentCalls;
    let name: string;
    let args: object;
    if (round === 1 || round === 4) {
      name = 'workspace_read';
      args = { workspace_id: workspaceId, path: 'brief.txt' };
    } else if (round === 2) {
      const {
        rows: [read],
      } = await database.pool.query(
        `SELECT invocation_id FROM tool_invocations
         WHERE owner_id=$1 AND tool_id='workspace_read' AND state='completed'`,
        [owner.userId],
      );
      name = 'workspace_propose_replace';
      args = {
        read_invocation_id: read.invocation_id,
        change: { kind: 'literal', old_text: 'Original', new_text: 'Updated' },
      };
    } else if (round === 3) {
      name = 'workspace_apply_replace';
      args = { approval_id: approvalId };
    } else {
      assert.equal(round, 5);
      const { rows } = await database.pool.query(
        `SELECT invocation_id FROM tool_invocations
         WHERE owner_id=$1 AND state='completed' AND tool_id IN ('workspace_read','workspace_apply_replace')`,
        [owner.userId],
      );
      name = 'finish_goal';
      args = {
        status: 'completed',
        outcomes: [
          {
            description: '文档已更新',
            status: 'achieved',
            receipt_refs: rows.map((row) => row.invocation_id),
          },
        ],
        clarification: null,
        answer: '完成',
      };
    }
    sendModelSse(response, {
      message: {
        content: null,
        tool_calls: [
          {
            id: `document-${round}`,
            type: 'function',
            function: { name, arguments: JSON.stringify(args) },
          },
        ],
      },
      usage: { total_tokens: 25 },
    });
  } catch (error) {
    console.error(error);
    response.destroy();
  }
});
const modelOrigin = await listen(upstream);
process.env.MODEL_PROVIDER_ALLOWED_LOCAL_ORIGINS = modelOrigin;
process.env.MODEL_PROVIDER_ENCRYPTION_KEY = Buffer.alloc(32).toString('base64');
const host = Bun.spawn(['/app/host/bin/along-host', '3002'], {
  env: {
    ...process.env,
    APP_ORIGIN: appOrigin,
    ALONG_LOCAL_MODEL_PROXY_TOKEN: proxyToken,
    ROLE: 'api',
    TZDB_VERSION: 'fixture-v1',
    WORKSPACE_REGISTRY_FILE: registry,
    HARNESS_COMPLETION_CAP: '1024',
    DATABASE_URL: database.connectionString,
  },
  stdout: 'inherit',
  stderr: 'inherit',
});
try {
  const headers = {
    cookie: `better-auth.session_token=${owner.token}`,
    'x-csrf-token': owner.csrfToken,
    'content-type': 'application/json',
    origin: appOrigin,
  };
  async function request(path: string, body?: unknown, status = 200, key?: string) {
    const id = randomUUID();
    const response = await fetch(`${apiOrigin}/api/v1${path}`, {
      headers: { ...headers, 'x-request-id': id, ...(key ? { 'idempotency-key': key } : {}) },
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10_000),
    });
    const envelope = await response.json();
    assert.equal(response.status, status, `${path}: ${JSON.stringify(envelope)}`);
    assert.equal(response.headers.get('x-request-id'), id);
    return envelope.data;
  }
  for (const deadline = performance.now() + 5_000; ;) {
    if (
      await fetch(`${apiOrigin}/healthz`).then(
        (r) => r.ok,
        () => false,
      )
    )
      break;
    if (performance.now() >= deadline || host.exitCode !== null)
      throw Error('Host failed to start');
    await Bun.sleep(100);
  }
  const before = await database.pool.query('SELECT count(*)::int AS count FROM task_events');
  await request('/brief?date=2026-11-26&timezone=Asia%2FShanghai');
  const after = await database.pool.query('SELECT count(*)::int AS count FROM task_events');
  assert.deepEqual(after.rows, before.rows);
  assert.deepEqual(
    (await request('/workspaces')).items.map(
      ({ workspace_id }: { workspace_id: string }) => workspace_id,
    ),
    [workspaceId],
  );

  const config = {
    name: 'Native product Bot',
    introduction: '',
    role: '',
    instructions: '',
    model_selection: null,
    tool_ids: [
      'workspace_read',
      'workspace_propose_replace',
      'workspace_apply_replace',
      'finish_goal',
    ],
    workspace_ids: [workspaceId],
  };
  const personalBot = await request('/bots', config);
  const botPath = `/bots/${personalBot.id}`;
  assert.deepEqual(await request('/bots'), { items: [personalBot] });
  assert.deepEqual(await request(botPath), personalBot);
  const savedBot = await request(botPath, { ...config, introduction: 'Native save', revision: 1 });
  assert.equal(savedBot.revision, 2);
  assert.equal(savedBot.config.introduction, 'Native save');
  const createKey = randomUUID();
  const { conversation_id: conversationId } = await request(
    `${botPath}/conversations`,
    {},
    200,
    createKey,
  );
  assert.deepEqual(await request(`${botPath}/conversations`, {}, 200, createKey), {
    conversation_id: conversationId,
  });
  assert.deepEqual(await request(`/conversations/${conversationId}/bot`), {
    bot_id: personalBot.id,
  });
  const page = await request(`${botPath}/conversations`);
  assert.deepEqual(
    page.items.map(({ conversation_id }: { conversation_id: string }) => conversation_id),
    [conversationId],
  );
  const messageId = randomUUID();
  const { conversation_id: documentConversationId } = await request(
    `${botPath}/conversations`,
    {},
    200,
    randomUUID(),
  );
  await database.pool.query(
    "INSERT INTO messages(id,owner_id,conversation_id,role,content) VALUES($1,$2,$3,'user','tea')",
    [messageId, owner.userId, conversationId],
  );
  const memory = await createMemoryService({
    pool: database.pool,
    sources: conversationMemorySources,
  }).remember(owner.userId, {
    conversationId,
    messageIds: [messageId],
    content: 'tea',
    idempotencyKey: randomUUID(),
  });
  const corrected = await request(`/memories/${memory.id}/actions/correct`, {
    conversationId,
    messageIds: [messageId],
    content: 'green tea',
    expectedRevision: 1,
  });
  assert.equal(corrected.revision, 2);
  assert.equal((await request(`/memories/${memory.id}`)).content, 'green tea');

  await database.pool.query(
    `INSERT INTO feishu_bot_connections (owner_id,attempt_id,expires_at,app_id,bot_name)
     VALUES ($1,$2,clock_timestamp()+interval '1 hour','cli_fixture','Test Robot')`,
    [owner.userId, randomUUID()],
  );
  const bot = '/office/feishu/bot';
  assert.deepEqual(await request(bot), { state: 'connected', name: 'Test Robot' });
  assert.deepEqual(await request(`${bot}/disconnect`, {}), { state: 'idle' });
  assert.deepEqual(await request(bot), { state: 'idle' });
  assert.equal((await database.pool.query('SELECT 1 FROM feishu_bot_connections')).rowCount, 0);

  const provider = await createProvider(database.pool, owner.userId, 'Office summary fixture');
  await updateProvider(database.pool, owner.userId, provider.id, {
    base_url: `${modelOrigin}/v1`,
    credential: { action: 'replace', api_key: 'fixture-only' },
  });
  await addModel(database.pool, owner.userId, provider.id, 'office-summary');
  await setDefault(database.pool, owner.userId, {
    provider_id: provider.id,
    model_id: 'office-summary',
  });
  const summaryPath = '/model-providers/actions/summarize-notes';
  const summaryInput = { notes: '负责人在周五确认交付。' };
  const summary = { summary: '会议摘要：周五确认交付。' };
  assert.deepEqual(await request(summaryPath, summaryInput), summary);
  const external = Object.values(networkInterfaces())
    .flat()
    .find((address) => address?.family === 'IPv4' && !address.internal);
  assert(external, 'run on a disposable Docker network');
  process.env.API_BASE = `http://${external.address}:3002`;
  process.env.ALONG_LOCAL_MODEL_PROXY_TOKEN = proxyToken;
  const summaryRequest = () => ({
    method: 'POST',
    headers,
    body: JSON.stringify(summaryInput),
    signal: AbortSignal.timeout(10_000),
  });
  const denied = await fetch(`${process.env.API_BASE}/api/v1${summaryPath}`, summaryRequest());
  assert.equal(denied.status, 403);
  await denied.arrayBuffer();
  // The Next route captures API_BASE at module load, after this test selects its listener.
  const { POST } = await import('../../apps/web/src/app/api/[...path]/route.js');
  const proxied = await POST(
    new Request(`${appOrigin}/api/v1${summaryPath}`, summaryRequest()) as NextRequest,
    { params: Promise.resolve({ path: ['v1', 'model-providers', 'actions', 'summarize-notes'] }) },
  );
  assert.equal(proxied.status, 200);
  assert.deepEqual((await proxied.json()).data, summary);

  async function stream(path: string, body: unknown) {
    const response = await fetch(`${apiOrigin}/api/v1${path}`, {
      method: 'POST',
      headers: { ...headers, 'idempotency-key': randomUUID() },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await response.text();
    assert.equal(response.status, 200, text);
    assert.match(response.headers.get('content-type') ?? '', /^text\/event-stream/);
    return frames(text);
  }
  const proposal = await stream('/conversations/messages', {
    conversation_id: documentConversationId,
    execution: 'harness',
    authorization_revision: 'delegation/1',
    raw_text:
      'Document approval fixture. Read brief.txt, propose replacing Original with Updated, wait for approval, then apply and independently read it back.',
  });
  approvalId = pending(proposal);
  const ids = started(proposal);
  const approvalPath = `/document-approvals/${approvalId}`;
  const frozen = await request(approvalPath);
  assert.equal(frozen.preview.before, original);
  assert.equal(frozen.preview.after, updated);
  const confirm = {
    presentation_hash: frozen.presentation_hash,
    seen_content: frozen.preview.body,
    idempotency_key: randomUUID(),
  };
  await request(
    `${approvalPath}/actions/confirm`,
    { ...confirm, seen_content: `${confirm.seen_content} ` },
    409,
  );
  assert.equal((await request(`${approvalPath}/actions/confirm`, confirm)).duplicate, false);
  assert.equal((await request(`${approvalPath}/actions/confirm`, confirm)).duplicate, true);
  assert.equal(await readFile(document, 'utf8'), original);
  const runPath = `/conversations/${ids.conversation_id}/runs/${ids.run_id}`;
  const waiting = await request(runPath);
  const resumed = await stream(`${runPath}/actions/resume`, {
    checkpoint_id: waiting.waiting.checkpoint_id,
    idempotency_key: randomUUID(),
  });
  assert.equal(resumed.at(-1)?.type, 'thread.completed', JSON.stringify(resumed));
  assert.equal(await readFile(document, 'utf8'), updated);
  assert.equal(documentCalls, 5);
  const { rows: evidence } = await database.pool.query(
    `SELECT tool_id,accepted_result FROM tool_invocations
     WHERE run_id=$1 AND state='completed' ORDER BY created_at`,
    [ids.run_id],
  );
  assert.equal(evidence.filter(({ tool_id }) => tool_id === 'workspace_apply_replace').length, 1);
  const reads = evidence.filter(({ tool_id }) => tool_id === 'workspace_read');
  assert.deepEqual(
    reads.map(({ accepted_result }) => accepted_result.result.content),
    [original, updated],
  );
  assert.deepEqual((await request(approvalPath)).preview, frozen.preview);

  await database.pool.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE id=$1', [
    owner.sessionId,
  ]);
  await request(`/memories/${memory.id}`, undefined, 401);
  await request(bot, undefined, 401);
  await request(botPath, undefined, 401);
  console.log(
    'Native product HTTP verified brief, workspaces, memory, Feishu disconnect, office summary, document approval, independent reread and session revocation.',
  );
} finally {
  if (host.exitCode === null) host.kill('SIGTERM');
  await host.exited;
  upstream.closeAllConnections();
  upstream.close();
  await rm(workspace, { recursive: true, force: true });
  await database.close();
}
