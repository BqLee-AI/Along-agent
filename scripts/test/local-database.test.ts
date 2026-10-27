import { describe, expect, it } from 'bun:test';
import {
  DeploymentDatabase,
  DeploymentDatabaseError,
  hostDatabaseUrl,
} from '../local/database.mjs';

const connectionString = 'postgresql://fixture:fixture-password@127.0.0.1:5432/fixture_database';

// These are pure API boundary tests. Real schema/lease/migration behavior is
// exercised by database-smoke.mjs with explicitly injected isolated PG16 input.
describe('local database explicit connection boundary', () => {
  it('encodes each private identity component without changing loopback routing', () => {
    const config = {
      ports: { postgres: 15432 },
      database: { user: '用 户@:/', password: 'secret@/#?%:值', name: '库 名/@?#' },
    };
    const url = new URL(hostDatabaseUrl(config));
    expect(url.hostname).toBe('127.0.0.1');
    expect(url.port).toBe('15432');
    expect(decodeURIComponent(url.username)).toBe(config.database.user);
    expect(decodeURIComponent(url.password)).toBe(config.database.password);
    expect(decodeURIComponent(url.pathname.slice(1))).toBe(config.database.name);
    expect(url.search).toBe('');
    expect(url.hash).toBe('');
  });

  it.each([
    '',
    'postgresql:///fixture',
    'postgresql://127.0.0.1/fixture',
    'postgresql://fixture@127.0.0.1/fixture',
    'postgresql://fixture:secret@127.0.0.1/',
    'https://fixture:secret@127.0.0.1/fixture',
    'postgresql://fixture:secret@127.0.0.1/fixture?options=-csearch_path=other',
    'postgresql://fixture:secret@127.0.0.1/fixture#private',
    'postgresql://fixture:%ZZ@127.0.0.1/fixture',
  ])('rejects incomplete or option-bearing connection input without leaking it', (value) => {
    let thrown: unknown;
    try {
      new DeploymentDatabase({ connectionString: value });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DeploymentDatabaseError);
    expect((thrown as DeploymentDatabaseError).code).toBe('connection_input_invalid');
    expect((thrown as Error).message).not.toContain('secret');
    expect((thrown as Error).message).not.toContain('postgresql:');
    expect((thrown as Error).message).not.toContain('%ZZ');
  });

  it('does not grant a deployment permit before connecting or after close', async () => {
    const database = new DeploymentDatabase({ connectionString });
    await expect(database.assertLease()).rejects.toMatchObject({ code: 'deployment_lease_lost' });
    await expect(database.classify()).rejects.toMatchObject({ code: 'deployment_lease_lost' });
    await expect(database.acquireLease()).rejects.toMatchObject({ code: 'connection_lost' });
    await database.close();
    await expect(database.assertLease()).rejects.toMatchObject({ code: 'deployment_lease_lost' });
    await expect(database.connect()).rejects.toMatchObject({ code: 'connection_state_invalid' });
  });
});
