import { expectApplicationRejection } from '../helpers/application-error.js';
import { readAcceptedInvocationResult } from '../../src/agent/tools/invocations/accepted-result.js';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { invokeTool, reserveToolInvocation } from '../../src/agent/tools/gateway.js';
import {
  readRunCreatedReminders,
  readRunInterruptionEvidence,
} from '../../src/agent/tools/evidence/run-evidence.js';
import type { ToolContext, ToolOutcome } from '../../src/agent/tools/contracts.js';
import { loadTimeContext } from '../../src/features/time/context.js';
import {
  admitTestUser,
  createIntegrationDatabase,
  seedApproval,
  type IntegrationDatabase,
} from './setup.js';
import {
  interruptedGoalResult,
  validateGoalResult,
} from '../../src/agent/execution/result/goal-result.js';
import { acceptTargetContinuation } from '../../src/agent/run/continuation/target.js';
import { createTaskWithinTransaction } from '../../src/features/tasks/create.js';
import { runSchedulePhase } from '../../src/features/tasks/scheduler/schedule.js';
import { runCancelPhase } from '../../src/features/tasks/scheduler/cancel-phase.js';

describe('direct reminder accepted facts', () => {
  let db: IntegrationDatabase;
  beforeAll(async () => {
    db = await createIntegrationDatabase();
  });
  afterAll(async () => {
    await db?.close();
  });
  const text = '2027年11月4日15:00提醒我核对报告';
  const args = { raw_time_text: text, note: '核对报告', occurrence: 'once' };
  for (const [request, timezone, kind, reason] of [
    ['2027年11月4日提醒我核对报告', 'Asia/Shanghai', 'clarify', 'DAYPART_MISSING'],
    ['2027年11月4日下午三点左右提醒我核对报告', 'Asia/Shanghai', 'clarify', 'FUZZY_RANGE'],
    ['2027年11月7日01:30提醒我核对报告', 'America/New_York', 'time_error', 'AMBIGUOUS_LOCAL_TIME'],
    [
      '2027年3月14日02:30提醒我核对报告',
      'America/New_York',
      'time_error',
      'NONEXISTENT_LOCAL_TIME',
    ],
    ['三分钟后提醒我核对报告', 'Asia/Shanghai', 'clarify', 'DAYPART_MISSING'],
  ] as const) {
    it(`does not create before resolving ${reason}`, async () => {
      const ctx = await fresh(undefined, request);
      const { outcome } = await call(ctx, 'blocked/1', {
        raw_time_text: request,
        note: '核对报告',
        occurrence: 'once',
        timezone_hint: timezone,
      });
      expect(outcome).toMatchObject({
        status: 'ok',
        result: { kind, ...(kind === 'time_error' ? { error: { code: reason } } : { reason }) },
      });
      expect(await counts(ctx)).toEqual({ approvals: 0, tasks: 0, task_events: 0, outbox: 0 });
    });
  }
  async function fresh(
    tools = ['create_reminder', 'set_user_timezone'],
    request = text,
    options: {
      anchor?: string;
      elapsedRevision?: 'elapsed/1';
      legacyScope?: boolean;
      original?: string;
    } = {},
  ): Promise<ToolContext> {
    const ownerId = randomUUID(),
      conversationId = randomUUID(),
      runId = randomUUID(),
      attemptId = randomUUID(),
      messageId = randomUUID();
    const anchor = options.anchor ?? '2027-11-03T00:00:00Z';
    await db.pool.query(
      "INSERT INTO users(id,auth_email,display_name,timezone_id) VALUES($1,$2,'reminder tester','Asia/Shanghai')",
      [ownerId, `${ownerId}@reminder.test`],
    );
    await admitTestUser(db.pool, ownerId);
    await db.pool.query('INSERT INTO conversations(id,owner_id) VALUES($1,$2)', [
      conversationId,
      ownerId,
    ]);
    await db.pool.query(
      "INSERT INTO messages(id,owner_id,conversation_id,role,content) VALUES($1,$2,$3,'user',$4)",
      [messageId, ownerId, conversationId, request],
    );
    await db.pool.query(
      `INSERT INTO agent_runs(id,owner_id,conversation_id,agent_revision,mode,budget_max_iterations,budget_max_tokens,execution,tools_allowlist,frozen_context,input_message_id) VALUES($1,$2,$3,'direct-test','chat',16,4096,'harness',$4::jsonb,$5::jsonb,$6)`,
      [
        runId,
        ownerId,
        conversationId,
        JSON.stringify(tools),
        JSON.stringify({
          authorization_revision: 'delegation/1',
          execution_lifecycle: 'request-bound',
          ...(!options.legacyScope ? { cancellationScopeRevision: 'scope/1' } : {}),
          ...(options.elapsedRevision || options.original
            ? {
                trustedExecutionContext: {
                  ...(options.elapsedRevision
                    ? {
                        request_anchor_utc: anchor,
                        time_capabilities: { elapsed_revision: options.elapsedRevision },
                      }
                    : {}),
                  ...(options.original
                    ? { continuation: { original_text: options.original } }
                    : {}),
                },
              }
            : {}),
          reminderDateSource: { version: 1, kind: 'new', inputMessageId: messageId },
        }),
        messageId,
      ],
    );
    await db.pool.query(
      'INSERT INTO run_attempts(id,owner_id,run_id,attempt_no) VALUES($1,$2,$3,1)',
      [attemptId, ownerId, runId],
    );
    return {
      ownerId,
      conversationId,
      runId,
      attemptId,
      requestId: randomUUID(),
      allowlist: tools,
      authorizationRevision: 'delegation/1',
      confirmedTimezone: 'Asia/Shanghai',
      anchorReceivedAtUtc: anchor,
      receivedAtUtc: anchor,
      foldChoice: 'none',
      timeContext: loadTimeContext('fixture-v1'),
    };
  }
  async function call(
    ctx: ToolContext,
    key: string,
    input: unknown = args,
    toolId = 'create_reminder',
  ) {
    const binding = await reserveToolInvocation(db.pool, ctx, {
      callKey: key,
      toolId,
      args: input,
    });
    return {
      binding,
      outcome: await invokeTool(db.pool, ctx, { ...binding, toolId, args: input }),
    };
  }
  async function counts(ctx: ToolContext) {
    const values: Record<string, number> = {};
    for (const table of ['approvals', 'tasks', 'task_events', 'outbox'])
      values[table] = (
        await db.pool.query(`SELECT count(*)::int n FROM ${table} WHERE owner_id=$1`, [ctx.ownerId])
      ).rows[0].n;
    return values;
  }
  async function cancelInput(taskId: string) {
    const { rows } = await db.pool.query(
      'SELECT original_note, wall_time, timezone_id FROM tasks WHERE id=$1',
      [taskId],
    );
    const task = rows[0];
    return {
      task_id: taskId,
      expected_note: task.original_note,
      expected_wall_time: task.wall_time,
      expected_timezone_id: task.timezone_id,
    };
  }
  for (const scenario of [
    {
      name: 'wrong ID with requested metadata',
      sameNote: false,
      wrongMetadata: true,
      allowed: false,
    },
    {
      name: 'self-consistent unrelated target',
      sameNote: false,
      wrongMetadata: false,
      allowed: false,
    },
    {
      name: 'self-consistent ambiguous target',
      sameNote: true,
      wrongMetadata: false,
      allowed: false,
    },
    { name: 'explicit unique target', sameNote: false, wrongMetadata: false, allowed: true },
    { name: 'explicit dated target', sameNote: true, wrongMetadata: false, allowed: true },
  ]) {
    it(`checks actual cancellation receipts for ${scenario.name}`, async () => {
      const targetYear = new Date().getUTCFullYear() + 1;
      const request = scenario.allowed
        ? scenario.sameNote
          ? `取消“核对报告”${targetYear}年11月5日那条。`
          : '取消“另一条”这条提醒。'
        : '取消“核对报告”这条提醒。';
      const ctx = await fresh(['cancel_reminder'], request);
      const ids: string[] = [];
      const client = await db.pool.connect();
      try {
        await client.query('BEGIN');
        for (const [index, note] of [
          '核对报告',
          scenario.sameNote ? '核对报告' : '另一条',
        ].entries()) {
          const source = await seedApproval(db.pool, { ownerId: ctx.ownerId, state: 'consumed' });
          const task = await createTaskWithinTransaction(client, {
            ownerId: ctx.ownerId,
            source: { approvalId: source.id },
            fireAtUtc: `${targetYear}-11-0${index + 4}T01:20:00Z`,
            wallTime: `${targetYear}-11-0${index + 4} 09:20`,
            timezoneId: 'Asia/Shanghai',
            fold: 0,
            resolvedUtcOffsetSeconds: 28800,
            tzdbVersion: 'fixture-v1',
            originalNote: note,
            idempotencyKey: randomUUID(),
          });
          ids.push(task.task_id);
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
      await runSchedulePhase(db.pool);
      expect(
        (await db.pool.query('SELECT state FROM tasks WHERE id=ANY($1::uuid[])', [ids])).rows,
      ).toEqual([{ state: 'scheduled' }, { state: 'scheduled' }]);
      const input = await cancelInput(ids[scenario.wrongMetadata ? 0 : 1]!);
      input.task_id = ids[1]!;
      const { outcome } = await call(ctx, 'receipt/scope', input, 'cancel_reminder');
      expect(outcome).toMatchObject({
        status: 'ok',
        result: { kind: scenario.allowed ? 'reminder_cancelled' : 'clarify' },
      });
      expect((await db.pool.query('SELECT state FROM tasks WHERE id=$1', [ids[1]])).rows).toEqual([
        { state: scenario.allowed ? 'cancel_pending' : 'scheduled' },
      ]);
      await runCancelPhase(db.pool);
      const tasks = await db.pool.query('SELECT id,state FROM tasks WHERE id=ANY($1::uuid[])', [
        ids,
      ]);
      const states = new Map(tasks.rows.map((task) => [task.id, task.state]));
      expect(states.get(ids[0])).toBe('scheduled');
      expect(states.get(ids[1])).toBe(scenario.allowed ? 'cancelled' : 'scheduled');
      const receipts = await db.pool.query(
        `SELECT o.task_id, o.provider_receipt_id, e.evidence_ref FROM outbox o
         JOIN task_events e ON e.task_id=o.task_id AND e.type='cancelled'
         WHERE o.task_id=ANY($1::uuid[]) AND o.command->>'kind'='cancel'
           AND o.status='dispatched'`,
        [ids],
      );
      if (scenario.allowed) {
        expect(receipts.rows).toEqual([
          {
            task_id: ids[1],
            provider_receipt_id: expect.stringMatching(/^pg-cancel:/u),
            evidence_ref: expect.stringMatching(/^pg-cancel:/u),
          },
        ]);
        expect(receipts.rows[0].evidence_ref).toBe(receipts.rows[0].provider_receipt_id);
      } else {
        expect(receipts.rows).toEqual([]);
        expect(
          (
            await db.pool.query(
              "SELECT 1 FROM task_events WHERE task_id=ANY($1::uuid[]) AND type='cancel_requested'",
              [ids],
            )
          ).rows,
        ).toEqual([]);
      }
    });
  }
  for (const [request, allowed] of [
    ['帮我取消“同名提醒”这条提醒。', false],
    ['取消“同名提醒”11月5日那条。', true],
    ['取消“同名提醒”的全部提醒。', true],
    ['不要取消“同名提醒”11月5日那条。', false],
  ] as const) {
    it(`checks the user's actual same-name scope: ${request}`, async () => {
      const ctx = await fresh(['cancel_reminder'], request);
      const ids = [randomUUID(), randomUUID()];
      for (const [index, id] of ids.entries()) {
        const source = await seedApproval(db.pool, { ownerId: ctx.ownerId, state: 'consumed' });
        const day = index === 0 ? '04' : '05';
        await db.pool.query(
          `INSERT INTO tasks(id,owner_id,original_note,fire_at_utc,wall_time,timezone_id,fold,
            resolved_utc_offset_seconds,tzdb_version,occurrence,state,state_version,source_approval_id)
           VALUES($1,$2,'同名提醒',$3,$4,'Asia/Shanghai',0,28800,'fixture-v1','once','scheduled',1,$5)`,
          [id, ctx.ownerId, `2027-11-${day}T01:20:00Z`, `2027-11-${day} 09:20`, source.id],
        );
      }
      const before = await counts(ctx);
      const result = await call(ctx, 'cancel/scope', await cancelInput(ids[1]!), 'cancel_reminder');
      expect(result.outcome).toMatchObject({
        status: 'ok',
        result: { kind: allowed ? 'reminder_cancelled' : 'clarify' },
      });
      const states = await db.pool.query('SELECT id,state FROM tasks WHERE id=ANY($1::uuid[])', [
        ids,
      ]);
      const byId = new Map(states.rows.map((row) => [row.id, row.state]));
      expect(byId.get(ids[0])).toBe('scheduled');
      expect(byId.get(ids[1])).toBe(allowed ? 'cancel_pending' : 'scheduled');
      if (!allowed) expect(await counts(ctx)).toEqual(before);
      if (request === '取消“同名提醒”的全部提醒。') {
        const other = await call(
          ctx,
          'cancel/all-other',
          await cancelInput(ids[0]!),
          'cancel_reminder',
        );
        expect(other.outcome).toMatchObject({
          status: 'ok',
          result: { kind: 'reminder_cancelled', task_id: ids[0], state: 'cancel_pending' },
        });
        const completed = await db.pool.query(
          "SELECT count(*)::int n FROM tasks WHERE id=ANY($1::uuid[]) AND state='cancel_pending'",
          [ids],
        );
        expect(completed.rows[0].n).toBe(2);
      }
    });
  }
  for (const [request, note, allowed] of [
    ['不要取消“另一条”提醒。', '另一条', false],
    ['帮我取消“同名提醒”这条提醒。', '另一条', false],
    ['帮我取消“另一条”这条提醒。', '另一条', true],
    ['请只取消“另一条”这条2027年11月4日09:20上海时间的提醒。', '另一条', true],
    ['请取消名称以“批量”开头的全部未来提醒，别的提醒不要取消。', '批量甲', true],
    ['请取消名称以“批量”开头的全部未来提醒，别的提醒不要取消。', '其他', false],
    ['请取消名称以“批量”开头的全部未来提醒，别的提醒不要取消。', '批量过期', false],
    ['请取消全部未来提醒。', '另一条', true],
    ['请取消全部未来提醒。', '批量过期', false],
    ['请取消全部未来提醒。', '全部未来提醒', false],
    [
      '请取消名称以“批量”开头的全部未来提醒，别的提醒不要取消。',
      '名称以“批量”开头的全部未来提醒，别的提醒不要取消',
      false,
    ],
  ] as const) {
    it(`verifies unique and batch cancellation scope: ${request} / ${note}`, async () => {
      const ctx = await fresh(['cancel_reminder'], request, {
        ...(['批量过期', '全部未来提醒'].includes(note) ? { anchor: '2027-11-05T00:00:00Z' } : {}),
      });
      const id = randomUUID();
      const source = await seedApproval(db.pool, { ownerId: ctx.ownerId, state: 'consumed' });
      await db.pool.query(
        `INSERT INTO tasks(id,owner_id,original_note,fire_at_utc,wall_time,timezone_id,fold,
          resolved_utc_offset_seconds,tzdb_version,occurrence,state,state_version,source_approval_id)
         VALUES($1,$2,$3,'2027-11-04T01:20:00Z','2027-11-04 09:20','Asia/Shanghai',0,28800,'fixture-v1','once','scheduled',1,$4)`,
        [id, ctx.ownerId, note, source.id],
      );
      const before = await counts(ctx);
      const result = await call(ctx, 'cancel/single', await cancelInput(id), 'cancel_reminder');
      expect(result.outcome).toMatchObject({
        status: 'ok',
        result: { kind: allowed ? 'reminder_cancelled' : 'clarify' },
      });
      if (!allowed) expect(await counts(ctx)).toEqual(before);
    });
  }
  for (const [request, note, anchor] of [
    ['取消全部未来提醒。', '全部未来提醒', '2027-11-05T00:00:00Z'],
    [
      '取消名称以“批量”开头的全部未来提醒，别的提醒不要取消。',
      '名称以“批量”开头的全部未来提醒，别的提醒不要取消',
      '2027-11-03T00:00:00Z',
    ],
  ] as const) {
    it(`keeps batch scope exclusive in a continuation: ${request}`, async () => {
      const ctx = await fresh(['cancel_reminder'], request, { anchor, original: request });
      const id = randomUUID();
      const source = await seedApproval(db.pool, { ownerId: ctx.ownerId, state: 'consumed' });
      await db.pool.query(
        `INSERT INTO tasks(id,owner_id,original_note,fire_at_utc,wall_time,timezone_id,fold,
          resolved_utc_offset_seconds,tzdb_version,occurrence,state,state_version,source_approval_id)
         VALUES($1,$2,$3,'2027-11-04T01:20:00Z','2027-11-04 09:20','Asia/Shanghai',0,28800,'fixture-v1','once','scheduled',1,$4)`,
        [id, ctx.ownerId, note, source.id],
      );
      const before = await counts(ctx);
      expect(
        (await call(ctx, 'cancel/continuation-batch', await cancelInput(id), 'cancel_reminder'))
          .outcome,
      ).toMatchObject({ status: 'ok', result: { kind: 'clarify' } });
      expect(await counts(ctx)).toEqual(before);
    });
  }
  it('waits for a concurrent same-name creation before checking ambiguity', async () => {
    const ctx = await fresh(['cancel_reminder'], '帮我取消“同名提醒”这条提醒。');
    const oldId = randomUUID();
    const oldSource = await seedApproval(db.pool, { ownerId: ctx.ownerId, state: 'consumed' });
    await db.pool.query(
      `INSERT INTO tasks(id,owner_id,original_note,fire_at_utc,wall_time,timezone_id,fold,
        resolved_utc_offset_seconds,tzdb_version,occurrence,state,state_version,source_approval_id)
       VALUES($1,$2,'同名提醒','2027-11-04T01:20:00Z','2027-11-04 09:20','Asia/Shanghai',0,28800,'fixture-v1','once','scheduled',1,$3)`,
      [oldId, ctx.ownerId, oldSource.id],
    );
    const source = await seedApproval(db.pool, { ownerId: ctx.ownerId, state: 'consumed' });
    const creator = await db.pool.connect();
    let pending: Promise<{ outcome: ToolOutcome }> | undefined;
    try {
      await creator.query('BEGIN');
      const pid = (await creator.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await createTaskWithinTransaction(creator, {
        ownerId: ctx.ownerId,
        source: { approvalId: source.id },
        fireAtUtc: '2027-11-05T01:20:00Z',
        wallTime: '2027-11-05 09:20',
        timezoneId: 'Asia/Shanghai',
        fold: 0,
        resolvedUtcOffsetSeconds: 28800,
        tzdbVersion: 'fixture-v1',
        originalNote: '同名提醒',
        idempotencyKey: randomUUID(),
      });
      pending = call(ctx, 'cancel/concurrent-create', await cancelInput(oldId), 'cancel_reminder');
      let blocked = false;
      for (let attempt = 0; attempt < 500 && !blocked; attempt++) {
        blocked = (
          await db.pool.query(
            'SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS blocked',
            [pid],
          )
        ).rows[0].blocked;
      }
      expect(blocked).toBe(true);
      await creator.query('COMMIT');
      expect((await pending).outcome).toMatchObject({
        status: 'ok',
        result: { kind: 'clarify', reason: 'TARGET_SCOPE_UNCLEAR' },
      });
      const states = await db.pool.query('SELECT state FROM tasks WHERE owner_id=$1', [
        ctx.ownerId,
      ]);
      expect(states.rows.map((row) => row.state).sort()).toEqual(['saved', 'scheduled']);
    } finally {
      await creator.query('ROLLBACK');
      creator.release();
      if (pending) await pending.catch(() => undefined);
    }
  });
  it('does not cancel a task identified only by a model-selected ID', async () => {
    const ctx = await fresh(['create_reminder', 'cancel_reminder']);
    const created = await call(ctx, 'create/target');
    if (created.outcome.status !== 'ok' || created.outcome.result.kind !== 'task_created')
      throw new Error('expected task creation');
    const taskId = created.outcome.result.task_id;
    const before = await counts(ctx);
    const cancel = await call(ctx, 'cancel/unverified', { task_id: taskId }, 'cancel_reminder');
    expect(cancel.outcome).toMatchObject({
      status: 'ok',
      result: { kind: 'clarify', reason: 'TARGET_IDENTITY_REQUIRED' },
    });
    expect(await counts(ctx)).toEqual(before);
    const task = await db.pool.query('SELECT state FROM tasks WHERE id=$1', [taskId]);
    expect(task.rows[0].state).toBe('saved');
  });
  it('rejects an ID paired with another target and can cancel the intended task', async () => {
    const ctx = await fresh(['create_reminder', 'cancel_reminder'], text, { legacyScope: true });
    const intended = await call(ctx, 'create/intended');
    const other = await call(ctx, 'create/other', { ...args, note: '另一条提醒' });
    if (
      intended.outcome.status !== 'ok' ||
      intended.outcome.result.kind !== 'task_created' ||
      other.outcome.status !== 'ok' ||
      other.outcome.result.kind !== 'task_created'
    )
      throw new Error('expected task creation');
    const intendedId = intended.outcome.result.task_id;
    const otherId = other.outcome.result.task_id;
    const identity = await cancelInput(intendedId);
    const before = await counts(ctx);
    const wrong = await call(
      ctx,
      'cancel/wrong',
      { ...identity, task_id: otherId },
      'cancel_reminder',
    );
    expect(wrong.outcome).toMatchObject({
      status: 'ok',
      result: { kind: 'clarify', reason: 'TARGET_IDENTITY_REQUIRED' },
    });
    expect(await counts(ctx)).toEqual(before);
    expect(
      (await db.pool.query('SELECT state FROM tasks WHERE id=$1', [otherId])).rows[0].state,
    ).toBe('saved');
    const correct = await call(ctx, 'cancel/correct', identity, 'cancel_reminder');
    expect(correct.outcome).toMatchObject({
      status: 'ok',
      result: { kind: 'reminder_cancelled', task_id: intendedId, state: 'cancel_pending' },
    });
  });
  it('does not cancel when the expected time or timezone belongs to another target', async () => {
    const ctx = await fresh(['create_reminder', 'cancel_reminder']);
    const created = await call(ctx, 'create/target');
    if (created.outcome.status !== 'ok' || created.outcome.result.kind !== 'task_created')
      throw new Error('expected task creation');
    const taskId = created.outcome.result.task_id;
    const identity = await cancelInput(taskId);
    const before = await counts(ctx);
    for (const [key, input] of [
      ['time', { ...identity, expected_wall_time: '2027-11-04 15:01' }],
      ['timezone', { ...identity, expected_timezone_id: 'Asia/Tokyo' }],
    ] as const) {
      const result = await call(ctx, `cancel/${key}`, input, 'cancel_reminder');
      expect(result.outcome).toMatchObject({
        status: 'ok',
        result: { kind: 'clarify', reason: 'TARGET_IDENTITY_REQUIRED' },
      });
    }
    expect(await counts(ctx)).toEqual(before);
    expect(
      (await db.pool.query('SELECT state FROM tasks WHERE id=$1', [taskId])).rows[0].state,
    ).toBe('saved');
  });
  it('reads full owned task and cancels once with stable accepted state', async () => {
    const ctx = await fresh(
      ['create_reminder', 'list_tasks', 'get_task', 'cancel_reminder'],
      text,
      {
        legacyScope: true,
      },
    );
    const created = await call(ctx, 'create/1');
    if (created.outcome.status !== 'ok' || created.outcome.result.kind !== 'task_created')
      throw new Error('expected task creation');
    const taskId = created.outcome.result.task_id;
    const detail = await call(ctx, 'detail/1', { task_id: taskId }, 'get_task');
    expect(detail.outcome).toMatchObject({
      status: 'ok',
      result: {
        kind: 'task_detail',
        task: { task_id: taskId, note: args.note, state: 'saved' },
      },
    });
    const list = await call(ctx, 'list/1', { limit: 1 }, 'list_tasks');
    expect(list.outcome).toMatchObject({
      status: 'ok',
      result: {
        kind: 'list_tasks',
        tasks: [{ task_id: taskId }],
        has_more: false,
        next_cursor: null,
      },
    });
    const input = await cancelInput(taskId);
    const cancel = await call(ctx, 'cancel/1', input, 'cancel_reminder');
    expect(cancel.outcome).toMatchObject({
      status: 'ok',
      result: {
        kind: 'reminder_cancelled',
        task_id: taskId,
        state: 'cancel_pending',
        duplicate: false,
      },
    });
    const pendingGoal = {
      status: 'partial' as const,
      outcomes: [
        {
          description: '已记录提醒',
          status: 'achieved' as const,
          receipt_refs: [created.binding.invocationId],
        },
        {
          description: '取消请求已接受，等待撤销回执',
          status: 'blocked' as const,
          receipt_refs: [cancel.binding.invocationId],
        },
      ],
      clarification: null,
      answer: '取消请求已接受，等待撤销回执。',
    };
    const client = await db.pool.connect();
    try {
      expect(await validateGoalResult(client, ctx, pendingGoal)).toEqual(pendingGoal);
      await expect(
        validateGoalResult(client, ctx, {
          ...pendingGoal,
          outcomes: [pendingGoal.outcomes[0]!],
        }),
      ).rejects.toThrow();
    } finally {
      client.release();
    }
    const replay = await invokeTool(db.pool, ctx, {
      ...cancel.binding,
      toolId: 'cancel_reminder',
      args: input,
    });
    expect(replay).toEqual({ ...cancel.outcome, replayed: true });
    expect(
      await invokeTool(db.pool, ctx, {
        ...cancel.binding,
        toolId: 'cancel_reminder',
        args: { task_id: randomUUID() },
      }),
    ).toMatchObject({ status: 'denied', error: { code: 'STATE_CONFLICT' } });
    const persisted = await db.pool.query('SELECT state FROM tasks WHERE id=$1', [taskId]);
    expect(persisted.rows[0].state).toBe('cancel_pending');
    expect((await counts(ctx)).approvals).toBe(0);
    const sourceGoal = {
      ...pendingGoal,
      clarification: { kind: 'target_selection', question: '另一个目标是哪条？' },
    };
    await db.pool.query('UPDATE agent_runs SET status=$2, goal_result=$3::jsonb WHERE id=$1', [
      ctx.runId,
      'done',
      JSON.stringify(sourceGoal),
    ]);
    const nextMessageId = randomUUID(),
      nextRunId = randomUUID();
    await db.pool.query(
      "INSERT INTO messages(id,owner_id,conversation_id,role,content) VALUES($1,$2,$3,'user','另一个')",
      [nextMessageId, ctx.ownerId, ctx.conversationId],
    );
    const nextClient = await db.pool.connect();
    try {
      const continuation = await acceptTargetContinuation(nextClient, {
        ownerId: ctx.ownerId,
        conversationId: ctx.conversationId,
        sourceRunId: ctx.runId,
        inputMessageId: nextMessageId,
        timeContext: ctx.timeContext,
      });
      expect(continuation?.continuation.receipts.map((item) => item.invocation_id)).toContain(
        cancel.binding.invocationId,
      );
      await nextClient.query(
        `INSERT INTO agent_runs(id,owner_id,conversation_id,agent_revision,mode,budget_max_iterations,budget_max_tokens,execution,tools_allowlist,frozen_context,input_message_id)
        VALUES($1,$2,$3,'direct-test','chat',16,4096,'harness',$4::jsonb,$5::jsonb,$6)`,
        [
          nextRunId,
          ctx.ownerId,
          ctx.conversationId,
          JSON.stringify(ctx.allowlist),
          JSON.stringify({
            authorization_revision: 'delegation/1',
            trustedExecutionContext: { continuation: continuation!.continuation },
          }),
          nextMessageId,
        ],
      );
      const nextContext = { ...ctx, runId: nextRunId };
      expect(await validateGoalResult(nextClient, nextContext, pendingGoal)).toEqual(pendingGoal);
      await expect(
        validateGoalResult(nextClient, nextContext, {
          ...pendingGoal,
          outcomes: [pendingGoal.outcomes[0]!],
        }),
      ).rejects.toThrow();
      const interrupted = await interruptedGoalResult(nextClient, nextContext, 'failed');
      expect(interrupted.outcomes).toContainEqual(
        expect.objectContaining({
          receipt_refs: [cancel.binding.invocationId],
          status: 'achieved',
        }),
      );
      expect(interrupted.answer).toContain('等待撤销回执');
    } finally {
      nextClient.release();
    }
  });

  it('does not expose another owner task through detail or cancellation', async () => {
    const owner = await fresh(['create_reminder']);
    const created = await call(owner, 'create/1');
    if (created.outcome.status !== 'ok' || created.outcome.result.kind !== 'task_created')
      throw new Error('expected task creation');
    const taskId = created.outcome.result.task_id;
    const other = await fresh(['get_task', 'cancel_reminder']);
    const detail = await call(other, 'detail/1', { task_id: taskId }, 'get_task');
    expect(detail.outcome.status).toBe('denied');
    const cancel = await call(
      await fresh(['get_task', 'cancel_reminder']),
      'cancel/1',
      { task_id: taskId },
      'cancel_reminder',
    );
    expect(cancel.outcome.status).toBe('denied');
    expect(
      (await db.pool.query('SELECT state FROM tasks WHERE id=$1', [taskId])).rows[0].state,
    ).toBe('saved');
  });
  it('rolls back cancellation when accepted result persistence fails', async () => {
    const ctx = await fresh(['create_reminder', 'cancel_reminder'], text, { legacyScope: true });
    const created = await call(ctx, 'create/1');
    if (created.outcome.status !== 'ok' || created.outcome.result.kind !== 'task_created')
      throw new Error('expected task creation');
    const taskId = created.outcome.result.task_id;
    const input = await cancelInput(taskId);
    const binding = await reserveToolInvocation(db.pool, ctx, {
      callKey: 'cancel/1',
      toolId: 'cancel_reminder',
      args: input,
    });
    const fn = `fail_cancel_${ctx.ownerId.replaceAll('-', '')}`;
    await db.pool.query(`
      CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'fixture persistence fault'; END $$;
      CREATE TRIGGER ${fn} BEFORE UPDATE ON tool_invocations
      FOR EACH ROW WHEN (NEW.invocation_id='${binding.invocationId}'::uuid)
      EXECUTE FUNCTION ${fn}();
    `);
    try {
      await expect(
        invokeTool(db.pool, ctx, {
          ...binding,
          toolId: 'cancel_reminder',
          args: input,
        }),
      ).rejects.toMatchObject({ code: 'P0001' });
      expect(
        (await db.pool.query('SELECT state FROM tasks WHERE id=$1', [taskId])).rows[0].state,
      ).toBe('saved');
      expect(
        (
          await db.pool.query(
            "SELECT count(*)::int n FROM outbox WHERE task_id=$1 AND command->>'kind'='cancel'",
            [taskId],
          )
        ).rows[0].n,
      ).toBe(0);
    } finally {
      await db.pool.query(`DROP TRIGGER ${fn} ON tool_invocations; DROP FUNCTION ${fn}()`);
    }
    expect(
      await invokeTool(db.pool, ctx, {
        ...binding,
        toolId: 'cancel_reminder',
        args: input,
      }),
    ).toMatchObject({
      status: 'ok',
      result: { kind: 'reminder_cancelled', state: 'cancel_pending' },
    });
  });
  it('does not cancel after the owner is disabled', async () => {
    const ctx = await fresh(['create_reminder', 'cancel_reminder']);
    const created = await call(ctx, 'create/1');
    if (created.outcome.status !== 'ok' || created.outcome.result.kind !== 'task_created')
      throw new Error('expected task creation');
    const taskId = created.outcome.result.task_id;
    const input = await cancelInput(taskId);
    const binding = await reserveToolInvocation(db.pool, ctx, {
      callKey: 'cancel/1',
      toolId: 'cancel_reminder',
      args: input,
    });
    await db.pool.query("UPDATE users SET status='disabled' WHERE id=$1", [ctx.ownerId]);
    expect(
      await invokeTool(db.pool, ctx, {
        ...binding,
        toolId: 'cancel_reminder',
        args: input,
      }),
    ).toMatchObject({ status: 'denied' });
    expect(
      (await db.pool.query('SELECT state FROM tasks WHERE id=$1', [taskId])).rows[0].state,
    ).toBe('saved');
  });
  const elapsedText = '三分钟后提醒我核对报告';
  const elapsedArgs = {
    raw_time_text: elapsedText,
    note: '核对报告',
    occurrence: 'once',
    time_kind: 'elapsed',
    duration_seconds: 180,
  };
  async function elapsedContext(secondsFromNow = 60, enabled = true) {
    const anchor = (
      await db.pool.query<{ anchor: string }>(
        `SELECT to_char((clock_timestamp() + $1::int * interval '1 second') AT TIME ZONE 'UTC',
                        'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS anchor`,
        [secondsFromNow],
      )
    ).rows[0]!.anchor;
    return fresh(['create_reminder'], elapsedText, {
      anchor,
      ...(enabled ? { elapsedRevision: 'elapsed/1' as const } : {}),
    });
  }
  it('creates anchor plus 180 seconds and preserves the elapsed receipt on replay', async () => {
    const ctx = await elapsedContext();
    ctx.confirmedTimezone = 'UTC';
    const binding = await reserveToolInvocation(db.pool, ctx, {
      callKey: 'elapsed/1',
      toolId: 'create_reminder',
      args: elapsedArgs,
    });
    const invoke = () =>
      invokeTool(db.pool, ctx, { ...binding, toolId: 'create_reminder', args: elapsedArgs });
    const first = await invoke();
    expect(await invoke()).toEqual({ ...first, replayed: true });
    const sourceMessageId = (
      await db.pool.query('SELECT input_message_id FROM agent_runs WHERE id=$1', [ctx.runId])
    ).rows[0].input_message_id;
    const fireAt = new Date(Date.parse(ctx.anchorReceivedAtUtc) + 180_000).toISOString();
    const basis = {
      kind: 'elapsed',
      anchor_utc: ctx.anchorReceivedAtUtc,
      duration_seconds: 180,
      source_message_id: sourceMessageId,
      revision: 'elapsed/1',
    };
    expect(first).toMatchObject({
      status: 'ok',
      result: {
        kind: 'task_created',
        fire_at_utc: fireAt,
        time_basis: basis,
        display_version: 'elapsed/1',
      },
    });
    expect(await counts(ctx)).toEqual({ approvals: 0, tasks: 1, task_events: 1, outbox: 1 });
    const saved = (
      await db.pool.query(
        'SELECT fire_at_utc, time_basis, display_version, source_invocation_id FROM tasks WHERE owner_id=$1',
        [ctx.ownerId],
      )
    ).rows[0];
    expect(saved.fire_at_utc.toISOString()).toBe(fireAt);
    expect(saved).toMatchObject({
      time_basis: basis,
      display_version: 'elapsed/1',
      source_invocation_id: binding.invocationId,
    });
  });
  it('uses UTC display for elapsed time without timezone rules', async () => {
    const ctx = await elapsedContext();
    ctx.timeContext = loadTimeContext(undefined);
    const { outcome } = await call(ctx, 'elapsed/no-rules', elapsedArgs);
    const fireAt = new Date(Date.parse(ctx.anchorReceivedAtUtc) + 180_000).toISOString();
    expect(outcome).toMatchObject({
      status: 'ok',
      result: {
        kind: 'task_created',
        fire_at_utc: fireAt,
        timezone_id: 'UTC',
        wall_time: fireAt.slice(0, 19).replace('T', ' '),
        fold: 0,
        resolved_utc_offset_seconds: 0,
        tzdb_version: null,
      },
    });
    expect(await counts(ctx)).toEqual({ approvals: 0, tasks: 1, task_events: 1, outbox: 1 });
  });
  it('does not silently replace an explicit timezone when rules are unavailable', async () => {
    const ctx = await elapsedContext();
    ctx.timeContext = loadTimeContext(undefined);
    expect(
      (await call(ctx, 'elapsed/explicit-zone', { ...elapsedArgs, timezone_hint: 'Asia/Shanghai' }))
        .outcome,
    ).toMatchObject({
      status: 'ok',
      result: { kind: 'time_error', error: { code: 'TZDB_UNAVAILABLE' } },
    });
    expect(await counts(ctx)).toEqual({ approvals: 0, tasks: 0, task_events: 0, outbox: 0 });
  });
  it('does not grant elapsed capability to an older frozen run', async () => {
    const ctx = await elapsedContext(60, false);
    expect((await call(ctx, 'elapsed/old', elapsedArgs)).outcome).toMatchObject({
      status: 'denied',
      error: { code: 'TOOL_FORBIDDEN' },
    });
    expect(await counts(ctx)).toEqual({ approvals: 0, tasks: 0, task_events: 0, outbox: 0 });
  });
  it('rejects a context anchor that differs from the frozen trusted anchor', async () => {
    const ctx = await elapsedContext();
    ctx.anchorReceivedAtUtc = new Date(Date.parse(ctx.anchorReceivedAtUtc) + 60_000)
      .toISOString()
      .replace('.000Z', 'Z');
    expect((await call(ctx, 'elapsed/anchor-forgery', elapsedArgs)).outcome).toMatchObject({
      status: 'denied',
      error: { code: 'TOOL_FORBIDDEN' },
    });
    expect(await counts(ctx)).toEqual({ approvals: 0, tasks: 0, task_events: 0, outbox: 0 });
  });
  it('does not accept forged source text or a caller-provided source message', async () => {
    const ctx = await elapsedContext();
    expect(
      (await call(ctx, 'elapsed/forged-text', { ...elapsedArgs, raw_time_text: '十分钟后' }))
        .outcome,
    ).toMatchObject({ status: 'ok', result: { kind: 'clarify', reason: 'DATE_SOURCE_UNCLEAR' } });
    expect(
      (
        await call(ctx, 'elapsed/forged-source', {
          ...elapsedArgs,
          source_message_id: randomUUID(),
        })
      ).outcome,
    ).toMatchObject({ status: 'denied', error: { code: 'TOOL_FORBIDDEN' } });
    expect(await counts(ctx)).toEqual({ approvals: 0, tasks: 0, task_events: 0, outbox: 0 });
  });
  it('does not create an elapsed reminder after its anchored target has passed', async () => {
    const ctx = await elapsedContext(-3600);
    expect((await call(ctx, 'elapsed/expired', elapsedArgs)).outcome).toMatchObject({
      status: 'ok',
      result: { kind: 'clarify', reason: 'FIRE_TIME_PASSED' },
    });
    expect(await counts(ctx)).toEqual({ approvals: 0, tasks: 0, task_events: 0, outbox: 0 });
  });
  it('creates without approval and concurrent replay preserves one immutable task, event, command and acceptance', async () => {
    const ctx = await fresh();
    const binding = await reserveToolInvocation(db.pool, ctx, {
      callKey: 'create/1',
      toolId: 'create_reminder',
      args,
    });
    const invoke = () => invokeTool(db.pool, ctx, { ...binding, toolId: 'create_reminder', args });
    const [outcome, concurrent] = await Promise.all([invoke(), invoke()]);
    expect([outcome.replayed, concurrent.replayed].sort()).toEqual([false, true]);
    expect({ ...concurrent, replayed: true }).toEqual({ ...outcome, replayed: true });
    expect(outcome).toMatchObject({
      status: 'ok',
      result: {
        kind: 'task_created',
        state: 'saved',
        timezone_id: 'Asia/Shanghai',
        wall_time: '2027-11-04 15:00',
      },
    });
    expect(await invoke()).toEqual({ ...outcome, replayed: true });
    expect(await counts(ctx)).toEqual({ approvals: 0, tasks: 1, task_events: 1, outbox: 1 });
    const row = (
      await db.pool.query(
        'SELECT source_approval_id,source_invocation_id FROM tasks WHERE owner_id=$1',
        [ctx.ownerId],
      )
    ).rows[0];
    expect(row).toEqual({ source_approval_id: null, source_invocation_id: binding.invocationId });
    expect(
      (
        await db.pool.query(
          "SELECT count(*)::int n FROM tool_calls WHERE invocation_id=$1 AND record_kind='accepted'",
          [binding.invocationId],
        )
      ).rows[0].n,
    ).toBe(1);
    await expect(
      reserveToolInvocation(db.pool, ctx, {
        callKey: 'create/1',
        toolId: 'create_reminder',
        args: { ...args, note: 'different' },
      }),
    ).rejects.toMatchObject({ errorCode: 'STATE_CONFLICT' });
    await call(ctx, 'create/2');
    expect(await counts(ctx)).toEqual({ approvals: 0, tasks: 2, task_events: 2, outbox: 2 });
  });
  for (const timeKind of ['wall', 'elapsed'] as const) {
    const reminderArgs = timeKind === 'elapsed' ? elapsedArgs : args;
    it(`denies unadmitted and disabled owners without creating or replaying ${timeKind} reminders`, async () => {
      const unadmitted = timeKind === 'elapsed' ? await elapsedContext() : await fresh();
      const unadmittedBinding = await reserveToolInvocation(db.pool, unadmitted, {
        callKey: 'unadmitted/1',
        toolId: 'create_reminder',
        args: reminderArgs,
      });
      await db.pool.query('DELETE FROM identity_account_admissions WHERE user_id=$1', [
        unadmitted.ownerId,
      ]);
      expect(
        await invokeTool(db.pool, unadmitted, {
          ...unadmittedBinding,
          toolId: 'create_reminder',
          args: reminderArgs,
        }),
      ).toMatchObject({ status: 'denied' });
      expect(await counts(unadmitted)).toEqual({
        approvals: 0,
        tasks: 0,
        task_events: 0,
        outbox: 0,
      });

      const disabled = timeKind === 'elapsed' ? await elapsedContext() : await fresh();
      const { binding, outcome } = await call(disabled, 'accepted/1', reminderArgs);
      expect(outcome).toMatchObject({ status: 'ok', result: { kind: 'task_created' } });
      const pending = await reserveToolInvocation(db.pool, disabled, {
        callKey: 'pending/1',
        toolId: 'create_reminder',
        args: reminderArgs,
      });
      await db.pool.query("UPDATE users SET status='disabled' WHERE id=$1", [disabled.ownerId]);
      expect(
        await invokeTool(db.pool, disabled, {
          ...binding,
          toolId: 'create_reminder',
          args: reminderArgs,
        }),
      ).toMatchObject({ status: 'denied' });
      expect(
        await invokeTool(db.pool, disabled, {
          ...pending,
          toolId: 'create_reminder',
          args: reminderArgs,
        }),
      ).toMatchObject({ status: 'denied' });
      const client = await db.pool.connect();
      try {
        await expectApplicationRejection(readRunCreatedReminders(client, disabled), {
          status: 403,
        });
        expect((await readRunInterruptionEvidence(client, disabled)).creations).toMatchObject([
          { invocation_id: binding.invocationId, kind: 'task_created' },
        ]);
      } finally {
        client.release();
      }
      expect(await counts(disabled)).toEqual({ approvals: 0, tasks: 1, task_events: 1, outbox: 1 });
    });
    it(`committed disable wins over a concurrent ${timeKind} reminder and leaves no creation facts`, async () => {
      const ctx = timeKind === 'elapsed' ? await elapsedContext() : await fresh();
      const binding = await reserveToolInvocation(db.pool, ctx, {
        callKey: 'disable-race/1',
        toolId: 'create_reminder',
        args: reminderArgs,
      });
      const disabler = await db.pool.connect();
      let pending: Promise<ToolOutcome> | undefined;
      try {
        await disabler.query('BEGIN');
        const pid = (await disabler.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))
          .rows[0]!.pid;
        await disabler.query("UPDATE users SET status='disabled' WHERE id=$1", [ctx.ownerId]);
        pending = invokeTool(db.pool, ctx, {
          ...binding,
          toolId: 'create_reminder',
          args: reminderArgs,
        });
        void pending.catch(() => {});
        const deadline = Date.now() + 5000;
        let blocked = false;
        while (Date.now() < deadline) {
          const result = await disabler.query(
            'SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))',
            [pid],
          );
          if (result.rowCount) {
            blocked = true;
            break;
          }
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
        expect(blocked).toBe(true);
        await disabler.query('COMMIT');
        expect(await pending).toMatchObject({ status: 'denied' });
        expect(await counts(ctx)).toEqual({ approvals: 0, tasks: 0, task_events: 0, outbox: 0 });
      } finally {
        await disabler.query('ROLLBACK');
        if (pending) await Promise.allSettled([pending]);
        disabler.release();
      }
    });
  }
  it('keeps settings-only frozen runs unable to create', async () => {
    const ctx = await fresh(['set_user_timezone']);
    expect((await call(ctx, 'create/1')).outcome).toMatchObject({ status: 'denied' });
    expect(await counts(ctx)).toEqual({ approvals: 0, tasks: 0, task_events: 0, outbox: 0 });
  });
  it('uses accepted same-run timezone over admission and explicit timezone over both without changing saved preference', async () => {
    const ctx = await fresh();
    expect(
      (await call(ctx, 'setting/1', { timezone_id: 'America/New_York' }, 'set_user_timezone'))
        .outcome,
    ).toMatchObject({
      status: 'ok',
      result: { kind: 'timezone_setting', timezone_id: 'America/New_York' },
    });
    expect((await call(ctx, 'create/default')).outcome).toMatchObject({
      status: 'ok',
      result: {
        kind: 'task_created',
        timezone_id: 'America/New_York',
        fire_at_utc: '2027-11-04T19:00:00.000Z',
      },
    });
    expect(
      (await call(ctx, 'create/explicit', { ...args, timezone_hint: 'Asia/Shanghai' })).outcome,
    ).toMatchObject({
      status: 'ok',
      result: {
        kind: 'task_created',
        timezone_id: 'Asia/Shanghai',
        fire_at_utc: '2027-11-04T07:00:00.000Z',
      },
    });
    expect(
      (await db.pool.query('SELECT timezone_id FROM users WHERE id=$1', [ctx.ownerId])).rows[0]
        .timezone_id,
    ).toBe('America/New_York');
  });
  it('does not replace an unknown explicit timezone with an accepted default', async () => {
    const ctx = await fresh();
    expect(
      (await call(ctx, 'create/unknown', { ...args, timezone_hint: 'Unknown/Test' })).outcome,
    ).toMatchObject({
      status: 'ok',
      result: { kind: 'time_error', error: { code: 'UNKNOWN_TIMEZONE' } },
    });
    expect(await counts(ctx)).toEqual({ approvals: 0, tasks: 0, task_events: 0, outbox: 0 });
    expect(
      (await db.pool.query('SELECT timezone_id FROM users WHERE id=$1', [ctx.ownerId])).rows[0]
        .timezone_id,
    ).toBe('Asia/Shanghai');
  });
  for (const stage of ['acceptance', 'audit']) {
    it(`rolls back all creation facts when ${stage} fails and retries the original reservation`, async () => {
      const ctx = await fresh();
      const binding = await reserveToolInvocation(db.pool, ctx, {
        callKey: 'atomic/1',
        toolId: 'create_reminder',
        args,
      });
      await db.pool
        .query(`CREATE FUNCTION fail_direct_${stage}() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'direct creation acceptance fault'; END $$`);
      await db.pool.query(
        stage === 'acceptance'
          ? `CREATE TRIGGER fail_direct_acceptance BEFORE UPDATE OF accepted_result ON tool_invocations FOR EACH ROW EXECUTE FUNCTION fail_direct_acceptance()`
          : `CREATE TRIGGER fail_direct_audit BEFORE INSERT ON tool_calls FOR EACH ROW WHEN (NEW.record_kind='accepted') EXECUTE FUNCTION fail_direct_audit()`,
      );
      try {
        await expect(
          invokeTool(db.pool, ctx, { ...binding, toolId: 'create_reminder', args }),
        ).rejects.toThrow('direct creation acceptance fault');
        expect(await counts(ctx)).toEqual({ approvals: 0, tasks: 0, task_events: 0, outbox: 0 });
        expect(
          (
            await db.pool.query(
              'SELECT state,accepted_result FROM tool_invocations WHERE invocation_id=$1',
              [binding.invocationId],
            )
          ).rows[0],
        ).toEqual({ state: 'reserved', accepted_result: null });
      } finally {
        await db.pool.query(
          `DROP TRIGGER fail_direct_${stage} ON ${stage === 'acceptance' ? 'tool_invocations' : 'tool_calls'}`,
        );
        await db.pool.query(`DROP FUNCTION fail_direct_${stage}()`);
      }
      expect(
        await invokeTool(db.pool, ctx, { ...binding, toolId: 'create_reminder', args }),
      ).toMatchObject({ status: 'ok', result: { kind: 'task_created' } });
      expect(await counts(ctx)).toEqual({ approvals: 0, tasks: 1, task_events: 1, outbox: 1 });
    });
  }
  it('refuses receipt hydration that differs from the real frozen task without changing persisted facts', async () => {
    const ctx = await fresh();
    const { binding } = await call(ctx, 'creation/1');
    const row = (
      await db.pool.query('SELECT * FROM tool_invocations WHERE invocation_id=$1', [
        binding.invocationId,
      ])
    ).rows[0];
    row.accepted_result.result.wall_time = '2027-11-05 15:00';
    const client = await db.pool.connect();
    try {
      await expect(readAcceptedInvocationResult(client, ctx, row)).rejects.toMatchObject({
        errorCode: 'STATE_CONFLICT',
      });
    } finally {
      client.release();
    }
    expect(await counts(ctx)).toEqual({ approvals: 0, tasks: 1, task_events: 1, outbox: 1 });
    expect(
      (await db.pool.query('SELECT wall_time FROM tasks WHERE owner_id=$1', [ctx.ownerId])).rows[0]
        .wall_time,
    ).toBe('2027-11-04 15:00');
  });
});
