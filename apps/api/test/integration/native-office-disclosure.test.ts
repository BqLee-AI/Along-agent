import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { ThreadEventSchema } from '@along/stream-protocol';
import { withTransaction } from '../../src/db/transaction.js';
import {
  createOfficeStorage,
  consumeOfficeAttachments,
} from '../../src/features/native-office/storage/public.js';
import { stagePrivateDisclosure } from '../../src/features/conversations/run/private-disclosure.js';
import { writeAuthorizedEvent } from '../../src/features/conversations/run/stream-authorization.js';
import { authorizePrivateOutput } from '../../src/agent/runtime/private-output.js';
import { createIntegrationDatabase, databaseUrl, seedAdmittedSession } from './setup.js';

const integrationTest = databaseUrl ? test : test.skip;
integrationTest(
  'revocation blocks a persisted office event that has not been delivered',
  async () => {
    const keyName = 'ALONG_OFFICE_OBSERVATION_KEY';
    const officeKey = Buffer.alloc(32, 1).toString('base64');
    const oldKey = process.env[keyName];
    const db = await createIntegrationDatabase();
    process.env[keyName] = officeKey;
    try {
      const user = await seedAdmittedSession(db.pool);
      const ownerId = user.userId;
      const sessionId = user.sessionId;
      const conversationId = randomUUID();
      const runId = randomUUID();
      const draftId = randomUUID();
      const attachment = await createOfficeStorage(db.pool).stageAttachment({
        ownerId,
        sessionId,
        draftId,
        idempotencyKey: randomUUID(),
        filename: 'notes.md',
        format: 'markdown',
        bytes: Buffer.from('private source'),
      });
      await db.pool.query('INSERT INTO conversations (id,owner_id) VALUES ($1,$2)', [
        conversationId,
        ownerId,
      ]);
      const messageId = randomUUID();
      await db.pool.query(
        "INSERT INTO messages (id,owner_id,conversation_id,role,content,request_id) VALUES ($1,$2,$3,'user','fixture',$4)",
        [messageId, ownerId, conversationId, randomUUID()],
      );
      await db.pool.query(
        "INSERT INTO agent_runs (id,owner_id,conversation_id,agent_revision,mode,budget_max_iterations,budget_max_tokens,execution,input_message_id,frozen_context) VALUES ($1,$2,$3,'test','chat',5,1000,'harness',$4,$5)",
        [
          runId,
          ownerId,
          conversationId,
          messageId,
          JSON.stringify({
            officeMaterials: [{ role: 'notes', attachmentId: attachment.attachmentId }],
          }),
        ],
      );
      await db.pool.query(
        'INSERT INTO run_attempts (id,owner_id,run_id,attempt_no) VALUES ($1,$2,$3,1)',
        [randomUUID(), ownerId, runId],
      );
      await withTransaction(db.pool, (client) =>
        consumeOfficeAttachments(client, {
          ownerId,
          sessionId,
          conversationId,
          runId,
          draftId,
          notesAttachmentId: attachment.attachmentId,
        }),
      );
      const context = { ownerId, conversationId, runId, officeSessionId: sessionId } as never;
      const authorize = () =>
        withTransaction(db.pool, (client) => authorizePrivateOutput(client, context));
      await expect(authorize()).resolves.toBe(true);
      delete process.env[keyName];
      await expect(authorize()).rejects.toMatchObject({ errorCode: 'FORBIDDEN' });
      process.env[keyName] = officeKey;
      const event = ThreadEventSchema.parse({
        protocol_version: 'v1',
        seq: 1,
        request_id: randomUUID(),
        type: 'message.delta',
        payload: { conversation_id: conversationId, run_id: runId, delta: 'private source' },
      });
      const attemptDelivery = async (pending: typeof event) => {
        let delivered = false;
        const open = await writeAuthorizedEvent(
          db.pool,
          ownerId,
          async () => {
            delivered = true;
            return true;
          },
          pending,
          sessionId,
        );
        return { open, delivered };
      };
      await withTransaction(db.pool, (client) => stagePrivateDisclosure(client, event));
      delete process.env[keyName];
      expect(await attemptDelivery(event)).toEqual({ open: true, delivered: false });
      process.env[keyName] = officeKey;
      const earlier = { ...event, seq: 2 };
      await withTransaction(db.pool, (client) => stagePrivateDisclosure(client, earlier));
      expect(await attemptDelivery(earlier)).toMatchObject({ delivered: true });
      await createOfficeStorage(db.pool).revokeAttachment({
        ownerId,
        sessionId,
        attachmentId: attachment.attachmentId,
      });
      await expect(authorize()).rejects.toMatchObject({ errorCode: 'NOT_FOUND' });
      expect(await attemptDelivery(event)).toEqual({ open: true, delivered: false });
      expect(
        (await db.pool.query('SELECT 1 FROM feishu_pending_disclosures WHERE run_id=$1', [runId]))
          .rowCount,
      ).toBe(1);
    } finally {
      if (oldKey === undefined) delete process.env[keyName];
      else process.env[keyName] = oldKey;
      await db.close();
    }
  },
  20_000,
);
