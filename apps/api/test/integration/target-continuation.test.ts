import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { acceptTargetContinuation } from '../../src/modules/conversations/target-continuation.js';
import { acceptReminderDate } from '../../src/modules/conversations/reminder-date.js';
import { loadTimeContext } from '../../src/modules/time/context.js';
import { admitTestUser, createIntegrationDatabase, type IntegrationDatabase } from './setup.js';
import { invokeTool, reserveToolInvocation } from '../../src/modules/tools/gateway.js';
import { validateGoalResult } from '../../src/modules/conversations/goal-result.js';
import { startConversationRun } from '../../src/modules/conversations/service.js';
import { createContextPolicy } from '../../src/modules/conversations/context-policy.js';

let db: IntegrationDatabase;
beforeAll(async () => {
  db = await createIntegrationDatabase();
});
afterAll(async () => {
  await db?.close();
});

async function fixture(
  allowlist = ['get_task', 'cancel_reminder'],
  options: { running?: boolean; noGoal?: boolean } = {},
) {
  const ownerId = randomUUID(),
    conversationId = randomUUID(),
    runId = randomUUID(),
    messageId = randomUUID();
  await db.pool.query(
    "INSERT INTO users(id,auth_email,display_name) VALUES($1,$2,'target tester')",
    [ownerId, `${ownerId}@target.test`],
  );
  await admitTestUser(db.pool, ownerId);
  await db.pool.query('INSERT INTO conversations(id,owner_id) VALUES($1,$2)', [
    conversationId,
    ownerId,
  ]);
  await db.pool.query(
    "INSERT INTO messages(id,owner_id,conversation_id,role,content,created_at) VALUES($1,$2,$3,'user','取消提醒',clock_timestamp()-interval '1 minute')",
    [messageId, ownerId, conversationId],
  );
  const goal = {
    status: 'blocked',
    outcomes: [{ description: '取消提醒', status: 'blocked', receipt_refs: [] }],
    clarification: { kind: 'target_selection', question: '哪一个？' },
    answer: '请选择提醒。',
  };
  await db.pool.query(
    `INSERT INTO agent_runs(id,owner_id,conversation_id,agent_revision,mode,status,budget_max_iterations,budget_max_tokens,execution,tools_allowlist,frozen_context,input_message_id,goal_result) VALUES($1,$2,$3,'test','chat',$8,16,4096,'harness',$4::jsonb,$5::jsonb,$6,$7::jsonb)`,
    [
      runId,
      ownerId,
      conversationId,
      JSON.stringify(allowlist),
      JSON.stringify({
        authorization_revision: 'delegation/1',
        anchorReceivedAtUtc: '2026-11-03T00:00:00Z',
        reminderDateSource: { version: 1, kind: 'new', inputMessageId: messageId },
      }),
      messageId,
      options.noGoal || options.running ? null : JSON.stringify(goal),
      options.running ? 'running' : 'done',
    ],
  );
  return { ownerId, conversationId, runId, messageId };
}
const timeContext = loadTimeContext('fixture-v1');

test('unverifiable source asks for the relationship without admitting an effect', async () => {
  const f = await fixture(undefined, { noGoal: true });
  const before = await db.pool.query(
    'SELECT count(*)::int n FROM messages WHERE conversation_id=$1',
    [f.conversationId],
  );
  const deps = {
    pool: db.pool,
    timeContext,
    harness: {
      binaryPath: '/unused',
      maxIterations: 8,
      maxTokens: 8000,
      contextPolicy: createContextPolicy({ completionCap: 512, model: 'test' }),
      model: async function* () {
        throw new Error('must not execute');
      },
    },
  };
  await expect(
    startConversationRun(
      deps,
      f.ownerId,
      randomUUID(),
      {
        raw_text: '第一个',
        conversation_id: f.conversationId,
        execution: 'harness',
        authorization_revision: 'delegation/1',
        clarification_of_run_id: f.runId,
      },
      null,
    ),
  ).rejects.toMatchObject({ httpStatus: 400, message: expect.stringContaining('请说明') });
  expect(
    (
      await db.pool.query('SELECT count(*)::int n FROM messages WHERE conversation_id=$1', [
        f.conversationId,
      ])
    ).rows[0].n,
  ).toBe(before.rows[0].n);
});

test('conversation admission lock permits only one successor of a real target gap', async () => {
  const f = await fixture();
  async function admit() {
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM conversations WHERE id=$1 FOR UPDATE', [f.conversationId]);
      const inputMessageId = randomUUID();
      await client.query(
        "INSERT INTO messages(id,owner_id,conversation_id,role,content) VALUES($1,$2,$3,'user','第一个')",
        [inputMessageId, f.ownerId, f.conversationId],
      );
      const accepted = await acceptTargetContinuation(client, {
        ...f,
        inputMessageId,
        sourceRunId: f.runId,
        timeContext,
      });
      if (accepted) {
        await client.query(
          `INSERT INTO agent_runs(id,owner_id,conversation_id,agent_revision,mode,budget_max_iterations,budget_max_tokens,execution,tools_allowlist,frozen_context,input_message_id) VALUES($1,$2,$3,'test','chat',16,4096,'harness',$4::jsonb,$5::jsonb,$6)`,
          [
            randomUUID(),
            f.ownerId,
            f.conversationId,
            JSON.stringify(['get_task', 'cancel_reminder']),
            JSON.stringify({ trustedExecutionContext: { continuation: accepted.continuation } }),
            inputMessageId,
          ],
        );
      }
      await client.query('COMMIT');
      return accepted;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  const results = await Promise.all([admit(), admit()]);
  expect(results.filter(Boolean)).toHaveLength(1);
  const continuation = results.find(Boolean)!.continuation;
  expect(continuation).toMatchObject({
    run_id: f.runId,
    invocation_id: null,
    original_input_message_id: f.messageId,
    original_text: '取消提醒',
    receipts: [],
    source_result: null,
  });
});

test('old profiles and unrelated intervening inputs cannot authorize a continuation', async () => {
  for (const old of [true, false]) {
    const f = await fixture(old ? ['list_tasks'] : ['get_task', 'cancel_reminder']);
    if (!old)
      await db.pool.query(
        "INSERT INTO messages(id,owner_id,conversation_id,role,content) VALUES($1,$2,$3,'user','另一个新目标')",
        [randomUUID(), f.ownerId, f.conversationId],
      );
    const inputMessageId = randomUUID();
    await db.pool.query(
      "INSERT INTO messages(id,owner_id,conversation_id,role,content,created_at) VALUES($1,$2,$3,'user','第一个',clock_timestamp()+interval '1 second')",
      [inputMessageId, f.ownerId, f.conversationId],
    );
    const client = await db.pool.connect();
    try {
      expect(
        await acceptTargetContinuation(client, {
          ...f,
          inputMessageId,
          sourceRunId: f.runId,
          timeContext,
        }),
      ).toBeNull();
    } finally {
      client.release();
    }
  }
});

test('an independent same-text delegation is a new input without a source reference', async () => {
  const f = await fixture();
  const inputMessageId = randomUUID();
  await db.pool.query(
    "INSERT INTO messages(id,owner_id,conversation_id,role,content) VALUES($1,$2,$3,'user','取消提醒')",
    [inputMessageId, f.ownerId, f.conversationId],
  );
  const client = await db.pool.connect();
  try {
    const source = await acceptReminderDate(client, {
      ...f,
      inputMessageId,
      text: '取消提醒',
      receivedAtUtc: '2026-11-03T01:00:00Z',
      foldChoice: 'none',
      confirmedTimezone: null,
      directCreation: true,
    });
    expect(source.source).toEqual({ version: 1, kind: 'new', inputMessageId });
  } finally {
    client.release();
  }
});

test('a foreign owner or an absent structured gap cannot provide authority', async () => {
  const f = await fixture(undefined, { noGoal: true });
  const inputMessageId = randomUUID();
  await db.pool.query(
    "INSERT INTO messages(id,owner_id,conversation_id,role,content) VALUES($1,$2,$3,'user','第一个')",
    [inputMessageId, f.ownerId, f.conversationId],
  );
  const client = await db.pool.connect();
  try {
    expect(
      await acceptTargetContinuation(client, {
        ...f,
        ownerId: randomUUID(),
        inputMessageId,
        sourceRunId: f.runId,
        timeContext,
      }),
    ).toBeNull();
    expect(
      await acceptTargetContinuation(client, {
        ...f,
        inputMessageId,
        sourceRunId: f.runId,
        timeContext,
      }),
    ).toBeNull();
  } finally {
    client.release();
  }
});

test('accepted effects are carried as receipts and must remain in the successor result', async () => {
  const f = await fixture(['get_task', 'cancel_reminder', 'set_user_timezone'], { running: true });
  const attemptId = randomUUID();
  await db.pool.query(
    'INSERT INTO run_attempts(id,owner_id,run_id,attempt_no) VALUES($1,$2,$3,1)',
    [attemptId, f.ownerId, f.runId],
  );
  const ctx = {
    ...f,
    attemptId,
    requestId: randomUUID(),
    allowlist: ['get_task', 'cancel_reminder', 'set_user_timezone'],
    authorizationRevision: 'delegation/1' as const,
    confirmedTimezone: null,
    anchorReceivedAtUtc: '2026-11-03T00:00:00Z',
    receivedAtUtc: '2026-11-03T00:00:00Z',
    foldChoice: 'none' as const,
    timeContext,
  };
  const args = { timezone_id: 'Asia/Shanghai' };
  const reserved = await reserveToolInvocation(db.pool, ctx, {
    callKey: 'setting/1',
    toolId: 'set_user_timezone',
    args,
  });
  const result = await invokeTool(db.pool, ctx, { ...reserved, toolId: 'set_user_timezone', args });
  expect(result.status).toBe('ok');
  const goal = {
    status: 'partial',
    outcomes: [
      { description: '已保存时区', status: 'achieved', receipt_refs: [reserved.invocationId] },
      { description: '取消提醒', status: 'blocked', receipt_refs: [] },
    ],
    clarification: { kind: 'target_selection', question: '哪一个？' },
    answer: '请选择。',
  };
  await db.pool.query(`UPDATE agent_runs SET status='done',goal_result=$2::jsonb WHERE id=$1`, [
    f.runId,
    JSON.stringify(goal),
  ]);
  const nextMessage = randomUUID(),
    nextRun = randomUUID();
  await db.pool.query(
    "INSERT INTO messages(id,owner_id,conversation_id,role,content) VALUES($1,$2,$3,'user','第一个')",
    [nextMessage, f.ownerId, f.conversationId],
  );
  const client = await db.pool.connect();
  try {
    const accepted = await acceptTargetContinuation(client, {
      ...f,
      sourceRunId: f.runId,
      inputMessageId: nextMessage,
      timeContext,
    });
    expect(accepted?.continuation.receipts).toMatchObject([
      {
        invocation_id: reserved.invocationId,
        tool_id: 'set_user_timezone',
        result: { status: 'ok' },
      },
    ]);
    await client.query(
      `INSERT INTO agent_runs(id,owner_id,conversation_id,agent_revision,mode,budget_max_iterations,budget_max_tokens,execution,tools_allowlist,frozen_context,input_message_id) VALUES($1,$2,$3,'test','chat',16,4096,'harness',$4::jsonb,$5::jsonb,$6)`,
      [
        nextRun,
        f.ownerId,
        f.conversationId,
        JSON.stringify(ctx.allowlist),
        JSON.stringify({
          authorization_revision: 'delegation/1',
          trustedExecutionContext: { continuation: accepted!.continuation },
        }),
        nextMessage,
      ],
    );
    const nextCtx = { ...ctx, runId: nextRun, attemptId: randomUUID() };
    const omitted = {
      status: 'completed' as const,
      outcomes: [{ description: '已处理', status: 'achieved' as const, receipt_refs: [] }],
      clarification: null,
      answer: '已处理。',
    };
    await expect(validateGoalResult(client, nextCtx, omitted)).rejects.toThrow();
    const preserved = {
      ...omitted,
      outcomes: [
        {
          description: '已保存时区',
          status: 'achieved' as const,
          receipt_refs: [reserved.invocationId],
        },
      ],
    };
    expect(await validateGoalResult(client, nextCtx, preserved)).toEqual(preserved);
  } finally {
    client.release();
  }
});
