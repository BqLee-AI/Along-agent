import {
  applicationErrorEvidence,
  expectApplicationRejection,
} from '../helpers/application-error.js';
import { httpStatusForError } from '@along/contracts';
import { describe, expect, it } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { ApplicationError } from '../../src/platform/errors.js';
import { consumeIdentityQuota } from '../../src/features/identity/security/rate-limit.js';
import { identityKeyfileFixture, identityKeysFixture } from '../helpers/identity-security.js';
import { createIntegrationDatabase, databaseUrl } from './setup.js';

const integration = databaseUrl ? describe : describe.skip;
integration('identity persistent atomic quota (real isolated PG)', () => {
  it('shares limits across concurrent processes and a fresh process restart', async () => {
    const db = await createIntegrationDatabase();
    const fixture = identityKeyfileFixture();
    async function processAttempts(count: number): Promise<number[]> {
      const child = Bun.spawn({
        cmd: [
          process.execPath,
          fileURLToPath(new URL('../helpers/identity-quota-process.ts', import.meta.url)),
          String(count),
        ],
        env: {
          ...process.env,
          DATABASE_URL: db.connectionString,
          ISOLATED_IDENTITY_TEST_KEYS: JSON.stringify(fixture),
        },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const result = await new Response(child.stdout).text();
      const errors = await new Response(child.stderr).text();
      expect(await child.exited, errors).toBe(0);
      return JSON.parse(result) as number[];
    }
    try {
      const results = (await Promise.all([processAttempts(6), processAttempts(6)])).flat();
      expect(results.filter((status) => status === 200)).toHaveLength(10);
      expect(results.filter((status) => status === 429)).toHaveLength(2);
      expect(await processAttempts(1)).toEqual([429]);
      const rows = (await db.pool.query('SELECT * FROM identity_rate_limits')).rows;
      expect(rows).toHaveLength(2);
      expect(JSON.stringify(rows)).not.toContain('same-account');
      expect(JSON.stringify(rows)).not.toContain('127.0.0.42');
    } finally {
      await db.close();
    }
  });
  it('keeps all dimensions committed, fixed windows and integer maximum Retry-After', async () => {
    const db = await createIntegrationDatabase();
    const keys = identityKeysFixture();
    try {
      for (let i = 0; i < 3; i++)
        await consumeIdentityQuota(db.pool, keys, 'forgot', {
          ip: '127.0.0.7',
          address: 'Case@Example.com',
        });
      const before = (
        await db.pool.query(
          'SELECT window_started_at,window_seconds,count FROM identity_rate_limits ORDER BY dimension',
        )
      ).rows;
      let caught: unknown;
      try {
        await consumeIdentityQuota(db.pool, keys, 'forgot', {
          ip: '127.0.0.7',
          address: 'case@example.com',
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ApplicationError);
      const error = caught as ApplicationError;
      expect(httpStatusForError(error.code)).toBe(429);
      expect(error.errorCode).toBe('RATE_LIMITED');
      const details = error.details as { retry_after_seconds: number };
      expect(Number.isInteger(details.retry_after_seconds)).toBe(true);
      const after = (
        await db.pool.query(
          'SELECT dimension,window_started_at,window_seconds,count,clock_timestamp() AS now FROM identity_rate_limits ORDER BY dimension',
        )
      ).rows;
      expect(after.map((row) => row.window_started_at)).toEqual(
        before.map((row) => row.window_started_at),
      );
      const expected = Math.max(
        ...after.map((row) =>
          Math.ceil(
            (row.window_started_at.getTime() + row.window_seconds * 1000 - row.now.getTime()) /
              1000,
          ),
        ),
      );
      expect(details.retry_after_seconds).toBeGreaterThanOrEqual(expected);
      expect(details.retry_after_seconds).toBeLessThanOrEqual(expected + 1);
      expect(after.find((row) => row.dimension === 'ip').count).toBe(4);
      await db.pool.query(
        `UPDATE identity_rate_limits SET window_started_at=window_started_at-interval '1 hour',expires_at=expires_at-interval '1 hour'`,
      );
      await consumeIdentityQuota(db.pool, keys, 'forgot', {
        ip: '127.0.0.7',
        address: 'case@example.com',
      });
      expect(
        (await db.pool.query('SELECT count(*)::int AS n FROM identity_rate_limits')).rows[0].n,
      ).toBe(4);
    } finally {
      await db.close();
    }
  });
  it('commits an exhausted IP charge without creating further controllable subjects', async () => {
    const db = await createIntegrationDatabase();
    const keys = identityKeysFixture();
    const cases = [
      {
        action: 'sign_in' as const,
        scope: 'sign_in',
        limit: 60,
        dimensions: ['identifier'],
        subjects: (i: number) => ({ ip: '192.0.2.1', identifier: `account-${i}` }),
      },
      {
        action: 'forgot' as const,
        scope: 'forgot',
        limit: 20,
        dimensions: ['address'],
        subjects: (i: number) => ({ ip: '192.0.2.2', address: `address-${i}@example.com` }),
      },
      {
        action: 'accept' as const,
        scope: 'accept',
        limit: 60,
        dimensions: ['token'],
        subjects: (i: number) => ({ ip: '192.0.2.3', token: `token-${i}` }),
      },
      {
        action: 'contact_request' as const,
        scope: 'contact_request',
        limit: 30,
        dimensions: ['actor', 'address'],
        subjects: (i: number) => ({
          ip: '192.0.2.4',
          actor: `actor-${i}`,
          address: `contact-${i}@example.com`,
        }),
      },
    ];
    try {
      for (const test of cases) {
        for (let i = 0; i < test.limit; i++)
          await consumeIdentityQuota(db.pool, keys, test.action, test.subjects(i));

        const before = (
          await db.pool.query(
            `SELECT dimension,count(*)::int AS rows,sum(count)::int AS charges
             FROM identity_rate_limits WHERE action=$1 AND dimension<>'ip'
             GROUP BY dimension ORDER BY dimension`,
            [test.scope],
          )
        ).rows;
        expect(before).toEqual(
          test.dimensions.map((dimension) => ({
            dimension,
            rows: test.limit,
            charges: test.limit,
          })),
        );
        for (let i = test.limit; i < test.limit + 5; i++)
          await expectApplicationRejection(
            consumeIdentityQuota(db.pool, keys, test.action, test.subjects(i)),
            { status: 429, errorCode: 'RATE_LIMITED' },
          );

        const after = (
          await db.pool.query(
            `SELECT dimension,count(*)::int AS rows,sum(count)::int AS charges
             FROM identity_rate_limits WHERE action=$1 AND dimension<>'ip'
             GROUP BY dimension ORDER BY dimension`,
            [test.scope],
          )
        ).rows;
        expect(after).toEqual(before);
        const ip = (
          await db.pool.query(
            `SELECT count FROM identity_rate_limits WHERE action=$1 AND dimension='ip'`,
            [test.scope],
          )
        ).rows;
        expect(ip).toEqual([{ count: test.limit + 1 }]);
      }
    } finally {
      await db.close();
    }
  });
  it('serializes concurrent IP boundary requests before charging distinct identifiers', async () => {
    const db = await createIntegrationDatabase();
    const otherPool = db.connect();
    const keys = identityKeysFixture();
    try {
      for (let i = 0; i < 58; i++)
        await consumeIdentityQuota(db.pool, keys, 'sign_in', {
          ip: '192.0.2.5',
          identifier: `before-${i}`,
        });
      const results = await Promise.allSettled(
        Array.from({ length: 8 }, (_, i) =>
          consumeIdentityQuota(i % 2 ? otherPool : db.pool, keys, 'sign_in', {
            ip: '192.0.2.5',
            identifier: `concurrent-${i}`,
          }),
        ),
      );
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(2);
      const rejected = results.filter((result) => result.status === 'rejected');
      expect(rejected).toHaveLength(6);
      for (const result of rejected)
        if (result.status === 'rejected')
          expect(applicationErrorEvidence(result.reason)).toMatchObject({
            status: 429,
            errorCode: 'RATE_LIMITED',
          });
      const rows = (
        await db.pool.query(
          `SELECT dimension,count(*)::int AS rows,sum(count)::int AS charges
           FROM identity_rate_limits GROUP BY dimension ORDER BY dimension`,
        )
      ).rows;
      expect(rows).toEqual([
        { dimension: 'identifier', rows: 60, charges: 60 },
        { dimension: 'ip', rows: 1, charges: 61 },
      ]);
    } finally {
      await otherPool.end();
      await db.close();
    }
  });
  it('does not permit switching invite actions to bypass shared address and actor budgets', async () => {
    const db = await createIntegrationDatabase();
    const keys = identityKeysFixture();
    try {
      for (let i = 0; i < 3; i++)
        await consumeIdentityQuota(db.pool, keys, i % 2 ? 'invite_resend' : 'invite_create', {
          ip: '127.0.0.9',
          actor: 'admin',
          address: 'target@example.com',
        });
      await expectApplicationRejection(
        consumeIdentityQuota(db.pool, keys, 'invite_resend', {
          ip: '127.0.0.9',
          actor: 'admin',
          address: 'target@example.com',
        }),
        { status: 429 },
      );
      await expectApplicationRejection(
        consumeIdentityQuota(db.pool, keys, 'contact_verify', {
          ip: '127.0.0.9',
          token: 'invalid-format',
        }),
        { status: 503 },
      );
    } finally {
      await db.close();
    }
  });
  it('rolls back every dimension on database failure rather than granting a partial permit', async () => {
    const db = await createIntegrationDatabase();
    const keys = identityKeysFixture();
    try {
      await db.pool.query(
        `CREATE FUNCTION identity_quota_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.dimension='address' THEN RAISE EXCEPTION 'isolated fault'; END IF; RETURN NEW; END $$; CREATE TRIGGER identity_quota_fault BEFORE INSERT OR UPDATE ON identity_rate_limits FOR EACH ROW EXECUTE FUNCTION identity_quota_fail()`,
      );
      await expectApplicationRejection(
        consumeIdentityQuota(db.pool, keys, 'forgot', {
          ip: '127.0.0.10',
          address: 'absent@example.com',
        }),
        { status: 503 },
      );
      expect(
        (await db.pool.query('SELECT count(*)::int AS n FROM identity_rate_limits')).rows[0].n,
      ).toBe(0);
    } finally {
      await db.close();
    }
  });
});
