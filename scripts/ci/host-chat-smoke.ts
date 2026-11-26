import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  createIntegrationDatabase,
  seedAdmittedSession,
} from '../../apps/api/test/integration/setup.js';
import { getApprovalDetail } from '../../apps/api/src/features/approvals/reminder/service.js';
import { createServer } from 'node:http';
import {
  addModel,
  createProvider,
  setDefault,
  updateProvider,
} from '../../apps/api/src/features/model-providers/public.js';
import { jsonBody, listen, sendModelSse } from '../../apps/api/test/helpers/harness-consumer.js';
import { consumeThreadStream } from '../../apps/web/src/features/conversations/model/conversation-run.js';
import { taskAdmission } from '../../apps/web/src/features/conversations/model/task.js';
import type { ThreadEvent } from '@along/stream-protocol';

const database = await createIntegrationDatabase();
let host: ReturnType<typeof Bun.spawn> | undefined;
let upstream: ReturnType<typeof createServer> | undefined;
try {
  const session = await seedAdmittedSession(database.pool);
  const elapsed = '六十五秒后提醒我核对报告';
  let providerCalls = 0;
  let invocationId;
  const providerEntered = Promise.withResolvers<void>();
  const releaseProvider = Promise.withResolvers<void>();
  const revocationEntered = Promise.withResolvers<void>();
  const releaseRevocation = Promise.withResolvers<void>();
  upstream = createServer(async (request, response) => {
    try {
      const body = (await jsonBody(request)) as { model: string };
      assert.equal(request.url, '/v1/chat/completions');
      assert.equal(body.model, 'native-reminder');
      let next;
      if (providerCalls === 2) {
        providerCalls++;
        revocationEntered.resolve();
        await releaseRevocation.promise;
        sendModelSse(response, {
          message: { content: 'revoked-session-content', tool_calls: [] },
          usage: { total_tokens: 25 },
        });
        return;
      }
      if (providerCalls++ === 0) {
        providerEntered.resolve();
        await releaseProvider.promise;
        next = {
          name: 'create_reminder',
          args: {
            raw_time_text: elapsed,
            note: '核对报告',
            occurrence: 'once',
            time_kind: 'elapsed',
            duration_seconds: 65,
          },
        };
      } else {
        const receipt = await database.pool.query(
          `SELECT i.invocation_id FROM tool_invocations i JOIN agent_runs r ON r.id=i.run_id
           WHERE r.owner_id=$1 AND i.tool_id='create_reminder' AND i.state='completed'`,
          [session.userId],
        );
        assert.equal(receipt.rowCount, 1);
        invocationId = receipt.rows[0].invocation_id;
        next = {
          name: 'finish_goal',
          args: {
            status: 'completed',
            outcomes: [
              { description: '记录提醒', status: 'achieved', receipt_refs: [invocationId] },
            ],
            clarification: null,
            answer: '已记录提醒。',
          },
        };
      }
      sendModelSse(response, {
        message: {
          content: null,
          tool_calls: [
            {
              id: randomUUID(),
              type: 'function',
              function: { name: next.name, arguments: JSON.stringify(next.args) },
            },
          ],
        },
        usage: { total_tokens: 25 },
      });
    } catch (error) {
      console.error(error);
      if (response.headersSent) response.destroy(error instanceof Error ? error : undefined);
      else response.writeHead(500).end();
    }
  });
  const origin = await listen(upstream);
  process.env.MODEL_PROVIDER_ALLOWED_LOCAL_ORIGINS = origin;
  process.env.MODEL_PROVIDER_ENCRYPTION_KEY = Buffer.alloc(32).toString('base64');
  const provider = await createProvider(database.pool, session.userId, 'Native reminder proof');
  await updateProvider(database.pool, session.userId, provider.id, {
    base_url: `${origin}/v1`,
    credential: { action: 'replace', api_key: 'fixture-only' },
  });
  await addModel(database.pool, session.userId, provider.id, 'native-reminder');
  await setDefault(database.pool, session.userId, {
    provider_id: provider.id,
    model_id: 'native-reminder',
  });
  const base = 'http://127.0.0.1:3002';
  function startHost() {
    return Bun.spawn(['/app/host/bin/along-host', '3002'], {
      env: {
        ...process.env,
        ROLE: 'all',
        TZDB_VERSION: 'fixture-v1',
        HARNESS_COMPLETION_CAP: '1024',
        DATABASE_URL: database.connectionString,
      },
      stdout: 'inherit',
      stderr: 'inherit',
    });
  }
  async function ready() {
    for (let i = 0; i < 30; i++) {
      try {
        if ((await fetch(base + '/healthz')).ok) return;
      } catch {}
      await Bun.sleep(200);
    }
    throw Error('host did not start');
  }
  host = startHost();
  await ready();
  const headers = {
    'content-type': 'application/json',
    cookie: `better-auth.session_token=${session.token}`,
    'x-csrf-token': session.csrfToken,
    'x-request-id': 'native-chat-test',
    'idempotency-key': randomUUID(),
  };
  const raw_text = '明天 9:20 提醒我喝水';
  const init = {
    method: 'POST',
    headers,
    body: JSON.stringify({
      raw_text,
      ...taskAdmission('reminder'),
      confirmed_timezone: 'Asia/Shanghai',
    }),
    signal: AbortSignal.timeout(10_000),
  };
  const send = () => fetch(base + '/api/v1/conversations/messages', init);
  const response = await send();
  const webResponse = response.clone();
  const text = await response.text();
  assert.equal(response.status, 200, text);
  assert.match(response.headers.get('content-type'), /^text\/event-stream/);
  assert.equal(response.headers.get('x-request-id'), 'native-chat-test');
  const events: ThreadEvent[] = [];
  await consumeThreadStream(webResponse, (event) => events.push(event));
  assert.deepEqual(
    events.map((event) => event.type),
    ['thread.started', 'message.delta', 'card.proposed', 'approval_required', 'thread.completed'],
  );
  const again = await send();
  assert.equal(await again.text(), text);
  const { rows } = await database.pool.query(
    'SELECT count(*)::int AS count FROM approvals WHERE owner_id = $1',
    [session.userId],
  );
  assert.equal(rows[0].count, 1);
  const approvalId = events.find((event) => event.type === 'approval_required').payload.approval_id;
  const { detail } = await getApprovalDetail(database, session.userId, approvalId);
  const post = (path, data) =>
    fetch(base + path, {
      method: 'POST',
      headers,
      body: JSON.stringify(data),
      signal: AbortSignal.timeout(10_000),
    });
  const confirmation = {
    presentation_hash: detail.presentation_hash,
    seen_content: detail.echo_text,
    idempotency_key: randomUUID(),
  };
  const confirmPath = `/api/v1/approvals/${approvalId}/actions/confirm`;
  const confirmed = await post(confirmPath, confirmation);
  const confirmationBody = await confirmed.json();
  assert.equal(confirmed.status, 200, JSON.stringify(confirmationBody));
  const taskId = confirmationBody.data.task_id;
  assert.equal((await (await post(confirmPath, confirmation)).json()).data.task_id, taskId);
  const canceled = await post(`/api/v1/tasks/${taskId}/actions/cancel`, {
    idempotency_key: randomUUID(),
  });
  const cancellationBody = await canceled.json();
  assert.equal(canceled.status, 200, JSON.stringify(cancellationBody));
  const state = await database.pool.query('SELECT state FROM tasks WHERE id = $1', [taskId]);
  assert.equal(state.rows[0].state, 'cancel_pending');
  const delegatedHeaders = {
    ...headers,
    'x-request-id': 'native-delegation-test',
    'idempotency-key': randomUUID(),
  };
  const sendDelegated = () =>
    fetch(base + '/api/v1/conversations/messages', {
      method: 'POST',
      headers: delegatedHeaders,
      body: JSON.stringify({
        raw_text: elapsed,
        execution: 'harness',
        authorization_revision: 'delegation/1',
      }),
      signal: AbortSignal.timeout(25_000),
    });
  const delegated = await sendDelegated();
  assert.equal(delegated.status, 200);
  const firstRunId = delegated.headers.get('x-run-id');
  assert.ok(firstRunId);
  const reader = delegated.body!.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /thread\.started/);
  await providerEntered.promise;
  await reader.cancel();
  releaseProvider.resolve();
  for (const deadline = performance.now() + 15_000; ;) {
    const run = await database.pool.query('SELECT status FROM agent_runs WHERE id=$1', [
      firstRunId,
    ]);
    if (run.rows[0]?.status === 'done') break;
    assert.equal(run.rows[0]?.status, 'running', JSON.stringify(run.rows));
    assert.ok(performance.now() < deadline, 'Run did not complete after disconnect');
    await Bun.sleep(100);
  }
  const replay = await sendDelegated();
  assert.equal(replay.headers.get('x-run-id'), firstRunId);
  const delegatedText = await replay.text();
  assert.equal(replay.status, 200, delegatedText);
  const delegatedEvents = delegatedText
    .trim()
    .split('\n\n')
    .map((frame) => JSON.parse(frame.slice(6)));
  assert.equal(delegatedEvents.at(-1).type, 'thread.completed', delegatedText);
  assert.equal(providerCalls, 2);
  assert.ok(invocationId);
  const revokedSubscription = await fetch(base + '/api/v1/conversations/messages', {
    method: 'POST',
    headers: { ...headers, 'x-request-id': randomUUID(), 'idempotency-key': randomUUID() },
    body: JSON.stringify({
      raw_text: '回答一个问题',
      execution: 'harness',
      authorization_revision: 'delegation/1',
    }),
    signal: AbortSignal.timeout(20_000),
  });
  assert.equal(revokedSubscription.status, 200);
  const revokedReader = revokedSubscription.body!.getReader();
  assert.match(new TextDecoder().decode((await revokedReader.read()).value), /thread\.started/);
  await revocationEntered.promise;
  await database.pool.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE id=$1', [
    session.sessionId,
  ]);
  releaseRevocation.resolve();
  assert.equal((await revokedReader.read()).done, true, 'revoked subscriber received a new event');
  const until = performance.now() + 110_000;
  let restarted = false;
  for (;;) {
    const { rows } = await database.pool.query(
      `
      SELECT id, state, schedule_receipt,
          (SELECT count(*)::int FROM notifications WHERE task_id=tasks.id) AS notices,
          (SELECT count(*)::int FROM task_events WHERE task_id=tasks.id AND type='fired') AS fired
      FROM tasks WHERE owner_id=$1 ORDER BY id
    `,
      [session.userId],
    );
    assert.equal(rows.length, 2);
    const cancelled = rows.find((task) => task.id === taskId);
    const delegatedTask = rows.find((task) => task.id !== taskId);
    assert.ok(cancelled && delegatedTask);
    assert.deepEqual([cancelled.notices, cancelled.fired], [0, 0]);
    if (!restarted && delegatedTask.state === 'scheduled') {
      await stopHost(host);
      host = startHost();
      await ready();
      restarted = true;
    }
    if (delegatedTask.state === 'fired' && cancelled.state === 'cancelled') {
      assert.ok(restarted, 'worker restart did not occur before delivery');
      assert.ok(delegatedTask.schedule_receipt);
      assert.deepEqual([delegatedTask.notices, delegatedTask.fired], [1, 1]);
      break;
    }
    assert.ok(performance.now() < until, JSON.stringify(rows));
    await Bun.sleep(500);
  }
  console.log(
    'native Worker fired the delegated task and cancelled the other task without delivery',
  );
  console.log('native Harness completed a delegated reminder with a durable invocation');
  console.log('native conversation SSE and idempotent replay passed');
} finally {
  if (host && host.exitCode === null) await stopHost(host);
  upstream?.closeAllConnections();
  upstream?.close();
  await database.close();
}

async function stopHost(child: ReturnType<typeof Bun.spawn>) {
  child.kill('SIGTERM');
  const deadline = setTimeout(() => child.kill('SIGKILL'), 5000);
  try {
    assert.equal(await child.exited, 0);
  } finally {
    clearTimeout(deadline);
  }
}
