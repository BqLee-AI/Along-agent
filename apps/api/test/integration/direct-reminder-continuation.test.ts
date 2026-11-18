import {
  listReminderClarifications,
  readReminderTimeErrors,
} from '../../src/agent/tools/reminders/reminder-source.js';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { acceptReminderDate } from '../../src/features/conversations/lifecycle/reminder-date.js';
import { admitTestUser, createIntegrationDatabase, type IntegrationDatabase } from './setup.js';
import { reserveToolInvocation, invokeTool } from '../../src/agent/tools/gateway.js';
import { loadTimeContext } from '../../src/features/time/context.js';
let db: IntegrationDatabase;
beforeAll(async () => {
  db = await createIntegrationDatabase();
  // Same isolated PG-clock convention as reminder-date-anchors.test.ts.
  await db.pool.query(`CREATE TABLE test_clock (at timestamptz NOT NULL);
    INSERT INTO test_clock VALUES ('2027-11-03T01:02:00Z');
    CREATE FUNCTION clock_timestamp() RETURNS timestamptz LANGUAGE sql AS
    'SELECT at FROM test_clock';`);
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
  await admitTestUser(db.pool, ownerId);
  await db.pool.query('INSERT INTO conversations(id,owner_id) VALUES($1,$2)', [
    conversationId,
    ownerId,
  ]);
  await db.pool.query(
    "INSERT INTO messages(id,owner_id,conversation_id,role,content,created_at) VALUES($1,$2,$3,'user','明天提醒我核对报告',clock_timestamp()-interval '2 minutes'),($4,$2,$3,'user','下午三点，上海时间',clock_timestamp())",
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
    const accepted = await acceptReminderDate(
      client,
      {
        ownerId,
        conversationId,
        inputMessageId: messageId,
        text: '下午三点，上海时间',
        receivedAtUtc: '2027-11-03T01:02:00Z',
        foldChoice: 'none',
        clarificationOfRunId: runId,
        confirmedTimezone: null,
        directCreation: true,
      },
      { listReminderClarifications, readReminderTimeErrors },
    );
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
        await acceptReminderDate(
          client,
          {
            ownerId,
            conversationId,
            inputMessageId: messageId,
            text: '下午三点，上海时间',
            receivedAtUtc: '2027-11-03T01:02:00Z',
            foldChoice: 'none',
            clarificationOfRunId: runId,
            confirmedTimezone: null,
            directCreation: true,
          },
          { listReminderClarifications, readReminderTimeErrors },
        )
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

test('timezone-only clarification preserves each selected reminder time and its accepted effects', async () => {
  const ownerId = randomUUID(),
    conversationId = randomUUID(),
    runId = randomUUID(),
    oldMessage = randomUUID(),
    messageId = randomUUID(),
    nextRunId = randomUUID(),
    attemptId = randomUUID();
  const selections = [
    {
      raw_time_text: '2027年11月4日15:00',
      note: '交报告',
      wall: '2027-11-04 15:00',
      utc: '2027-11-04T07:00:00.000Z',
    },
    {
      raw_time_text: '2027年11月5日16:00',
      note: '取包裹',
      wall: '2027-11-05 16:00',
      utc: '2027-11-05T08:00:00.000Z',
    },
  ];
  await db.pool.query(
    "INSERT INTO users(id,auth_email,display_name) VALUES($1,$2,'multi clarification')",
    [ownerId, `${ownerId}@clarification.test`],
  );
  await admitTestUser(db.pool, ownerId);
  await db.pool.query('INSERT INTO conversations(id,owner_id) VALUES($1,$2)', [
    conversationId,
    ownerId,
  ]);
  await db.pool.query(
    "INSERT INTO messages(id,owner_id,conversation_id,role,content,created_at) VALUES($1,$2,$3,'user',$4,clock_timestamp()-interval '2 minutes')",
    [
      oldMessage,
      ownerId,
      conversationId,
      '2027年11月4日15:00提醒我交报告，2027年11月5日16:00提醒我取包裹。',
    ],
  );
  await db.pool.query(
    `INSERT INTO agent_runs(id,owner_id,conversation_id,agent_revision,mode,budget_max_iterations,budget_max_tokens,execution,tools_allowlist,frozen_context,input_message_id)
     VALUES($1,$2,$3,'direct','chat',16,4096,'harness','["create_reminder"]',$4::jsonb,$5)`,
    [
      runId,
      ownerId,
      conversationId,
      JSON.stringify({
        authorization_revision: 'delegation/1',
        execution_lifecycle: 'request-bound',
        anchorReceivedAtUtc: '2027-11-03T01:00:00Z',
        reminderDateSource: { version: 1, kind: 'new', inputMessageId: oldMessage },
      }),
      oldMessage,
    ],
  );
  await db.pool.query(
    'INSERT INTO run_attempts(id,owner_id,run_id,attempt_no) VALUES($1,$2,$3,1)',
    [attemptId, ownerId, runId],
  );
  const ctx = {
    ownerId,
    conversationId,
    runId,
    attemptId,
    requestId: randomUUID(),
    allowlist: ['create_reminder'],
    authorizationRevision: 'delegation/1' as const,
    confirmedTimezone: null as string | null,
    anchorReceivedAtUtc: '2027-11-03T01:00:00Z',
    receivedAtUtc: '2027-11-03T01:00:00Z',
    foldChoice: 'none' as const,
    timeContext: loadTimeContext('fixture-v1'),
  };
  for (const selection of selections) {
    const args = {
      raw_time_text: selection.raw_time_text,
      note: selection.note,
      occurrence: 'once',
    };
    const binding = await reserveToolInvocation(db.pool, ctx, {
      callKey: `missing/${selection.note}`,
      toolId: 'create_reminder',
      args,
    });
    expect(
      await invokeTool(db.pool, ctx, { ...binding, toolId: 'create_reminder', args }),
    ).toMatchObject({ status: 'ok', result: { kind: 'clarify', reason: 'TIMEZONE_MISSING' } });
  }
  expect((await db.pool.query('SELECT id FROM tasks WHERE owner_id=$1', [ownerId])).rows).toEqual(
    [],
  );
  await db.pool.query("UPDATE agent_runs SET status='done',goal_result=$2::jsonb WHERE id=$1", [
    runId,
    JSON.stringify({
      status: 'blocked',
      outcomes: selections.map((s) => ({
        description: s.note,
        status: 'blocked',
        receipt_refs: [],
      })),
      clarification: { kind: 'timezone', question: '哪个时区？' },
      answer: '请补充时区。',
    }),
  ]);
  await db.pool.query(
    "INSERT INTO messages(id,owner_id,conversation_id,role,content) VALUES($1,$2,$3,'user','上海时间')",
    [messageId, ownerId, conversationId],
  );
  const client = await db.pool.connect();
  try {
    const accepted = await acceptReminderDate(
      client,
      {
        ownerId,
        conversationId,
        inputMessageId: messageId,
        text: '上海时间',
        receivedAtUtc: '2027-11-03T01:02:00Z',
        foldChoice: 'none',
        clarificationOfRunId: runId,
        confirmedTimezone: null,
        directCreation: true,
      },
      { listReminderClarifications, readReminderTimeErrors },
    );
    expect(accepted).toMatchObject({
      anchor: ctx.anchorReceivedAtUtc,
      timezone: 'Asia/Shanghai',
      source: { kind: 'clarification', inputMessageId: oldMessage, sourceRunId: runId },
    });
    await db.pool.query(
      `INSERT INTO agent_runs(id,owner_id,conversation_id,agent_revision,mode,budget_max_iterations,budget_max_tokens,execution,tools_allowlist,frozen_context,input_message_id)
       VALUES($1,$2,$3,'next','chat',16,4096,'harness','["create_reminder"]',$4::jsonb,$5)`,
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
    const nextAttemptId = randomUUID();
    await db.pool.query(
      'INSERT INTO run_attempts(id,owner_id,run_id,attempt_no) VALUES($1,$2,$3,1)',
      [nextAttemptId, ownerId, nextRunId],
    );
    const nextCtx = {
      ...ctx,
      runId: nextRunId,
      attemptId: nextAttemptId,
      confirmedTimezone: accepted.timezone!,
      anchorReceivedAtUtc: accepted.anchor,
      receivedAtUtc: '2027-11-03T01:02:00Z',
    };
    for (const selection of selections) {
      const args = {
        raw_time_text: selection.raw_time_text,
        note: selection.note,
        occurrence: 'once',
      };
      const binding = await reserveToolInvocation(db.pool, nextCtx, {
        callKey: `selected/${selection.note}`,
        toolId: 'create_reminder',
        args,
      });
      const outcome = await invokeTool(db.pool, nextCtx, {
        ...binding,
        toolId: 'create_reminder',
        args,
      });
      expect(outcome).toMatchObject({
        status: 'ok',
        result: {
          kind: 'task_created',
          wall_time: selection.wall,
          fire_at_utc: selection.utc,
          timezone_id: 'Asia/Shanghai',
          original_note: selection.note,
        },
      });
      expect(
        await invokeTool(db.pool, nextCtx, { ...binding, toolId: 'create_reminder', args }),
      ).toMatchObject({ ...outcome, replayed: true });
      const facts = await db.pool.query(
        `SELECT t.wall_time,t.timezone_id,t.fire_at_utc,t.original_note,
          (SELECT count(*)::int FROM task_events e WHERE e.task_id=t.id AND e.type='created') AS created,
          (SELECT count(*)::int FROM outbox o WHERE o.task_id=t.id AND o.command->>'fire_at_utc'=$3) AS scheduled,
          i.accepted_result
         FROM tasks t JOIN tool_invocations i ON i.invocation_id=t.source_invocation_id
         WHERE t.owner_id=$1 AND t.source_invocation_id=$2`,
        [ownerId, binding.invocationId, selection.utc],
      );
      expect(facts.rows).toHaveLength(1);
      expect(facts.rows[0]).toMatchObject({
        wall_time: selection.wall,
        timezone_id: 'Asia/Shanghai',
        fire_at_utc: new Date(selection.utc),
        original_note: selection.note,
        created: 1,
        scheduled: 1,
      });
      expect(facts.rows[0].accepted_result).toMatchObject({
        status: 'ok',
        result: {
          kind: 'task_created',
          wall_time: selection.wall,
          fire_at_utc: selection.utc,
          original_note: selection.note,
        },
      });
    }
    for (const raw_time_text of ['2027年11月5日17:00', '2027年11月6日16:00']) {
      const args = { raw_time_text, note: '取包裹', occurrence: 'once' };
      const binding = await reserveToolInvocation(db.pool, nextCtx, {
        callKey: `unquoted/${raw_time_text}`,
        toolId: 'create_reminder',
        args,
      });
      expect(
        await invokeTool(db.pool, nextCtx, { ...binding, toolId: 'create_reminder', args }),
      ).toMatchObject({ status: 'ok', result: { kind: 'clarify', reason: 'DATE_SOURCE_UNCLEAR' } });
    }
    expect(
      (await db.pool.query('SELECT count(*)::int AS count FROM tasks WHERE owner_id=$1', [ownerId]))
        .rows[0].count,
    ).toBe(2);
  } finally {
    client.release();
  }
});
