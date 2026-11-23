import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createApp } from '../../src/http/app.js';
import { createIntegrationDatabase, databaseUrl, seedAdmittedSession } from './setup.js';

const integrationTest = databaseUrl ? test : test.skip;

integrationTest(
  'office capability requires authentication and reflects the server admission gate',
  async () => {
    const previousGate = process.env.ALONG_NATIVE_OFFICE_ADMISSION;
    const previousKey = process.env.ALONG_OFFICE_OBSERVATION_KEY;
    const db = await createIntegrationDatabase();
    try {
      const session = await seedAdmittedSession(db.pool);
      const app = createApp({ pool: db.pool, tzdbVersion: 'test' });
      const url = 'http://localhost/api/v1/conversations/office-capabilities';
      const readCapability = async () => {
        const response = await app.handle(
          new Request(url, { headers: { cookie: `better-auth.session_token=${session.token}` } }),
        );
        const body: unknown = await response.json();
        return body;
      };
      expect((await app.handle(new Request(url))).status).toBe(401);
      delete process.env.ALONG_NATIVE_OFFICE_ADMISSION;
      expect(await readCapability()).toMatchObject({ data: { admission_enabled: false } });
      process.env.ALONG_NATIVE_OFFICE_ADMISSION = '1';
      delete process.env.ALONG_OFFICE_OBSERVATION_KEY;
      expect(await readCapability()).toMatchObject({ data: { admission_enabled: false } });
      process.env.ALONG_OFFICE_OBSERVATION_KEY = Buffer.alloc(32, 1).toString('base64');
      expect(await readCapability()).toMatchObject({ data: { admission_enabled: true } });
    } finally {
      if (previousGate === undefined) delete process.env.ALONG_NATIVE_OFFICE_ADMISSION;
      else process.env.ALONG_NATIVE_OFFICE_ADMISSION = previousGate;
      if (previousKey === undefined) delete process.env.ALONG_OFFICE_OBSERVATION_KEY;
      else process.env.ALONG_OFFICE_OBSERVATION_KEY = previousKey;
      await db.close();
    }
  },
  20_000,
);

integrationTest(
  'office HTTP authenticates before upload, preserves bytes, replays and revokes',
  async () => {
    const db = await createIntegrationDatabase();
    try {
      const session = await seedAdmittedSession(db.pool);
      const app = createApp({ pool: db.pool, tzdbVersion: 'test' });
      const draft = randomUUID();
      const key = randomUUID();
      const cookie = `better-auth.session_token=${session.token}`;
      const path = `http://localhost/api/v1/conversations/attachments?draft_id=${draft}`;
      const headers = {
        cookie,
        'x-csrf-token': session.csrfToken,
        'idempotency-key': key,
        'content-type': 'application/octet-stream',
        'x-along-filename': encodeURIComponent('会议纪要.md'),
      };
      const send = (body: string, extra: Record<string, string> = {}) =>
        app.handle(new Request(path, { method: 'POST', headers: { ...headers, ...extra }, body }));
      expect((await send('test', { 'x-csrf-token': 'bad' })).status).toBe(403);
      expect((await send('test', { 'content-encoding': 'gzip' })).status).toBe(400);
      const first = await send('一\r\n二');
      expect(first.status).toBe(200);
      const receipt = (await first.json()) as {
        data: { attachment_id: string; filename: string; byte_length: number };
      };
      expect(receipt.data).toMatchObject({
        filename: '会议纪要.md',
        byte_length: Buffer.byteLength('一\r\n二'),
      });
      const replay = await send('一\r\n二');
      expect(((await replay.json()) as typeof receipt).data.attachment_id).toBe(
        receipt.data.attachment_id,
      );
      expect((await send('changed')).status).toBe(409);
      const revoked = await app.handle(
        new Request(
          `http://localhost/api/v1/conversations/attachments/${receipt.data.attachment_id}/actions/revoke?draft_id=${draft}`,
          { method: 'POST', headers },
        ),
      );
      expect(revoked.status).toBe(200);
      const bytes = await db.pool.query('SELECT content FROM office_attachments WHERE id=$1', [
        receipt.data.attachment_id,
      ]);
      expect(bytes.rows[0].content).toEqual(Buffer.from('一\r\n二'));
    } finally {
      await db.close();
    }
  },
  20_000,
);
