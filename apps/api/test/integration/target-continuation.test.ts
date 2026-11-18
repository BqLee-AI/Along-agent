import { expectApplicationRejection } from '../helpers/application-error.js';
import {
  listReminderClarifications,
  readReminderTimeErrors,
} from '../../src/agent/tools/reminders/reminder-source.js';
import { configureTestModel } from '../helpers/model-selection.js';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { GoalResult } from '@along/contracts';
import {
  acceptTargetContinuation,
  readCancellationScopeInput,
} from '../../src/agent/operations/target-continuation.js';
import { acceptReminderDate } from '../../src/features/conversations/lifecycle/reminder-date.js';
import { loadTimeContext } from '../../src/features/time/context.js';
import {
  admitTestUser,
  createIntegrationDatabase,
  seedApproval,
  type IntegrationDatabase,
} from './setup.js';
import { invokeTool, reserveToolInvocation } from '../../src/agent/tools/gateway.js';
import { validateGoalResult } from '../../src/agent/operations/goal-result.js';
import { startConversationRun } from '../../src/agent/operations/start.js';
import { createContextPolicy } from '../../src/features/conversations/public.js';
import {
  readShownCancellationCandidates,
  renderCancellationClarification,
} from '../../src/agent/tools/reminders/reminder-cancel-scope.js';

let db: IntegrationDatabase;
beforeAll(async () => {
  db = await createIntegrationDatabase();
});
afterAll(async () => {
  await db?.close();
});

interface DocumentGrant {
  workspace_id: string;
  owner_id: string;
  registration_digest: string;
  root_identity: string;
  output_directories?: Array<{ path: string; identity: string }>;
}

function documentGrant(ownerId: string): DocumentGrant {
  return {
    workspace_id: 'documents',
    owner_id: ownerId,
    registration_digest: 'a'.repeat(64),
    root_identity: 'root',
  };
}

async function fixture(
  allowlist = ['get_task', 'cancel_reminder'],
  options: {
    running?: boolean;
    noGoal?: boolean;
    scope?: boolean;
    text?: string;
    clarificationKind?: 'target_selection' | 'destination';
    workspaceGrants?: (ownerId: string) => DocumentGrant[];
    omitReminderDateSource?: boolean;
  } = {},
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
  await configureTestModel(db.pool, ownerId, 'test');
  await db.pool.query('INSERT INTO conversations(id,owner_id) VALUES($1,$2)', [
    conversationId,
    ownerId,
  ]);
  await db.pool.query(
    "INSERT INTO messages(id,owner_id,conversation_id,role,content,created_at) VALUES($1,$2,$3,'user',$4,clock_timestamp()-interval '1 minute')",
    [messageId, ownerId, conversationId, options.text ?? '取消提醒'],
  );
  const goal = {
    status: 'blocked',
    outcomes: [{ description: '取消提醒', status: 'blocked', receipt_refs: [] }],
    clarification: { kind: options.clarificationKind ?? 'target_selection', question: '哪一个？' },
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
        ...(options.scope ? { cancellationScopeRevision: 'scope/1' } : {}),
        anchorReceivedAtUtc: '2026-11-03T00:00:00Z',
        ...(options.omitReminderDateSource
          ? {}
          : { reminderDateSource: { version: 1, kind: 'new', inputMessageId: messageId } }),
        ...(options.workspaceGrants ? { workspaceGrants: options.workspaceGrants(ownerId) } : {}),
      }),
      messageId,
      options.noGoal || options.running ? null : JSON.stringify(goal),
      options.running ? 'running' : 'done',
    ],
  );
  return { ownerId, conversationId, runId, messageId };
}
const timeContext = loadTimeContext('fixture-v1');

test.each([
  { scope: true, text: '帮我取消“同名提醒”这条提醒。', normalized: true },
  { scope: true, text: '取消“同名提醒”11月5日那条。', normalized: true },
  { scope: false, text: '帮我取消“同名提醒”这条提醒。', normalized: false },
  { scope: true, text: '查询“同名提醒”有几条。', normalized: false },
])(
  'normalizes only a new same-name cancellation clarification: $text',
  async ({ scope, text, normalized }) => {
    const f = await fixture(undefined, {
      running: true,
      scope,
      text,
    });
    const ids = [randomUUID(), randomUUID()];
    for (const [index, id] of ids.entries()) {
      const source = await seedApproval(db.pool, { ownerId: f.ownerId, state: 'consumed' });
      const day = index === 0 ? '04' : '05';
      await db.pool.query(
        `INSERT INTO tasks(id,owner_id,original_note,fire_at_utc,wall_time,timezone_id,fold,
        resolved_utc_offset_seconds,tzdb_version,occurrence,state,state_version,source_approval_id)
       VALUES($1,$2,'同名提醒',$3,$4,'Asia/Shanghai',0,28800,'fixture-v1','once','scheduled',1,$5)`,
        [id, f.ownerId, `2027-11-${day}T01:20:00Z`, `2027-11-${day} 09:20`, source.id],
      );
    }
    const attemptId = randomUUID();
    await db.pool.query(
      'INSERT INTO run_attempts(id,owner_id,run_id,attempt_no) VALUES($1,$2,$3,1)',
      [attemptId, f.ownerId, f.runId],
    );
    const context = {
      ...f,
      attemptId,
      requestId: randomUUID(),
      allowlist: ['get_task', 'cancel_reminder'],
      authorizationRevision: 'delegation/1' as const,
      confirmedTimezone: 'Asia/Shanghai',
      anchorReceivedAtUtc: '2026-11-03T00:00:00Z',
      receivedAtUtc: '2026-11-03T00:00:00Z',
      foldChoice: 'none' as const,
      timeContext,
    };
    const supplied: GoalResult = {
      status: 'blocked',
      outcomes: [{ description: '取消提醒', status: 'blocked', receipt_refs: [] }],
      clarification: { kind: 'target_selection', question: '选哪条？' },
      answer: '请选择提醒。',
    };
    const client = await db.pool.connect();
    try {
      const goal = await validateGoalResult(client, context, supplied);
      if (normalized) {
        expect(
          readShownCancellationCandidates(goal.answer).map((candidate) => candidate.id),
        ).toEqual(text.includes('11月5日') ? [ids[1]] : ids);
        expect(goal.clarification?.question).toBe(goal.answer);
      } else {
        expect(goal).toEqual(supplied);
      }
    } finally {
      client.release();
    }
  },
);

test.each([true, false])(
  'ordinal candidate source must match actual owned candidates: %s',
  async (forged) => {
    const f = await fixture(undefined, { running: true, scope: true, text: '取消第二条' });
    const entries = [];
    for (const [index, note] of ['喝水', '喝水', '吃药'].entries()) {
      const id = randomUUID();
      const source = await seedApproval(db.pool, { ownerId: f.ownerId, state: 'consumed' });
      const wall = `2027-11-05 ${String(index + 9).padStart(2, '0')}:00`;
      await db.pool.query(
        `INSERT INTO tasks(id,owner_id,original_note,fire_at_utc,wall_time,timezone_id,fold,
       resolved_utc_offset_seconds,tzdb_version,occurrence,state,state_version,source_approval_id)
       VALUES($1,$2,$3,$4,$5,'Asia/Shanghai',0,28800,'fixture-v1','once','scheduled',1,$6)`,
        [id, f.ownerId, note, `2027-11-05T0${index + 1}:00:00Z`, wall, source.id],
      );
      entries.push({ id, wall_time: wall, timezone_id: 'Asia/Shanghai' });
    }
    const answer = renderCancellationClarification([entries[0]!, entries[forged ? 2 : 1]!]);
    const goal = {
      status: 'blocked',
      outcomes: [{ description: '取消喝水提醒', status: 'blocked', receipt_refs: [] }],
      clarification: { kind: 'target_selection', question: answer },
      answer,
    };
    await db.pool.query(
      'UPDATE agent_runs SET cancellation_scope_candidates=$2::jsonb WHERE id=$1',
      [
        f.runId,
        JSON.stringify({
          original: '取消“喝水”11月5日那条',
          question: renderCancellationClarification(entries.slice(0, 2)),
        }),
      ],
    );
    const runId = randomUUID(),
      messageId = randomUUID();
    await db.pool.query(
      "INSERT INTO messages(id,owner_id,conversation_id,role,content) VALUES($1,$2,$3,'user','取消第二条')",
      [messageId, f.ownerId, f.conversationId],
    );
    await db.pool.query(
      `INSERT INTO agent_runs(id,owner_id,conversation_id,agent_revision,mode,budget_max_iterations,budget_max_tokens,execution,tools_allowlist,frozen_context,input_message_id)
     VALUES($1,$2,$3,'test','chat',16,4096,'harness','["get_task","cancel_reminder"]',$4::jsonb,$5)`,
      [
        runId,
        f.ownerId,
        f.conversationId,
        JSON.stringify({
          cancellationScopeRevision: 'scope/1',
          trustedExecutionContext: {
            continuation: {
              run_id: f.runId,
              original_text: '取消“喝水”11月5日那条',
              goal_result: goal,
            },
          },
        }),
        messageId,
      ],
    );
    const client = await db.pool.connect();
    try {
      const scope = await readCancellationScopeInput(client, { ...f, runId });
      expect(scope.shownCandidates).toEqual(forged ? [] : entries.slice(0, 2));
    } finally {
      client.release();
    }
  },
);

test.each([
  { verbatim: true, dated: false, change: 'none' },
  { verbatim: false, dated: false, change: 'none' },
  { verbatim: true, dated: true, change: 'none' },
  { verbatim: true, dated: false, change: 'added' },
  { verbatim: true, dated: false, change: 'removed' },
])(
  'ordinal requires verified candidates: $verbatim, dated: $dated, change: $change',
  async ({ verbatim, dated, change }) => {
    const f = await fixture(undefined, {
      running: true,
      scope: true,
      text: dated ? '取消“同名提醒”11月5日那条。' : '帮我取消“同名提醒”这条提醒。',
    });
    const ids = [randomUUID(), randomUUID()];
    for (const [index, id] of ids.entries()) {
      const source = await seedApproval(db.pool, { ownerId: f.ownerId, state: 'consumed' });
      const day = dated ? '05' : index === 0 ? '04' : '05';
      const hour = dated && index === 1 ? '10' : '09';
      await db.pool.query(
        `INSERT INTO tasks(id,owner_id,original_note,fire_at_utc,wall_time,timezone_id,fold,
        resolved_utc_offset_seconds,tzdb_version,occurrence,state,state_version,source_approval_id)
       VALUES($1,$2,'同名提醒',$3,$4,'Asia/Shanghai',0,28800,'fixture-v1','once','scheduled',1,$5)`,
        [
          id,
          f.ownerId,
          `2027-11-${day}T0${Number(hour) - 8}:20:00Z`,
          `2027-11-${day} ${hour}:20`,
          source.id,
        ],
      );
    }
    const attemptId = randomUUID();
    await db.pool.query(
      'INSERT INTO run_attempts(id,owner_id,run_id,attempt_no) VALUES($1,$2,$3,1)',
      [attemptId, f.ownerId, f.runId],
    );
    const context = {
      ...f,
      attemptId,
      requestId: randomUUID(),
      allowlist: ['get_task', 'cancel_reminder'],
      authorizationRevision: 'delegation/1' as const,
      confirmedTimezone: 'Asia/Shanghai',
      anchorReceivedAtUtc: '2026-11-03T00:00:00Z',
      receivedAtUtc: '2026-11-03T00:00:00Z',
      foldChoice: 'none' as const,
      timeContext,
    };
    const args = (index: number) => ({
      task_id: ids[index]!,
      expected_note: '同名提醒',
      expected_wall_time: dated
        ? `2027-11-05 ${index === 1 ? '10' : '09'}:20`
        : `2027-11-0${index + 4} 09:20`,
      expected_timezone_id: 'Asia/Shanghai',
    });
    const toolId = 'cancel_reminder';
    const firstBinding = await reserveToolInvocation(db.pool, context, {
      callKey: 'ambiguous',
      toolId,
      args: args(1),
    });
    const first = await invokeTool(db.pool, context, { ...firstBinding, toolId, args: args(1) });
    if (first.status !== 'ok' || first.result.kind !== 'clarify')
      throw new Error('expected clarification');
    expect(first.result.reason).toBe('TARGET_SCOPE_UNCLEAR');
    const goal: GoalResult = {
      status: 'blocked',
      outcomes: [{ description: '取消提醒', status: 'blocked', receipt_refs: [] }],
      clarification: { kind: 'target_selection', question: first.result.text },
      answer: verbatim ? first.result.text : '请选择第二条或者第一条。',
    };
    if (verbatim) {
      const validatingClient = await db.pool.connect();
      try {
        expect(await validateGoalResult(validatingClient, context, goal)).toEqual(goal);
      } finally {
        validatingClient.release();
      }
    }
    await db.pool.query("UPDATE agent_runs SET status='done',goal_result=$2::jsonb WHERE id=$1", [
      f.runId,
      JSON.stringify(goal),
    ]);
    if (change === 'added') {
      const source = await seedApproval(db.pool, { ownerId: f.ownerId, state: 'consumed' });
      await db.pool.query(
        `INSERT INTO tasks(id,owner_id,original_note,fire_at_utc,wall_time,timezone_id,fold,
          resolved_utc_offset_seconds,tzdb_version,occurrence,state,state_version,source_approval_id)
         VALUES($1,$2,'同名提醒','2027-11-06T01:20:00Z','2027-11-06 09:20','Asia/Shanghai',0,28800,'fixture-v1','once','scheduled',1,$3)`,
        [randomUUID(), f.ownerId, source.id],
      );
    }
    if (change === 'removed') {
      await db.pool.query(
        "UPDATE tasks SET state='cancelled',state_version=state_version+1 WHERE id=$1",
        [ids[0]],
      );
    }
    const messageId = randomUUID(),
      runId = randomUUID(),
      nextAttempt = randomUUID();
    await db.pool.query(
      "INSERT INTO messages(id,owner_id,conversation_id,role,content) VALUES($1,$2,$3,'user','第二条')",
      [messageId, f.ownerId, f.conversationId],
    );
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM conversations WHERE id=$1 FOR UPDATE', [f.conversationId]);
      const accepted = await acceptTargetContinuation(client, {
        ...f,
        inputMessageId: messageId,
        sourceRunId: f.runId,
        timeContext,
      });
      expect(accepted?.continuation.source_result).toBeNull();
      await client.query(
        `INSERT INTO agent_runs(id,owner_id,conversation_id,agent_revision,mode,budget_max_iterations,budget_max_tokens,execution,tools_allowlist,frozen_context,input_message_id)
       VALUES($1,$2,$3,'test','chat',16,4096,'harness',$4::jsonb,$5::jsonb,$6)`,
        [
          runId,
          f.ownerId,
          f.conversationId,
          JSON.stringify(context.allowlist),
          JSON.stringify({
            authorization_revision: 'delegation/1',
            cancellationScopeRevision: 'scope/1',
            trustedExecutionContext: { continuation: accepted!.continuation },
          }),
          messageId,
        ],
      );
      await client.query(
        'INSERT INTO run_attempts(id,owner_id,run_id,attempt_no) VALUES($1,$2,$3,1)',
        [nextAttempt, f.ownerId, runId],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    const next = { ...context, runId, attemptId: nextAttempt };
    if (change !== 'removed') {
      const wrongBinding = await reserveToolInvocation(db.pool, next, {
        callKey: 'wrong',
        toolId,
        args: args(0),
      });
      expect(
        await invokeTool(db.pool, next, { ...wrongBinding, toolId, args: args(0) }),
      ).toMatchObject({ status: 'ok', result: { kind: 'clarify' } });
    }
    const rightBinding = await reserveToolInvocation(db.pool, next, {
      callKey: 'right',
      toolId,
      args: args(1),
    });
    const right = await invokeTool(db.pool, next, { ...rightBinding, toolId, args: args(1) });
    if (verbatim) {
      expect(right).toMatchObject({
        status: 'ok',
        result: { kind: 'reminder_cancelled', task_id: ids[1], state: 'cancel_pending' },
      });
      expect(
        await invokeTool(db.pool, next, { ...rightBinding, toolId, args: args(1) }),
      ).toMatchObject({
        status: 'ok',
        replayed: true,
        result: { kind: 'reminder_cancelled', task_id: ids[1] },
      });
    } else {
      expect(right).toMatchObject({ status: 'ok', result: { kind: 'clarify' } });
    }
    const states = await db.pool.query('SELECT id,state FROM tasks WHERE id=ANY($1::uuid[])', [
      ids,
    ]);
    expect(new Map(states.rows.map((row) => [row.id, row.state]))).toEqual(
      new Map([
        [ids[0], change === 'removed' ? 'cancelled' : 'scheduled'],
        [ids[1], verbatim ? 'cancel_pending' : 'scheduled'],
      ]),
    );
  },
);

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
  await expectApplicationRejection(
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
    { status: 400, message: expect.stringContaining('请说明') },
  );
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

test('an older unanswered target gap prevents an ambiguous continuation', async () => {
  const f = await fixture();
  const oldMessageId = randomUUID();
  await db.pool.query(
    "INSERT INTO messages(id,owner_id,conversation_id,role,content,created_at) VALUES($1,$2,$3,'user','另一个问题',clock_timestamp()-interval '2 minutes')",
    [oldMessageId, f.ownerId, f.conversationId],
  );
  await db.pool.query(
    `INSERT INTO agent_runs(id,owner_id,conversation_id,agent_revision,mode,status,budget_max_iterations,budget_max_tokens,execution,tools_allowlist,frozen_context,input_message_id,goal_result)
     SELECT $1,owner_id,conversation_id,agent_revision,mode,status,budget_max_iterations,budget_max_tokens,execution,tools_allowlist,frozen_context,$2,goal_result
     FROM agent_runs WHERE id=$3`,
    [randomUUID(), oldMessageId, f.runId],
  );
  const inputMessageId = randomUUID();
  await db.pool.query(
    "INSERT INTO messages(id,owner_id,conversation_id,role,content) VALUES($1,$2,$3,'user','第一个')",
    [inputMessageId, f.ownerId, f.conversationId],
  );
  const client = await db.pool.connect();
  try {
    const continuation = await acceptTargetContinuation(client, {
      ...f,
      inputMessageId,
      sourceRunId: f.runId,
      timeContext,
    });
    expect(continuation).toBeNull();
  } finally {
    client.release();
  }
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
    const source = await acceptReminderDate(
      client,
      {
        ...f,
        inputMessageId,
        text: '取消提醒',
        receivedAtUtc: '2026-11-03T01:00:00Z',
        foldChoice: 'none',
        confirmedTimezone: null,
        directCreation: true,
      },
      { listReminderClarifications, readReminderTimeErrors },
    );
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

test.each(['target_selection', 'destination'] as const)(
  'continues an owned document $kind gap with its frozen scope',
  async (kind) => {
    const f = await fixture(['workspace_read'], {
      text: '修改这份资料',
      clarificationKind: kind,
      workspaceGrants: (ownerId) => [documentGrant(ownerId)],
      omitReminderDateSource: true,
    });
    const grant = documentGrant(f.ownerId);
    const inputMessageId = randomUUID();
    await db.pool.query(
      "INSERT INTO messages(id,owner_id,conversation_id,role,content) VALUES($1,$2,$3,'user','第二个')",
      [inputMessageId, f.ownerId, f.conversationId],
    );
    const client = await db.pool.connect();
    try {
      const accepted = await acceptTargetContinuation(client, {
        ...f,
        inputMessageId,
        sourceRunId: f.runId,
        timeContext,
        kind,
      });
      expect(accepted?.workspaceGrants).toEqual([grant]);
      expect(accepted?.workspaceCreateAllowed).toBe(false);
      expect(accepted?.continuation).toMatchObject({
        run_id: f.runId,
        original_input_message_id: f.messageId,
        original_text: '修改这份资料',
        receipts: [],
        source_result: null,
      });
      expect(
        await acceptTargetContinuation(client, {
          ...f,
          ownerId: randomUUID(),
          inputMessageId,
          sourceRunId: f.runId,
          timeContext,
          kind,
        }),
      ).toBeNull();
    } finally {
      client.release();
    }
  },
);

test('a destination continuation preserves the predecessor creation eligibility', async () => {
  const f = await fixture(['workspace_read', 'workspace_create'], {
    clarificationKind: 'destination',
    workspaceGrants: (ownerId) => [
      {
        ...documentGrant(ownerId),
        output_directories: [{ path: 'outputs', identity: 'directory' }],
      },
    ],
  });
  const inputMessageId = randomUUID();
  await db.pool.query(
    "INSERT INTO messages(id,owner_id,conversation_id,role,content) VALUES($1,$2,$3,'user','输出目录')",
    [inputMessageId, f.ownerId, f.conversationId],
  );
  const client = await db.pool.connect();
  try {
    const accepted = await acceptTargetContinuation(client, {
      ...f,
      inputMessageId,
      sourceRunId: f.runId,
      timeContext,
      kind: 'destination',
    });
    expect(accepted?.workspaceCreateAllowed).toBe(true);
    expect(accepted?.workspaceGrants?.[0]?.output_directories).toEqual([
      { path: 'outputs', identity: 'directory' },
    ]);
  } finally {
    client.release();
  }
});

test('a document destination and an older target gap are ambiguous', async () => {
  const f = await fixture(['workspace_read'], {
    clarificationKind: 'destination',
    workspaceGrants: (ownerId) => [documentGrant(ownerId)],
  });
  const olderMessage = randomUUID();
  await db.pool.query(
    "INSERT INTO messages(id,owner_id,conversation_id,role,content,created_at) VALUES($1,$2,$3,'user','旧问题',clock_timestamp()-interval '2 minutes')",
    [olderMessage, f.ownerId, f.conversationId],
  );
  await db.pool.query(
    `INSERT INTO agent_runs(id,owner_id,conversation_id,agent_revision,mode,status,budget_max_iterations,budget_max_tokens,execution,tools_allowlist,frozen_context,input_message_id,goal_result)
     SELECT $1,owner_id,conversation_id,agent_revision,mode,status,budget_max_iterations,budget_max_tokens,execution,tools_allowlist,frozen_context,$2,
       jsonb_set(goal_result,'{clarification,kind}','"target_selection"'::jsonb)
     FROM agent_runs WHERE id=$3`,
    [randomUUID(), olderMessage, f.runId],
  );
  const inputMessageId = randomUUID();
  await db.pool.query(
    "INSERT INTO messages(id,owner_id,conversation_id,role,content) VALUES($1,$2,$3,'user','第二个')",
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
        kind: 'destination',
      }),
    ).toBeNull();
  } finally {
    client.release();
  }
});

test('workspace tools alone or a foreign frozen grant cannot authorize a document gap', async () => {
  for (const grants of [
    [],
    [
      {
        workspace_id: 'documents',
        owner_id: randomUUID(),
        registration_digest: 'a'.repeat(64),
        root_identity: 'root',
      },
    ],
  ]) {
    const f = await fixture(['workspace_read'], { workspaceGrants: () => grants });
    const inputMessageId = randomUUID();
    await db.pool.query(
      "INSERT INTO messages(id,owner_id,conversation_id,role,content) VALUES($1,$2,$3,'user','第二个')",
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
