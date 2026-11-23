import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { startConversationRun } from '../../src/agent/operations/start.js';
import { createHarnessSession } from '../../src/agent/runtime/attempt-session.js';
import type { ConversationDeps, RunContext } from '../../src/agent/runtime/contracts.js';
import { RunOwnership } from '../../src/agent/runtime/run-ownership.js';
import { createContextPolicy } from '../../src/features/conversations/public.js';
import { withTransaction } from '../../src/db/transaction.js';
import {
  createOfficeStorage,
  writeOfficeDelivery,
  type WriteOfficeDelivery,
} from '../../src/features/native-office/storage/public.js';
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
const officeKey = Buffer.alloc(32, 182).toString('base64');

(databaseUrl ? describe : describe.skip)('native office transaction admission', () => {
  let db: IntegrationDatabase;
  let deps: ConversationDeps;
  const started: RunContext[] = [];
  const owners = new Set<RunOwnership>();
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
        maxIterations: 8,
        maxTokens: 8000,
        contextPolicy: createContextPolicy({ completionCap: 512, model: 'office-admission' }),
      },
      modelTransport: async () => {
        throw new Error('admission does not call the model');
      },
      runDriver: {
        async acquire(runId) {
          const ownership = await RunOwnership.tryAcquire(db.pool, runId);
          if (!ownership) throw new Error('owner unavailable');
          owners.add(ownership);
          return ownership;
        },
        async release(owner) {
          owners.delete(owner);
          await owner.close();
        },
        start(_deps, context) {
          started.push(context);
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

  async function stagedTasks() {
    const actor = await seedAdmittedSession(db.pool);
    // seedAdmittedSession supplies Asia/Shanghai by default. These workflows
    // model an owner who has not configured a timezone.
    await db.pool.query('UPDATE users SET timezone_id=NULL WHERE id=$1', [actor.userId]);
    await configureTestModel(db.pool, actor.userId, 'office-admission');
    const draftId = randomUUID();
    const attachment = await createOfficeStorage(db.pool).stageAttachment({
      ownerId: actor.userId,
      sessionId: actor.sessionId,
      draftId,
      idempotencyKey: randomUUID(),
      filename: 'tasks.csv',
      format: 'csv',
      bytes: Buffer.from(
        'task_id,title,owner,due_date,status\r\n1,private title,A,2027-01-01,todo\r\n',
      ),
    });
    const body = {
      execution: 'harness',
      authorization_revision: 'delegation/1',
      raw_text: '请分析所选任务表',
      office_materials: { draft_id: draftId, tasks_attachment_id: attachment.attachmentId },
    };
    return { actor, draftId, attachment, body };
  }

  async function assertDraftUnchanged(ownerId: string, attachmentId: string) {
    const result = await db.pool.query(
      `SELECT u.bound_conversation_id,(SELECT count(*)::integer FROM agent_runs WHERE owner_id=$1) AS runs,
        (SELECT count(*)::integer FROM messages WHERE owner_id=$1) AS messages,
        (SELECT count(*)::integer FROM conversations WHERE owner_id=$1) AS conversations,
        (SELECT count(*)::integer FROM conversation_idempotency WHERE owner_id=$1) AS receipts
       FROM office_attachments u WHERE u.owner_id=$1 AND u.id=$2`,
      [ownerId, attachmentId],
    );
    expect(result.rows).toEqual([
      { bound_conversation_id: null, runs: 0, messages: 0, conversations: 0, receipts: 0 },
    ]);
  }

  test('keeps files staged when disabled, request-bound, unsigned, or missing the snapshot key', async () => {
    const { actor, attachment, body } = await stagedTasks();
    const { userId, sessionId } = actor;
    const key = randomUUID();
    const start = (runtime: ConversationDeps, session: string | null, idem: string | null) =>
      startConversationRun(runtime, userId, randomUUID(), body, idem, session);

    delete process.env[gateName];
    try {
      await expect(start(deps, sessionId, key)).rejects.toMatchObject({
        errorCode: 'VALIDATION_ERROR',
      });
    } finally {
      process.env[gateName] = '1';
    }
    await expect(
      start(
        { pool: db.pool, timeContext: deps.timeContext, harness: deps.harness },
        sessionId,
        key,
      ),
    ).rejects.toMatchObject({ errorCode: 'VALIDATION_ERROR' });
    await expect(start(deps, sessionId, null)).rejects.toMatchObject({
      errorCode: 'VALIDATION_ERROR',
    });
    await expect(start(deps, null, key)).rejects.toMatchObject({ errorCode: 'FORBIDDEN' });
    delete process.env[keyName];
    try {
      await expect(start(deps, sessionId, key)).rejects.toMatchObject({ errorCode: 'FORBIDDEN' });
    } finally {
      process.env[keyName] = officeKey;
    }
    await assertDraftUnchanged(userId, attachment.attachmentId);

    const ordinary = await startConversationRun(
      deps,
      userId,
      randomUUID(),
      {
        raw_text: '普通请求',
        execution: 'harness',
        authorization_revision: 'delegation/1',
      },
      randomUUID(),
      sessionId,
    );
    const row = (
      await db.pool.query('SELECT frozen_context,tools_allowlist FROM agent_runs WHERE id=$1', [
        ordinary.runId,
      ])
    ).rows[0]!;
    expect(row.frozen_context).not.toHaveProperty('officeMaterials');
    expect(row.tools_allowlist).toContain('get_task');
    expect(row.tools_allowlist).not.toContain('office_analyze_tasks');
  });

  test('freezes selected metadata and consumes a draft once, even across concurrent retries', async () => {
    const { actor, draftId, attachment, body } = await stagedTasks();
    const { userId, sessionId } = actor;
    const key = randomUUID();
    const start = (request: unknown = body, idem = key, session = sessionId) =>
      startConversationRun(deps, userId, randomUUID(), request, idem, session);
    const [first, duplicate] = await Promise.all([start(), start()]);
    expect(duplicate.runId).toBe(first.runId);
    expect(started.filter(({ runId }) => runId === first.runId)).toHaveLength(1);
    const { rows } = await db.pool.query(
      `SELECT r.frozen_context,r.tools_allowlist,a.attempt_no,a.lease_token,
         m.session_id,m.draft_id,m.scope_run_id,i.attachment_id,i.sha256
       FROM agent_runs r JOIN run_attempts a ON a.run_id=r.id
       JOIN office_run_materials m ON m.run_id=r.id
       JOIN office_run_inputs i ON i.run_id=r.id WHERE r.id=$1`,
      [first.runId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      frozen_context: {
        authorization_revision: 'delegation/1',
        execution_lifecycle: 'server-owned',
        officeSessionId: sessionId,
        officeMaterials: [
          { role: 'tasks', attachmentId: attachment.attachmentId, sha256: rows[0]!.sha256 },
        ],
      },
      tools_allowlist: [
        'office_analyze_tasks',
        'office_create_artifacts',
        'get_user_prefs',
        'create_reminder',
      ],
      attempt_no: 1,
      session_id: sessionId,
      draft_id: draftId,
      scope_run_id: first.runId,
      attachment_id: attachment.attachmentId,
    });
    expect(rows[0]!.lease_token).not.toBeNull();
    expect(JSON.stringify(rows[0]!.frozen_context)).not.toContain('private title');
    await expect(start(body, randomUUID())).rejects.toMatchObject({
      errorCode: 'OFFICE_MATERIALS_UNAVAILABLE',
    });
    for (const selection of [
      { ...body.office_materials, draft_id: randomUUID() },
      { ...body.office_materials, tasks_attachment_id: randomUUID() },
      { draft_id: draftId, notes_attachment_id: attachment.attachmentId },
    ]) {
      await expect(start({ ...body, office_materials: selection })).rejects.toMatchObject({
        errorCode: 'STATE_CONFLICT',
      });
    }
    await createOfficeStorage(db.pool).revokeAttachment({
      ownerId: userId,
      sessionId,
      attachmentId: attachment.attachmentId,
    });
    const otherSession = randomUUID();
    await db.pool.query(
      `INSERT INTO sessions (id,user_id,token_hash,expires_at) VALUES ($1,$2,$3,now()+interval '1 hour')`,
      [otherSession, userId, randomUUID()],
    );
    delete process.env[gateName];
    delete process.env[keyName];
    try {
      expect(await start(body, key, otherSession)).toMatchObject({
        runId: first.runId,
        serverOwned: true,
        replay: null,
        context: null,
      });
    } finally {
      process.env[gateName] = '1';
      process.env[keyName] = officeKey;
    }
    const runs = await db.pool.query('SELECT id FROM agent_runs WHERE owner_id=$1', [userId]);
    expect(runs.rows).toEqual([{ id: first.runId }]);
  });

  // Controlled durable gateway outcomes; no model or gateway runs in this suite.
  async function acceptReceipt(
    context: RunContext,
    toolId: string,
    outcomeKind: 'success' | 'denied' | 'clarification',
    result: unknown,
  ) {
    const invocationId = randomUUID();
    await db.pool.query(
      `INSERT INTO tool_invocations (invocation_id,owner_id,conversation_id,run_id,call_key,
         first_attempt_id,first_request_id,tool_id,args_hash,args_bytes,execution_kind,frozen_context,
         state,outcome_kind,result_version,accepted_result,accepted_attempt_id,accepted_request_id,accepted_at)
       VALUES ($1::uuid,$2,$3,$4,$1::uuid::text,$5,'admission-test',$6,$7,0,'local','{}',
         'completed',$8,1,$9::jsonb,$5,'admission-test',clock_timestamp())`,
      [
        invocationId,
        context.ownerId,
        context.conversationId,
        context.runId,
        context.attemptId,
        toolId,
        'a'.repeat(64),
        outcomeKind,
        JSON.stringify(result),
      ],
    );
    return invocationId;
  }

  const timezoneDenied = {
    status: 'denied',
    error: { code: 'OFFICE_TIMEZONE_REQUIRED', message: 'Timezone required' },
  };

  for (const scenario of [
    {
      name: 'carries only verified manifest metadata for a reminder-only timezone gap',
      kind: 'valid',
    },
    {
      name: 'does not turn partially delivered analysis into a reminder-only continuation',
      kind: 'partial',
    },
    { name: 'does not carry a delivery receipt after its source was revoked', kind: 'revoked' },
  ] as const) {
    test(scenario.name, async () => {
      const unfinishedAnalysis = scenario.kind === 'partial';
      const { actor, attachment, body } = await stagedTasks();
      const { userId, sessionId } = actor;
      const first = await startConversationRun(
        deps,
        userId,
        randomUUID(),
        {
          ...body,
          raw_text: unfinishedAnalysis
            ? '请交付 Markdown 和 CSV 汇总，再提醒我明天下午三点查看。'
            : '请交付 Markdown 汇总，再提醒我明天下午三点查看。',
        },
        randomUUID(),
        sessionId,
      );
      const prior = started.find(({ runId }) => runId === first.runId)!;
      expect(prior.trustedExecutionContext?.timezone).toBeNull();
      const delivery: WriteOfficeDelivery = {
        ownerId: userId,
        conversationId: first.conversationId,
        runId: first.runId,
        sessionId,
        paramsSha256: 'c'.repeat(64),
        artifacts: [
          {
            filename: 'report.md',
            format: 'markdown',
            bytes: Buffer.from('private title'),
            sourceAttachmentIds: [attachment.attachmentId],
          },
        ],
      };
      const writeDelivery = () =>
        withTransaction(db.pool, (client) => writeOfficeDelivery(client, delivery));
      const [artifact] = await writeDelivery();
      const receipt = {
        status: 'ok',
        result: {
          kind: 'office_create_artifacts',
          artifacts: [
            {
              artifact_id: artifact!.artifactId,
              filename: artifact!.filename,
              format: artifact!.format,
              size_bytes: artifact!.sizeBytes,
            },
          ],
        },
      };
      const earlierDeliveryId = await acceptReceipt(
        prior,
        'office_create_artifacts',
        'success',
        receipt,
      );
      // A fresh invocation can reuse the same slot/manifest. Only one of the
      // equivalent accepted receipts was cited by the terminal goal.
      expect(await writeDelivery()).toEqual([artifact]);
      const deliveryId = await acceptReceipt(prior, 'office_create_artifacts', 'success', receipt);
      await acceptReceipt(prior, 'create_reminder', 'clarification', {
        status: 'ok',
        result: {
          kind: 'clarify',
          reason: 'TIMEZONE_MISSING',
          phrase_key: 'ASK_TIMEZONE',
          text: 'Confirm timezone',
        },
      });
      if (unfinishedAnalysis)
        await acceptReceipt(prior, 'office_analyze_tasks', 'denied', timezoneDenied);
      await db.pool.query(`UPDATE agent_runs SET status='done',goal_result=$2::jsonb WHERE id=$1`, [
        first.runId,
        JSON.stringify({
          status: 'partial',
          outcomes: [
            { description: 'private title', status: 'achieved', receipt_refs: [deliveryId] },
            { description: 'pending', status: 'blocked', receipt_refs: [] },
          ],
          clarification: { kind: 'timezone', question: 'Confirm timezone' },
          answer: 'private title',
        }),
      ]);
      if (scenario.kind === 'revoked') {
        await createOfficeStorage(db.pool).revokeAttachment({
          ownerId: userId,
          sessionId,
          attachmentId: attachment.attachmentId,
        });
      }
      const continuation = startConversationRun(
        deps,
        userId,
        randomUUID(),
        {
          conversation_id: first.conversationId,
          clarification_of_run_id: first.runId,
          raw_text: 'Asia/Shanghai',
          execution: 'harness',
          authorization_revision: 'delegation/1',
        },
        randomUUID(),
        sessionId,
      );
      if (scenario.kind !== 'valid') {
        await expect(continuation).rejects.toMatchObject({ errorCode: 'VALIDATION_ERROR' });
        expect(
          (
            await db.pool.query('SELECT 1 FROM office_run_materials WHERE scope_run_id=$1', [
              first.runId,
            ])
          ).rowCount,
        ).toBe(1);
      } else {
        const next = await continuation;
        const context = started.find(({ runId }) => runId === next.runId)!;
        expect(context.allowlist).toEqual(['get_user_prefs', 'create_reminder']);
        expect(context.trustedExecutionContext?.continuation).toMatchObject({
          run_id: first.runId,
          receipts: [
            { invocation_id: deliveryId, tool_id: 'office_create_artifacts', result: receipt },
          ],
        });
        expect(JSON.stringify(context.trustedExecutionContext?.continuation)).not.toContain(
          earlierDeliveryId,
        );
        expect(JSON.stringify(context.trustedExecutionContext?.continuation)).not.toContain(
          'private title',
        );
      }
    });
  }

  test('requires trusted timezone evidence and gives only one adjacent successor the original scope', async () => {
    const { actor, attachment, body } = await stagedTasks();
    const { userId, sessionId } = actor;
    const unrelatedText = 'unselected conversation history';
    const earlier = await startConversationRun(
      deps,
      userId,
      randomUUID(),
      {
        execution: 'harness',
        authorization_revision: 'delegation/1',
        raw_text: unrelatedText,
      },
      randomUUID(),
      sessionId,
    );
    await deps.runDriver!.release(started.find(({ runId }) => runId === earlier.runId)!.ownership!);
    const first = await startConversationRun(
      deps,
      userId,
      randomUUID(),
      { ...body, conversation_id: earlier.conversationId },
      randomUUID(),
      sessionId,
    );
    const original = started.find(({ runId }) => runId === first.runId)!;
    expect(original.trustedExecutionContext?.timezone).toBeNull();
    const originalSession = await createHarnessSession(
      deps,
      original,
      async () => true,
      new AbortController().signal,
    );
    const originalStart = originalSession.start;
    await originalSession.close();
    const goal = {
      status: 'blocked',
      outcomes: [{ description: 'private title', status: 'blocked', receipt_refs: [] }],
      clarification: { kind: 'timezone', question: 'private title' },
      answer: 'private title',
    };
    await db.pool.query(`UPDATE agent_runs SET status='done',goal_result=$2::jsonb WHERE id=$1`, [
      first.runId,
      JSON.stringify(goal),
    ]);
    const followup = {
      conversation_id: first.conversationId,
      clarification_of_run_id: first.runId,
      execution: 'harness',
      authorization_revision: 'delegation/1',
      raw_text: 'Asia/Shanghai',
    };
    const start = (key: string, input: unknown = followup) =>
      startConversationRun(deps, userId, randomUUID(), input, key, sessionId);
    const key = randomUUID();
    await expect(start(key)).rejects.toMatchObject({ errorCode: 'VALIDATION_ERROR' });

    const invocationId = await acceptReceipt(
      original,
      'office_analyze_tasks',
      'denied',
      timezoneDenied,
    );
    await expect(
      start(key, { ...followup, raw_text: 'Asia/Shanghai and create another file' }),
    ).rejects.toMatchObject({ errorCode: 'VALIDATION_ERROR' });
    const otherSessionId = randomUUID();
    await db.pool.query(
      `INSERT INTO sessions (id,user_id,token_hash,expires_at) VALUES ($1,$2,$3,now()+interval '1 hour')`,
      [otherSessionId, userId, randomUUID()],
    );
    await expect(
      startConversationRun(deps, userId, randomUUID(), followup, key, otherSessionId),
    ).rejects.toMatchObject({ errorCode: 'VALIDATION_ERROR' });
    const results = await Promise.allSettled([start(key), start(randomUUID())]);
    const success = results.filter((entry) => entry.status === 'fulfilled');
    expect(success).toHaveLength(1);
    const next = success[0]!.value;
    const { rows } = await db.pool.query(
      `SELECT r.frozen_context,m.scope_run_id,m.previous_run_id,m.session_id,
         (SELECT count(*)::integer FROM office_run_inputs WHERE attachment_id=$2) AS consumption_count
       FROM agent_runs r JOIN office_run_materials m ON m.run_id=r.id WHERE r.id=$1`,
      [next.runId, attachment.attachmentId],
    );
    expect(rows[0]).toMatchObject({
      scope_run_id: first.runId,
      previous_run_id: first.runId,
      session_id: sessionId,
      consumption_count: 1,
      frozen_context: {
        officeSessionId: sessionId,
        officeMaterials: original.officeMaterials,
        anchorReceivedAtUtc: original.anchorReceivedAtUtc,
        confirmedTimezone: 'Asia/Shanghai',
        trustedExecutionContext: {
          request_anchor_utc: original.anchorReceivedAtUtc,
          continuation: {
            run_id: first.runId,
            invocation_id: invocationId,
            original_text: body.raw_text,
          },
        },
      },
    });
    expect(JSON.stringify(rows[0]!.frozen_context)).not.toContain('private title');
    const successor = started.find(({ runId }) => runId === next.runId)!;
    const successorSession = await createHarnessSession(
      deps,
      successor,
      async () => true,
      new AbortController().signal,
    );
    try {
      for (const [frame, context, content, continuation] of [
        [originalStart, original, body.raw_text, null],
        [
          successorSession.start,
          successor,
          followup.raw_text,
          { run_id: first.runId, invocation_id: invocationId, original_text: body.raw_text },
        ],
      ] as const) {
        expect(frame).toMatchObject({
          protocol: 'harness/v8',
          r3_context: {
            manifest: { message_ids: [] },
            messages: [],
            summary: null,
            input: { type: 'user', message_id: context.userMessageId, content },
          },
          trusted_context: { continuation },
        });
        expect(JSON.stringify(frame)).not.toContain(unrelatedText);
      }
    } finally {
      await successorSession.close();
    }
  });
});
