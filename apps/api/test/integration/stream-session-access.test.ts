import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { ThreadEvent } from '@along/stream-protocol';
import { writeAuthorizedEvent } from '../../src/modules/conversations/stream-authorization.js';
import {
  createIntegrationDatabase,
  databaseUrl,
  seedAdmittedSession,
  type IntegrationDatabase,
} from './setup.js';

const maybe = databaseUrl ? describe : describe.skip;

maybe('stream session access', () => {
  let database: IntegrationDatabase;
  beforeAll(async () => {
    database = await createIntegrationDatabase();
  });
  afterAll(async () => {
    await database?.close();
  });

  it('does not deliver after the original session is revoked or expired', async () => {
    const session = await seedAdmittedSession(database.pool);
    const event = {} as ThreadEvent;
    let delivered = 0;
    const deliver = () =>
      writeAuthorizedEvent(
        database.pool,
        session.userId,
        async () => {
          delivered++;
          return true;
        },
        event,
        session.sessionId,
      );
    expect(await deliver()).toBe(true);
    await database.pool.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE id=$1', [
      session.sessionId,
    ]);
    await expect(deliver()).rejects.toThrow();
    expect(delivered).toBe(1);
    await database.pool.query(
      "UPDATE sessions SET revoked_at=NULL,created_at=now()-interval '2 days',expires_at=now()-interval '1 day' WHERE id=$1",
      [session.sessionId],
    );
    await expect(deliver()).rejects.toThrow();
    expect(delivered).toBe(1);
  });
});
