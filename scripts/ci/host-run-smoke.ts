import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import {
  createIntegrationDatabase,
  seedAdmittedSession,
} from '../../apps/api/test/integration/setup.js';
import {
  addModel,
  createProvider,
  setDefault,
  updateProvider,
} from '../../apps/api/src/features/model-providers/public.js';
import { getApprovalDetail } from '../../apps/api/src/features/approvals/reminder/service.js';
import {
  frames,
  jsonBody,
  listen,
  pending,
  sendModelSse,
  started,
} from '../../apps/api/test/helpers/harness-consumer.js';
import { fixtureBotConfig } from '../../apps/api/test/helpers/bot-conversation.js';

const db = await createIntegrationDatabase();
const modelCalls = { approval: 0, pause: 0, compact: 0 };
const gates = new Map<
  string,
  {
    entered: ReturnType<typeof Promise.withResolvers<void>>;
    release: ReturnType<typeof Promise.withResolvers<void>>;
    dispatched?: boolean;
  }
>();
const upstream = createServer(async (req, res) => {
  try {
    const { messages } = (await jsonBody(req)) as {
      messages: Array<{ role: string; content: string }>;
    };
    const system = messages.find((message) => message.role === 'system')?.content ?? '';
    const user = messages.findLast((message) => message.role === 'user')?.content ?? '';
    let name = '';
    let args: unknown = {};
    let content: string | null = null;
    if (system.includes('producing a compact, untrusted historical summary')) {
      modelCalls.compact++;
      const input = JSON.parse(user);
      content = JSON.stringify({
        text: 'Historical summary',
        coverage: [
          ...(input.previous?.coverage ?? []),
          ...input.messages.map(({ id, sequence }) => ({ id, sequence })),
        ],
        candidates: [],
      });
    } else if (user.includes('approval scenario')) {
      if (modelCalls.approval++ === 0) {
        name = 'propose_task';
        args = {
          raw_time_text: '2027-11-02 09:20',
          timezone_hint: 'Asia/Shanghai',
          note: 'native approval scenario',
          occurrence: 'once',
        };
      } else {
        content = 'Reminder decision observed';
      }
    } else if (user.includes('pause scenario') || user.includes('active compact scenario')) {
      const label = user.includes('pause scenario') ? 'pause' : 'active compact';
      const gate = gates.get(label)!;
      if (label === 'pause') modelCalls.pause++;
      if (!gate.dispatched) {
        gate.dispatched = true;
        gate.entered.resolve();
        await gate.release.promise;
        name = 'get_user_prefs';
      } else {
        name = 'finish_goal';
        args = {
          status: 'completed',
          outcomes: [{ description: 'Answer', status: 'achieved', receipt_refs: [] }],
          clarification: null,
          answer: 'Resumed answer',
        };
      }
    } else if (messages.some((message) => message.content?.includes('disconnect scenario'))) {
      const gate = gates.get('disconnect')!;
      gate.entered.resolve();
      await gate.release.promise;
      content = 'Late reply must lose';
    } else if (messages.some((message) => message.content?.includes('cancel scenario'))) {
      const gate = gates.get('cancel')!;
      gate.entered.resolve();
      await gate.release.promise;
      name = 'finish_goal';
      args = {
        status: 'completed',
        outcomes: [{ description: 'Answer', status: 'achieved', receipt_refs: [] }],
        clarification: null,
        answer: 'Late reply must lose',
      };
    } else if (user.includes('automatic compact scenario')) {
      name = 'finish_goal';
      args = {
        status: 'completed',
        outcomes: [{ description: 'Answer', status: 'achieved', receipt_refs: [] }],
        clarification: null,
        answer: 'Automatic compact continuation',
      };
    } else {
      content = 'Native answer';
    }
    if (res.destroyed) return;
    sendModelSse(res, {
      message: {
        content,
        tool_calls: name
          ? [
              {
                id: randomUUID(),
                type: 'function',
                function: { name, arguments: JSON.stringify(args) },
              },
            ]
          : [],
      },
      usage: { total_tokens: 12 },
    });
  } catch (error) {
    console.error(error);
    res.destroy();
  }
});
let host: ReturnType<typeof Bun.spawn> | undefined;
try {
  const session = await seedAdmittedSession(db.pool);
  const origin = await listen(upstream);
  process.env.MODEL_PROVIDER_ALLOWED_LOCAL_ORIGINS = origin;
  process.env.MODEL_PROVIDER_ENCRYPTION_KEY = Buffer.alloc(32).toString('base64');
  const provider = await createProvider(db.pool, session.userId, 'Native Run proof');
  await updateProvider(db.pool, session.userId, provider.id, {
    base_url: `${origin}/v1`,
    credential: { action: 'replace', api_key: 'fixture-only' },
  });
  await addModel(db.pool, session.userId, provider.id, 'native-run');
  await setDefault(db.pool, session.userId, { provider_id: provider.id, model_id: 'native-run' });
  host = Bun.spawn(['/app/host/bin/along-host', '3003'], {
    env: {
      ...process.env,
      ROLE: 'api',
      DATABASE_URL: db.connectionString,
      TZDB_VERSION: 'fixture-v1',
      HARNESS_COMPLETION_CAP: '1024',
      HARNESS_AUTO_COMPACT_PLANNING_TOKENS: '16000',
    },
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const base = 'http://127.0.0.1:3003';
  const root = '/api/v1/conversations';
  const auth = {
    cookie: `better-auth.session_token=${session.token}`,
    'x-csrf-token': session.csrfToken,
  };
  const get = (path: string) =>
    fetch(base + path, { headers: auth, signal: AbortSignal.timeout(20_000) });
  const post = (path: string, body: unknown, key = randomUUID()) =>
    fetch(base + path, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json', 'idempotency-key': key },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
  const until = async <T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> => {
    const deadline = Date.now() + 12_000;
    let value: T;
    do {
      value = await read();
      if (done(value)) return value;
      await Bun.sleep(100);
    } while (Date.now() < deadline);
    throw new Error(`durable state did not converge: ${JSON.stringify(value)}`);
  };
  const json = async (response: Response) => {
    const body = await response.text();
    assert.equal(response.status, 200, body);
    return JSON.parse(body).data;
  };
  const collect = async (response: Response) => {
    const text = await response.text();
    assert.equal(response.status, 200, text);
    assert.match(response.headers.get('content-type') ?? '', /^text\/event-stream/);
    return frames(text);
  };
  await until(async () => {
    try {
      return (await get('/healthz')).ok;
    } catch {
      return false;
    }
  }, Boolean);
  const { id: botId } = await json(
    await post('/api/v1/bots', { ...fixtureBotConfig(session.userId), name: 'Native Run smoke' }),
  );
  const newConversation = async (): Promise<string> => {
    const { conversation_id } = await json(await post(`/api/v1/bots/${botId}/conversations`, {}));
    return conversation_id;
  };
  const send = async (text: string, delegated = false, conversationId?: string) =>
    post(root + '/messages', {
      raw_text: text,
      execution: 'harness',
      confirmed_timezone: 'Asia/Shanghai',
      conversation_id: conversationId ?? (await newConversation()),
      ...(delegated ? { authorization_revision: 'delegation/1' } : {}),
    });
  const normal = await collect(await send('plain historical chat'));
  assert.equal(normal.at(-1)?.type, 'thread.completed', JSON.stringify(normal));
  const runPath = (conversation: string, run: string) => `${root}/${conversation}/runs/${run}`;
  const normalIds = started(normal);
  assert.deepEqual(
    await collect(
      await get(
        `${runPath(normalIds.conversation_id, normalIds.run_id)}/events?after_seq=${normal[0]!.seq}`,
      ),
    ),
    normal.slice(1),
  );
  const listed = await json(await get(`${root}?limit=1`));
  assert.equal(listed.items.length, 1);
  const invalidCursor = await get(
    `${runPath(normalIds.conversation_id, normalIds.run_id)}/events?after_seq=1&after_seq=2`,
  );
  assert.equal(invalidCursor.status, 400);
  assert.equal((await invalidCursor.json()).error.code, 'VALIDATION_ERROR');

  async function openBlocked(text: string, delegated: boolean, conversationId?: string) {
    const gate = { entered: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() };
    gates.set(text, gate);
    const response = await send(`${text} scenario`, delegated, conversationId);
    assert.equal(response.status, 200);
    const path = runPath(
      response.headers.get('x-conversation-id')!,
      response.headers.get('x-run-id')!,
    );
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let opening = '';
    while (!opening.includes('thread.started')) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false, `${text} closed before thread.started`);
      opening += decoder.decode(chunk.value, { stream: true });
    }
    await Promise.race([
      gate.entered.promise,
      Bun.sleep(8000).then(() => {
        throw new Error('provider never entered');
      }),
    ]);
    return { path, reader, release: gate.release.resolve };
  }
  const disconnected = await openBlocked('disconnect', false);
  await disconnected.reader.cancel();
  await until(
    async () => json(await get(disconnected.path)),
    (run) => run.status === 'cancelled',
  );
  disconnected.release();
  const cancelled = await openBlocked('cancel', true);
  assert.equal(
    (await json(await post(`${cancelled.path}/actions/cancel`, { idempotency_key: randomUUID() })))
      .status,
    'cancelled',
  );
  cancelled.release();
  await cancelled.reader.cancel();
  const cancellation = await collect(await get(`${cancelled.path}/events`));
  assert.equal(cancellation.at(-1)?.type, 'thread.cancelled');

  const waitingEvents = await collect(
    await send('approval scenario 2027-11-02 09:20 提醒我检查报告'),
  );
  assert.ok(
    waitingEvents.some((event) => event.type === 'approval_required'),
    JSON.stringify(waitingEvents),
  );
  const approvalId = pending(waitingEvents);
  const waitingIds = started(waitingEvents);
  const waitingPath = runPath(waitingIds.conversation_id, waitingIds.run_id);
  const waiting = await json(await get(waitingPath));
  assert.equal(waiting.status, 'suspended_approval');
  const resume = { checkpoint_id: waiting.waiting.checkpoint_id, idempotency_key: randomUUID() };
  assert.equal((await post(`${waitingPath}/actions/resume`, resume)).status, 409);
  const { detail } = await getApprovalDetail(db, session.userId, approvalId);
  await json(
    await post(`/api/v1/approvals/${approvalId}/actions/confirm`, {
      presentation_hash: detail.presentation_hash,
      seen_content: detail.echo_text,
      idempotency_key: randomUUID(),
    }),
  );
  const resumed = await collect(await post(`${waitingPath}/actions/resume`, resume));
  assert.equal(resumed.at(-1)?.type, 'thread.completed', JSON.stringify(resumed));
  assert.deepEqual(await collect(await post(`${waitingPath}/actions/resume`, resume)), resumed);
  assert.equal(modelCalls.approval, 2);
  const originalEffect = await db.pool.query(
    'SELECT count(*)::int AS count FROM tool_invocations WHERE run_id=$1 AND tool_id=$2',
    [waitingIds.run_id, 'propose_task'],
  );
  assert.equal(originalEffect.rows[0]?.count, 1);

  const paused = await openBlocked('pause', true);
  const pause = await json(
    await post(`${paused.path}/actions/pause`, { reason: 'user', purpose: 'none' }),
  );
  paused.release();
  await until(
    async () => json(await get(paused.path)),
    (run) => run.status === 'paused',
  );
  await paused.reader.cancel();
  const continued = await collect(
    await post(`${paused.path}/actions/continue`, { pause_id: pause.pause_id }),
  );
  assert.equal(continued.at(-1)?.type, 'thread.completed', JSON.stringify(continued));

  const compact = await json(
    await post(`${root}/${normalIds.conversation_id}/actions/compact`, {}),
  );
  assert.ok(compact.run_id, JSON.stringify(compact));
  const compactPath = `${runPath(normalIds.conversation_id, compact.run_id)}/compacts/${compact.pause_id}`;
  const compacted = await until(
    async () => json(await get(compactPath)),
    (receipt) => ['continued', 'failed'].includes(receipt.status),
  );
  assert.equal(compacted.status, 'continued', JSON.stringify(compacted));
  assert.equal(modelCalls.compact, 1);
  const active = await openBlocked('active compact', true, waitingIds.conversation_id);
  const activeKey = randomUUID();
  const activeReceipt = await json(await post(`${active.path}/actions/compact`, {}, activeKey));
  assert.equal(activeReceipt.status, 'pending');
  const repeatedCompact = await json(await post(`${active.path}/actions/compact`, {}, activeKey));
  assert.equal(repeatedCompact.pause_id, activeReceipt.pause_id);
  active.release();
  const activeResult = await until(
    async () => json(await get(`${active.path}/compacts/${activeReceipt.pause_id}`)),
    (receipt) => ['continued', 'failed'].includes(receipt.status),
  );
  assert.equal(activeResult.status, 'continued', JSON.stringify(activeResult));
  await active.reader.cancel();
  const activeEvents = await collect(await get(`${active.path}/events`));
  assert.equal(activeEvents.at(-1)?.type, 'thread.completed', JSON.stringify(activeEvents));
  assert.equal(modelCalls.compact, 2);

  const history = await collect(await send('历史资料'.repeat(4750)));
  assert.equal(history.at(-1)?.type, 'thread.completed', JSON.stringify(history));
  const initialAuto = await collect(
    await send('automatic compact scenario', true, started(history).conversation_id),
  );
  const autoIds = started(initialAuto);
  const autoPath = runPath(autoIds.conversation_id, autoIds.run_id);
  const autoView = await until(
    async () => json(await get(autoPath)),
    (run) => run.status === 'done' || run.status === 'failed',
  );
  const auto = await collect(await get(`${autoPath}/events`));
  assert.equal(autoView.status, 'done', JSON.stringify({ autoView, auto }));
  assert.equal(auto.at(-1)?.type, 'thread.completed', JSON.stringify(auto));
  const autoOperations = await db.pool.query(
    `SELECT p.purpose, p.state, o.status, o.usage_recorded FROM harness_pauses p
     JOIN compact_operations o ON o.pause_id=p.id WHERE p.run_id=$1`,
    [autoIds.run_id],
  );
  assert.deepEqual(autoOperations.rows, [
    {
      purpose: 'automatic_compact',
      state: 'consumed',
      status: 'published',
      usage_recorded: true,
    },
  ]);
  assert.equal(modelCalls.compact, 3);
  console.log(
    'native conversation HTTP verified cursor replay, request-bound abort, cancel fencing, approval resume, pause continuation and idle, active and automatic compact',
  );
} finally {
  for (const gate of gates.values()) gate.release.resolve();
  if (host && host.exitCode === null) {
    host.kill('SIGTERM');
    const timeout = setTimeout(() => host?.kill('SIGKILL'), 6000);
    try {
      assert.equal(await host.exited, 0);
    } finally {
      clearTimeout(timeout);
    }
  }
  upstream.closeAllConnections();
  upstream.close();
  await db.close();
}
