import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { HarnessR3SnapshotSchema, type HarnessSnapshot } from '@along/contracts';
import {
  continueConversationPause,
  requestConversationPause,
} from '../../src/agent/operations/pause.js';
import { startConversationRun } from '../../src/agent/operations/start.js';
import { createHarnessSession } from '../../src/agent/runtime/attempt-session.js';
import type { ConversationDeps } from '../../src/agent/runtime/contracts.js';
import { withTransaction } from '../../src/db/transaction.js';
import {
  createContextPolicy,
  decodeRunSnapshot,
  encodeRunSnapshot,
  readLatestRunSnapshotPayload,
  readRunSnapshotPayload,
  writeHarnessSnapshotWithinTransaction,
} from '../../src/features/conversations/public.js';
import { measureSdkContext } from '../../src/features/model-providers/public.js';
import { loadTimeContext } from '../../src/features/time/public.js';
import { createApp } from '../../src/http/app.js';
import { httpTestDeps } from '../helpers/http-app.js';
import { configureTestModel } from '../helpers/model-selection.js';
import {
  createIntegrationDatabase,
  databaseUrl,
  seedAdmittedSession,
  type IntegrationDatabase,
} from './setup.js';

const suite = databaseUrl ? describe : describe.skip;
const configEnv = 'FEISHU_BOT_DOCX_CONFIG';
const secretEnv = 'TEST_PRIVATE_SNAPSHOT_BOT_SECRET';
const observationKeyEnv = 'TEST_PRIVATE_SNAPSHOT_OBSERVATION_KEY';
const url = `https://synthetic.feishu.cn/docx/${'A'.repeat(27)}`;
const appId = 'cli_123456789abc';
const officeKeyEnv = 'ALONG_OFFICE_OBSERVATION_KEY';

suite('private Harness snapshots', () => {
  let db: IntegrationDatabase;
  beforeAll(async () => {
    db = await createIntegrationDatabase();
  });
  afterAll(async () => {
    await db?.close();
  });

  test('seals private checkpoint, pause and compact data; denies bad bindings and revoked grants', async () => {
    const priorEnv = new Map(
      [configEnv, secretEnv, observationKeyEnv].map((name) => [name, process.env[name]] as const),
    );
    const { userId: ownerId, sessionId } = await seedAdmittedSession(db.pool);
    const [conversationId, runId, legacyRunId, attemptId, legacyAttemptId, pauseId, messageId] =
      Array.from({ length: 7 }, () => randomUUID());
    const binding = { ownerId, conversationId, runId, attemptId };
    const grant = {
      kind: 'feishu-docx-bot/1',
      appId,
      url,
      sessionId,
      connectionId: randomUUID(),
      generation: randomUUID(),
      revision: randomUUID(),
    };
    const frozen = { execution_profile: 'compact-memory/1', execution_lifecycle: 'request-bound' };
    const legacy = { ...binding, runId: legacyRunId, attemptId: legacyAttemptId };
    const snapshot: HarnessSnapshot = {
      version: 2,
      message_refs: [messageId],
      tool_refs: [],
      next_call_no: 1,
      usage: { iterations: 0, tokens: 0 },
      waiting: null,
    };
    const pause = { ...binding, kind: 'pause' as const, id: pauseId };
    const continuation = { ...pause, kind: 'compact-snapshot' as const };
    const continuationContext = { ...pause, kind: 'compact-context' as const };
    const privateText = 'synthetic-private-snapshot';
    const large = { content: privateText + 'x'.repeat(800_000) };
    try {
      const configured = JSON.stringify({
        ownerId,
        appId,
        connectionId: grant.connectionId,
        revision: grant.revision,
        secretEnv,
        observationKeyEnv,
        documents: [url],
      });
      process.env[configEnv] = configured;
      process.env[secretEnv] = 'synthetic-test-secret';
      process.env[observationKeyEnv] = randomBytes(32).toString('base64');
      const stored = await withTransaction(db.pool, async (client) => {
        await client.query('INSERT INTO conversations(id,owner_id) VALUES($1,$2)', [
          conversationId,
          ownerId,
        ]);
        await client.query(
          `INSERT INTO messages(id,owner_id,conversation_id,role,content) VALUES($1,$2,$3,'user','synthetic')`,
          [messageId, ownerId, conversationId],
        );
        for (const [run, attempt, frozenContext] of [
          [runId, attemptId, { ...frozen, feishuDocx: grant }],
          [legacyRunId, legacyAttemptId, frozen],
        ] as const) {
          await client.query(
            `INSERT INTO agent_runs(id,owner_id,conversation_id,agent_revision,mode,status,
               budget_max_iterations,budget_max_tokens,execution,input_message_id,frozen_context)
             VALUES($1,$2,$3,'test','chat','paused',10,10000,'harness',$4,$5::jsonb)`,
            [run, ownerId, conversationId, messageId, JSON.stringify(frozenContext)],
          );
          await client.query(
            `INSERT INTO run_attempts(id,owner_id,run_id,attempt_no,status) VALUES($1,$2,$3,1,'done')`,
            [attempt, ownerId, run],
          );
        }
        await client.query(
          `INSERT INTO feishu_bot_connections(owner_id,attempt_id,expires_at,app_id,bot_name)
           VALUES($1,$2,now()+interval '1 day',$3,'synthetic')`,
          [ownerId, grant.generation, appId],
        );
        const checkpointId = await writeHarnessSnapshotWithinTransaction(
          client,
          binding,
          snapshot,
          'harness/v2',
        );
        const legacyId = await writeHarnessSnapshotWithinTransaction(
          client,
          legacy,
          snapshot,
          'harness/v2',
        );
        const raw = await client.query<{ id: string; payload: unknown }>(
          'SELECT id,payload FROM run_checkpoints WHERE id IN ($1,$2)',
          [checkpointId, legacyId],
        );
        expect(raw.rows.find(({ id }) => id === checkpointId)?.payload).toMatchObject({
          encoding: 'feishu-snapshot-aead/1',
        });
        expect(raw.rows.find(({ id }) => id === legacyId)?.payload).toEqual(snapshot);
        const sealedPause = await encodeRunSnapshot(client, pause, { content: privateText });
        const sealedSnapshot = await encodeRunSnapshot(client, continuation, large);
        const sealedContext = await encodeRunSnapshot(client, continuationContext, large);
        expect(sealedPause).not.toContain(privateText);
        expect(sealedSnapshot).not.toContain(privateText);
        expect(sealedContext).not.toContain(privateText);
        expect(Buffer.byteLength(sealedSnapshot)).toBeGreaterThan(1024 * 1024);
        await client.query(
          `INSERT INTO harness_pauses(id,owner_id,conversation_id,run_id,attempt_id,idempotency_key,
             reason,purpose,resume_source,state,snapshot)
           VALUES($1,$2,$3,$4,$5,$1,'runtime','manual_compact','runtime','paused',$6::jsonb)`,
          [pauseId, ownerId, conversationId, runId, attemptId, sealedPause],
        );
        await client.query(
          `INSERT INTO compact_operations(pause_id,owner_id,conversation_id,run_id,attempt_id,status)
           VALUES($1,$2,$3,$4,$5,'pending')`,
          [pauseId, ownerId, conversationId, runId, attemptId],
        );
        await client.query(
          `INSERT INTO compact_continuations(pause_id,attempt_id,snapshot,context) VALUES($1,$2,$3::jsonb,$4::jsonb)`,
          [pauseId, attemptId, sealedSnapshot, sealedContext],
        );
        return { checkpointId, legacyId };
      });
      await withTransaction(db.pool, async (client) => {
        const {
          rows: [row],
        } = await client.query<{ pause: unknown; snapshot: unknown; context: unknown }>(
          `SELECT p.snapshot AS pause,c.snapshot,c.context FROM harness_pauses p
           JOIN compact_continuations c ON c.pause_id=p.id WHERE p.id=$1`,
          [pauseId],
        );
        expect(await readRunSnapshotPayload(client, binding, stored.checkpointId)).toEqual(
          snapshot,
        );
        expect(await readLatestRunSnapshotPayload(client, binding)).toEqual({ payload: snapshot });
        expect(await decodeRunSnapshot(client, pause, row!.pause)).toEqual({
          content: privateText,
        });
        expect(await decodeRunSnapshot(client, continuation, row!.snapshot)).toEqual(large);
        expect(await decodeRunSnapshot(client, continuationContext, row!.context)).toEqual(large);
        await expect(decodeRunSnapshot(client, continuationContext, row!.snapshot)).rejects.toThrow(
          'invalid private snapshot ciphertext',
        );
        await expect(
          decodeRunSnapshot(client, { ...pause, id: randomUUID() }, row!.pause),
        ).rejects.toThrow('invalid private snapshot ciphertext');
        await expect(decodeRunSnapshot(client, pause, { content: privateText })).rejects.toThrow(
          'invalid private snapshot encoding',
        );
        await expect(decodeRunSnapshot(client, pause, { encoding: 'future/1' })).rejects.toThrow(
          'invalid private snapshot encoding',
        );
      });
      const reader = await db.pool.connect();
      try {
        await reader.query('BEGIN READ ONLY');
        expect(await readRunSnapshotPayload(reader, legacy, stored.legacyId)).toEqual(snapshot);
        await expect(readRunSnapshotPayload(reader, binding, stored.checkpointId)).rejects.toThrow(
          'private snapshot authorization unavailable',
        );
      } finally {
        await reader.query('ROLLBACK');
        reader.release();
      }
      const readPrivate = () =>
        withTransaction(db.pool, (client) =>
          readRunSnapshotPayload(client, binding, stored.checkpointId),
        );
      delete process.env[configEnv];
      await expect(readPrivate()).rejects.toThrow('private snapshot authorization unavailable');
      expect(
        await withTransaction(db.pool, (client) =>
          readRunSnapshotPayload(client, legacy, stored.legacyId),
        ),
      ).toEqual(snapshot);
      process.env[configEnv] = configured;
      await db.pool.query('UPDATE feishu_bot_connections SET attempt_id=$1 WHERE owner_id=$2', [
        randomUUID(),
        ownerId,
      ]);
      await expect(readPrivate()).rejects.toThrow('private snapshot authorization unavailable');
      await db.pool.query('UPDATE feishu_bot_connections SET attempt_id=$1 WHERE owner_id=$2', [
        grant.generation,
        ownerId,
      ]);
      await db.pool.query('UPDATE sessions SET revoked_at=now() WHERE id=$1', [sessionId]);
      await expect(readPrivate()).rejects.toThrow('private snapshot authorization unavailable');
    } finally {
      for (const [name, value] of priorEnv) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  test('persists only Along envelopes for office checkpoint, pause and compact recovery', async () => {
    const priorKey = process.env[officeKeyEnv];
    const { userId: ownerId } = await seedAdmittedSession(db.pool);
    const [conversationId, runId, attemptId, resumedAttemptId, pauseId, messageId, attachmentId] =
      Array.from({ length: 7 }, () => randomUUID());
    const binding = { ownerId, conversationId, runId, attemptId };
    const pause = { ...binding, id: pauseId, kind: 'pause' as const };
    const continuation = {
      ...pause,
      attemptId: resumedAttemptId,
      kind: 'compact-snapshot' as const,
    };
    const compactContext = { ...continuation, kind: 'compact-context' as const };
    const privateText = 'synthetic-office-notes-待核对';
    const snapshot = HarnessR3SnapshotSchema.parse({
      version: 4,
      original_manifest: { message_ids: [] },
      original_summary: null,
      context: {
        manifest: { message_ids: [] },
        summary: null,
        messages: [],
        input: { type: 'user', message_id: messageId, content: privateText },
      },
      tool_refs: [],
      next_call_no: 1,
      usage: { iterations: 1, tokens: null },
      waiting: null,
      native_state: {
        protected_messages: [],
        history_index: 0,
        units: [],
        hard_denied: '',
        closing_goal: false,
        pending_model: { content: privateText, tool_calls: [] },
      },
    });
    type Sealed = { encoding: string; ciphertext: string };
    const encoding = 'along-office-snapshot-aead/1';
    const officeMaterials = [
      {
        attachmentId,
        role: 'notes',
        filename: 'synthetic.txt',
        format: 'txt',
        sha256: 'a'.repeat(64),
        sizeBytes: Buffer.byteLength(privateText),
        expiresAt: '2027-01-01T00:00:00Z',
      },
    ];

    try {
      const key = randomBytes(32).toString('base64');
      process.env[officeKeyEnv] = key;
      const { checkpointId, invalidBindings, legacyBinding } = await withTransaction(
        db.pool,
        async (client) => {
          await client.query('INSERT INTO conversations(id,owner_id) VALUES($1,$2)', [
            conversationId,
            ownerId,
          ]);
          await client.query(
            `INSERT INTO messages(id,owner_id,conversation_id,role,content) VALUES($1,$2,$3,'user','synthetic')`,
            [messageId, ownerId, conversationId],
          );
          const insertRun = async (id: string, frozen: Record<string, unknown>) => {
            await client.query(
              `INSERT INTO agent_runs(id,owner_id,conversation_id,agent_revision,mode,status,
               budget_max_iterations,budget_max_tokens,execution,input_message_id,frozen_context)
             VALUES($1,$2,$3,'test','chat','paused',10,10000,'harness',$4,$5::jsonb)`,
              [
                id,
                ownerId,
                conversationId,
                messageId,
                JSON.stringify({
                  execution_profile: 'compact-memory/1',
                  execution_lifecycle: 'request-bound',
                  ...frozen,
                }),
              ],
            );
          };
          const insertFixture = async (frozen: Record<string, unknown>) => {
            const fixture = { ...pause, runId: randomUUID(), attemptId: randomUUID() };
            await insertRun(fixture.runId, frozen);
            await client.query(
              `INSERT INTO run_attempts(id,owner_id,run_id,attempt_no,status)
             VALUES($1,$2,$3,1,'done')`,
              [fixture.attemptId, ownerId, fixture.runId],
            );
            return fixture;
          };
          await insertRun(runId, { officeMaterials });
          await client.query(
            `INSERT INTO run_attempts(id,owner_id,run_id,attempt_no,status)
           VALUES($1,$2,$3,1,'done'),($4,$2,$3,2,'running')`,
            [attemptId, ownerId, runId, resumedAttemptId],
          );
          const checkpoint = await writeHarnessSnapshotWithinTransaction(
            client,
            binding,
            snapshot,
            'harness/v8',
          );
          const sealedPause = await encodeRunSnapshot(client, pause, snapshot);
          const sealedSnapshot = await encodeRunSnapshot(client, continuation, snapshot);
          const sealedContext = await encodeRunSnapshot(client, compactContext, snapshot.context);
          await client.query(
            `INSERT INTO harness_pauses(id,owner_id,conversation_id,run_id,attempt_id,idempotency_key,
             reason,purpose,resume_source,state,snapshot)
           VALUES($1,$2,$3,$4,$5,$1,'runtime','manual_compact','runtime','paused',$6::jsonb)`,
            [pauseId, ownerId, conversationId, runId, attemptId, sealedPause],
          );
          await client.query(
            `INSERT INTO compact_operations(pause_id,owner_id,conversation_id,run_id,attempt_id,status)
           VALUES($1,$2,$3,$4,$5,'pending')`,
            [pauseId, ownerId, conversationId, runId, attemptId],
          );
          await client.query(
            `INSERT INTO compact_continuations(pause_id,attempt_id,snapshot,context)
           VALUES($1,$2,$3::jsonb,$4::jsonb)`,
            [pauseId, resumedAttemptId, sealedSnapshot, sealedContext],
          );
          const invalidBindings = [
            {
              binding: await insertFixture({
                officeMaterials,
                feishuDocx: { kind: 'feishu-docx-bot/1' },
              }),
              error: 'conflicting private snapshot authorities',
            },
          ];
          for (const malformed of [null, [], {}]) {
            invalidBindings.push({
              binding: await insertFixture({ officeMaterials: malformed }),
              error: 'invalid office snapshot authority',
            });
          }
          return {
            checkpointId: checkpoint,
            invalidBindings,
            legacyBinding: await insertFixture({}),
          };
        },
      );
      await withTransaction(db.pool, async (client) => {
        const {
          rows: [row],
        } = await client.query<{
          checkpoint: Sealed;
          pause: Sealed;
          snapshot: Sealed;
          context: Sealed;
        }>(
          `SELECT k.payload AS checkpoint,p.snapshot AS pause,c.snapshot,c.context
           FROM harness_pauses p JOIN compact_continuations c ON c.pause_id=p.id
           JOIN run_checkpoints k ON k.id=$2 WHERE p.id=$1`,
          [pauseId, checkpointId],
        );
        const stored = row!;
        for (const envelope of Object.values(stored)) {
          expect(envelope).toEqual({ encoding, ciphertext: expect.any(String) });
          expect(JSON.stringify(envelope)).not.toContain(privateText);
        }
        expect(await readRunSnapshotPayload(client, binding, checkpointId)).toEqual(snapshot);
        expect(await readLatestRunSnapshotPayload(client, binding)).toEqual({ payload: snapshot });
        expect(await decodeRunSnapshot(client, pause, stored.pause)).toEqual(snapshot);
        expect(await decodeRunSnapshot(client, continuation, stored.snapshot)).toEqual(snapshot);
        expect(await decodeRunSnapshot(client, compactContext, stored.context)).toEqual(
          snapshot.context,
        );

        for (const moved of [
          { ...pause, attemptId: resumedAttemptId },
          { ...pause, id: randomUUID() },
          { ...pause, kind: 'compact-snapshot' as const },
        ]) {
          await expect(decodeRunSnapshot(client, moved, stored.pause)).rejects.toThrow(
            'invalid private snapshot ciphertext',
          );
        }
        for (const field of ['ownerId', 'conversationId', 'runId'] as const) {
          await expect(
            decodeRunSnapshot(client, { ...pause, [field]: randomUUID() }, stored.pause),
          ).rejects.toThrow('snapshot Run binding unavailable');
        }

        const tampered = Buffer.from(stored.pause.ciphertext, 'base64');
        tampered.writeUInt8(tampered.readUInt8(tampered.length - 1) ^ 1, tampered.length - 1);
        await expect(
          decodeRunSnapshot(client, pause, { encoding, ciphertext: tampered.toString('base64') }),
        ).rejects.toThrow('invalid private snapshot ciphertext');
        for (const unsealed of [
          snapshot,
          { ...stored.pause, encoding: 'feishu-snapshot-aead/1' },
          { ...stored.pause, ciphertext: `${stored.pause.ciphertext}\n` },
        ]) {
          await expect(decodeRunSnapshot(client, pause, unsealed)).rejects.toThrow(
            'invalid private snapshot encoding',
          );
        }

        delete process.env[officeKeyEnv];
        await expect(encodeRunSnapshot(client, pause, snapshot)).rejects.toThrow(
          'private snapshot key unavailable',
        );
        await expect(readRunSnapshotPayload(client, binding, checkpointId)).rejects.toThrow(
          'private snapshot key unavailable',
        );
        process.env[officeKeyEnv] = randomBytes(32).toString('base64');
        await expect(decodeRunSnapshot(client, pause, stored.pause)).rejects.toThrow(
          'invalid private snapshot ciphertext',
        );
        process.env[officeKeyEnv] = key;

        for (const { binding: invalidBinding, error } of invalidBindings) {
          await expect(encodeRunSnapshot(client, invalidBinding, snapshot)).rejects.toThrow(error);
          await expect(decodeRunSnapshot(client, invalidBinding, snapshot)).rejects.toThrow(error);
        }
        await expect(decodeRunSnapshot(client, legacyBinding, stored.pause)).rejects.toThrow(
          'invalid private snapshot encoding',
        );
      });
      const reader = await db.pool.connect();
      try {
        await reader.query('BEGIN READ ONLY');
        await expect(readRunSnapshotPayload(reader, binding, checkpointId)).rejects.toThrow(
          'private snapshot authorization unavailable',
        );
      } finally {
        await reader.query('ROLLBACK');
        reader.release();
      }
    } finally {
      if (priorKey === undefined) delete process.env[officeKeyEnv];
      else process.env[officeKeyEnv] = priorKey;
    }
  });

  test('missing only the observation key preserves public history and cancellation, but not private continuation', async () => {
    const priorEnv = new Map(
      ['APP_ORIGIN', configEnv, secretEnv, observationKeyEnv].map(
        (name) => [name, process.env[name]] as const,
      ),
    );
    const actor = await seedAdmittedSession(db.pool);
    const appId = 'cli_keylesssnapshot';
    const ownerId = actor.userId;
    const model = 'keyless-fixture';
    const delivered = 'Already delivered synthetic text.';
    const makeDeps = () =>
      ({
        pool: db.pool,
        timeContext: loadTimeContext('fixture-v1'),
        harness: {
          binaryPath: '/unused',
          maxIterations: 10,
          maxTokens: 8000,
          contextPolicy: createContextPolicy({ completionCap: 512, model }),
        },
        modelTransport: async () => ({
          measure: measureSdkContext,
          model: async function* () {
            yield { type: 'delta', delta: delivered };
            yield {
              type: 'complete',
              reply: { message: { content: delivered, tool_calls: [] }, usage: null },
            };
          },
        }),
      }) satisfies ConversationDeps;
    try {
      await configureTestModel(db.pool, ownerId, model);
      process.env.APP_ORIGIN = 'http://localhost:3000';
      process.env[configEnv] = JSON.stringify({
        ownerId,
        appId,
        connectionId: randomUUID(),
        revision: randomUUID(),
        secretEnv,
        observationKeyEnv,
        documents: [url],
      });
      process.env[secretEnv] = 'synthetic-test-secret';
      process.env[observationKeyEnv] = randomBytes(32).toString('base64');
      await db.pool.query(
        `INSERT INTO feishu_bot_connections(owner_id,attempt_id,expires_at,app_id,bot_name)
         VALUES($1,$2,now()+interval '1 day',$3,'synthetic')`,
        [ownerId, randomUUID(), appId],
      );
      const beforeRestart = makeDeps();
      async function admit(rawText: string) {
        const { context } = await startConversationRun(
          beforeRestart,
          ownerId,
          randomUUID(),
          { execution: 'harness', authorization_revision: 'delegation/1', raw_text: rawText },
          null,
          actor.sessionId,
        );
        const userMessageId = context?.userMessageId;
        if (!context || !userMessageId) throw new Error('fixture Run unavailable');
        return { ...context, userMessageId };
      }
      async function park(rawText: string, privateRun: boolean) {
        const context = await admit(rawText);
        expect(Boolean(context.feishuDocx)).toBe(privateRun);
        const session = await createHarnessSession(
          beforeRestart,
          context,
          async () => true,
          new AbortController().signal,
        );
        try {
          const frame = () => ({ protocol: session.start.protocol, request_ref: randomUUID() });
          expect(await session.handleRequest({ ...frame(), type: 'pause_probe' })).toEqual({
            pending: false,
          });
          const modelRequest = {
            ...frame(),
            type: 'model' as const,
            messages: [{ role: 'user' as const, content: rawText }],
            remaining_tokens: context.maxTokens,
            max_output_tokens: 32,
          };
          expect(await session.handleRequest(modelRequest)).toEqual({
            type: 'delta',
            delta: delivered,
          });
          expect(
            await session.handleRequest({ ...frame(), type: 'answer', delta: delivered }),
          ).toEqual({ accepted: true });
          expect(
            await session.handleRequest({
              ...frame(),
              type: 'model_next',
              model_ref: modelRequest.request_ref,
            }),
          ).toMatchObject({ type: 'complete' });
          const { pause_id } = await requestConversationPause(
            beforeRestart,
            ownerId,
            context.conversationId,
            context.runId,
            { reason: 'user', purpose: 'none' },
            randomUUID(),
          );
          expect(
            await session.handleRequest({
              ...frame(),
              type: 'pause_point',
              context: {
                version: 3,
                message_refs: [context.userMessageId],
                tool_refs: [],
                next_call_no: 1,
                usage: { iterations: 1, tokens: null },
                waiting: null,
                native_state: {
                  protected_messages: [],
                  units: [],
                  hard_denied: '',
                  closing_goal: false,
                  pending_model: null,
                },
              },
            }),
          ).toEqual({ paused: true });
          return { context, pause_id };
        } finally {
          await session.close();
        }
      }
      const privateRun = await park(`Read ${url}`, true);
      const ordinaryRun = await park('Ordinary request', false);

      const active = await admit(`Read ${url}`);
      const activeSession = await createHarnessSession(
        beforeRestart,
        active,
        async () => true,
        new AbortController().signal,
      );
      try {
        const protocol = activeSession.start.protocol;
        const usage = { iterations: 0, tokens: 0 };
        await activeSession.handleRequest({
          protocol,
          request_ref: randomUUID(),
          type: 'snapshot',
          context: {
            version: 2,
            message_refs: [active.userMessageId],
            tool_refs: [],
            next_call_no: 1,
            usage,
            waiting: null,
          },
        });
        delete process.env[observationKeyEnv];
        expect(
          await activeSession.handleRequest({
            protocol,
            request_ref: randomUUID(),
            type: 'finish',
            outcome: 'cancelled',
            usage,
          }),
        ).toEqual({ accepted: true });
      } finally {
        await activeSession.close();
      }

      const restarted = makeDeps();
      const app = createApp(httpTestDeps(restarted));
      const request = (path: string, body?: unknown, key = randomUUID()) =>
        app.handle(
          new Request(`http://localhost:3000/api/v1/conversations${path}`, {
            headers: {
              cookie: `better-auth.session_token=${actor.token}`,
              'x-csrf-token': actor.csrfToken,
              'content-type': 'application/json',
              'idempotency-key': key,
            },
            ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
          }),
        );
      const { conversationId, runId } = privateRun.context;
      const path = `/${conversationId}/runs/${runId}`;
      const view = await request(path);
      expect(view.status).toBe(200);
      expect(await view.json()).toMatchObject({ data: { status: 'paused', attempt_no: 1 } });
      const key = randomUUID();
      const denied = await request(
        `${path}/actions/continue`,
        { pause_id: privateRun.pause_id },
        key,
      );
      expect(denied.status).toBe(403);
      expect(await denied.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
      const waiting = await db.pool.query(
        `SELECT p.state,
          (SELECT count(*)::int FROM run_attempts WHERE run_id=p.run_id) AS attempts,
          (SELECT count(*)::int FROM harness_pause_resumes WHERE pause_id=p.id OR idempotency_key=$2) AS resumes
         FROM harness_pauses p WHERE p.id=$1`,
        [privateRun.pause_id, key],
      );
      expect(waiting.rows).toEqual([{ state: 'paused', attempts: 1, resumes: 0 }]);
      const cancel = await request(`${path}/actions/cancel`, { idempotency_key: randomUUID() });
      expect(cancel.status).toBe(200);
      expect(await cancel.json()).toMatchObject({ data: { status: 'cancelled', attempt_no: 1 } });
      const history = await request(`/${conversationId}?run_id=${runId}`);
      expect(history.status).toBe(200);
      expect(await history.json()).toMatchObject({
        data: {
          events: [
            { type: 'message.delta', payload: { delta: delivered } },
            { type: 'thread.cancelled' },
          ],
        },
      });

      const resumed = await continueConversationPause(
        restarted,
        ownerId,
        ordinaryRun.context.conversationId,
        ordinaryRun.context.runId,
        randomUUID(),
        { pause_id: ordinaryRun.pause_id },
        randomUUID(),
      );
      if (!resumed.context) throw new Error('ordinary continuation unavailable');
      const ordinary = await createHarnessSession(
        restarted,
        resumed.context,
        async () => true,
        new AbortController().signal,
      );
      try {
        expect(ordinary.start.snapshot?.usage).toEqual({ iterations: 1, tokens: null });
        expect(
          await ordinary.handleRequest({
            protocol: ordinary.start.protocol,
            request_ref: randomUUID(),
            type: 'finish_goal',
            usage: { iterations: 1, tokens: null },
            goal_result: {
              status: 'completed',
              outcomes: [
                { description: 'Ordinary request answered', status: 'achieved', receipt_refs: [] },
              ],
              clarification: null,
              answer: delivered,
            },
          }),
        ).toEqual({ accepted: true });
        const view = await request(`/${resumed.conversationId}/runs/${resumed.runId}`);
        expect(view.status).toBe(200);
        expect(await view.json()).toMatchObject({ data: { status: 'done', attempt_no: 2 } });
      } finally {
        await ordinary.close();
      }
    } finally {
      for (const [name, value] of priorEnv) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  }, 30_000);
});
