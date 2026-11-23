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
    const oldKey = process.env.ALONG_OFFICE_OBSERVATION_KEY;
    process.env.ALONG_OFFICE_OBSERVATION_KEY = Buffer.alloc(32, 1).toString('base64');
    const db = await createIntegrationDatabase();
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
      expect(
        await withTransaction(db.pool, (client) => authorizePrivateOutput(client, context)),
      ).toBe(true);
      delete process.env.ALONG_OFFICE_OBSERVATION_KEY;
      await expect(
        withTransaction(db.pool, (client) => authorizePrivateOutput(client, context)),
      ).rejects.toMatchObject({ errorCode: 'FORBIDDEN' });
      process.env.ALONG_OFFICE_OBSERVATION_KEY = Buffer.alloc(32, 1).toString('base64');
      const event = ThreadEventSchema.parse({
        protocol_version: 'v1',
        seq: 1,
        request_id: randomUUID(),
        type: 'message.delta',
        payload: { conversation_id: conversationId, run_id: runId, delta: 'private source' },
      });
      await withTransaction(db.pool, (client) => stagePrivateDisclosure(client, event));
      delete process.env.ALONG_OFFICE_OBSERVATION_KEY;
      let missingKeyDelivered = false;
      expect(
        await writeAuthorizedEvent(
          db.pool,
          ownerId,
          async () => {
            missingKeyDelivered = true;
            return true;
          },
          event,
          sessionId,
        ),
      ).toBe(true);
      expect(missingKeyDelivered).toBe(false);
      process.env.ALONG_OFFICE_OBSERVATION_KEY = Buffer.alloc(32, 1).toString('base64');
      const earlier = { ...event, seq: 2 };
      await withTransaction(db.pool, (client) => stagePrivateDisclosure(client, earlier));
      let firstDelivered = false;
      await writeAuthorizedEvent(
        db.pool,
        ownerId,
        async () => {
          firstDelivered = true;
          return true;
        },
        earlier,
        sessionId,
      );
      expect(firstDelivered).toBe(true);
      await createOfficeStorage(db.pool).revokeAttachment({
        ownerId,
        sessionId,
        attachmentId: attachment.attachmentId,
      });
      await expect(
        withTransaction(db.pool, (client) => authorizePrivateOutput(client, context)),
      ).rejects.toMatchObject({ errorCode: 'NOT_FOUND' });
      let delivered = false;
      expect(
        await writeAuthorizedEvent(
          db.pool,
          ownerId,
          async () => {
            delivered = true;
            return true;
          },
          event,
          sessionId,
        ),
      ).toBe(true);
      expect(delivered).toBe(false);
      expect(
        (await db.pool.query('SELECT 1 FROM feishu_pending_disclosures WHERE run_id=$1', [runId]))
          .rowCount,
      ).toBe(1);
    } finally {
      if (oldKey === undefined) delete process.env.ALONG_OFFICE_OBSERVATION_KEY;
      else process.env.ALONG_OFFICE_OBSERVATION_KEY = oldKey;
      await db.close();
    }
  },
  20_000,
);
