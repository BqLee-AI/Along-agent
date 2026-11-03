import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { acceptReminderDate } from '../../src/modules/conversations/reminder-date.js';
import { createIntegrationDatabase, type IntegrationDatabase } from './setup.js';
import { reserveToolInvocation, invokeTool } from '../../src/modules/tools/gateway.js';
import { loadTimeContext } from '../../src/modules/time/context.js';
let db: IntegrationDatabase;
beforeAll(async () => {
  db = await createIntegrationDatabase();
});
afterAll(async () => {
  await db?.close();
});
test('explicit same-goal time clarification inherits only the accepted unresolved predecessor once', async () => {
  const ownerId = randomUUID(),
    conversationId = randomUUID(),
    runId = randomUUID(),
    oldMessage = randomUUID(),
    messageId = randomUUID();
  const nextRunId = randomUUID(),
    attemptId = randomUUID();
  await db.pool.query(
    "INSERT INTO users(id,auth_email,display_name) VALUES($1,$2,'clarification tester')",
    [ownerId, `${ownerId}@clarification.test`],
  );
  await db.pool.query('INSERT INTO conversations(id,owner_id) VALUES($1,$2)', [
    conversationId,
    ownerId,
  ]);
  await db.pool.query(
    "INSERT INTO messages(id,owner_id,conversation_id,role,content,created_at) VALUES($1,$2,$3,'user','2027年11月4日提醒我核对报告',clock_timestamp()-interval '2 minutes'),($4,$2,$3,'user','下午三点，上海时间',clock_timestamp())",
    [oldMessage, ownerId, conversationId, messageId],
  );
  const source = { version: 1, kind: 'new', inputMessageId: oldMessage };
  const goal = {
    status: 'blocked',
    outcomes: [{ description: '核对报告提醒', status: 'blocked', receipt_refs: [] }],
    clarification: { kind: 'time', question: '几点、哪个时区？' },
    answer: '请补充时刻和时区。',
  };
  await db.pool.query(
    `INSERT INTO agent_runs(id,owner_id,conversation_id,agent_revision,mode,status,budget_max_iterations,budget_max_tokens,execution,tools_allowlist,frozen_context,input_message_id,goal_result) VALUES($1,$2,$3,'direct','chat','done',16,4096,'harness','["create_reminder"]',$4::jsonb,$5,$6::jsonb)`,
    [
      runId,
      ownerId,
      conversationId,
      JSON.stringify({
        authorization_revision: 'delegation/1',
        execution_lifecycle: 'request-bound',
        anchorReceivedAtUtc: '2027-11-03T01:00:00Z',
        reminderDateSource: source,
      }),
      oldMessage,
      JSON.stringify(goal),
    ],
  );
  const client = await db.pool.connect();
  try {
    const accepted = await acceptReminderDate(client, {
      ownerId,
      conversationId,
      inputMessageId: messageId,
      text: '下午三点，上海时间',
      receivedAtUtc: '2027-11-03T01:02:00Z',
      foldChoice: 'none',
      clarificationOfRunId: runId,
      confirmedTimezone: null,
      directCreation: true,
    });
    expect(accepted).toMatchObject({
      anchor: '2027-11-03T01:00:00Z',
      source: { kind: 'clarification', inputMessageId: oldMessage, sourceRunId: runId },
    });
    expect(accepted.source.sourceInvocationId).toBeUndefined();
    await db.pool.query(
      `INSERT INTO agent_runs(id,owner_id,conversation_id,agent_revision,mode,budget_max_iterations,budget_max_tokens,frozen_context,execution,tools_allowlist,input_message_id) VALUES($1,$2,$3,'next','chat',16,4096,$4::jsonb,'harness','["create_reminder"]',$5)`,
      [
        nextRunId,
        ownerId,
        conversationId,
        JSON.stringify({
          authorization_revision: 'delegation/1',
          execution_lifecycle: 'request-bound',
          reminderDateSource: accepted.source,
        }),
        messageId,
      ],
    );
    expect(
      (
        await acceptReminderDate(client, {
          ownerId,
          conversationId,
          inputMessageId: messageId,
          text: '下午三点，上海时间',
          receivedAtUtc: '2027-11-03T01:02:00Z',
          foldChoice: 'none',
          clarificationOfRunId: runId,
          confirmedTimezone: null,
          directCreation: true,
        })
      ).source.kind,
    ).toBe('unresolved');
    await db.pool.query(
      'INSERT INTO run_attempts(id,owner_id,run_id,attempt_no) VALUES($1,$2,$3,1)',
      [attemptId, ownerId, nextRunId],
    );
    const ctx = {
      ownerId,
      conversationId,
      runId: nextRunId,
      attemptId,
      requestId: randomUUID(),
      allowlist: ['create_reminder'],
      authorizationRevision: 'delegation/1' as const,
      confirmedTimezone: 'Asia/Shanghai',
      anchorReceivedAtUtc: accepted.anchor,
      receivedAtUtc: '2027-11-03T01:02:00Z',
      foldChoice: 'none' as const,
      timeContext: loadTimeContext('fixture-v1'),
    };
    const args = { raw_time_text: '2027年11月4日下午三点', note: '核对报告', occurrence: 'once' };
    const binding = await reserveToolInvocation(db.pool, ctx, {
      callKey: 'clarified/1',
      toolId: 'create_reminder',
      args,
    });
    expect(
      await invokeTool(db.pool, ctx, { ...binding, toolId: 'create_reminder', args }),
    ).toMatchObject({
      status: 'ok',
      result: { kind: 'task_created', wall_time: '2027-11-04 15:00', timezone_id: 'Asia/Shanghai' },
    });
  } finally {
    client.release();
  }
});
