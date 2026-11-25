import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { confirmApproval } from '../../src/features/approvals/reminder/confirm.js';
import { getApprovalDetail } from '../../src/features/approvals/reminder/service.js';
import { executeRun } from '../../src/agent/run/execute-turn.js';
import { startConversationRun } from '../../src/agent/run/admit-message.js';
import type { ThreadEvent } from '@along/stream-protocol';
import { getTaskDetail } from '../../src/features/tasks/read/queries.js';
import { runCancelPhase } from '../../src/features/tasks/scheduler/cancel-phase.js';
import { runSchedulePhase } from '../../src/features/tasks/scheduler/schedule.js';
import { loadTimeContext } from '../../src/features/time/context.js';
import type { ToolContext } from '../../src/agent/tools/contracts.js';
import { invokeTool, reserveToolInvocation } from '../../src/agent/tools/gateway.js';
import {
  admitTestUser,
  createIntegrationDatabase,
  databaseUrl,
  type IntegrationDatabase,
} from './setup.js';

const maybe = databaseUrl ? describe : describe.skip;

maybe('elapsed UTC cancellation follow-up', () => {
  let db: IntegrationDatabase;
  beforeAll(async () => {
    db = await createIntegrationDatabase();
  });
  afterAll(async () => {
    await db?.close();
  });

  it('confirms and revokes a scheduled UTC elapsed reminder without inventing timezone rules', async () => {
    const ownerId = randomUUID();
    const conversationId = randomUUID();
    const messageId = randomUUID();
    const runId = randomUUID();
    const attemptId = randomUUID();
    const text = '三分钟后提醒我核对报告';
    const tools = ['create_reminder', 'request_cancel_task'];
    const anchor = (
      await db.pool.query<{ anchor: string }>(
        `SELECT to_char((clock_timestamp() + interval '1 minute') AT TIME ZONE 'UTC',
                      'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS anchor`,
      )
    ).rows[0]!.anchor;
    await db.pool.query(
      "INSERT INTO users(id,auth_email,display_name,timezone_id) VALUES($1,$2,'tester','UTC')",
      [ownerId, `${ownerId}@fixture.test`],
    );
    await admitTestUser(db.pool, ownerId);
    await db.pool.query('INSERT INTO conversations(id,owner_id) VALUES($1,$2)', [
      conversationId,
      ownerId,
    ]);
    await db.pool.query(
      "INSERT INTO messages(id,owner_id,conversation_id,role,content) VALUES($1,$2,$3,'user',$4)",
      [messageId, ownerId, conversationId, text],
    );
    await db.pool.query(
      `INSERT INTO agent_runs(id,owner_id,conversation_id,agent_revision,mode,budget_max_iterations,budget_max_tokens,execution,tools_allowlist,frozen_context,input_message_id)
       VALUES($1,$2,$3,'direct-test','chat',16,4096,'harness',$4::jsonb,$5::jsonb,$6)`,
      [
        runId,
        ownerId,
        conversationId,
        JSON.stringify(tools),
        JSON.stringify({
          authorization_revision: 'delegation/1',
          execution_lifecycle: 'request-bound',
          trustedExecutionContext: {
            request_anchor_utc: anchor,
            time_capabilities: { elapsed_revision: 'elapsed/1' },
          },
          reminderDateSource: { version: 1, kind: 'new', inputMessageId: messageId },
        }),
        messageId,
      ],
    );
    await db.pool.query(
      'INSERT INTO run_attempts(id,owner_id,run_id,attempt_no) VALUES($1,$2,$3,1)',
      [attemptId, ownerId, runId],
    );
    const ctx: ToolContext = {
      ownerId,
      conversationId,
      runId,
      attemptId,
      requestId: randomUUID(),
      allowlist: tools,
      authorizationRevision: 'delegation/1',
      confirmedTimezone: 'UTC',
      anchorReceivedAtUtc: anchor,
      receivedAtUtc: anchor,
      foldChoice: 'none',
      timeContext: loadTimeContext(undefined),
    };
    async function call(toolId: string, args: unknown) {
      const binding = await reserveToolInvocation(db.pool, ctx, {
        callKey: `${toolId}/1`,
        toolId,
        args,
      });
      return invokeTool(db.pool, ctx, { ...binding, toolId, args });
    }
    const created = await call('create_reminder', {
      raw_time_text: text,
      note: '核对报告',
      occurrence: 'once',
      time_kind: 'elapsed',
      duration_seconds: 180,
    });
    expect(created).toMatchObject({
      status: 'ok',
      result: { kind: 'task_created', timezone_id: 'UTC', tzdb_version: null },
    });
    if (created.status !== 'ok' || created.result.kind !== 'task_created')
      throw new Error('expected created elapsed task');
    const taskId = created.result.task_id;
    const task = (
      await db.pool.query(
        'SELECT fire_at_utc, wall_time, timezone_id, tzdb_version, time_basis, display_version FROM tasks WHERE id=$1 AND owner_id=$2',
        [taskId, ownerId],
      )
    ).rows[0];
    expect(task).toMatchObject({
      timezone_id: 'UTC',
      tzdb_version: null,
      display_version: 'elapsed/1',
      time_basis: { kind: 'elapsed', anchor_utc: anchor, duration_seconds: 180 },
    });
    for (let i = 0; i < 15; i++) {
      await runSchedulePhase(db.pool);
      if ((await getTaskDetail({ pool: db.pool }, ownerId, taskId)).state === 'scheduled') break;
    }
    expect((await getTaskDetail({ pool: db.pool }, ownerId, taskId)).state).toBe('scheduled');

    const started = await startConversationRun(
      { pool: db.pool, timeContext: loadTimeContext(undefined) },
      ownerId,
      randomUUID(),
      { raw_text: `取消任务 ${taskId}` },
      randomUUID(),
    );
    if (!started.context) throw new Error('expected business run');
    const events: ThreadEvent[] = [];
    await executeRun(
      { pool: db.pool, timeContext: loadTimeContext(undefined) },
      started.context,
      async (event) => {
        events.push(event);
        return true;
      },
    );
    const required = events.find((event) => event.type === 'approval_required');
    if (!required || required.type !== 'approval_required')
      throw new Error('cancel approval missing');
    const approvalId = required.payload.approval_id;
    const { detail } = await getApprovalDetail({ pool: db.pool }, ownerId, approvalId);
    const pending = (
      await db.pool.query(
        'SELECT state, kind, target_task_id, tzdb_version, fire_at_utc, wall_time, timezone_id FROM approvals WHERE id=$1 AND owner_id=$2',
        [approvalId, ownerId],
      )
    ).rows[0];
    expect(pending).toMatchObject({
      state: 'pending',
      kind: 'cancel_task',
      target_task_id: taskId,
      tzdb_version: null,
      fire_at_utc: task.fire_at_utc,
      wall_time: task.wall_time,
      timezone_id: task.timezone_id,
    });
    expect((await getTaskDetail({ pool: db.pool }, ownerId, taskId)).state).toBe('scheduled');
    const confirmed = await confirmApproval({ pool: db.pool }, ownerId, approvalId, {
      presentation_hash: detail.presentation_hash,
      seen_content: detail.echo_text,
      idempotency_key: randomUUID(),
    });
    expect(confirmed).toMatchObject({ status: 'consumed', task_id: taskId, duplicate: false });
    expect((await getTaskDetail({ pool: db.pool }, ownerId, taskId)).state).toBe('cancel_pending');
    const before = (
      await db.pool.query(
        "SELECT status, provider_receipt_id FROM outbox WHERE task_id=$1 AND command->>'kind'='cancel'",
        [taskId],
      )
    ).rows;
    expect(before).toEqual([{ status: 'pending', provider_receipt_id: null }]);
    for (let i = 0; i < 15; i++) {
      await runCancelPhase(db.pool);
      if ((await getTaskDetail({ pool: db.pool }, ownerId, taskId)).state === 'cancelled') break;
    }
    expect((await getTaskDetail({ pool: db.pool }, ownerId, taskId)).state).toBe('cancelled');
    const commands = (
      await db.pool.query(
        "SELECT id, status, provider_receipt_id, expected_state_version FROM outbox WHERE task_id=$1 AND command->>'kind'='cancel'",
        [taskId],
      )
    ).rows;
    expect(commands).toHaveLength(1);
    expect(commands[0].status).toBe('dispatched');
    expect(commands[0].provider_receipt_id).toBe(
      `pg-cancel:${commands[0].id}:${commands[0].expected_state_version}`,
    );
    expect(
      (
        await db.pool.query(
          "SELECT type, evidence_ref FROM task_events WHERE task_id=$1 AND type='cancelled'",
          [taskId],
        )
      ).rows,
    ).toEqual([{ type: 'cancelled', evidence_ref: commands[0].provider_receipt_id }]);
    expect(
      (await db.pool.query('SELECT 1 FROM task_leases WHERE task_id=$1', [taskId])).rows,
    ).toHaveLength(0);
  });
});
