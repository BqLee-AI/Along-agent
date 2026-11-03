import { readAcceptedInvocationResult } from '../../src/modules/tools/accepted-result.js';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { invokeTool, reserveToolInvocation } from '../../src/modules/tools/gateway.js';
import type { ToolContext } from '../../src/modules/tools/contracts.js';
import { loadTimeContext } from '../../src/modules/time/context.js';
import { createIntegrationDatabase, type IntegrationDatabase } from './setup.js';

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
  ): Promise<ToolContext> {
    const ownerId = randomUUID(),
      conversationId = randomUUID(),
      runId = randomUUID(),
      attemptId = randomUUID(),
      messageId = randomUUID();
    await db.pool.query(
      "INSERT INTO users(id,auth_email,display_name,timezone_id) VALUES($1,$2,'reminder tester','Asia/Shanghai')",
      [ownerId, `${ownerId}@reminder.test`],
    );
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
      anchorReceivedAtUtc: '2027-11-03T00:00:00Z',
      receivedAtUtc: '2027-11-03T00:00:00Z',
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
