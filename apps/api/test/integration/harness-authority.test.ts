import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Pool } from 'pg';
import {
  HARNESS_PROTOCOL_VERSION,
  type HarnessRequest,
  type HarnessSnapshot,
} from '@along/contracts';
import type { ThreadEvent } from '@along/stream-protocol';
import { HttpError } from '../../src/http/errors.js';
import { startConversationRun } from '../../src/modules/conversations/service.js';
import type {
  ConversationDeps,
  RunContext,
  StartResult,
} from '../../src/modules/conversations/contracts.js';
import {
  createHarnessSession,
  cancelConversationRun,
  getRunView,
  resumeConversationRun,
} from '../../src/modules/conversations/harness-authority.js';
import type { HarnessSession } from '../../src/modules/conversations/harness-authority.js';
import {
  listRunEvents,
  listConversationEvents,
} from '../../src/modules/conversations/repository.js';
import { confirmApproval, rejectApproval } from '../../src/modules/approvals/confirm.js';
import { reviseApproval } from '../../src/modules/approvals/revise.js';
import { getApprovalDetail } from '../../src/modules/approvals/service.js';
import { loadTimeContext } from '../../src/modules/time/context.js';
import { seedSession } from '../../src/modules/identity/seed.js';
import type { SeededSession } from '../../src/modules/identity/seed.js';
import { createIntegrationDatabase, databaseUrl, type IntegrationDatabase } from './setup.js';
import {
  executeLocalInvocation,
  executeNonTransactionalInvocation,
  reserveInvocation,
  ToolExecutionError,
} from '../../src/modules/tools/invocations.js';
import { appendEvent, lockRun } from '../../src/modules/conversations/run-state.js';

const maybe = databaseUrl ? describe : describe.skip;
const idReply = z.object({ invocation_id: z.string().uuid() });
const checkpointReply = z.object({ checkpoint_ref: z.string().uuid() });
const proposalReply = z.object({
  status: z.literal('ok'),
  result: z.object({
    kind: z.literal('approval'),
    approval: z.object({ approvalId: z.string().uuid() }),
  }),
});
const timeContext = loadTimeContext('fixture-v1');

interface Fixture {
  actor: SeededSession;
  started: StartResult;
  context: RunContext;
  events: ThreadEvent[];
  session: HarnessSession;
  frame(request: HarnessRequest): Promise<unknown>;
}
interface WaitingFixture extends Fixture {
  invocationId: string;
  outcome: unknown;
  approvalId: string;
  snapshot: HarnessSnapshot;
  checkpointId: string;
}

maybe('harness durable authority against PostgreSQL', () => {
  let database: IntegrationDatabase;
  let deps: ConversationDeps;
  beforeAll(async () => {
    database = await createIntegrationDatabase();
    deps = {
      pool: database.pool,
      timeContext,
      harness: {
        binaryPath: process.env.HARNESS_BINARY ?? '/app/harness/bin/along-harness',
        maxIterations: 8,
        maxTokens: 8000,
        model: async () => ({ message: { content: 'answer', tool_calls: [] }, usage: null }),
      },
    };
  });
  afterAll(async () => {
    await database?.close();
  });

  async function fresh(): Promise<Fixture> {
    const actor = await seedSession(database.pool, {});
    const started = await startConversationRun(
      deps,
      actor.userId,
      randomUUID(),
      {
        execution: 'harness',
        raw_text: '2027-11-02 09:20 提醒我喝水',
        confirmed_timezone: 'Asia/Shanghai',
        idempotency_key: randomUUID(),
      },
      null,
    );
    if (!started.context) throw new Error('fresh context missing');
    const context = started.context;
    const events: ThreadEvent[] = [];
    const session = await createHarnessSession(
      deps,
      context,
      async (event) => {
        events.push(event);
        return true;
      },
      new AbortController().signal,
    );
    function frame(request: HarnessRequest): Promise<unknown> {
      return session.handleRequest(request);
    }
    return { actor, started, context, events, session, frame };
  }
  function request<T extends HarnessRequest['type']>(
    type: T,
    value: Omit<Extract<HarnessRequest, { type: T }>, 'type' | 'protocol' | 'request_ref'>,
  ): Extract<HarnessRequest, { type: T }> {
    return {
      protocol: HARNESS_PROTOCOL_VERSION,
      request_ref: randomUUID(),
      type,
      ...value,
    } as Extract<HarnessRequest, { type: T }>;
  }
  async function invoke(
    fixture: Fixture,
    toolId = 'list_tasks',
    args: Record<string, unknown> = {},
  ) {
    const reserved = idReply.parse(
      await fixture.frame(request('reserve', { call_key: 'harness/1', tool_id: toolId, args })),
    );
    const outcome = await fixture.frame(
      request('invoke', { invocation_id: reserved.invocation_id, tool_id: toolId, args }),
    );
    return { invocationId: reserved.invocation_id, outcome };
  }
  async function waiting(): Promise<WaitingFixture> {
    const fixture = await fresh();
    const invoked = await invoke(fixture, 'propose_task', {
      raw_time_text: fixture.context.inputText,
      timezone_hint: 'Asia/Shanghai',
      note: '喝水',
      occurrence: 'once',
    });
    const approvalId = proposalReply.parse(invoked.outcome).result.approval.approvalId;
    const snapshot: HarnessSnapshot = {
      version: 1,
      message_refs: [fixture.context.userMessageId],
      tool_refs: [invoked.invocationId],
      next_call_no: 2,
      usage: { iterations: 1, tokens: null },
      waiting: { invocation_id: invoked.invocationId, approval_id: approvalId },
    };
    const checkpoint = checkpointReply.parse(
      await fixture.frame(request('snapshot', { context: snapshot })),
    );
    await fixture.frame(
      request('suspend', {
        checkpoint_ref: checkpoint.checkpoint_ref,
        invocation_id: invoked.invocationId,
        approval_id: approvalId,
      }),
    );
    return {
      ...fixture,
      ...invoked,
      approvalId,
      snapshot,
      checkpointId: checkpoint.checkpoint_ref,
    };
  }
  async function resume(fixture: WaitingFixture, key = randomUUID()) {
    return resumeConversationRun(
      deps,
      fixture.actor.userId,
      fixture.context.conversationId,
      fixture.context.runId,
      randomUUID(),
      { checkpoint_id: fixture.checkpointId, idempotency_key: key },
    );
  }
  async function blocked(pool: Pool, blockerPid: number, count = 1) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const result = await pool.query<{ n: number }>(
        `WITH RECURSIVE blocked AS (
          SELECT pid FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))
          UNION SELECT a.pid FROM pg_stat_activity a JOIN blocked b ON b.pid=ANY(pg_blocking_pids(a.pid))
        ) SELECT count(DISTINCT pid)::int AS n FROM blocked`,
        [blockerPid],
      );
      if ((result.rows[0]?.n ?? 0) >= count) return;
    }
    throw new Error('expected real PostgreSQL lock wait was not observed');
  }

  it('reconstructs trusted input/grant/limits and rejects owner, cross-Run, and unknown-tool references without effects', async () => {
    const first = await fresh();
    const other = await fresh();
    const forged = await createHarnessSession(
      deps,
      {
        ...first.context,
        inputText: 'injected',
        allowlist: ['arbitrary_effect'],
        maxTokens: 999999,
      },
      async () => true,
      new AbortController().signal,
    );
    expect(forged.start.messages[0]?.content).toBe(first.context.inputText);
    expect(forged.start.tools.map((tool) => tool.name)).not.toContain('arbitrary_effect');
    expect(forged.start.budget.max_tokens).toBe(8000);
    await expect(
      createHarnessSession(
        deps,
        { ...first.context, ownerId: other.actor.userId },
        async () => true,
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(HttpError);
    const reserved = idReply.parse(
      await other.frame(
        request('reserve', { call_key: 'harness/1', tool_id: 'list_tasks', args: {} }),
      ),
    );
    await expect(
      first.frame(
        request('invoke', {
          invocation_id: reserved.invocation_id,
          tool_id: 'list_tasks',
          args: {},
        }),
      ),
    ).rejects.toBeInstanceOf(HttpError);
    await expect(
      first.frame(
        request('reserve', { call_key: 'harness/1', tool_id: 'arbitrary_effect', args: {} }),
      ),
    ).rejects.toBeInstanceOf(HttpError);
    expect(
      (
        await database.pool.query('SELECT count(*)::int n FROM approvals WHERE owner_id=$1', [
          first.actor.userId,
        ])
      ).rows[0]?.n,
    ).toBe(0);
    await database.pool.query("UPDATE users SET status='disabled' WHERE id=$1", [
      first.actor.userId,
    ]);
    await expect(
      first.frame(request('answer', { delta: 'not authorized' })),
    ).rejects.toBeInstanceOf(HttpError);
    expect(await listRunEvents(database.pool, first.actor.userId, first.context.runId)).toEqual([]);
  });

  it('rejects unresolved effects as done and atomically rolls back terminal message/checkpoint/attempt/Run on a real trigger failure', async () => {
    const fixture = await fresh();
    await fixture.frame(
      request('reserve', { call_key: 'harness/1', tool_id: 'list_tasks', args: {} }),
    );
    await expect(
      fixture.frame(request('finish', { outcome: 'done', usage: { iterations: 1, tokens: null } })),
    ).rejects.toBeInstanceOf(HttpError);
    const pending = await fresh();
    await invoke(pending, 'propose_task', {
      raw_time_text: pending.context.inputText,
      timezone_hint: 'Asia/Shanghai',
      note: '喝水',
      occurrence: 'once',
    });
    await expect(
      pending.frame(request('finish', { outcome: 'done', usage: { iterations: 1, tokens: null } })),
    ).rejects.toMatchObject({
      errorCode: 'STATE_CONFLICT',
      message: 'Run has unresolved approval',
    });
    const clean = await fresh();
    await clean.frame(request('answer', { delta: 'accepted visible delta' }));
    const name = `terminal_fault_${clean.context.runId.replaceAll('-', '')}`;
    await database.pool.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'terminal fixture fault'; END $$;
      CREATE TRIGGER ${name} BEFORE INSERT ON run_checkpoints FOR EACH ROW
      WHEN (NEW.owner_id='${clean.actor.userId}'::uuid AND NEW.kind='thread.completed') EXECUTE FUNCTION ${name}()`);
    try {
      await expect(
        clean.frame(request('finish', { outcome: 'done', usage: { iterations: 1, tokens: null } })),
      ).rejects.toBeDefined();
      const state = await database.pool.query(
        `SELECT r.status,a.status AS attempt_status,
        (SELECT count(*)::int FROM messages WHERE conversation_id=r.conversation_id AND role='assistant') AS messages,
        (SELECT count(*)::int FROM run_checkpoints WHERE attempt_id=a.id AND kind='thread.completed') AS terminals
        FROM agent_runs r JOIN run_attempts a ON a.run_id=r.id WHERE r.id=$1`,
        [clean.context.runId],
      );
      expect(state.rows).toEqual([
        { status: 'running', attempt_status: 'running', messages: 0, terminals: 0 },
      ]);
    } finally {
      await database.pool.query(`DROP TRIGGER ${name} ON run_checkpoints; DROP FUNCTION ${name}()`);
    }
    await clean.frame(
      request('finish', { outcome: 'done', usage: { iterations: 1, tokens: null } }),
    );
    expect(
      (
        await database.pool.query(
          "SELECT content FROM messages WHERE conversation_id=$1 AND role='assistant'",
          [clean.context.conversationId],
        )
      ).rows,
    ).toEqual([{ content: 'accepted visible delta' }]);
  });

  it('validates actual snapshot references/counters/monotone usage and filters internal snapshots from both event consumers', async () => {
    const fixture = await fresh();
    const invocation = await invoke(fixture);
    const snapshot: HarnessSnapshot = {
      version: 1,
      message_refs: [fixture.context.userMessageId],
      tool_refs: [invocation.invocationId],
      next_call_no: 2,
      usage: { iterations: 2, tokens: 10 },
      waiting: null,
    };
    await fixture.frame(request('snapshot', { context: snapshot }));
    for (const bad of [
      { ...snapshot, message_refs: [randomUUID()] },
      { ...snapshot, tool_refs: [randomUUID()] },
      { ...snapshot, next_call_no: 1 },
      { ...snapshot, usage: { iterations: 1, tokens: 10 } },
      { ...snapshot, usage: { iterations: 2, tokens: 9 } },
      {
        ...snapshot,
        waiting: { invocation_id: invocation.invocationId, approval_id: randomUUID() },
      },
    ])
      await expect(fixture.frame(request('snapshot', { context: bad }))).rejects.toBeInstanceOf(
        HttpError,
      );
    await fixture.frame(request('answer', { delta: 'read result accepted' }));
    expect(
      (await listRunEvents(database.pool, fixture.actor.userId, fixture.context.runId)).map(
        (event) => event.type,
      ),
    ).toEqual(['message.delta']);
    expect(
      (
        await listConversationEvents(database.pool, {
          ownerId: fixture.actor.userId,
          conversationId: fixture.context.conversationId,
          afterSeq: null,
          limit: 100,
        })
      ).map((event) => event.type),
    ).toEqual(['message.delta']);
    const stored = await database.pool.query(
      'SELECT count(*)::int n FROM run_checkpoints WHERE attempt_id=$1 AND kind=$2',
      [fixture.context.attemptId, 'harness_snapshot'],
    );
    expect(stored.rows[0]?.n).toBe(1);
  });

  it('persists suspension without completed, pending resume rejects, GET and same inbound key do not execute or allocate attempts', async () => {
    const fixture = await waiting();
    const view = await getRunView(
      deps,
      fixture.actor.userId,
      fixture.context.conversationId,
      fixture.context.runId,
    );
    expect(view).toMatchObject({
      status: 'suspended_approval',
      attempt_no: 1,
      can_resume: false,
      waiting: {
        checkpoint_id: fixture.checkpointId,
        invocation_id: fixture.invocationId,
        approval_id: fixture.approvalId,
      },
    });
    expect(fixture.events.map((event) => event.type)).toEqual([
      'card.proposed',
      'approval_required',
    ]);
    const inbound = (
      await database.pool.query<{ idempotency_key: string }>(
        'SELECT idempotency_key FROM conversation_idempotency WHERE run_id=$1',
        [fixture.context.runId],
      )
    ).rows[0]!;
    const replay = await startConversationRun(
      deps,
      fixture.actor.userId,
      randomUUID(),
      {
        execution: 'harness',
        raw_text: fixture.context.inputText,
        confirmed_timezone: 'Asia/Shanghai',
        idempotency_key: inbound.idempotency_key,
      },
      null,
    );
    expect(replay.context).toBeNull();
    expect(replay.replay).toEqual(fixture.events);
    await expect(resume(fixture)).rejects.toMatchObject({
      errorCode: 'STATE_CONFLICT',
      details: { status: 'pending' },
    });
    await expect(
      getRunView(deps, randomUUID(), fixture.context.conversationId, fixture.context.runId),
    ).rejects.toBeInstanceOf(HttpError);
    await expect(
      resumeConversationRun(
        deps,
        fixture.actor.userId,
        fixture.context.conversationId,
        fixture.context.runId,
        randomUUID(),
        { checkpoint_id: randomUUID(), idempotency_key: randomUUID() },
      ),
    ).rejects.toBeInstanceOf(HttpError);
    const attempts = await database.pool.query(
      'SELECT count(*)::int n FROM run_attempts WHERE run_id=$1',
      [fixture.context.runId],
    );
    expect(attempts.rows[0]?.n).toBe(1);
  });

  for (const status of ['consumed', 'rejected', 'expired', 'superseded'] as const) {
    it(`${status} resumes once with original decision truth, retaining Run/invocation and rejecting old attempt`, async () => {
      const fixture = await waiting();
      let taskId: string | null = null;
      if (status === 'consumed') {
        const detail = await getApprovalDetail(
          { pool: database.pool },
          fixture.actor.userId,
          fixture.approvalId,
        );
        const consumed = await confirmApproval(
          { pool: database.pool },
          fixture.actor.userId,
          fixture.approvalId,
          {
            presentation_hash: detail.detail.presentation_hash,
            seen_content: detail.detail.echo_text,
            idempotency_key: randomUUID(),
          },
        );
        taskId = consumed.task_id;
      } else if (status === 'rejected') {
        await rejectApproval({ pool: database.pool }, fixture.actor.userId, fixture.approvalId, {
          idempotency_key: randomUUID(),
        });
      } else if (status === 'expired') {
        await database.pool.query(
          "UPDATE approvals SET expires_at=now()-interval '1 second' WHERE id=$1",
          [fixture.approvalId],
        );
      } else {
        await reviseApproval(
          { pool: database.pool, timeContext },
          fixture.actor.userId,
          fixture.approvalId,
          {
            raw_text: '2027-11-03 10:20 提醒我喝水',
            confirmed_timezone: 'Asia/Shanghai',
            idempotency_key: randomUUID(),
          },
        );
      }
      const view = await getRunView(
        deps,
        fixture.actor.userId,
        fixture.context.conversationId,
        fixture.context.runId,
      );
      expect(view.can_resume).toBe(true);
      const key = randomUUID();
      const resumed = await resume(fixture, key);
      if (!resumed.context) throw new Error('resume context missing');
      const resumedEvents: ThreadEvent[] = [];
      const session = await createHarnessSession(
        deps,
        resumed.context,
        async (event) => {
          resumedEvents.push(event);
          return true;
        },
        new AbortController().signal,
      );
      expect(session.start.approval).toMatchObject({
        approval_id: fixture.approvalId,
        status,
        task_id: taskId,
      });
      expect(session.start.observations[0]?.invocation_id).toBe(fixture.invocationId);
      expect(session.start.snapshot?.next_call_no).toBe(2);
      await expect(resume(fixture, key)).rejects.toMatchObject({
        errorCode: 'STATE_CONFLICT',
        details: { status: 'running' },
      });
      await expect(resume(fixture, randomUUID())).rejects.toBeInstanceOf(HttpError);
      await expect(
        createHarnessSession(deps, fixture.context, async () => true, new AbortController().signal),
      ).rejects.toBeInstanceOf(HttpError);
      await expect(
        session.handleRequest(
          request('invoke', {
            invocation_id: fixture.invocationId,
            tool_id: 'propose_task',
            args: {},
          }),
        ),
      ).rejects.toBeInstanceOf(HttpError);
      if (status !== 'consumed')
        await expect(
          session.handleRequest(
            request('reserve', {
              call_key: 'harness/2',
              tool_id: 'propose_task',
              args: {},
            }),
          ),
        ).rejects.toBeInstanceOf(HttpError);
      await session.handleRequest(request('answer', { delta: `decision: ${status}` }));
      await session.handleRequest(
        request('finish', { outcome: 'done', usage: { iterations: 2, tokens: null } }),
      );
      const replay = await resume(fixture, key);
      expect(replay.context).toBeNull();
      expect(replay.replay).toEqual(resumedEvents);
      expect(
        (
          await database.pool.query('SELECT count(*)::int n FROM run_attempts WHERE run_id=$1', [
            fixture.context.runId,
          ])
        ).rows[0]?.n,
      ).toBe(2);
      expect(
        (
          await database.pool.query(
            'SELECT count(*)::int n FROM tool_invocations WHERE run_id=$1',
            [fixture.context.runId],
          )
        ).rows[0]?.n,
      ).toBe(1);
      expect(
        (
          await database.pool.query('SELECT count(*)::int n FROM tasks WHERE owner_id=$1', [
            fixture.actor.userId,
          ])
        ).rows[0]?.n,
      ).toBe(status === 'consumed' ? 1 : 0);
    });
  }

  for (const kind of ['failed', 'unknown'] as const) {
    it(`accepted ${kind} tool state cannot become a done Run or be retried in a new slot`, async () => {
      const fixture = await fresh();
      const reserved = await reserveInvocation(database.pool, fixture.context, {
        callKey: 'harness/1',
        toolId: 'list_tasks',
        args: {},
        executionKind: kind === 'unknown' ? 'non_transactional' : 'read_only',
      });
      const input = { invocationId: reserved.invocationId, toolId: 'list_tasks', args: {} };
      if (kind === 'unknown') {
        const outcome = await executeNonTransactionalInvocation(
          database.pool,
          fixture.context,
          input,
          {
            execute: async () => {
              throw new Error('lost effect response');
            },
          },
        );
        expect(outcome.status).toBe('unknown');
      } else {
        const outcome = await executeLocalInvocation(
          database.pool,
          fixture.context,
          input,
          async () => {
            throw new ToolExecutionError();
          },
        );
        expect(outcome.status).toBe('failed');
      }
      await expect(
        fixture.frame(
          request('finish', { outcome: 'done', usage: { iterations: 1, tokens: null } }),
        ),
      ).rejects.toMatchObject({ errorCode: 'STATE_CONFLICT' });
      await expect(
        fixture.frame(
          request('reserve', { call_key: 'harness/2', tool_id: 'list_tasks', args: {} }),
        ),
      ).rejects.toMatchObject({ errorCode: 'STATE_CONFLICT' });
      expect(
        (
          await database.pool.query('SELECT status FROM agent_runs WHERE id=$1', [
            fixture.context.runId,
          ])
        ).rows[0]?.status,
      ).toBe('running');
      expect(
        (
          await database.pool.query(
            'SELECT count(*)::int n FROM tool_invocations WHERE run_id=$1',
            [fixture.context.runId],
          )
        ).rows[0]?.n,
      ).toBe(1);
    });
  }

  it('tool commits before cancel through a real audit barrier; its approval survives while late native action is rejected', async () => {
    const fixture = await fresh();
    const args = {
      raw_time_text: fixture.context.inputText,
      timezone_hint: 'Asia/Shanghai',
      note: '喝水',
      occurrence: 'once',
    };
    const reserved = idReply.parse(
      await fixture.frame(
        request('reserve', { call_key: 'harness/1', tool_id: 'propose_task', args }),
      ),
    );
    const blocker = await database.pool.connect();
    const key = Number.parseInt(fixture.context.runId.slice(0, 7), 16);
    const pid = (await blocker.query<{ pid: number }>('SELECT pg_backend_pid() pid')).rows[0]!.pid;
    const name = `audit_barrier_${fixture.context.runId.replaceAll('-', '')}`;
    await blocker.query('SELECT pg_advisory_lock(46,$1)', [key]);
    await database.pool.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_advisory_xact_lock(46,${key}); RETURN NEW; END $$;
      CREATE TRIGGER ${name} BEFORE INSERT ON tool_calls FOR EACH ROW
      WHEN (NEW.owner_id='${fixture.actor.userId}'::uuid AND NEW.record_kind='accepted') EXECUTE FUNCTION ${name}()`);
    try {
      const invoking = fixture.frame(
        request('invoke', { invocation_id: reserved.invocation_id, tool_id: 'propose_task', args }),
      );
      const rejected = invoking.then(
        () => null,
        (error: unknown) => error,
      );
      await blocked(database.pool, pid);
      const executing = (
        await database.pool.query<{ pid: number }>(
          'SELECT pid FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))',
          [pid],
        )
      ).rows[0]!.pid;
      const cancelling = cancelConversationRun(
        deps,
        fixture.actor.userId,
        fixture.context.conversationId,
        fixture.context.runId,
        randomUUID(),
        { idempotency_key: randomUUID() },
      );
      await blocked(database.pool, executing);
      await blocker.query('SELECT pg_advisory_unlock(46,$1)', [key]);
      expect((await cancelling).status).toBe('cancelled');
      expect(await rejected).toBeInstanceOf(HttpError);
      const facts = await database.pool.query(
        `SELECT i.state,i.outcome_kind,a.state AS approval_state
        FROM tool_invocations i JOIN approvals a ON a.id=i.approval_id WHERE i.invocation_id=$1`,
        [reserved.invocation_id],
      );
      expect(facts.rows).toEqual([
        { state: 'completed', outcome_kind: 'approval_pending', approval_state: 'pending' },
      ]);
      expect(
        (await listRunEvents(database.pool, fixture.actor.userId, fixture.context.runId)).map(
          (event) => event.type,
        ),
      ).toEqual(['thread.cancelled']);
    } finally {
      await blocker.query('SELECT pg_advisory_unlock(46,$1)', [key]);
      blocker.release();
      await database.pool.query(`DROP TRIGGER ${name} ON tool_calls; DROP FUNCTION ${name}()`);
    }
  });

  it('cancel relocates to the latest attempt when resume wins the old-attempt lock', async () => {
    const fixture = await waiting();
    await rejectApproval({ pool: database.pool }, fixture.actor.userId, fixture.approvalId, {
      idempotency_key: randomUUID(),
    });
    const blocker = await database.pool.connect();
    const pid = (await blocker.query<{ pid: number }>('SELECT pg_backend_pid() pid')).rows[0]!.pid;
    await blocker.query('BEGIN');
    try {
      await blocker.query('SELECT id FROM run_attempts WHERE id=$1 FOR UPDATE', [
        fixture.context.attemptId,
      ]);
      const resumed = resume(fixture);
      await blocked(database.pool, pid);
      const cancelled = cancelConversationRun(
        deps,
        fixture.actor.userId,
        fixture.context.conversationId,
        fixture.context.runId,
        randomUUID(),
        { idempotency_key: randomUUID() },
      );
      await blocked(database.pool, pid, 2);
      await blocker.query('COMMIT');
      const newAttempt = await resumed;
      const result = await cancelled;
      expect(result).toMatchObject({
        status: 'cancelled',
        attempt_no: 2,
        attempt_id: newAttempt.context?.attemptId,
      });
      expect(
        (await listRunEvents(database.pool, fixture.actor.userId, fixture.context.runId)).filter(
          (event) => event.type === 'thread.cancelled',
        ),
      ).toHaveLength(1);
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
    }
  });

  it('two terminal writers finish after both assistant inserts hold conversation foreign-key locks', async () => {
    const first = await fresh();
    const second = await startConversationRun(
      deps,
      first.actor.userId,
      randomUUID(),
      {
        execution: 'harness',
        conversation_id: first.context.conversationId,
        raw_text: 'second terminal writer',
        idempotency_key: randomUUID(),
      },
      null,
    );
    if (!second.context) throw new Error('second context missing');
    const secondSession = await createHarnessSession(
      deps,
      second.context,
      async () => true,
      new AbortController().signal,
    );
    await first.frame(request('answer', { delta: 'first assistant' }));
    await secondSession.handleRequest(request('answer', { delta: 'second assistant' }));
    const blocker = await database.pool.connect();
    const pid = (await blocker.query<{ pid: number }>('SELECT pg_backend_pid() pid')).rows[0]!.pid;
    const key = Math.floor(Math.random() * 1_000_000_000);
    const name = `z_terminal_barrier_${first.context.runId.replaceAll('-', '')}`;
    // AFTER INSERT runs after the immediate RI constraint trigger: both real
    // assistant inserts have acquired their conversation FK KEY SHARE locks.
    await blocker.query('SELECT pg_advisory_lock(46,$1)', [key]);
    await database.pool.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_advisory_xact_lock_shared(46,${key}); RETURN NEW; END $$;
      CREATE TRIGGER ${name} AFTER INSERT ON messages FOR EACH ROW
      WHEN (NEW.conversation_id='${first.context.conversationId}'::uuid AND NEW.role='assistant')
      EXECUTE FUNCTION ${name}()`);
    let terminals: Promise<PromiseSettledResult<unknown>[]> | undefined;
    try {
      terminals = Promise.allSettled([
        first.frame(request('finish', { outcome: 'done', usage: { iterations: 1, tokens: null } })),
        secondSession.handleRequest(
          request('finish', { outcome: 'done', usage: { iterations: 1, tokens: null } }),
        ),
      ]);
      await blocked(database.pool, pid, 2);
      await blocker.query('SELECT pg_advisory_unlock(46,$1)', [key]);
      const results = await terminals;
      expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
      for (const runId of [first.context.runId, second.context.runId]) {
        const events = await listRunEvents(database.pool, first.actor.userId, runId);
        expect(events.map((event) => event.type)).toEqual(['message.delta', 'thread.completed']);
        expect(
          (await getRunView(deps, first.actor.userId, first.context.conversationId, runId)).status,
        ).toBe('done');
      }
      expect(
        (
          await database.pool.query(
            `SELECT content FROM messages WHERE conversation_id=$1 AND role='assistant' ORDER BY content`,
            [first.context.conversationId],
          )
        ).rows,
      ).toEqual([{ content: 'first assistant' }, { content: 'second assistant' }]);
    } finally {
      await blocker.query('SELECT pg_advisory_unlock(46,$1)', [key]);
      await terminals;
      blocker.release();
      await database.pool.query(`DROP TRIGGER ${name} ON messages; DROP FUNCTION ${name}()`);
    }
  });

  it('cancel between accepted answer chunks persists only accepted output and prevents all later effects', async () => {
    const fixture = await fresh();
    const session = await createHarnessSession(
      deps,
      fixture.context,
      async (event) => {
        if (event.type === 'message.delta')
          await cancelConversationRun(
            deps,
            fixture.actor.userId,
            fixture.context.conversationId,
            fixture.context.runId,
            randomUUID(),
            { idempotency_key: randomUUID() },
          );
        return true;
      },
      new AbortController().signal,
    );
    await expect(
      session.handleRequest(request('answer', { delta: 'a'.repeat(8001) })),
    ).rejects.toMatchObject({ errorCode: 'STATE_CONFLICT' });
    await expect(
      session.handleRequest(
        request('finish', { outcome: 'done', usage: { iterations: 1, tokens: null } }),
      ),
    ).rejects.toMatchObject({ errorCode: 'STATE_CONFLICT' });
    await expect(
      session.handleRequest(
        request('reserve', { call_key: 'harness/1', tool_id: 'list_tasks', args: {} }),
      ),
    ).rejects.toMatchObject({ errorCode: 'STATE_CONFLICT' });
    const events = await listRunEvents(database.pool, fixture.actor.userId, fixture.context.runId);
    expect(events.map((event) => event.type)).toEqual(['message.delta', 'thread.cancelled']);
    expect(events[0]).toMatchObject({ payload: { delta: 'a'.repeat(4000) } });
    expect(
      (
        await database.pool.query(
          `SELECT content FROM messages WHERE conversation_id=$1 AND role='assistant'`,
          [fixture.context.conversationId],
        )
      ).rows,
    ).toEqual([{ content: 'a'.repeat(4000) }]);
    expect(
      (
        await database.pool.query('SELECT count(*)::int n FROM tool_invocations WHERE run_id=$1', [
          fixture.context.runId,
        ])
      ).rows[0]?.n,
    ).toBe(0);
  });

  it('conversation cursor assignment cannot overtake an uncommitted earlier event', async () => {
    const first = await fresh();
    const second = await startConversationRun(
      deps,
      first.actor.userId,
      randomUUID(),
      {
        execution: 'harness',
        conversation_id: first.context.conversationId,
        raw_text: 'second',
        idempotency_key: randomUUID(),
      },
      null,
    );
    if (!second.context) throw new Error('second context missing');
    const session = await createHarnessSession(
      deps,
      second.context,
      async () => true,
      new AbortController().signal,
    );
    const client = await database.pool.connect();
    const pid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() pid')).rows[0]!.pid;
    await client.query('BEGIN');
    try {
      await lockRun(client, first.context);
      const earlier = await appendEvent(client, first.context, 'message.delta', {
        conversation_id: first.context.conversationId,
        run_id: first.context.runId,
        delta: 'first',
      });
      const later = session.handleRequest(request('answer', { delta: 'second' }));
      await blocked(database.pool, pid);
      const before = await listConversationEvents(database.pool, {
        ownerId: first.actor.userId,
        conversationId: first.context.conversationId,
        afterSeq: null,
        limit: 100,
      });
      expect(before).toEqual([]);
      await client.query('COMMIT');
      await later;
      const after = await listConversationEvents(database.pool, {
        ownerId: first.actor.userId,
        conversationId: first.context.conversationId,
        afterSeq: earlier.seq,
        limit: 100,
      });
      expect(after).toHaveLength(1);
      expect(after[0]).toMatchObject({ type: 'message.delta', payload: { delta: 'second' } });
      expect(after[0]!.seq).toBeGreaterThan(earlier.seq);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('cancel wins real attempt-lock races against reserve, snapshot and finish; no effect and one cancelled event', async () => {
    const fixture = await fresh();
    const blocker = await database.pool.connect();
    const pid = (await blocker.query<{ pid: number }>('SELECT pg_backend_pid() pid')).rows[0]!.pid;
    await blocker.query('BEGIN');
    try {
      await blocker.query('SELECT id FROM run_attempts WHERE id=$1 FOR UPDATE', [
        fixture.context.attemptId,
      ]);
      const key = randomUUID();
      const cancelled = cancelConversationRun(
        deps,
        fixture.actor.userId,
        fixture.context.conversationId,
        fixture.context.runId,
        randomUUID(),
        { idempotency_key: key },
      );
      await blocked(database.pool, pid);
      const reserve = fixture.frame(
        request('reserve', { call_key: 'harness/1', tool_id: 'propose_task', args: {} }),
      );
      const finishing = fixture.frame(
        request('finish', { outcome: 'done', usage: { iterations: 0, tokens: null } }),
      );
      const snapshotting = fixture.frame(
        request('snapshot', {
          context: {
            version: 1,
            message_refs: [fixture.context.userMessageId],
            tool_refs: [],
            next_call_no: 1,
            usage: { iterations: 0, tokens: null },
            waiting: null,
          },
        }),
      );
      const actions = Promise.allSettled([reserve, finishing, snapshotting]);
      await blocked(database.pool, pid, 4);
      await blocker.query('COMMIT');
      expect((await cancelled).status).toBe('cancelled');
      for (const action of await actions) {
        expect(action).toMatchObject({
          status: 'rejected',
          reason: { errorCode: 'STATE_CONFLICT' },
        });
      }
      await cancelConversationRun(
        deps,
        fixture.actor.userId,
        fixture.context.conversationId,
        fixture.context.runId,
        randomUUID(),
        { idempotency_key: key },
      );
      await expect(
        fixture.frame(
          request('snapshot', {
            context: {
              version: 1,
              message_refs: [fixture.context.userMessageId],
              tool_refs: [],
              next_call_no: 1,
              usage: { iterations: 0, tokens: null },
              waiting: null,
            },
          }),
        ),
      ).rejects.toBeInstanceOf(HttpError);
      await expect(
        fixture.frame(
          request('finish', { outcome: 'done', usage: { iterations: 0, tokens: null } }),
        ),
      ).rejects.toBeInstanceOf(HttpError);
      expect(
        (await listRunEvents(database.pool, fixture.actor.userId, fixture.context.runId)).map(
          (event) => event.type,
        ),
      ).toEqual(['thread.cancelled']);
      expect(
        (
          await database.pool.query(
            'SELECT count(*)::int n FROM tool_invocations WHERE run_id=$1',
            [fixture.context.runId],
          )
        ).rows[0]?.n,
      ).toBe(0);
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
    }
  });

  it('model waiting holds no database locks and its late response cannot authorize output after durable cancel', async () => {
    const fixture = await fresh();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const modelDeps: ConversationDeps = {
      ...deps,
      harness: {
        ...deps.harness!,
        model: async () => {
          entered.resolve();
          await release.promise;
          return { message: { content: 'late model answer', tool_calls: [] }, usage: null };
        },
      },
    };
    const session = await createHarnessSession(
      modelDeps,
      fixture.context,
      async () => true,
      new AbortController().signal,
    );
    const response = session.handleRequest(
      request('model', {
        messages: [{ role: 'user', content: fixture.context.inputText }],
        remaining_tokens: 8000,
      }),
    );
    await entered.promise;
    try {
      const cancelled = await cancelConversationRun(
        modelDeps,
        fixture.actor.userId,
        fixture.context.conversationId,
        fixture.context.runId,
        randomUUID(),
        { idempotency_key: randomUUID() },
      );
      expect(cancelled.status).toBe('cancelled');
    } finally {
      release.resolve();
    }
    await expect(response).rejects.toBeInstanceOf(HttpError);
    expect(
      (await listRunEvents(database.pool, fixture.actor.userId, fixture.context.runId)).map(
        (event) => event.type,
      ),
    ).toEqual(['thread.cancelled']);
  });

  it('two concurrent resume keys behind a real lock allocate only one attempt for the waiting point', async () => {
    const fixture = await waiting();
    await rejectApproval({ pool: database.pool }, fixture.actor.userId, fixture.approvalId, {
      idempotency_key: randomUUID(),
    });
    const client = await database.pool.connect();
    const pid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() pid')).rows[0]!.pid;
    await client.query('BEGIN');
    try {
      await client.query('SELECT id FROM run_attempts WHERE id=$1 FOR UPDATE', [
        fixture.context.attemptId,
      ]);
      const requests = Promise.allSettled([resume(fixture), resume(fixture)]);
      await blocked(database.pool, pid, 2);
      await client.query('COMMIT');
      const results = await requests;
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find((result) => result.status === 'rejected');
      expect(rejected?.status === 'rejected' ? rejected.reason : null).toMatchObject({
        errorCode: 'STATE_CONFLICT',
      });
      expect(
        (
          await database.pool.query('SELECT count(*)::int n FROM run_attempts WHERE run_id=$1', [
            fixture.context.runId,
          ])
        ).rows[0]?.n,
      ).toBe(2);
      expect(
        (
          await database.pool.query(
            'SELECT count(*)::int n FROM harness_resumes WHERE checkpoint_id=$1',
            [fixture.checkpointId],
          )
        ).rows[0]?.n,
      ).toBe(1);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
