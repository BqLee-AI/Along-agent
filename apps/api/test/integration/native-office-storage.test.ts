import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { withTransaction } from '../../src/db/transaction.js';
import {
  assertOfficeSources,
  consumeOfficeAttachments,
  continueOfficeAttachments,
  createOfficeStorage,
  prepareOfficeAttachments,
  readOfficeAttachment,
  writeOfficeDelivery,
  type OfficeExecution,
  type StageOfficeAttachment,
  type WriteOfficeDelivery,
} from '../../src/features/native-office/storage/public.js';
import { getConversationRuns } from '../../src/features/conversations/history/history-service.js';
import { createIntegrationDatabase, databaseUrl, seedAdmittedSession } from './setup.js';
import { startWorkerLoop } from '../../src/worker/loop.js';

const integrationTest = databaseUrl ? test : test.skip;
const NOT_FOUND = { code: 404, errorCode: 'NOT_FOUND' };
const UNAVAILABLE = { errorCode: 'OFFICE_MATERIALS_UNAVAILABLE' };
const CONFLICT = { errorCode: 'IDEMPOTENCY_CONFLICT' };
const QUOTA = { errorCode: 'OFFICE_QUOTA_EXCEEDED' };

async function owner(pool: Pool) {
  const { userId: ownerId, sessionId } = await seedAdmittedSession(pool);
  return { ownerId, sessionId };
}

async function relogin(pool: Pool, ownerId: string) {
  const sessionId = randomUUID();
  await pool.query(
    `INSERT INTO sessions (id, user_id, token_hash, expires_at)
     VALUES ($1, $2, $3, statement_timestamp() + interval '1 hour')`,
    [sessionId, ownerId, randomUUID()],
  );
  return { ownerId, sessionId };
}

async function conversation(pool: Pool, ownerId: string) {
  const id = randomUUID();
  await pool.query('INSERT INTO conversations (id, owner_id) VALUES ($1, $2)', [id, ownerId]);
  return id;
}

async function createAdmission(client: PoolClient, input: OfficeExecution) {
  const { conversationId, runId, ownerId } = input;
  const messageId = randomUUID();
  await client.query(
    `INSERT INTO messages (id, owner_id, conversation_id, role, content, request_id)
     VALUES ($1, $2, $3, 'user', 'Selected material', $4)`,
    [messageId, ownerId, conversationId, runId],
  );
  await client.query(
    `INSERT INTO agent_runs (id, owner_id, conversation_id, agent_revision, mode,
       budget_max_iterations, budget_max_tokens, execution, input_message_id, frozen_context)
     VALUES ($1, $2, $3, 'test', 'chat', 5, 10000, 'harness', $4, '{}')`,
    [runId, ownerId, conversationId, messageId],
  );
  await client.query(
    'INSERT INTO run_attempts (id, owner_id, run_id, attempt_no) VALUES ($1, $2, $3, 1)',
    [randomUUID(), ownerId, runId],
  );
}

function upload(
  actor: { ownerId: string; sessionId: string },
  draftId: string = randomUUID(),
): StageOfficeAttachment {
  return {
    ...actor,
    draftId,
    idempotencyKey: randomUUID(),
    filename: '单次纪要.md',
    format: 'markdown',
    bytes: Buffer.from('纪要\r\nLine two'),
  };
}

integrationTest(
  'office upload scopes keys and hides unauthorized drafts, conversations and revokes',
  async () => {
    const db = await createIntegrationDatabase();
    try {
      const storage = createOfficeStorage(db.pool);
      const alice = await owner(db.pool);
      const bob = await owner(db.pool);
      const otherLogin = await relogin(db.pool, alice.ownerId);
      const convo = await conversation(db.pool, alice.ownerId);
      const otherConvo = await conversation(db.pool, alice.ownerId);
      const original = { ...upload(alice), conversationId: convo };
      await expect(storage.stageAttachment({ ...original, ...bob })).rejects.toMatchObject(
        NOT_FOUND,
      );
      const [file, sameFile] = await Promise.all([
        storage.stageAttachment(original),
        storage.stageAttachment(original),
      ]);
      expect(file).toEqual(sameFile);
      expect(file.status).toBe('available');
      await expect(
        storage.stageAttachment({ ...original, bytes: Buffer.from('different') }),
      ).rejects.toMatchObject(CONFLICT);
      await expect(
        storage.stageAttachment({ ...original, filename: 'other.md' }),
      ).rejects.toMatchObject(CONFLICT);
      await expect(
        storage.stageAttachment({ ...original, conversationId: otherConvo }),
      ).rejects.toMatchObject(CONFLICT);
      expect((await storage.stageAttachment({ ...original, ...otherLogin })).attachmentId).not.toBe(
        file.attachmentId,
      );
      expect((await db.pool.query('SELECT 1 FROM office_attachment_bytes')).rowCount).toBe(2);

      const revoke = {
        ...alice,
        draftId: original.draftId,
        conversationId: convo,
        attachmentId: file.attachmentId,
      };
      for (const mismatch of [
        { ...bob },
        { ...otherLogin },
        { draftId: randomUUID() },
        { conversationId: otherConvo },
        { attachmentId: randomUUID() },
      ]) {
        await expect(storage.revokeAttachment({ ...revoke, ...mismatch })).rejects.toMatchObject(
          NOT_FOUND,
        );
      }
      await storage.revokeAttachment(revoke);
      await storage.revokeAttachment(revoke);
      expect(await storage.pruneBytes(1)).toEqual({ attachments: 1, artifacts: 0 });
      expect(await storage.stageAttachment(original)).toEqual({ ...file, status: 'revoked' });
      expect((await db.pool.query('SELECT 1 FROM office_attachment_bytes')).rowCount).toBe(1);

      const expiring = await storage.stageAttachment({ ...original, ...otherLogin });
      await db.pool.query(
        `UPDATE office_attachments SET created_at = now() - interval '2 days',
       expires_at = now() - interval '1 day' WHERE id = $1`,
        [expiring.attachmentId],
      );
      const expired = await storage.stageAttachment({ ...original, ...otherLogin });
      expect(expired).toMatchObject({ attachmentId: expiring.attachmentId, status: 'expired' });
      const worker = startWorkerLoop({ pool: db.pool });
      await worker.stop();
      expect(await storage.stageAttachment({ ...original, ...otherLogin })).toEqual(expired);
      expect((await db.pool.query('SELECT 1 FROM office_attachment_bytes')).rowCount).toBe(0);
    } finally {
      await db.close();
    }
  },
  20_000,
);

integrationTest(
  'office quota is owner-scoped and cannot be oversubscribed by concurrent staging',
  async () => {
    const db = await createIntegrationDatabase();
    try {
      const storage = createOfficeStorage(db.pool);
      const alice = await owner(db.pool);
      const bob = await owner(db.pool);
      const request = { ...upload(alice), bytes: Buffer.alloc(1024 * 1024, 65) };
      const requests = Array.from({ length: 31 }, () => ({
        ...request,
        idempotencyKey: randomUUID(),
      }));
      const staged = await Promise.all(requests.map((item) => storage.stageAttachment(item)));
      const remaining = [randomUUID(), randomUUID()].map((idempotencyKey) => ({
        ...request,
        idempotencyKey,
      }));
      const results = await Promise.allSettled(
        remaining.map((item) => storage.stageAttachment(item)),
      );
      const winner = results.findIndex((result) => result.status === 'fulfilled');
      expect(winner).toBeGreaterThanOrEqual(0);
      expect(results[1 - winner]).toMatchObject({ status: 'rejected', reason: QUOTA });
      const winning = await storage.stageAttachment(remaining[winner]!);
      expect(results[winner]).toMatchObject({ status: 'fulfilled', value: winning });
      await expect(
        storage.stageAttachment({ ...upload(bob), bytes: request.bytes }),
      ).resolves.toMatchObject({ status: 'available' });

      const run = {
        ...alice,
        conversationId: await conversation(db.pool, alice.ownerId),
        runId: randomUUID(),
      };
      await withTransaction(db.pool, async (client) => {
        await createAdmission(client, run);
        await consumeOfficeAttachments(client, {
          ...run,
          draftId: request.draftId,
          notesAttachmentId: staged[0]!.attachmentId,
        });
      });
      const deliver = () =>
        withTransaction(db.pool, (client) =>
          writeOfficeDelivery(client, {
            ...run,
            paramsSha256: 'a'.repeat(64),
            artifacts: [
              {
                filename: 'Report.md',
                format: 'markdown',
                bytes: request.bytes,
                sourceAttachmentIds: [staged[0]!.attachmentId],
              },
            ],
          }),
        );
      await expect(deliver()).rejects.toMatchObject(QUOTA);
      expect((await db.pool.query('SELECT 1 FROM office_deliveries')).rowCount).toBe(0);

      await storage.revokeAttachment({
        ...alice,
        attachmentId: winning.attachmentId,
        draftId: request.draftId,
      });
      await expect(deliver()).resolves.toHaveLength(1);
      await expect(storage.stageAttachment(remaining[1 - winner]!)).rejects.toMatchObject(QUOTA);
      await storage.revokeAttachment({ ...alice, attachmentId: staged[0]!.attachmentId });
      await expect(storage.stageAttachment(remaining[1 - winner]!)).resolves.toMatchObject({
        status: 'available',
      });
      await expect(
        storage.stageAttachment({ ...upload(alice), bytes: Buffer.alloc(1024 * 1024 + 1) }),
      ).rejects.toMatchObject({ code: 413 });
    } finally {
      await db.close();
    }
  },
  30_000,
);

integrationTest(
  'office admission races consume once and roll back the losing message, Run, attempt and other input',
  async () => {
    const db = await createIntegrationDatabase();
    try {
      const storage = createOfficeStorage(db.pool);
      const alice = await owner(db.pool);
      const otherLogin = await relogin(db.pool, alice.ownerId);
      const bob = await owner(db.pool);
      const draft = upload(alice);
      const note = await storage.stageAttachment(draft);
      const tasks = await storage.stageAttachment({
        ...draft,
        idempotencyKey: randomUUID(),
        filename: 'tasks.csv',
        format: 'csv',
        bytes: Buffer.from('record,1'),
      });
      const alternative = await storage.stageAttachment({
        ...draft,
        idempotencyKey: randomUUID(),
        filename: 'alt.csv',
        format: 'csv',
        bytes: Buffer.from('record,2'),
      });
      const wrongConvo = await conversation(db.pool, alice.ownerId);
      const scoped = await storage.stageAttachment({
        ...upload(alice, draft.draftId),
        conversationId: wrongConvo,
      });
      const admit = (
        input: OfficeExecution,
        notesAttachmentId: string,
        tasksAttachmentId?: string,
        draftId = draft.draftId,
      ) =>
        withTransaction(db.pool, async (client) => {
          const selection = { ...input, draftId, notesAttachmentId, tasksAttachmentId };
          const frozen = await prepareOfficeAttachments(client, selection);
          await createAdmission(client, input);
          const consumed = await consumeOfficeAttachments(client, selection);
          expect(consumed).toEqual(frozen);
          return consumed;
        });
      const convo1 = await conversation(db.pool, alice.ownerId);
      const convo2 = await conversation(db.pool, alice.ownerId);
      const badRun = { ...alice, conversationId: convo1, runId: randomUUID() };
      await expect(admit(badRun, scoped.attachmentId)).rejects.toMatchObject(NOT_FOUND);
      await expect(admit({ ...badRun, ...otherLogin }, note.attachmentId)).rejects.toMatchObject(
        NOT_FOUND,
      );
      await expect(admit(badRun, note.attachmentId, undefined, randomUUID())).rejects.toMatchObject(
        NOT_FOUND,
      );
      const bobRun = {
        ...bob,
        conversationId: await conversation(db.pool, bob.ownerId),
        runId: randomUUID(),
      };
      await expect(admit(bobRun, note.attachmentId)).rejects.toMatchObject(NOT_FOUND);
      await expect(admit(badRun, tasks.attachmentId)).rejects.toMatchObject({
        errorCode: 'VALIDATION_ERROR',
      });
      const revoked = await storage.stageAttachment(upload(alice, draft.draftId));
      await storage.revokeAttachment({
        ...alice,
        draftId: draft.draftId,
        attachmentId: revoked.attachmentId,
      });
      await expect(admit(badRun, revoked.attachmentId)).rejects.toMatchObject(UNAVAILABLE);

      const runs = [convo1, convo2].map((conversationId) => ({
        ...alice,
        conversationId,
        runId: randomUUID(),
      }));
      const result = await Promise.allSettled([
        admit(runs[0]!, note.attachmentId, tasks.attachmentId),
        admit(runs[1]!, note.attachmentId, alternative.attachmentId),
      ]);
      const winner = result.findIndex((item) => item.status === 'fulfilled');
      expect(winner).toBeGreaterThanOrEqual(0);
      const loser = 1 - winner;
      expect(result[loser]).toMatchObject({ status: 'rejected', reason: UNAVAILABLE });
      const won = runs[winner]!;
      expect((await db.pool.query('SELECT id FROM agent_runs')).rows).toEqual([{ id: won.runId }]);
      expect((await db.pool.query('SELECT run_id FROM run_attempts')).rows).toEqual([
        { run_id: won.runId },
      ]);
      expect((await db.pool.query('SELECT request_id FROM messages')).rows).toEqual([
        { request_id: won.runId },
      ]);
      const unconsumed = [tasks, alternative][loser]!;
      expect(
        (
          await db.pool.query('SELECT bound_conversation_id FROM office_attachments WHERE id=$1', [
            unconsumed.attachmentId,
          ])
        ).rows,
      ).toEqual([{ bound_conversation_id: null }]);
      const read = (input: OfficeExecution) =>
        withTransaction(db.pool, (client) =>
          readOfficeAttachment(client, { ...input, role: 'notes' }),
        );
      await expect(read(won)).resolves.toMatchObject({
        attachmentId: note.attachmentId,
        bytes: draft.bytes,
      });
      await expect(read({ ...won, ...otherLogin })).rejects.toMatchObject(NOT_FOUND);
      await expect(read({ ...won, conversationId: wrongConvo })).rejects.toMatchObject(NOT_FOUND);
      await expect(read(runs[loser]!)).rejects.toMatchObject(NOT_FOUND);
      await expect(storage.listRunMaterials(bob.ownerId, [won.runId])).resolves.toEqual(new Map());
      const history = (await storage.listRunMaterials(otherLogin.ownerId, [won.runId])).get(
        won.runId,
      )!;
      expect(history.inputs.map((item) => item.role)).toEqual(['notes', 'tasks']);
      expect(history.inputs[0]).not.toHaveProperty('sha256');
      expect(history.inputs[0]).not.toHaveProperty('bytes');
      await storage.revokeAttachment({ ...otherLogin, attachmentId: note.attachmentId });
      await expect(read(won)).rejects.toMatchObject(UNAVAILABLE);
      await expect(
        withTransaction(db.pool, (client) =>
          writeOfficeDelivery(client, {
            ...won,
            paramsSha256: 'a'.repeat(64),
            artifacts: [
              {
                filename: 'Late report.md',
                format: 'markdown',
                bytes: draft.bytes,
                sourceAttachmentIds: [note.attachmentId],
              },
            ],
          }),
        ),
      ).rejects.toMatchObject(UNAVAILABLE);
      expect((await db.pool.query('SELECT 1 FROM office_deliveries')).rowCount).toBe(0);
      expect((await db.pool.query('SELECT 1 FROM office_artifact_bytes')).rowCount).toBe(0);
    } finally {
      await db.close();
    }
  },
  20_000,
);

integrationTest(
  'office delivery and continuations share one atomic effect; revoke and expiry use actual sources',
  async () => {
    const db = await createIntegrationDatabase();
    try {
      const { pool } = db;
      const storage = createOfficeStorage(pool);
      const alice = await owner(pool);
      const bob = await owner(pool);
      const original = {
        ...alice,
        conversationId: await conversation(pool, alice.ownerId),
        runId: randomUUID(),
      };
      const draft = upload(alice);
      const notes = await storage.stageAttachment(draft);
      const tasks = await storage.stageAttachment({
        ...draft,
        idempotencyKey: randomUUID(),
        format: 'csv',
        filename: 'tasks.csv',
        bytes: Buffer.from('t,1'),
      });
      await withTransaction(pool, async (client) => {
        await createAdmission(client, original);
        await consumeOfficeAttachments(client, {
          ...original,
          draftId: draft.draftId,
          notesAttachmentId: notes.attachmentId,
          tasksAttachmentId: tasks.attachmentId,
        });
      });
      const otherLogin = await relogin(pool, alice.ownerId);
      const continuations = [randomUUID(), randomUUID()].map((runId) => ({
        ...original,
        ...otherLogin,
        runId,
      }));
      const follow = (input: OfficeExecution) =>
        withTransaction(pool, async (client) => {
          await createAdmission(client, input);
          return continueOfficeAttachments(client, { ...input, previousRunId: original.runId });
        });
      const races = await Promise.allSettled(continuations.map(follow));
      const successor = races.findIndex((item) => item.status === 'fulfilled');
      expect(successor).toBeGreaterThanOrEqual(0);
      expect(races[1 - successor]).toMatchObject({ status: 'rejected', reason: UNAVAILABLE });
      const next = continuations[successor]!;
      expect(
        (await pool.query('SELECT run_id FROM office_run_inputs GROUP BY run_id')).rows,
      ).toEqual([{ run_id: original.runId }]);

      const request: WriteOfficeDelivery = {
        ...original,
        paramsSha256: 'a'.repeat(64),
        artifacts: [
          {
            filename: '报告.md',
            format: 'markdown',
            bytes: Buffer.from('纪要\r\n'),
            sourceAttachmentIds: null,
          },
          {
            filename: '汇总.csv',
            format: 'csv',
            bytes: Buffer.from('\ufeffcount\r\n1\r\n'),
            sourceAttachmentIds: [tasks.attachmentId],
          },
        ],
      };
      await expect(
        withTransaction(pool, async (client) => {
          await writeOfficeDelivery(client, request);
          throw new Error('acceptance did not commit');
        }),
      ).rejects.toThrow('acceptance did not commit');
      expect((await pool.query('SELECT 1 FROM office_deliveries')).rowCount).toBe(0);
      expect((await pool.query('SELECT 1 FROM office_artifact_bytes')).rowCount).toBe(0);
      const deliver = (input: WriteOfficeDelivery) =>
        withTransaction(pool, (client) => writeOfficeDelivery(client, input));
      await expect(
        deliver({
          ...request,
          artifacts: [
            {
              ...request.artifacts[0]!,
              sourceAttachmentIds: [randomUUID()],
            },
          ],
        }),
      ).rejects.toMatchObject({ errorCode: 'VALIDATION_ERROR' });
      const [first, replay] = await Promise.all([
        deliver(request),
        deliver({ ...request, ...next }),
      ]);
      expect(first).toEqual(replay);
      expect(first).toHaveLength(2);
      await expect(
        deliver({ ...request, ...next, paramsSha256: 'b'.repeat(64) }),
      ).rejects.toMatchObject(CONFLICT);
      expect((await pool.query('SELECT 1 FROM office_artifact_bytes')).rowCount).toBe(2);
      const report = first.find(({ format }) => format === 'markdown')!;
      const csv = first.find(({ format }) => format === 'csv')!;
      const key = {
        ...otherLogin,
        conversationId: original.conversationId,
        runId: csv.runId,
        artifactId: csv.artifactId,
      };
      await expect(storage.downloadArtifact(key)).resolves.toMatchObject({
        bytes: request.artifacts[1]!.bytes,
      });
      await expect(storage.downloadArtifact({ ...key, ...bob })).rejects.toMatchObject(NOT_FOUND);
      await expect(storage.downloadArtifact({ ...key, runId: randomUUID() })).rejects.toMatchObject(
        NOT_FOUND,
      );
      await expect(
        storage.downloadArtifact({ ...key, conversationId: randomUUID() }),
      ).rejects.toMatchObject(NOT_FOUND);

      const disclosure = (sourceAttachmentIds: string[] | null) =>
        withTransaction(pool, (client) =>
          assertOfficeSources(client, { ...next, sourceAttachmentIds }),
        );
      await expect(disclosure(null)).resolves.toBeUndefined();
      await storage.revokeAttachment({ ...otherLogin, attachmentId: notes.attachmentId });
      await expect(disclosure(null)).rejects.toMatchObject(NOT_FOUND);
      await expect(disclosure([notes.attachmentId])).rejects.toMatchObject(NOT_FOUND);
      await expect(disclosure([randomUUID()])).rejects.toMatchObject(NOT_FOUND);
      await expect(disclosure([tasks.attachmentId])).resolves.toBeUndefined();
      await expect(
        storage.downloadArtifact({ ...key, artifactId: report.artifactId }),
      ).rejects.toMatchObject(NOT_FOUND);
      await expect(storage.downloadArtifact(key)).resolves.toMatchObject({
        bytes: request.artifacts[1]!.bytes,
      });
      const page = await getConversationRuns({ pool }, alice.ownerId, original.conversationId, {});
      const projected = page.items.find((item) => item.run_id === original.runId) as unknown as {
        office_materials: {
          inputs: Array<Record<string, unknown>>;
          artifacts: Array<{ artifact_id: string; status: string; download_url: string | null }>;
        };
      };
      expect(projected.office_materials.inputs).toHaveLength(2);
      expect(projected.office_materials.inputs[0]).not.toHaveProperty('sha256');
      expect(projected.office_materials.inputs[0]).not.toHaveProperty('bytes');
      expect(
        projected.office_materials.artifacts.find((item) => item.artifact_id === report.artifactId),
      ).toMatchObject({ status: 'revoked', download_url: null });
      expect(
        projected.office_materials.artifacts.find((item) => item.artifact_id === csv.artifactId),
      ).toMatchObject({
        status: 'available',
        download_url: `/api/v1/conversations/${original.conversationId}/runs/${csv.runId}/artifacts/${csv.artifactId}/content`,
      });
      await expect(follow({ ...next, runId: randomUUID() })).rejects.toMatchObject(UNAVAILABLE);

      await pool.query(
        `UPDATE office_attachments SET created_at=now() - interval '2 days',
                      expires_at=now() - interval '1 day' WHERE id=$1`,
        [tasks.attachmentId],
      );
      expect(await storage.pruneBytes()).toEqual({ attachments: 2, artifacts: 1 });
      await expect(storage.downloadArtifact(key)).resolves.toMatchObject({
        bytes: request.artifacts[1]!.bytes,
      });
      await pool.query(
        `UPDATE office_artifacts SET created_at=now() - interval '2 days',
                      expires_at=now() - interval '1 day' WHERE id=$1`,
        [csv.artifactId],
      );
      await expect(storage.downloadArtifact(key)).rejects.toMatchObject(NOT_FOUND);
      expect(await storage.pruneBytes()).toEqual({ attachments: 0, artifacts: 1 });
      const history = (
        await storage.listRunMaterials(alice.ownerId, [original.runId, next.runId])
      ).get(next.runId)!;
      expect(history.artifacts.map((item) => [item.runId, item.status])).toEqual([
        [csv.runId, 'expired'],
        [report.runId, 'revoked'],
      ]);
      await expect(deliver(request)).resolves.toEqual(history.artifacts);
      expect((await pool.query('SELECT 1 FROM office_artifact_bytes')).rowCount).toBe(0);
    } finally {
      await db.close();
    }
  },
  20_000,
);
