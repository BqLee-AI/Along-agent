import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { startConversationRun } from '../../src/modules/conversations/service.js';
import { confirmApproval } from '../../src/modules/approvals/confirm.js';
import { invokeTool, reserveToolInvocation } from '../../src/modules/tools/gateway.js';
import type { ToolContext, ToolOutcome } from '../../src/modules/tools/contracts.js';
import { loadTimeContext } from '../../src/modules/time/context.js';
import { createIntegrationDatabase, databaseUrl, type IntegrationDatabase } from './setup.js';

const maybe = databaseUrl ? describe : describe.skip;
const tools = [
  'propose_task',
  'request_cancel_task',
  'list_tasks',
  'read_brief_cards',
  'get_user_prefs',
];
const args = { raw_time_text: '2026-11-02 09:20', note: '喝水', occurrence: 'once' };

function approvalOf(outcome: ToolOutcome) {
  if (outcome.status !== 'ok' || outcome.result.kind !== 'approval') {
    throw new Error('expected an accepted approval');
  }
  return outcome.result.approval;
}

maybe('persistent tool invocation identity and local results', () => {
  let database: IntegrationDatabase;
  let pool: Pool;
  beforeAll(async () => {
    database = await createIntegrationDatabase();
    pool = database.pool;
  });
  afterAll(async () => {
    await database?.close();
  });

  async function fresh(): Promise<ToolContext> {
    const ownerId = randomUUID();
    await pool.query(
      'INSERT INTO users (id,auth_email,display_name,timezone_id) VALUES ($1,$2,$3,$4)',
      [ownerId, `${ownerId}@fixture.test`, 'tester', 'Asia/Shanghai'],
    );
    const started = await startConversationRun(
      { pool, timeContext: loadTimeContext('fixture-v1') },
      ownerId,
      randomUUID(),
      { raw_text: '你好', confirmed_timezone: 'Asia/Shanghai' },
      randomUUID(),
    );
    if (!started.context) throw new Error('expected a fresh run');
    return { ...started.context, allowlist: tools };
  }

  async function reserve(
    ctx: ToolContext,
    callKey = 'action/1',
    toolId = 'propose_task',
    input: unknown = args,
  ) {
    const { invocationId } = await reserveToolInvocation(pool, ctx, {
      callKey,
      toolId,
      args: input,
    });
    return { invocationId, toolId, args: input };
  }

  async function effects(ownerId: string) {
    const counts: Record<string, number> = {};
    for (const table of [
      'approvals',
      'tool_calls',
      'tasks',
      'task_events',
      'outbox',
      'notifications',
    ]) {
      counts[table] = (
        await pool.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM ${table} WHERE owner_id=$1`,
          [ownerId],
        )
      ).rows[0]!.n;
    }
    return counts;
  }

  for (const target of ['audit', 'result'] as const) {
    it(`${target} persistence fault rolls back the approval and can retry the same reservation`, async () => {
      const ctx = await fresh();
      const input = await reserve(ctx);
      const table = target === 'audit' ? 'tool_calls' : 'tool_invocations';
      const event = target === 'audit' ? 'INSERT' : 'UPDATE';
      const fn = `fail_${target}_${ctx.ownerId.replaceAll('-', '')}`;
      await pool.query(`
        CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'fixture persistence fault'; END $$;
        CREATE TRIGGER ${fn} BEFORE ${event} ON ${table}
        FOR EACH ROW WHEN (NEW.owner_id='${ctx.ownerId}'::uuid) EXECUTE FUNCTION ${fn}();
      `);
      try {
        await expect(invokeTool(pool, ctx, input)).rejects.toMatchObject({ code: 'P0001' });
        expect(await effects(ctx.ownerId)).toEqual({
          approvals: 0,
          tool_calls: 0,
          tasks: 0,
          task_events: 0,
          outbox: 0,
          notifications: 0,
        });
        const { rows } = await pool.query(
          'SELECT state FROM tool_invocations WHERE invocation_id=$1',
          [input.invocationId],
        );
        expect(rows[0]).toEqual({ state: 'reserved' });
      } finally {
        await pool.query(`DROP TRIGGER ${fn} ON ${table}; DROP FUNCTION ${fn}();`);
      }
      const first = await invokeTool(pool, ctx, input);
      expect(first.replayed).toBe(false);
      const replay = await invokeTool(pool, { ...ctx, requestId: randomUUID() }, input);
      expect(replay).toEqual({ ...first, replayed: true });
      expect((await effects(ctx.ownerId)).approvals).toBe(1);
      expect((await effects(ctx.ownerId)).tasks).toBe(0);
    });
  }

  it('two connections reserve and invoke one logical call once; equal args in a new slot are a new action', async () => {
    const ctx = await fresh();
    const left = database.connect();
    const right = database.connect();
    try {
      const request = { callKey: 'concurrent/1', toolId: 'propose_task', args };
      const [a, b] = await Promise.all([
        reserveToolInvocation(left, ctx, request),
        reserveToolInvocation(right, { ...ctx, requestId: randomUUID() }, request),
      ]);
      expect(a.invocationId).toBe(b.invocationId);
      const input = { invocationId: a.invocationId, toolId: request.toolId, args };
      const [first, second] = await Promise.all([
        invokeTool(left, ctx, input),
        invokeTool(right, ctx, input),
      ]);
      expect(approvalOf(first)).toEqual(approvalOf(second));
      expect([first.replayed, second.replayed].sort()).toEqual([false, true]);
      expect((await effects(ctx.ownerId)).approvals).toBe(1);
      const next = await reserve(ctx, 'concurrent/2');
      expect(next.invocationId).not.toBe(a.invocationId);
      expect(approvalOf(await invokeTool(pool, ctx, next)).approvalId).not.toBe(
        approvalOf(first).approvalId,
      );
      expect((await effects(ctx.ownerId)).approvals).toBe(2);
    } finally {
      await left.end();
      await right.end();
    }
  });

  it('canonical object order preserves identity while changed content, tool and explicit defaults conflict', async () => {
    const ctx = await fresh();
    const input = await reserve(ctx);
    const same = await reserve(ctx, 'action/1', 'propose_task', {
      note: args.note,
      occurrence: args.occurrence,
      raw_time_text: args.raw_time_text,
    });
    expect(same.invocationId).toBe(input.invocationId);
    await expect(
      reserve(ctx, 'action/1', 'propose_task', { ...args, note: '不同动作' }),
    ).rejects.toMatchObject({ errorCode: 'STATE_CONFLICT' });
    expect(
      await invokeTool(pool, ctx, { ...input, args: { ...args, note: '不同动作' } }),
    ).toMatchObject({ status: 'denied', error: { code: 'STATE_CONFLICT' } });
    expect(await invokeTool(pool, ctx, { ...input, toolId: 'list_tasks' })).toMatchObject({
      status: 'denied',
      error: { code: 'STATE_CONFLICT' },
    });
    const defaults = await reserve(ctx, 'defaults/1', 'list_tasks', {});
    expect(await invokeTool(pool, ctx, { ...defaults, args: { limit: 20 } })).toMatchObject({
      status: 'denied',
      error: { code: 'STATE_CONFLICT' },
    });
    expect((await effects(ctx.ownerId)).approvals).toBe(0);
  });

  it('a process killed after accepting a local result loses its answer, not the result or approval', async () => {
    const ctx = await fresh();
    const input = await reserve(ctx);
    const ready = Promise.withResolvers<void>();
    const child = Bun.spawn(
      [
        process.execPath,
        fileURLToPath(new URL('./fixtures/tool-local-answer-loss.ts', import.meta.url)),
        JSON.stringify({ ctx, input }),
      ],
      {
        env: { ...process.env, DATABASE_URL: database.connectionString },
        stdout: 'ignore',
        stderr: 'inherit',
        ipc(message) {
          if (message === 'accepted-without-answer') ready.resolve();
        },
      },
    );
    child.exited.then(() => ready.reject(new Error('local child exited before accepting result')));
    try {
      await ready.promise;
    } finally {
      child.kill('SIGKILL');
      await child.exited;
    }
    const reopened = database.connect();
    try {
      const result = await invokeTool(reopened, { ...ctx, requestId: randomUUID() }, input);
      expect(result.replayed).toBe(true);
      const approval = approvalOf(result);
      expect((await effects(ctx.ownerId)).approvals).toBe(1);
      const { rows } = await pool.query(
        'SELECT approval_id FROM tool_invocations WHERE invocation_id=$1',
        [input.invocationId],
      );
      expect(rows[0]?.approval_id).toBe(approval.approvalId);
    } finally {
      await reopened.end();
    }
  }, 15000);

  it('first reservation freezes temporal context; accepted results survive unavailable rules and terminal approval state', async () => {
    const ctx = await fresh();
    const input = await reserve(ctx, 'freeze/1', 'propose_task', {
      ...args,
      raw_time_text: '明天 9:20',
    });
    const first = await invokeTool(
      pool,
      { ...ctx, receivedAtUtc: '2026-12-25T01:00:00Z', confirmedTimezone: 'Europe/Paris' },
      input,
    );
    const approval = approvalOf(first);
    expect(approval.timezoneId).toBe('Asia/Shanghai');
    const nextDay = new Date(Date.parse(ctx.anchorReceivedAtUtc) + 24 * 3600_000 + 8 * 3600_000)
      .toISOString()
      .slice(0, 10);
    expect(approval.wallTime).toBe(`${nextDay} 09:20`);
    for (const state of ['consumed', 'rejected', 'expired', 'superseded']) {
      await pool.query('UPDATE approvals SET state=$2 WHERE id=$1', [approval.approvalId, state]);
      const replay = await invokeTool(
        pool,
        { ...ctx, timeContext: loadTimeContext(undefined) },
        input,
      );
      expect(replay).toEqual({ ...first, replayed: true });
    }
    expect((await effects(ctx.ownerId)).approvals).toBe(1);
    const { rows } = await pool.query(
      'SELECT accepted_result,approval_id FROM tool_invocations WHERE invocation_id=$1',
      [input.invocationId],
    );
    expect(rows[0]?.approval_id).toBe(approval.approvalId);
    expect(JSON.stringify(rows[0]?.accepted_result)).not.toContain(args.note);
  });

  it('current permission can hide an accepted result without replacing it, and an original denial never upgrades', async () => {
    const ctx = await fresh();
    const input = await reserve(ctx);
    const first = await invokeTool(pool, ctx, input);
    const blocked = { ...ctx, allowlist: [] };
    expect((await invokeTool(pool, blocked, input)).status).toBe('denied');
    expect(await invokeTool(pool, ctx, input)).toEqual({ ...first, replayed: true });
    const deniedInput = await reserve(ctx, 'denied/1');
    const denied = await invokeTool(pool, blocked, deniedInput);
    expect(denied.status).toBe('denied');
    expect(await invokeTool(pool, ctx, deniedInput)).toEqual({ ...denied, replayed: true });
    expect((await effects(ctx.ownerId)).approvals).toBe(1);
  });

  it('owner, conversation, Run and attempt association are checked before history or effects', async () => {
    const ctx = await fresh();
    const other = await fresh();
    const input = await reserve(ctx);
    await invokeTool(pool, ctx, input);
    for (const [stolen, errorCode] of [
      [other, 'NOT_FOUND'],
      [{ ...ctx, ownerId: other.ownerId }, 'FORBIDDEN'],
      [{ ...ctx, runId: other.runId }, 'FORBIDDEN'],
      [{ ...ctx, conversationId: other.conversationId }, 'FORBIDDEN'],
      [{ ...ctx, attemptId: other.attemptId }, 'FORBIDDEN'],
    ] as const) {
      await expect(invokeTool(pool, stolen, input)).rejects.toMatchObject({ errorCode });
    }
    expect((await effects(ctx.ownerId)).approvals).toBe(1);
    expect((await effects(other.ownerId)).approvals).toBe(0);
  });

  it('valid later attempts retain identity, while fenced attempts and cancelled Runs cannot begin new effects', async () => {
    const ctx = await fresh();
    const input = await reserve(ctx);
    const nextAttempt = randomUUID();
    await pool.query("UPDATE run_attempts SET status='fenced_out' WHERE id=$1", [ctx.attemptId]);
    await pool.query(
      "INSERT INTO run_attempts(id,owner_id,run_id,attempt_no,status) VALUES($1,$2,$3,2,'running')",
      [nextAttempt, ctx.ownerId, ctx.runId],
    );
    expect(await invokeTool(pool, ctx, input)).toMatchObject({
      status: 'denied',
      error: { code: 'TOOL_FORBIDDEN' },
    });
    const current = { ...ctx, attemptId: nextAttempt, requestId: randomUUID() };
    expect(
      (
        await reserveToolInvocation(pool, current, {
          callKey: 'action/1',
          toolId: 'propose_task',
          args,
        })
      ).invocationId,
    ).toBe(input.invocationId);
    const first = await invokeTool(pool, current, input);
    const pending = await reserve(current, 'after-cancel/1');
    await pool.query("UPDATE agent_runs SET status='cancelled' WHERE id=$1", [ctx.runId]);
    expect(await invokeTool(pool, current, pending)).toMatchObject({
      status: 'denied',
      error: { code: 'TOOL_FORBIDDEN' },
    });
    expect(await invokeTool(pool, current, input)).toEqual({ ...first, replayed: true });
    expect((await effects(ctx.ownerId)).approvals).toBe(1);
  });

  it('read-only outputs are accepted snapshots, and a new reference sees changed source data', async () => {
    const ctx = await fresh();
    const prefs = await reserve(ctx, 'prefs/1', 'get_user_prefs', {});
    const firstPrefs = await invokeTool(pool, ctx, prefs);
    await pool.query("UPDATE users SET timezone_id='Europe/Paris' WHERE id=$1", [ctx.ownerId]);
    expect(await invokeTool(pool, ctx, prefs)).toEqual({ ...firstPrefs, replayed: true });
    const nextPrefs = await invokeTool(
      pool,
      ctx,
      await reserve(ctx, 'prefs/2', 'get_user_prefs', {}),
    );
    expect(nextPrefs).toMatchObject({
      status: 'ok',
      result: { kind: 'prefs', timezone_id: 'Europe/Paris' },
    });
    const invalid = await invokeTool(
      pool,
      ctx,
      await reserve(ctx, 'prefs/invalid', 'get_user_prefs', { owner_id: ctx.ownerId }),
    );
    expect(invalid.status).toBe('denied');
    const list = await reserve(ctx, 'list/1', 'list_tasks', {});
    const brief = await reserve(ctx, 'brief/1', 'read_brief_cards', { date: '2026-11-02' });
    const firstList = await invokeTool(pool, ctx, list);
    const firstBrief = await invokeTool(pool, ctx, brief);
    await pool.query(
      `INSERT INTO tasks(id,owner_id,original_note,fire_at_utc,wall_time,timezone_id,fold,resolved_utc_offset_seconds,tzdb_version,occurrence,state,state_version)
      VALUES($1,$2,'新提醒','2026-11-02T01:20:00Z','2026-11-02 09:20','Asia/Shanghai',0,28800,'fixture-v1','once','saved',1)`,
      [randomUUID(), ctx.ownerId],
    );
    expect(await invokeTool(pool, ctx, list)).toEqual({ ...firstList, replayed: true });
    expect(await invokeTool(pool, ctx, brief)).toEqual({ ...firstBrief, replayed: true });
    const latest = await invokeTool(pool, ctx, await reserve(ctx, 'list/2', 'list_tasks', {}));
    expect(latest).toMatchObject({
      status: 'ok',
      result: { kind: 'list_tasks', tasks: [{ note_preview: '新提醒' }] },
    });
    const latestBrief = await invokeTool(
      pool,
      ctx,
      await reserve(ctx, 'brief/2', 'read_brief_cards', { date: '2026-11-02' }),
    );
    expect(latestBrief).toMatchObject({
      status: 'ok',
      result: { kind: 'brief', cards: [{ title: '新提醒' }] },
    });
  });

  it('an empty active list does not hide terminal tasks from explicit history queries', async () => {
    const ctx = await fresh();
    const terminal = ['fired', 'missed', 'cancelled'] as const;
    const ids = terminal.map(() => randomUUID());
    for (const [index, state] of terminal.entries()) {
      await pool.query(
        `INSERT INTO tasks(id,owner_id,original_note,fire_at_utc,wall_time,timezone_id,fold,resolved_utc_offset_seconds,tzdb_version,occurrence,state,state_version)
         VALUES($1,$2,'已结束的提醒','2026-11-01T08:40:00Z','2026-11-01 16:40','Asia/Shanghai',0,28800,'fixture-v1','once',$3,1)`,
        [ids[index], ctx.ownerId, state],
      );
    }
    const active = await invokeTool(pool, ctx, await reserve(ctx, 'active/1', 'list_tasks', {}));
    expect(active).toMatchObject({
      status: 'ok',
      result: { kind: 'list_tasks', tasks: [], has_more: false },
    });
    for (const [index, state] of terminal.entries()) {
      const history = await invokeTool(
        pool,
        ctx,
        await reserve(ctx, `history/${state}`, 'list_tasks', { state }),
      );
      expect(history).toMatchObject({
        status: 'ok',
        result: { kind: 'list_tasks', tasks: [{ task_id: ids[index], state }], has_more: false },
      });
    }
  });

  it('different cancellation calls retain the existing pending approval reuse rule', async () => {
    const ctx = await fresh();
    const first = await invokeTool(pool, ctx, await reserve(ctx));
    if (first.status !== 'ok' || first.result.kind !== 'approval')
      throw new Error('expected proposal');
    const created = await confirmApproval({ pool }, ctx.ownerId, first.result.approval.approvalId, {
      presentation_hash: first.result.approval.presentationHash,
      seen_content: first.result.echo_text,
      idempotency_key: randomUUID(),
    });
    const cancelArgs = { task_id: created.task_id, reason_text: '取消提醒' };
    const a = await reserve(ctx, 'cancel/1', 'request_cancel_task', cancelArgs);
    const b = await reserve(ctx, 'cancel/2', 'request_cancel_task', cancelArgs);
    expect(a.invocationId).not.toBe(b.invocationId);
    const firstCancel = await invokeTool(pool, ctx, a);
    const secondCancel = await invokeTool(pool, ctx, b);
    expect(approvalOf(secondCancel)).toEqual(approvalOf(firstCancel));
    expect((await effects(ctx.ownerId)).approvals).toBe(2);
    const { rows } = await pool.query(
      'SELECT approval_id FROM tool_invocations WHERE invocation_id=ANY($1::uuid[])',
      [[a.invocationId, b.invocationId]],
    );
    expect(rows.map((row) => row.approval_id)).toEqual([
      approvalOf(firstCancel).approvalId,
      approvalOf(firstCancel).approvalId,
    ]);
  });

  it('clarification and typed time failures replay their original structures rather than rerun normalization', async () => {
    const ctx = await fresh();
    for (const [callKey, raw_time_text, timezone_hint, kind] of [
      ['clarify/1', '11月2日 9:20', 'Asia/Shanghai', 'clarify'],
      ['typed/1', '2026-11-01 01:30', 'America/New_York', 'time_error'],
    ]) {
      const input = await reserve(ctx, callKey, 'propose_task', {
        ...args,
        raw_time_text,
        timezone_hint,
      });
      const first = await invokeTool(pool, ctx, input);
      expect(first).toMatchObject({ status: 'ok', result: { kind } });
      expect(await invokeTool(pool, ctx, input)).toEqual({ ...first, replayed: true });
    }
    expect((await effects(ctx.ownerId)).approvals).toBe(0);
  });
});
