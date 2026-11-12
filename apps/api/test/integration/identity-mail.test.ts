import { describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Pool } from 'pg';
import {
  issueToken,
  lookupDigest,
  sealIdentity,
  tokenDigest,
  type IdentityKeyring,
} from '../../src/modules/identity/email-security.js';
import {
  createResendIdentitySender,
  enqueueIdentityMail,
  runIdentityMailTick,
  type IdentityMailConfig,
} from '../../src/modules/identity/mail.js';
import { identityKeysFixture } from '../helpers/identity-security.js';
import { createIntegrationDatabase, databaseUrl } from './setup.js';

interface SeededDelivery {
  id: string;
  challengeId: string;
  ownerId: string;
  token: string;
}
interface SeedOptions {
  to?: string;
  status?: string;
  admitted?: boolean;
  staleGeneration?: boolean;
  expiresAt?: Date;
}
async function seedDelivery(
  pool: Pool,
  keys: IdentityKeyring,
  options: SeedOptions = {},
): Promise<SeededDelivery> {
  const ownerId = randomUUID();
  const challengeId = randomUUID();
  const token = issueToken();
  const to = options.to ?? 'recipient@example.com';
  const expiresAt = options.expiresAt ?? new Date(Date.now() + 1800000);
  const candidate = sealIdentity(
    keys,
    to,
    `identity:challenge:${challengeId}:${ownerId}:verify_contact:1`,
  );
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO users(id,auth_email,status) VALUES($1,$2,$3)`, [
      ownerId,
      `${ownerId}@local.invalid`,
      options.status ?? 'active',
    ]);
    if (options.admitted !== false)
      await client.query(
        `INSERT INTO identity_account_admissions(user_id,source,admitted_at,contact_generation) VALUES($1,'local_maintenance',clock_timestamp(),$2)`,
        [ownerId, options.staleGeneration ? 2 : 1],
      );
    await client.query(
      `INSERT INTO identity_challenges(id,purpose,token_digest,token_key_id,user_id,lookup_digest,lookup_key_id,generation,candidate_ciphertext,candidate_nonce,candidate_tag,encryption_key_id,masked_email,created_at,expires_at) VALUES($1,'verify_contact',$2,$3,$4,$5,$6,1,$7,$8,$9,$10,'r***@example.com',$11,$12)`,
      [
        challengeId,
        tokenDigest(keys, 'verify_contact', token),
        keys.challenge.active,
        ownerId,
        lookupDigest(keys, to),
        keys.lookup.id,
        candidate.ciphertext,
        candidate.nonce,
        candidate.tag,
        candidate.encryption_key_id,
        new Date(expiresAt.getTime() - 1800000),
        expiresAt,
      ],
    );
    const delivery = await enqueueIdentityMail(client, keys, {
      challengeId,
      purpose: 'verify_contact',
      generation: 1,
      to,
      token,
      expiresAt,
    });
    await client.query('COMMIT');
    return { id: delivery.delivery_id, challengeId, ownerId, token };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
async function listening(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/emails`;
}
async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
const integration = databaseUrl ? describe : describe.skip;
integration(
  'identity mail isolated PG + loopback protocol simulator (NOT real provider/email proof)',
  () => {
    it.each(['single claimant with lock probe', 'competing claimants'] as const)(
      '%s: commits before IO, classifies outcomes and never replays',
      async (mode) => {
        const db = await createIntegrationDatabase();
        const keys = identityKeysFixture();
        const deliveries: SeededDelivery[] = [];
        const observed: { id: string; to: string; text: string }[] = [];
        const protocolErrors: unknown[] = [];
        const server = createServer(async (request, response) => {
          try {
            const chunks: Buffer[] = [];
            for await (const chunk of request) chunks.push(Buffer.from(chunk));
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
              to: string[];
              text: string;
            };
            const id = String(request.headers['idempotency-key']);
            observed.push({ id, to: body.to[0]!, text: body.text });
            expect(request.method).toBe('POST');
            expect(request.headers.authorization).toBe('Bearer isolated-protocol-simulator-only');
            const row = (
              await db.pool.query(
                `SELECT status,attempt_count FROM identity_mail_deliveries WHERE id=$1`,
                [id],
              )
            ).rows[0];
            expect(row).toMatchObject({ status: 'submitting', attempt_count: 1 });
            const delivery = deliveries.find((item) => item.id === id)!;
            // Probe only without a competing claimant: a losing claimant can still
            // hold SHARE locks after the sender commits, independently of network IO.
            if (mode === 'single claimant with lock probe') {
              const client = await db.pool.connect();
              try {
                await client.query('BEGIN');
                await client.query(`SET LOCAL lock_timeout='250ms'`);
                await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [
                  delivery.ownerId,
                ]);
                await client.query('SELECT id FROM identity_challenges WHERE id=$1 FOR UPDATE', [
                  delivery.challengeId,
                ]);
                await client.query('COMMIT');
              } catch (error) {
                await client.query('ROLLBACK');
                throw error;
              } finally {
                client.release();
              }
            }
            if (body.to[0] === 'rejected@example.com') {
              response.writeHead(422, { 'content-type': 'application/json' });
              response.end(
                JSON.stringify({ message: 'private raw recipient and error must never persist' }),
              );
            } else if (body.to[0] === 'lost@example.com') response.destroy();
            else {
              response.writeHead(200, { 'content-type': 'application/json' });
              response.end(JSON.stringify({ id: `accepted_${id}` }));
            }
          } catch (error) {
            protocolErrors.push(error);
            response.destroy();
          }
        });
        let peer: Pool | undefined;
        try {
          const endpoint = await listening(server);
          for (const to of ['accepted@example.com', 'rejected@example.com', 'lost@example.com'])
            deliveries.push(await seedDelivery(db.pool, keys, { to }));
          const mail: IdentityMailConfig = {
            origin: 'http://localhost:3000',
            from: 'sender@example.com',
            send: createResendIdentitySender({
              apiKey: 'isolated-protocol-simulator-only',
              from: 'sender@example.com',
              endpoint,
            }),
            timeoutMs: 1000,
          };
          if (mode === 'competing claimants') {
            peer = db.connect();
            await Promise.all([
              runIdentityMailTick(db.pool, { keys, mail }),
              runIdentityMailTick(peer, { keys, mail }),
            ]);
          } else {
            await runIdentityMailTick(db.pool, { keys, mail });
          }
          expect(protocolErrors).toEqual([]);
          expect(observed).toHaveLength(3);
          expect(new Set(observed.map((item) => item.id)).size).toBe(3);
          const rows = (
            await db.pool.query('SELECT * FROM identity_mail_deliveries ORDER BY created_at,id')
          ).rows;
          for (const [index, expected] of ['submitted', 'failed', 'unknown'].entries()) {
            const row = rows.find((item) => item.id === deliveries[index]!.id);
            expect(row.status).toBe(expected);
            expect(row.attempt_count).toBe(1);
            expect(row.payload_ciphertext).toBeNull();
            expect(row.payload_nonce).toBeNull();
            expect(row.payload_tag).toBeNull();
            expect(row.encryption_key_id).toBeNull();
            expect(row.payload_erased_at).toBeInstanceOf(Date);
            expect(row.submitted_at !== null).toBe(expected === 'submitted');
            const request = observed.find((item) => item.id === row.id)!;
            expect(request.text).toContain(`/verify-contact#token=${deliveries[index]!.token}`);
            expect(request.text).not.toContain('?token=');
          }
          expect(JSON.stringify(rows)).not.toContain('private raw');
          for (const delivery of deliveries)
            expect(JSON.stringify(rows)).not.toContain(delivery.token);
          await runIdentityMailTick(db.pool, { keys, mail });
          expect(observed).toHaveLength(3);
        } finally {
          try {
            await peer?.end();
            await closeServer(server);
          } finally {
            await db.close();
          }
        }
      },
    );
    it('bounds timeout and leaves lost acceptance unknown without replay after restart', async () => {
      const db = await createIntegrationDatabase();
      const keys = identityKeysFixture();
      let calls = 0;
      const server = createServer((request) => {
        calls++;
        request.resume();
      });
      try {
        const endpoint = await listening(server);
        const delivery = await seedDelivery(db.pool, keys);
        const mail: IdentityMailConfig = {
          origin: 'http://localhost:3000',
          from: 'sender@example.com',
          send: createResendIdentitySender({
            apiKey: 'isolated-only',
            from: 'sender@example.com',
            endpoint,
          }),
          timeoutMs: 100,
        };
        await runIdentityMailTick(db.pool, { keys, mail });
        expect(calls).toBe(1);
        expect(
          (
            await db.pool.query(
              'SELECT status,attempt_count,payload_ciphertext FROM identity_mail_deliveries WHERE id=$1',
              [delivery.id],
            )
          ).rows[0],
        ).toMatchObject({ status: 'unknown', attempt_count: 1, payload_ciphertext: null });
        const restarted = db.connect();
        try {
          await runIdentityMailTick(restarted, { keys, mail });
        } finally {
          await restarted.end();
        }
        expect(calls).toBe(1);
      } finally {
        try {
          await closeServer(server);
        } finally {
          await db.close();
        }
      }
    });
    it('suppresses stale generation, expiry, disabled and unadmitted users before network', async () => {
      const db = await createIntegrationDatabase();
      const keys = identityKeysFixture();
      let calls = 0;
      const mail: IdentityMailConfig = {
        origin: 'http://localhost:3000',
        from: 'sender@example.com',
        send: async () => {
          calls++;
          return { status: 'submitted' };
        },
      };
      try {
        for (const options of [
          { staleGeneration: true },
          { expiresAt: new Date(Date.now() - 1000) },
          { status: 'disabled' },
          { status: 'deleted_requested' },
          { admitted: false },
        ])
          await seedDelivery(db.pool, keys, options);
        await runIdentityMailTick(db.pool, { keys, mail });
        expect(calls).toBe(0);
        const rows = (
          await db.pool.query(
            'SELECT status,attempt_count,payload_ciphertext FROM identity_mail_deliveries',
          )
        ).rows;
        expect(rows).toHaveLength(5);
        for (const row of rows)
          expect(row).toMatchObject({
            status: 'suppressed',
            attempt_count: 0,
            payload_ciphertext: null,
          });
      } finally {
        await db.close();
      }
    });
    it('never reaps fresh submitting, marks only abandoned submitting unknown, and erases finite secrets', async () => {
      const db = await createIntegrationDatabase();
      const keys = identityKeysFixture();
      let calls = 0;
      const mail: IdentityMailConfig = {
        origin: 'http://localhost:3000',
        from: 'sender@example.com',
        send: async () => {
          calls++;
          return { status: 'submitted' };
        },
      };
      try {
        const fresh = await seedDelivery(db.pool, keys);
        const abandoned = await seedDelivery(db.pool, keys);
        const old = await seedDelivery(db.pool, keys, {
          expiresAt: new Date(Date.now() - 31 * 86400000),
        });
        const originalDigest = tokenDigest(keys, 'verify_contact', old.token);
        const consumed = await seedDelivery(db.pool, keys, {
          expiresAt: new Date(Date.now() - 30 * 86400000 + 20 * 60000),
        });
        await db.pool.query(
          `UPDATE identity_challenges SET consumed_at=clock_timestamp()-interval '30 days 5 minutes' WHERE id=$1`,
          [consumed.challengeId],
        );
        await db.pool.query(
          `UPDATE identity_mail_deliveries SET status='submitting',attempt_count=1,updated_at=CASE WHEN id=$1 THEN clock_timestamp()-interval '121 seconds' ELSE clock_timestamp() END WHERE id=ANY($2::uuid[])`,
          [abandoned.id, [fresh.id, abandoned.id]],
        );
        await runIdentityMailTick(db.pool, { keys, mail });
        expect(calls).toBe(0);
        const freshRow = (
          await db.pool.query('SELECT * FROM identity_mail_deliveries WHERE id=$1', [fresh.id])
        ).rows[0];
        expect(freshRow.status).toBe('submitting');
        expect(freshRow.payload_ciphertext).not.toBeNull();
        expect(
          (
            await db.pool.query(
              'SELECT status,payload_ciphertext FROM identity_mail_deliveries WHERE id=$1',
              [abandoned.id],
            )
          ).rows[0],
        ).toMatchObject({ status: 'unknown', payload_ciphertext: null });
        const challenge = (
          await db.pool.query('SELECT * FROM identity_challenges WHERE id=$1', [old.challengeId])
        ).rows[0];
        expect(challenge.candidate_ciphertext).toBeNull();
        expect(challenge.token_key_id).toBe('erased');
        expect(challenge.token_digest.equals(originalDigest)).toBe(false);
        expect(challenge.token_digest).toHaveLength(32);
        expect(
          (
            await db.pool.query('SELECT token_key_id FROM identity_challenges WHERE id=$1', [
              consumed.challengeId,
            ])
          ).rows[0].token_key_id,
        ).toBe('erased');
      } finally {
        await db.close();
      }
    });
    it('keeps enqueue atomic and does not claim queued work with absent configuration', async () => {
      const db = await createIntegrationDatabase();
      const keys = identityKeysFixture();
      try {
        const delivery = await seedDelivery(db.pool, keys);
        const client = await db.pool.connect();
        try {
          await client.query('BEGIN');
          const second = randomUUID();
          await client.query(
            `INSERT INTO identity_challenges(id,purpose,token_digest,token_key_id,user_id,lookup_digest,lookup_key_id,generation,candidate_ciphertext,candidate_nonce,candidate_tag,encryption_key_id,masked_email,created_at,expires_at) SELECT $1,purpose,$2,token_key_id,user_id,lookup_digest,lookup_key_id,2,candidate_ciphertext,candidate_nonce,candidate_tag,encryption_key_id,masked_email,created_at,expires_at FROM identity_challenges WHERE id=$3`,
            [second, tokenDigest(keys, 'verify_contact', issueToken()), delivery.challengeId],
          );
          const queued = await enqueueIdentityMail(client, keys, {
            challengeId: second,
            purpose: 'verify_contact',
            generation: 2,
            to: 'second@example.com',
            token: issueToken(),
            expiresAt: new Date(Date.now() + 1800000),
          });
          expect(
            (
              await db.pool.query('SELECT id FROM identity_mail_deliveries WHERE id=$1', [
                queued.delivery_id,
              ])
            ).rowCount,
          ).toBe(0);
          await client.query('ROLLBACK');
          expect(
            (
              await db.pool.query('SELECT id FROM identity_mail_deliveries WHERE id=$1', [
                queued.delivery_id,
              ])
            ).rowCount,
          ).toBe(0);
        } finally {
          client.release();
        }
        const previous = process.env.IDENTITY_MAIL_PROVIDER;
        delete process.env.IDENTITY_MAIL_PROVIDER;
        try {
          await expect(runIdentityMailTick(db.pool, { keys })).rejects.toMatchObject({
            httpStatus: 503,
          });
        } finally {
          if (previous === undefined) delete process.env.IDENTITY_MAIL_PROVIDER;
          else process.env.IDENTITY_MAIL_PROVIDER = previous;
        }
        expect(
          (
            await db.pool.query(
              'SELECT status,attempt_count FROM identity_mail_deliveries WHERE id=$1',
              [delivery.id],
            )
          ).rows[0],
        ).toMatchObject({ status: 'queued', attempt_count: 0 });
      } finally {
        await db.close();
      }
    });
    it('fails closed on missing retained encryption keys without claiming or sending', async () => {
      const db = await createIntegrationDatabase();
      const keys = identityKeysFixture();
      let calls = 0;
      const mail: IdentityMailConfig = {
        origin: 'http://localhost:3000',
        from: 'sender@example.com',
        send: async () => {
          calls++;
          return { status: 'submitted' };
        },
      };
      try {
        const delivery = await seedDelivery(db.pool, keys);
        const retained = keys.encryption.keys[keys.encryption.active]!;
        delete keys.encryption.keys[keys.encryption.active];
        await expect(runIdentityMailTick(db.pool, { keys, mail })).rejects.toMatchObject({
          httpStatus: 503,
        });
        expect(calls).toBe(0);
        expect(
          (
            await db.pool.query(
              'SELECT status,attempt_count FROM identity_mail_deliveries WHERE id=$1',
              [delivery.id],
            )
          ).rows[0],
        ).toMatchObject({ status: 'queued', attempt_count: 0 });
        keys.encryption.keys[keys.encryption.active] = retained;
        await runIdentityMailTick(db.pool, { keys, mail });
        expect(calls).toBe(1);
      } finally {
        await db.close();
      }
    });
    it('does not replay an accepted request when recording its terminal result fails', async () => {
      const db = await createIntegrationDatabase();
      const keys = identityKeysFixture();
      let calls = 0;
      const mail: IdentityMailConfig = {
        origin: 'http://localhost:3000',
        from: 'sender@example.com',
        send: async () => {
          calls++;
          return { status: 'submitted', acceptanceId: 'accepted_once' };
        },
      };
      try {
        const delivery = await seedDelivery(db.pool, keys);
        await db.pool.query(
          `CREATE FUNCTION identity_finish_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status='submitted' THEN RAISE EXCEPTION 'isolated commit-result fault'; END IF; RETURN NEW; END $$; CREATE TRIGGER identity_finish_fault BEFORE UPDATE ON identity_mail_deliveries FOR EACH ROW EXECUTE FUNCTION identity_finish_fail()`,
        );
        await expect(runIdentityMailTick(db.pool, { keys, mail })).rejects.toMatchObject({
          httpStatus: 503,
        });
        expect(calls).toBe(1);
        expect(
          (
            await db.pool.query(
              'SELECT status,attempt_count FROM identity_mail_deliveries WHERE id=$1',
              [delivery.id],
            )
          ).rows[0],
        ).toMatchObject({ status: 'submitting', attempt_count: 1 });
        await db.pool.query('DROP TRIGGER identity_finish_fault ON identity_mail_deliveries');
        await runIdentityMailTick(db.pool, { keys, mail });
        expect(calls).toBe(1);
        await db.pool.query(
          `UPDATE identity_mail_deliveries SET updated_at=clock_timestamp()-interval '121 seconds' WHERE id=$1`,
          [delivery.id],
        );
        await runIdentityMailTick(db.pool, { keys, mail });
        expect(calls).toBe(1);
        expect(
          (
            await db.pool.query(
              'SELECT status,payload_ciphertext FROM identity_mail_deliveries WHERE id=$1',
              [delivery.id],
            )
          ).rows[0],
        ).toMatchObject({ status: 'unknown', payload_ciphertext: null });
      } finally {
        await db.close();
      }
    });
  },
);
