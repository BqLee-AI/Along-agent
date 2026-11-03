import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { invokeTool, reserveToolInvocation } from '../../src/modules/tools/gateway.js';
import type { ToolContext } from '../../src/modules/tools/contracts.js';
import * as toolQuery from '../../src/modules/tools/query.js';
import { loadTimeContext } from '../../src/modules/time/context.js';
import { createIntegrationDatabase, databaseUrl, type IntegrationDatabase } from './setup.js';

const maybe = databaseUrl ? describe : describe.skip;
const delegationTools = [
  'get_user_prefs',
  'set_user_timezone',
  'list_tasks',
  'read_brief_cards',
  'read_run_observation',
];

maybe('delegation personal timezone transactions', () => {
  let database: IntegrationDatabase;
  let pool: Pool;
  beforeAll(async () => {
    database = await createIntegrationDatabase();
    pool = database.pool;
  });
  afterAll(async () => {
    await database?.close();
  });

  async function fresh(delegation = true): Promise<ToolContext> {
    const ownerId = randomUUID();
    const conversationId = randomUUID();
    const runId = randomUUID();
    const attemptId = randomUUID();
    const messageId = randomUUID();
    await pool.query(
      "INSERT INTO users(id,auth_email,display_name,timezone_id) VALUES($1,$2,'timezone tester','Asia/Shanghai')",
      [ownerId, `${ownerId}@timezone.test`],
    );
    await pool.query('INSERT INTO conversations(id,owner_id) VALUES($1,$2)', [
      conversationId,
      ownerId,
    ]);
    await pool.query(
      "INSERT INTO messages(id,owner_id,conversation_id,role,content) VALUES($1,$2,$3,'user','记住我的时区')",
      [messageId, ownerId, conversationId],
    );
    const frozen = delegation
      ? { authorization_revision: 'delegation/1', execution_lifecycle: 'request-bound' }
      : {};
    await pool.query(
      `INSERT INTO agent_runs(id,owner_id,conversation_id,agent_revision,mode,
        budget_max_iterations,budget_max_tokens,execution,tools_allowlist,frozen_context,input_message_id)
       VALUES($1,$2,$3,'timezone-test','chat',16,4096,'harness',$4::jsonb,$5::jsonb,$6)`,
      [
        runId,
        ownerId,
        conversationId,
        JSON.stringify(delegation ? delegationTools : ['get_user_prefs']),
        JSON.stringify(frozen),
        messageId,
      ],
    );
    await pool.query('INSERT INTO run_attempts(id,owner_id,run_id,attempt_no) VALUES($1,$2,$3,1)', [
      attemptId,
      ownerId,
      runId,
    ]);
    return {
      ownerId,
      conversationId,
      runId,
      attemptId,
      requestId: randomUUID(),
      allowlist: delegation ? delegationTools : ['get_user_prefs'],
      confirmedTimezone: 'Asia/Shanghai',
      anchorReceivedAtUtc: '2026-11-02T00:00:00Z',
      receivedAtUtc: '2026-11-02T00:00:00Z',
      foldChoice: 'none',
      timeContext: loadTimeContext('fixture-v1'),
      ...(delegation ? { authorizationRevision: 'delegation/1' as const } : {}),
    };
  }

  async function reserve(
    ctx: ToolContext,
    callKey: string,
    args: unknown,
    toolId = 'set_user_timezone',
  ) {
    return { ...(await reserveToolInvocation(pool, ctx, { callKey, toolId, args })), toolId, args };
  }
  async function timezone(ctx: ToolContext) {
    return (await pool.query('SELECT timezone_id FROM users WHERE id=$1', [ctx.ownerId])).rows[0]
      ?.timezone_id;
  }
  async function counts(ctx: ToolContext) {
    const result: Record<string, number> = {};
    for (const table of ['approvals', 'tasks', 'task_events', 'outbox', 'notifications']) {
      result[table] = (
        await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE owner_id=$1`, [ctx.ownerId])
      ).rows[0]!.n;
    }
    return result;
  }

  it('saves a supported alias directly, freezes replay across connections and preserves a later setting', async () => {
    const ctx = await fresh();
    const input = await reserve(ctx, 'timezone/1', { timezone_id: '纽约时间' });
    const first = await invokeTool(pool, ctx, input);
    expect(first).toMatchObject({
      status: 'ok',
      replayed: false,
      result: {
        kind: 'timezone_setting',
        timezone_id: 'America/New_York',
        previous_timezone_id: 'Asia/Shanghai',
        alias_version: 'ALIAS_TABLE_V1',
      },
    });
    expect(await timezone(ctx)).toBe('America/New_York');
    const next = await reserve(ctx, 'timezone/2', { timezone_id: 'Asia/Shanghai' });
    await invokeTool(pool, ctx, next);
    const reopened = database.connect();
    try {
      expect(
        await invokeTool(
          reopened,
          { ...ctx, requestId: randomUUID(), timeContext: loadTimeContext(undefined) },
          input,
        ),
      ).toEqual({ ...first, replayed: true });
    } finally {
      await reopened.end();
    }
    expect(await timezone(ctx)).toBe('Asia/Shanghai');
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM tool_calls WHERE invocation_id=$1 AND record_kind='accepted'",
          [input.invocationId],
        )
      ).rows[0]!.n,
    ).toBe(1);
    expect(await counts(ctx)).toEqual({
      approvals: 0,
      tasks: 0,
      task_events: 0,
      outbox: 0,
      notifications: 0,
    });
  });

  it('stable reservation reuses its id while same key or invocation with different arguments conflicts', async () => {
    const ctx = await fresh();
    const input = await reserve(ctx, 'timezone/1', { timezone_id: 'America/New_York' });
    expect((await reserve(ctx, 'timezone/1', input.args)).invocationId).toBe(input.invocationId);
    await expect(reserve(ctx, 'timezone/1', { timezone_id: null })).rejects.toMatchObject({
      errorCode: 'STATE_CONFLICT',
    });
    expect(await invokeTool(pool, ctx, { ...input, args: { timezone_id: null } })).toMatchObject({
      status: 'denied',
      error: { code: 'STATE_CONFLICT' },
    });
    expect(await timezone(ctx)).toBe('Asia/Shanghai');
    expect(await invokeTool(pool, ctx, input)).toMatchObject({
      status: 'ok',
      result: { timezone_id: 'America/New_York' },
    });
  });

  it('clears to real null and exposes both accepted same-run settings through the public fact query', async () => {
    const ctx = await fresh();
    const save = await reserve(ctx, 'timezone/1', { timezone_id: 'America/New_York' });
    await invokeTool(pool, ctx, save);
    const clear = await reserve(ctx, 'timezone/2', { timezone_id: null });
    const outcome = await invokeTool(pool, ctx, clear);
    expect(outcome).toMatchObject({
      status: 'ok',
      result: {
        kind: 'timezone_setting',
        timezone_id: null,
        previous_timezone_id: 'America/New_York',
        alias_version: 'ALIAS_TABLE_V1',
      },
    });
    expect(await timezone(ctx)).toBeNull();
    const prefs = await reserve(ctx, 'prefs/1', {}, 'get_user_prefs');
    expect(await invokeTool(pool, ctx, prefs)).toMatchObject({
      status: 'ok',
      result: { kind: 'prefs', timezone_id: null },
    });
    const client = await pool.connect();
    try {
      const facts = await toolQuery.readRunTimezoneSettings(client, ctx);
      expect(facts).toEqual([
        {
          invocation_id: save.invocationId,
          timezone_id: 'America/New_York',
          previous_timezone_id: 'Asia/Shanghai',
          alias_version: 'ALIAS_TABLE_V1',
        },
        {
          invocation_id: clear.invocationId,
          timezone_id: null,
          previous_timezone_id: 'America/New_York',
          alias_version: 'ALIAS_TABLE_V1',
        },
      ]);
      await expect(
        toolQuery.readRunTimezoneSettings(client, { ...ctx, ownerId: randomUUID() }),
      ).rejects.toMatchObject({ httpStatus: 403 });
    } finally {
      client.release();
    }
    expect(await invokeTool(pool, ctx, clear)).toEqual({ ...outcome, replayed: true });
  });

  it('unavailable rules cannot save an unverified zone but do not prevent explicit clearing', async () => {
    const ctx = { ...(await fresh()), timeContext: loadTimeContext(undefined) };
    const save = await reserve(ctx, 'unavailable/1', { timezone_id: 'Asia/Shanghai' });
    expect(await invokeTool(pool, ctx, save)).toMatchObject({
      status: 'denied',
      error: { code: 'TZDB_UNAVAILABLE' },
    });
    expect(await timezone(ctx)).toBe('Asia/Shanghai');
    const clear = await reserve(ctx, 'unavailable/2', { timezone_id: null });
    expect(await invokeTool(pool, ctx, clear)).toMatchObject({
      status: 'ok',
      result: {
        kind: 'timezone_setting',
        timezone_id: null,
        previous_timezone_id: 'Asia/Shanghai',
        alias_version: 'unavailable',
      },
    });
    expect(await timezone(ctx)).toBeNull();
  });

  for (const args of [
    { timezone_id: 'Europe/Paris' },
    { timezone_id: 'UTC' },
    { timezone_id: '' },
    { timezone_id: '__proto__' },
    { timezone_id: 'constructor' },
    { timezone_id: 'Asia/Shanghai', owner_id: randomUUID() },
    { timezone_id: 'Asia/Shanghai', ownerId: randomUUID() },
    { timezone_id: 'America/New_York', display_name: 'injected' },
    { timezone_id: 'America/New_York', authorization_revision: 'delegation/1' },
    {},
    { timezone_id: 123 },
  ]) {
    it(`rejects unsupported timezone or extra account fields: ${JSON.stringify(args)}`, async () => {
      const ctx = await fresh();
      const input = await reserve(ctx, 'invalid/1', args);
      const outcome = await invokeTool(pool, ctx, input);
      expect(outcome.status).toBe('denied');
      expect(await invokeTool(pool, ctx, input)).toEqual({ ...outcome, replayed: true });
      expect(await timezone(ctx)).toBe('Asia/Shanghai');
      expect((await counts(ctx)).approvals).toBe(0);
    });
  }

  it('does not grant legacy runs a new tool or accept a caller-spoofed delegation revision', async () => {
    const legacy = await fresh(false);
    const input = await reserve(legacy, 'legacy/1', { timezone_id: null });
    expect(await invokeTool(pool, legacy, input)).toMatchObject({ status: 'denied' });
    expect(await timezone(legacy)).toBe('Asia/Shanghai');
    const spoofed = { ...legacy, authorizationRevision: 'delegation/1' as const };
    await expect(reserve(spoofed, 'spoof/1', { timezone_id: null })).rejects.toMatchObject({
      httpStatus: 403,
    });
    await expect(invokeTool(pool, spoofed, input)).rejects.toMatchObject({ httpStatus: 403 });
    expect(await timezone(legacy)).toBe('Asia/Shanghai');
  });

  it('cannot drop the frozen revision or execute after cancellation or account disablement', async () => {
    const ctx = await fresh();
    const input = await reserve(ctx, 'timezone/1', { timezone_id: null });
    const downgraded = { ...ctx, authorizationRevision: undefined };
    await expect(invokeTool(pool, downgraded, input)).rejects.toMatchObject({ httpStatus: 403 });
    await pool.query("UPDATE users SET status='disabled' WHERE id=$1", [ctx.ownerId]);
    expect(await invokeTool(pool, ctx, input)).toMatchObject({ status: 'denied' });
    expect(await timezone(ctx)).toBe('Asia/Shanghai');
    const cancelled = await fresh();
    const waiting = await reserve(cancelled, 'timezone/1', { timezone_id: null });
    await pool.query(
      "UPDATE agent_runs SET status='cancelled',ended_at=clock_timestamp() WHERE id=$1",
      [cancelled.runId],
    );
    expect(await invokeTool(pool, cancelled, waiting)).toMatchObject({ status: 'denied' });
    expect(await timezone(cancelled)).toBe('Asia/Shanghai');
  });

  for (const target of ['domain', 'result', 'audit'] as const) {
    it(`${target} failure rolls back preference, accepted result and audit; same reservation remains executable`, async () => {
      const ctx = await fresh();
      const input = await reserve(ctx, 'timezone/1', { timezone_id: 'America/New_York' });
      const table =
        target === 'domain' ? 'users' : target === 'result' ? 'tool_invocations' : 'tool_calls';
      const event = target === 'audit' ? 'INSERT' : 'UPDATE';
      const ownerColumn = target === 'domain' ? 'id' : 'owner_id';
      const name = `timezone_fault_${randomUUID().replaceAll('-', '')}`;
      await pool.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'timezone fixture fault'; END $$;
        CREATE TRIGGER ${name} BEFORE ${event} ON ${table} FOR EACH ROW
        WHEN (NEW.${ownerColumn}='${ctx.ownerId}'::uuid) EXECUTE FUNCTION ${name}();`);
      try {
        await expect(invokeTool(pool, ctx, input)).rejects.toMatchObject({ code: 'P0001' });
        expect(await timezone(ctx)).toBe('Asia/Shanghai');
        expect(
          (
            await pool.query(
              'SELECT state,accepted_result FROM tool_invocations WHERE invocation_id=$1',
              [input.invocationId],
            )
          ).rows[0],
        ).toEqual({ state: 'reserved', accepted_result: null });
        expect(
          (
            await pool.query('SELECT count(*)::int AS n FROM tool_calls WHERE invocation_id=$1', [
              input.invocationId,
            ])
          ).rows[0]!.n,
        ).toBe(0);
        expect(await counts(ctx)).toEqual({
          approvals: 0,
          tasks: 0,
          task_events: 0,
          outbox: 0,
          notifications: 0,
        });
      } finally {
        await pool.query(`DROP TRIGGER ${name} ON ${table}; DROP FUNCTION ${name}();`);
      }
      expect(await invokeTool(pool, ctx, input)).toMatchObject({ status: 'ok', replayed: false });
      expect(await timezone(ctx)).toBe('America/New_York');
    });
  }

  it('does not reinterpret historical task or pending approval timezone snapshots', async () => {
    const ctx = await fresh();
    const taskId = randomUUID();
    const approvalId = randomUUID();
    await pool.query(
      `INSERT INTO tasks(id,owner_id,fire_at_utc,wall_time,timezone_id,fold,
      resolved_utc_offset_seconds,tzdb_version,original_note)
      VALUES($1,$2,'2027-01-01T01:20:00Z','2027-01-01 09:20','Asia/Shanghai',0,28800,'2024a','frozen reminder')`,
      [taskId, ctx.ownerId],
    );
    await pool.query(
      `INSERT INTO approvals(id,owner_id,original_text,fire_at_utc,wall_time,timezone_id,fold,
      resolved_utc_offset_seconds,tzdb_version,occurrence,presentation_hash,presentation_version,state,expires_at)
      VALUES($1,$2,'frozen reminder','2027-01-01T01:20:00Z','2027-01-01 09:20','Asia/Shanghai',0,28800,
      '2024a','single','frozen-hash','v1','pending',clock_timestamp()+interval '1 hour')`,
      [approvalId, ctx.ownerId],
    );
    const beforeTask = (
      await pool.query('SELECT to_jsonb(t) AS value FROM tasks t WHERE id=$1', [taskId])
    ).rows[0];
    const beforeApproval = (
      await pool.query('SELECT to_jsonb(a) AS value FROM approvals a WHERE id=$1', [approvalId])
    ).rows[0];
    for (const [index, value] of ['America/New_York', null].entries()) {
      await invokeTool(pool, ctx, await reserve(ctx, `timezone/${index}`, { timezone_id: value }));
    }
    expect(
      (await pool.query('SELECT to_jsonb(t) AS value FROM tasks t WHERE id=$1', [taskId])).rows[0],
    ).toEqual(beforeTask);
    expect(
      (await pool.query('SELECT to_jsonb(a) AS value FROM approvals a WHERE id=$1', [approvalId]))
        .rows[0],
    ).toEqual(beforeApproval);
  });
});
