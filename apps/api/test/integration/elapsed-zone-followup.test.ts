import { createFixtureConversation } from '../helpers/bot-conversation.js';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { loadTimeContext } from '../../src/features/time/context.js';
import type { ToolContext } from '../../src/agent/tools/contracts.js';
import { invokeTool, reserveToolInvocation } from '../../src/agent/tools/gateway.js';
import { admitTestUser, createIntegrationDatabase, type IntegrationDatabase } from './setup.js';

const text = '三分钟后提醒我核对报告';
const args = {
  raw_time_text: text,
  note: '核对报告',
  occurrence: 'once',
  time_kind: 'elapsed',
  duration_seconds: 180,
};
const empty = { approvals: 0, tasks: 0, task_events: 0, outbox: 0 };
const created = { approvals: 0, tasks: 1, task_events: 1, outbox: 1 };

describe('elapsed reminder frozen timezone authority', () => {
  let db: IntegrationDatabase;
  beforeAll(async () => {
    db = await createIntegrationDatabase();
  });
  afterAll(async () => {
    await db?.close();
  });

  async function fresh(
    source: 'explicit' | 'preference' | 'legacy' | 'none',
    options: { anchor?: string; unavailable?: boolean } = {},
  ): Promise<ToolContext> {
    const ownerId = randomUUID();
    const conversationId = randomUUID();
    const runId = randomUUID();
    const attemptId = randomUUID();
    const messageId = randomUUID();
    const anchor =
      options.anchor ??
      (
        await db.pool.query<{ anchor: string }>(
          `SELECT to_char((clock_timestamp() + interval '1 minute') AT TIME ZONE 'UTC',
                        'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS anchor`,
        )
      ).rows[0]!.anchor;
    const timezone = source === 'none' ? null : 'Asia/Shanghai';
    const timeContext = loadTimeContext(options.unavailable ? undefined : 'fixture-v1');
    const tools = ['create_reminder', 'set_user_timezone'];
    await db.pool.query(
      "INSERT INTO users(id,auth_email,display_name,timezone_id) VALUES($1,$2,'zone tester',$3)",
      [ownerId, `${ownerId}@zone.test`, source === 'explicit' ? null : timezone],
    );
    await admitTestUser(db.pool, ownerId);
    await createFixtureConversation(db.pool, ownerId, { id: conversationId });
    await db.pool.query(
      "INSERT INTO messages(id,owner_id,conversation_id,role,content) VALUES($1,$2,$3,'user',$4)",
      [messageId, ownerId, conversationId, text],
    );
    const trusted = {
      version: 1,
      authorization_revision: 'delegation/1',
      execution_lifecycle: 'request-bound',
      input_message_id: messageId,
      received_at_utc: anchor,
      request_anchor_utc: anchor,
      continuation: null,
      timezone:
        timezone && source !== 'legacy'
          ? {
              timezone_id: timezone,
              source,
              reference: source === 'explicit' ? messageId : ownerId,
            }
          : null,
      time_capabilities: {
        elapsed_revision: 'elapsed/1',
        wall_rules: timeContext.available
          ? {
              ruleset_id: timeContext.ruleset_id,
              tzdb_version: timeContext.tzdb_version,
              alias_version: timeContext.aliases.version,
            }
          : null,
      },
      workspaces: [],
    };
    const frozen = {
      confirmedTimezone: timezone,
      anchorReceivedAtUtc: anchor,
      receivedAtUtc: anchor,
      foldChoice: 'none',
      authorization_revision: 'delegation/1',
      execution_lifecycle: 'request-bound',
      reminderDateSource: { version: 1, kind: 'new', inputMessageId: messageId },
      trustedExecutionContext: trusted,
    };
    await db.pool.query(
      `INSERT INTO agent_runs(id,owner_id,conversation_id,agent_revision,mode,budget_max_iterations,
        budget_max_tokens,execution,tools_allowlist,frozen_context,input_message_id)
       VALUES($1,$2,$3,'zone-test','chat',16,4096,'harness',$4::jsonb,$5::jsonb,$6)`,
      [runId, ownerId, conversationId, JSON.stringify(tools), JSON.stringify(frozen), messageId],
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
      confirmedTimezone: timezone,
      anchorReceivedAtUtc: anchor,
      receivedAtUtc: anchor,
      foldChoice: 'none',
      timeContext,
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
    return invokeTool(db.pool, ctx, { ...binding, toolId, args: input });
  }

  async function counts(ctx: ToolContext) {
    const result: Record<string, number> = {};
    for (const table of ['approvals', 'tasks', 'task_events', 'outbox']) {
      result[table] = (
        await db.pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE owner_id=$1`, [
          ctx.ownerId,
        ])
      ).rows[0]!.n;
    }
    return result;
  }

  it('rejects an inherited explicit timezone without a model hint when rules are unavailable', async () => {
    const ctx = await fresh('explicit', { unavailable: true });
    expect(await call(ctx, 'explicit/unavailable')).toMatchObject({
      status: 'ok',
      result: { kind: 'time_error', error: { code: 'TZDB_UNAVAILABLE' } },
    });
    expect(await counts(ctx)).toEqual(empty);
  });

  it('rejects an inherited explicit timezone when the available rules do not cover the instant', async () => {
    const ctx = await fresh('explicit', { anchor: '2030-01-01T00:00:00Z' });
    expect(ctx.timeContext.available).toBe(true);
    expect(await call(ctx, 'explicit/outside-coverage')).toMatchObject({
      status: 'ok',
      result: { kind: 'time_error', error: { code: 'TZDB_UNAVAILABLE' } },
    });
    expect(await counts(ctx)).toEqual(empty);
  });

  for (const source of ['preference', 'legacy', 'none'] as const) {
    it(`allows UTC fallback without an explicit timezone (${source})`, async () => {
      const ctx = await fresh(source, { unavailable: true });
      expect(await call(ctx, `fallback/${source}`)).toMatchObject({
        status: 'ok',
        result: { kind: 'task_created', timezone_id: 'UTC', tzdb_version: null },
      });
      expect(await counts(ctx)).toEqual(created);
    });
  }

  it('uses a valid inherited explicit timezone without a hint', async () => {
    const ctx = await fresh('explicit', { anchor: '2027-11-03T00:00:00Z' });
    expect(await call(ctx, 'explicit/valid')).toMatchObject({
      status: 'ok',
      result: {
        kind: 'task_created',
        timezone_id: 'Asia/Shanghai',
        fire_at_utc: '2027-11-03T00:03:00.000Z',
        wall_time: '2027-11-03 08:03:00',
        resolved_utc_offset_seconds: 28800,
        tzdb_version: 'fixture-v1',
      },
    });
    expect(await counts(ctx)).toEqual(created);
  });

  it('uses an accepted same-run setting before admission timezone, but a tool hint before both', async () => {
    const ctx = await fresh('explicit');
    expect(
      await call(ctx, 'setting', { timezone_id: 'America/New_York' }, 'set_user_timezone'),
    ).toMatchObject({
      status: 'ok',
      result: { kind: 'timezone_setting', timezone_id: 'America/New_York' },
    });
    const unavailable = { ...ctx, timeContext: loadTimeContext(undefined) };
    expect(await call(unavailable, 'setting/fallback')).toMatchObject({
      status: 'ok',
      result: { kind: 'task_created', timezone_id: 'UTC', tzdb_version: null },
    });
    expect(
      await call(unavailable, 'setting/hint', { ...args, timezone_hint: 'Asia/Shanghai' }),
    ).toMatchObject({
      status: 'ok',
      result: { kind: 'time_error', error: { code: 'TZDB_UNAVAILABLE' } },
    });
    expect(await counts(ctx)).toEqual(created);
    expect(
      (await db.pool.query('SELECT timezone_id FROM users WHERE id=$1', [ctx.ownerId])).rows[0]!
        .timezone_id,
    ).toBe('America/New_York');
  });
});
