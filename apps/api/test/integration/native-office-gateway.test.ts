import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { startConversationRun } from '../../src/agent/operations/start.js';
import type { ConversationDeps, RunContext } from '../../src/agent/runtime/contracts.js';
import { createHarnessSession } from '../../src/agent/runtime/attempt-session.js';
import { runNativeHarness } from '../../src/agent/harness/harness-process.js';
import {
  continueConversationPause,
  requestConversationPause,
} from '../../src/agent/operations/pause.js';
import { measureSdkContext } from '../../src/features/model-providers/public.js';
import { RunOwnership } from '../../src/agent/runtime/run-ownership.js';
import { invokeTool, reserveToolInvocation } from '../../src/agent/tools/gateway.js';
import { readRunContextObservations } from '../../src/agent/tools/invocations/context-query.js';
import { createContextPolicy } from '../../src/features/conversations/public.js';
import { getConversationRuns } from '../../src/features/conversations/history/history-service.js';
import { createOfficeStorage } from '../../src/features/native-office/public.js';
import { loadTimeContext } from '../../src/features/time/public.js';
import { configureTestModel } from '../helpers/model-selection.js';
import {
  createIntegrationDatabase,
  databaseUrl,
  seedAdmittedSession,
  type IntegrationDatabase,
} from './setup.js';

const keyName = 'ALONG_OFFICE_OBSERVATION_KEY';
const gateName = 'ALONG_NATIVE_OFFICE_ADMISSION';
const officeKey = Buffer.alloc(32, 76).toString('base64');
const notesText = '办公室专用正文 ⚡';
const taskTitle = '绝不可明文保存的任务标题';
const request =
  '请分析截至 2027-01-01 的所选资料，导出 Markdown 报告和负责人汇总 CSV，并于明天下午3点提醒我复查任务。';
const nativeBinary = process.env.HARNESS_BINARY;

(databaseUrl ? describe : describe.skip)('native office gateway transactions', () => {
  let db: IntegrationDatabase;
  let deps: ConversationDeps;
  const owners = new Set<RunOwnership>();
  const contexts = new Map<string, RunContext>();
  const previous = { [keyName]: process.env[keyName], [gateName]: process.env[gateName] };

  beforeAll(async () => {
    db = await createIntegrationDatabase();
    process.env[gateName] = '1';
    process.env[keyName] = officeKey;
    deps = {
      pool: db.pool,
      timeContext: loadTimeContext('fixture-v1'),
      harness: {
        binaryPath: '/unused',
        maxIterations: 32,
        maxTokens: 32000,
        contextPolicy: createContextPolicy({ completionCap: 512, model: 'office-gateway' }),
      },
      modelTransport: async () => {
        throw new Error('gateway tests must not call a model');
      },
      runDriver: {
        async acquire(runId) {
          const owner = await RunOwnership.tryAcquire(db.pool, runId);
          if (!owner) throw new Error('owner unavailable');
          owners.add(owner);
          return owner;
        },
        async release(owner) {
          owners.delete(owner);
          await owner.close();
        },
        start(_deps, context) {
          contexts.set(context.runId, context);
        },
      },
    };
  });

  afterAll(async () => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    for (const owner of owners) await owner.close();
    await db?.close();
  });

  async function officeRun(text: string, timezone = true, notesOnly = false, priorText?: string) {
    const { userId, sessionId } = await seedAdmittedSession(db.pool);
    if (!timezone) await db.pool.query('UPDATE users SET timezone_id=NULL WHERE id=$1', [userId]);
    await configureTestModel(db.pool, userId, 'office-gateway');
    let conversationId: string | undefined;
    if (priorText) {
      const prior = await startConversationRun(
        deps,
        userId,
        randomUUID(),
        {
          execution: 'harness',
          authorization_revision: 'delegation/1',
          raw_text: priorText,
        },
        randomUUID(),
        sessionId,
      );
      await deps.runDriver!.release(contexts.get(prior.runId)!.ownership!);
      conversationId = prior.conversationId;
    }
    const draftId = randomUUID();
    const storage = createOfficeStorage(db.pool);
    const binding = { ownerId: userId, sessionId, draftId };
    const notes = await storage.stageAttachment({
      ...binding,
      idempotencyKey: randomUUID(),
      filename: 'secret-notes.md',
      format: 'markdown',
      bytes: Buffer.from(notesText),
    });
    const tasks = await storage.stageAttachment({
      ...binding,
      idempotencyKey: randomUUID(),
      filename: 'secret-tasks.csv',
      format: 'csv',
      bytes: Buffer.from(
        'task_id,title,owner,due_date,status\r\n' +
          `001,${taskTitle},甲,2026-12-31,todo\r\n` +
          '002,今天,甲,2027-01-01,in_progress\r\n' +
          '003,昨天,乙,2026-12-31,done\r\n' +
          '004,未分配,,,invalid\r\n' +
          '005,日历非法,乙,2026-02-30,todo\r\n' +
          '006,续页,丙,2026-12-31,canceled\r\n',
      ),
    });
    const run = await startConversationRun(
      deps,
      userId,
      randomUUID(),
      {
        execution: 'harness',
        authorization_revision: 'delegation/1',
        raw_text: text,
        ...(conversationId ? { conversation_id: conversationId } : {}),
        office_materials: {
          draft_id: draftId,
          notes_attachment_id: notes.attachmentId,
          ...(!notesOnly ? { tasks_attachment_id: tasks.attachmentId } : {}),
        },
      },
      randomUUID(),
      sessionId,
    );
    const ctx = contexts.get(run.runId);
    if (!ctx) throw new Error('first acceptance must start the persisted Run');
    return { ctx, binding, notesId: notes.attachmentId, storage };
  }

  async function call(ctx: RunContext, toolId: string, args: unknown) {
    const { invocationId } = await reserveToolInvocation(db.pool, ctx, {
      callKey: randomUUID(),
      toolId,
      args,
    });
    return invokeTool(db.pool, ctx, { invocationId, toolId, args });
  }

  async function expectIncompleteDeliveryDenied(ctx: RunContext, notesInvocationId: string) {
    const outcome = await call(ctx, 'office_create_artifacts', {
      formats: ['markdown'],
      notes_invocation_ids: [notesInvocationId],
    });
    expect(outcome).toMatchObject({ status: 'denied', error: { code: 'OFFICE_DELIVERY_SCOPE' } });
    const { rowCount } = await db.pool.query(
      'SELECT 1 FROM office_run_materials WHERE run_id=$1 AND delivery_run_id IS NOT NULL',
      [ctx.runId],
    );
    expect(rowCount).toBe(0);
  }

  test('checks fresh start, reply and provider enqueue after admission', async () => {
    const { ctx, binding, notesId, storage } = await officeRun('请总结选中的纪要。', true, true);
    let dispatched = false;
    const session = await createHarnessSession(
      {
        ...deps,
        modelTransport: async () => ({
          measure: measureSdkContext,
          async *model(_request, _tools, _signal, authorizeDispatch) {
            if (!authorizeDispatch) throw new Error('office provider handoff requires authority');
            // Scheduling already succeeded. Revoke while the provider prepares to enqueue.
            await storage.revokeAttachment({ ...binding, attachmentId: notesId });
            await authorizeDispatch(() => {
              dispatched = true;
            });
            yield {
              type: 'complete',
              reply: { message: { content: 'synthetic', tool_calls: [] }, usage: null },
            };
          },
        }),
      },
      ctx,
      async () => true,
      new AbortController().signal,
    );
    try {
      const frame = () => ({ protocol: session.start.protocol, request_ref: randomUUID() });
      expect(session.start.tools.map(({ name }) => name).sort()).toEqual([
        'create_reminder',
        'get_user_prefs',
        'office_create_artifacts',
        'office_read_notes',
      ]);
      let started = false;
      const enqueue = () => {
        started = true;
        return undefined;
      };
      delete process.env[keyName];
      await expect(session.guardStart(enqueue)).rejects.toMatchObject({ errorCode: 'FORBIDDEN' });
      expect(started).toBe(false);
      process.env[keyName] = officeKey;
      await session.guardStart(enqueue);
      expect(started).toBe(true);

      const model = {
        ...frame(),
        type: 'model' as const,
        messages: [{ role: 'user' as const, content: ctx.inputText }],
        remaining_tokens: ctx.maxTokens,
        max_output_tokens: 32,
      };
      expect(await session.handleRequest({ ...frame(), type: 'pause_probe' })).toEqual({
        pending: false,
      });
      await expect(session.handleRequest(model)).rejects.toMatchObject({
        errorCode: 'OFFICE_MATERIALS_UNAVAILABLE',
      });
      expect(dispatched).toBe(false);
      started = false;
      await expect(session.guardStart(enqueue)).rejects.toMatchObject({
        errorCode: 'OFFICE_MATERIALS_UNAVAILABLE',
      });
      await expect(
        session.guardReply(model, { type: 'delta', delta: notesText }, enqueue),
      ).rejects.toMatchObject({ errorCode: 'OFFICE_MATERIALS_UNAVAILABLE' });
      expect(started).toBe(false);
    } finally {
      process.env[keyName] = officeKey;
      await session.close();
      await deps.runDriver!.release(ctx.ownership!);
    }
  });

  (nativeBinary ? test : test.skip)(
    'restores private observations and prior usage through the production native consumer',
    async () => {
      const unrelated = 'synthetic private material from another message';
      const { ctx } = await officeRun('请总结选中的纪要。', true, true, unrelated);
      const dispatched: { text: string; remaining: number | null }[] = [];
      let notesInvocation = '';
      let pauseId = '';
      const services = {
        ...deps.harness!,
        binaryPath: nativeBinary!,
        libraryPath: process.env.HARNESS_LIBRARY_PATH ?? process.env.LD_LIBRARY_PATH,
      };
      const runtime: ConversationDeps = {
        ...deps,
        harness: services,
        modelTransport: async () => ({
          measure: measureSdkContext,
          async *model(model, _tools, _signal, authorizeDispatch) {
            if (!authorizeDispatch) throw new Error('office provider handoff requires authority');
            await authorizeDispatch(() => {
              dispatched.push({
                text: JSON.stringify(model.messages),
                remaining: model.remaining_tokens,
              });
            });
            const first = dispatched.length === 1;
            yield {
              type: 'complete',
              reply: {
                usage: { total_tokens: 41 },
                message: {
                  content: null,
                  tool_calls: [
                    {
                      id: `synthetic-${dispatched.length}`,
                      type: 'function',
                      function: first
                        ? { name: 'office_read_notes', arguments: '{}' }
                        : {
                            name: 'finish_goal',
                            arguments: JSON.stringify({
                              status: 'completed',
                              outcomes: [
                                {
                                  description: '已读纪要',
                                  status: 'achieved',
                                  receipt_refs: [notesInvocation],
                                },
                              ],
                              clarification: null,
                              answer: notesText,
                            }),
                          },
                    },
                  ],
                },
              },
            };
          },
        }),
      };

      const drive = async (context: RunContext, pauseAfterRead: boolean) => {
        const signal = AbortSignal.timeout(15_000);
        const session = await createHarnessSession(runtime, context, async () => true, signal);
        try {
          if (!pauseAfterRead) {
            expect(session.start.snapshot?.usage).toEqual({ iterations: 1, tokens: 41 });
            expect(session.start.observations).toMatchObject([
              {
                invocation_id: notesInvocation,
                view: 'full',
                result: { result: { content: notesText } },
              },
            ]);
          }
          await runNativeHarness({
            services,
            start: session.start,
            guardStart: session.guardStart,
            guardReply: session.guardReply,
            signal,
            handleRequest: async (request) => {
              const result = await session.handleRequest(request);
              if (request.type === 'invoke' && request.tool_id === 'office_read_notes') {
                expect(pauseAfterRead).toBe(true);
                expect(notesInvocation).toBe('');
                notesInvocation = request.invocation_id;
                ({ pause_id: pauseId } = await requestConversationPause(
                  runtime,
                  ctx.ownerId,
                  ctx.conversationId,
                  ctx.runId,
                  { reason: 'user', purpose: 'none' },
                  randomUUID(),
                ));
              }
              return result;
            },
          });
        } finally {
          await session.close();
          await runtime.runDriver!.release(context.ownership!);
        }
      };

      await drive(ctx, true);
      expect(dispatched).toHaveLength(1);
      expect(dispatched[0]?.text).not.toContain(notesText);
      expect(pauseId).not.toBe('');
      const saved = await db.pool.query(
        `SELECT p.state,p.snapshot,i.accepted_result FROM harness_pauses p JOIN tool_invocations i
       ON i.run_id=p.run_id WHERE p.id=$1 AND i.invocation_id=$2`,
        [pauseId, notesInvocation],
      );
      expect(saved.rows).toEqual([
        {
          state: 'paused',
          snapshot: { encoding: 'along-office-snapshot-aead/1', ciphertext: expect.any(String) },
          accepted_result: { encoding: 'along-office-aead/1', ciphertext: expect.any(String) },
        },
      ]);
      expect(JSON.stringify(saved.rows)).not.toContain(notesText);
      const resumeKey = randomUUID();
      const resume = () =>
        continueConversationPause(
          runtime,
          ctx.ownerId,
          ctx.conversationId,
          ctx.runId,
          randomUUID(),
          { pause_id: pauseId },
          resumeKey,
        );
      delete process.env[keyName];
      try {
        await expect(resume()).rejects.toMatchObject({ errorCode: 'FORBIDDEN' });
        expect(
          (await db.pool.query('SELECT id FROM run_attempts WHERE run_id=$1', [ctx.runId])).rows,
        ).toEqual([{ id: ctx.attemptId }]);
        expect(dispatched).toHaveLength(1);
      } finally {
        process.env[keyName] = officeKey;
      }
      await resume();
      const resumed = contexts.get(ctx.runId)!;
      expect(resumed.attemptId).not.toBe(ctx.attemptId);
      await drive(resumed, false);
      expect(dispatched).toHaveLength(2);
      expect(dispatched[1]?.remaining).toBe(ctx.maxTokens - 41);
      expect(dispatched[1]?.text).toContain(notesText);
      expect(
        dispatched.every(({ text }) => !text.includes(taskTitle) && !text.includes(unrelated)),
      ).toBe(true);
      expect(
        (await db.pool.query('SELECT status FROM agent_runs WHERE id=$1', [ctx.runId])).rows,
      ).toEqual([{ status: 'done' }]);
      expect(
        (
          await db.pool.query(
            `SELECT content,source_run_id FROM messages WHERE conversation_id=$1 AND role='assistant'`,
            [ctx.conversationId],
          )
        ).rows,
      ).toEqual([{ content: notesText, source_run_id: ctx.runId }]);
    },
    30_000,
  );

  test('accepts bounded private reads, atomically delivers a complete manifest, and replays without disclosure after revocation', async () => {
    const { ctx, binding, notesId, storage } = await officeRun(request);
    const notes = await call(ctx, 'office_read_notes', {});
    expect(notes).toMatchObject({
      status: 'ok',
      result: { content: notesText, next_offset: null },
    });
    const accepted = await call(ctx, 'office_analyze_tasks', { action: 'analyze' });
    expect(accepted).toMatchObject({
      status: 'ok',
      result: {
        as_of: '2027-01-01',
        total_records: 6,
        next_after_record: 5,
        totals: {
          total: 6,
          overdue: 1,
          anomaly_rows: 2,
          missing_owner: 1,
          missing_due_date: 1,
          invalid_status: 1,
          invalid_due_date: 1,
        },
        records: [
          { record_number: 1, task_id: '001' },
          { record_number: 2 },
          { record_number: 3 },
          { record_number: 4 },
          { record_number: 5 },
        ],
      },
    });
    const page = await call(ctx, 'office_analyze_tasks', {
      action: 'page',
      analysis_invocation_id: accepted.invocationId,
      after_record: 5,
    });
    expect(page).toMatchObject({
      status: 'ok',
      result: {
        as_of: '2027-01-01',
        after_record: 5,
        records: [{ record_number: 6, task_id: '006' }],
        next_after_record: null,
      },
    });
    const hydrated = await ctx.ownership!.transaction((client) =>
      readRunContextObservations(client, ctx, [notes.invocationId, accepted.invocationId], {
        project: true,
      }),
    );
    expect(hydrated).toMatchObject([
      {
        view: 'full',
        invocation_id: notes.invocationId,
        result: { status: 'ok', result: { content: notesText } },
      },
      {
        view: 'full',
        invocation_id: accepted.invocationId,
        result: { status: 'ok', result: { as_of: '2027-01-01' } },
      },
    ]);

    await expectIncompleteDeliveryDenied(ctx, notes.invocationId);
    const args = {
      formats: ['markdown', 'csv'],
      analysis_invocation_id: accepted.invocationId,
      notes_invocation_ids: [notes.invocationId],
      interpretation: '仅存在于工件中的解读',
    };
    const receipt = await call(ctx, 'office_create_artifacts', args);
    if (receipt.status !== 'ok' || receipt.result.kind !== 'office_create_artifacts')
      throw new Error('artifact receipt missing');
    expect(receipt.result.artifacts).toHaveLength(2);
    const again = await invokeTool(db.pool, ctx, {
      toolId: 'office_create_artifacts',
      invocationId: receipt.invocationId,
      args,
    });
    expect(again).toEqual({ ...receipt, replayed: true });
    expect(
      await call(ctx, 'office_create_artifacts', { ...args, formats: ['csv', 'markdown'] }),
    ).toMatchObject({ status: 'ok', result: receipt.result });
    expect(
      (await db.pool.query('SELECT 1 FROM office_artifacts WHERE scope_run_id=$1', [ctx.runId]))
        .rowCount,
    ).toBe(2);
    const ledger = await db.pool.query(
      `SELECT tool_id,accepted_result,args_hash,frozen_context FROM tool_invocations WHERE run_id=$1`,
      [ctx.runId],
    );
    expect(
      ledger.rows
        .filter(
          (row) => row.tool_id === 'office_read_notes' || row.tool_id === 'office_analyze_tasks',
        )
        .every((row) => row.accepted_result.encoding === 'along-office-aead/1'),
    ).toBe(true);
    const serialized = JSON.stringify(ledger.rows);
    for (const secret of [
      notesText,
      taskTitle,
      args.interpretation,
      'secret-notes.md',
      'secret-tasks.csv',
    ])
      expect(serialized).not.toContain(secret);

    const reminderArgs = { raw_time_text: '明天下午3点', note: '复查任务', occurrence: 'once' };
    const operations = await Promise.all([
      call(ctx, 'create_reminder', reminderArgs),
      call(ctx, 'create_reminder', reminderArgs),
    ]);
    expect(
      operations.filter(
        (outcome) => outcome.status === 'ok' && outcome.result.kind === 'task_created',
      ),
    ).toHaveLength(1);
    expect(
      operations.filter(
        (outcome) => outcome.status === 'denied' && outcome.error.code === 'STATE_CONFLICT',
      ),
    ).toHaveLength(1);
    expect(
      (await db.pool.query('SELECT 1 FROM tasks WHERE owner_id=$1', [ctx.ownerId])).rowCount,
    ).toBe(1);
    expect(
      (
        await db.pool.query('SELECT 1 FROM outbox WHERE idempotency_key=$1', [
          `office-reminder:${ctx.runId}`,
        ])
      ).rowCount,
    ).toBe(1);
    const history = await getConversationRuns(deps, ctx.ownerId, ctx.conversationId, {
      run_id: ctx.runId,
    });
    expect(history.items[0]?.office_materials?.reminder).toMatchObject({
      state: 'created',
      task_id: expect.any(String),
      current_status: expect.any(String),
    });

    process.env[keyName] = '';
    try {
      await expect(
        invokeTool(db.pool, ctx, {
          toolId: 'office_read_notes',
          invocationId: notes.invocationId,
          args: {},
        }),
      ).rejects.toMatchObject({ errorCode: 'FORBIDDEN' });
    } finally {
      process.env[keyName] = officeKey;
    }
    await storage.revokeAttachment({ ...binding, attachmentId: notesId });
    await expect(
      invokeTool(db.pool, ctx, {
        toolId: 'office_read_notes',
        invocationId: notes.invocationId,
        args: {},
      }),
    ).rejects.toMatchObject({ errorCode: 'OFFICE_MATERIALS_UNAVAILABLE' });
  });

  test('missing time zone cannot consume the combined delivery slot or cause a premature reminder', async () => {
    const { ctx } = await officeRun(request.replace('截至 2027-01-01 的', ''), false);
    const notes = await call(ctx, 'office_read_notes', {});
    expect(await call(ctx, 'office_analyze_tasks', { action: 'analyze' })).toMatchObject({
      status: 'denied',
      error: { code: 'OFFICE_TIMEZONE_REQUIRED' },
    });
    await expectIncompleteDeliveryDenied(ctx, notes.invocationId);
    expect(
      await call(ctx, 'create_reminder', {
        raw_time_text: '明天下午3点',
        note: '复查任务',
        occurrence: 'once',
      }),
    ).toMatchObject({ status: 'denied', error: { code: 'OFFICE_DELIVERY_REQUIRED' } });
    const pendingDelivery = await db.pool.query(
      'SELECT 1 FROM office_run_materials WHERE run_id=$1 AND delivery_run_id IS NOT NULL',
      [ctx.runId],
    );
    expect(pendingDelivery.rowCount).toBe(0);
    expect(
      (await db.pool.query('SELECT 1 FROM tasks WHERE owner_id=$1', [ctx.ownerId])).rowCount,
    ).toBe(0);
  });

  test('a timezone clarification does not occupy the reminder creation slot', async () => {
    const { ctx } = await officeRun(
      '请总结纪要，导出 Markdown 报告，并于明天下午3点提醒我复查任务。',
      false,
      true,
    );
    const notes = await call(ctx, 'office_read_notes', {});
    expect(
      await call(ctx, 'office_create_artifacts', {
        formats: ['markdown'],
        notes_invocation_ids: [notes.invocationId],
      }),
    ).toMatchObject({ status: 'ok', result: { kind: 'office_create_artifacts' } });
    const args = { raw_time_text: '明天下午3点', note: '复查任务', occurrence: 'once' };
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(await call(ctx, 'create_reminder', args)).toMatchObject({
        status: 'ok',
        result: { kind: 'clarify', reason: 'TIMEZONE_MISSING' },
      });
    }
    expect(
      (await db.pool.query('SELECT 1 FROM tasks WHERE owner_id=$1', [ctx.ownerId])).rowCount,
    ).toBe(0);
  });

  test('receipt write failure rolls back both formats and fences the failed lease', async () => {
    const { ctx } = await officeRun(request);
    const notes = await call(ctx, 'office_read_notes', {});
    const analysis = await call(ctx, 'office_analyze_tasks', { action: 'analyze' });
    const args = {
      formats: ['markdown', 'csv'],
      notes_invocation_ids: [notes.invocationId],
      analysis_invocation_id: analysis.invocationId,
    };
    const toolId = 'office_create_artifacts';
    const { invocationId } = await reserveToolInvocation(db.pool, ctx, {
      callKey: randomUUID(),
      toolId,
      args,
    });
    const before = await db.pool.query<{ count: number }>(
      'SELECT count(*)::integer AS count FROM office_artifacts WHERE content IS NOT NULL',
    );
    await db.pool.query(`
      CREATE FUNCTION reject_office_receipt_test() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected receipt failure'; END; $$;
      CREATE TRIGGER reject_office_receipt_test BEFORE UPDATE ON tool_invocations
      FOR EACH ROW WHEN (NEW.invocation_id = '${invocationId}'::uuid AND NEW.state='completed')
      EXECUTE FUNCTION reject_office_receipt_test()
    `);
    const create = () => invokeTool(db.pool, ctx, { toolId, invocationId, args });
    try {
      await expect(create()).rejects.toThrow('injected receipt failure');
      const { rows } = await db.pool.query(
        `SELECT delivery_run_id,delivery_params_sha256,
           (SELECT count(*)::integer FROM office_artifacts WHERE scope_run_id=$1) AS artifacts,
           (SELECT count(*)::integer FROM office_artifacts WHERE content IS NOT NULL) AS artifact_bytes
         FROM office_run_materials WHERE run_id=$1`,
        [ctx.runId],
      );
      expect(rows).toEqual([
        {
          delivery_run_id: null,
          delivery_params_sha256: null,
          artifacts: 0,
          artifact_bytes: before.rows[0]!.count,
        },
      ]);
      expect(
        (
          await db.pool.query(
            'SELECT state,accepted_result FROM tool_invocations WHERE invocation_id=$1',
            [invocationId],
          )
        ).rows,
      ).toEqual([{ state: 'reserved', accepted_result: null }]);
    } finally {
      await db.pool.query(
        'DROP TRIGGER reject_office_receipt_test ON tool_invocations; DROP FUNCTION reject_office_receipt_test()',
      );
    }
    await expect(create()).rejects.toThrow('Run ownership lost');
  });
});
