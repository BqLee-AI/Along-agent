import type { PoolClient } from 'pg';
import { notReady } from '../../../platform/errors.js';
import type { IdentityKeyring } from './email-security.js';

// All digest-dependent transactions take this lock before reading or writing identity
// lookup state. Different processes with different configurations cannot both pass
// the check while the database is still empty and then write incompatible digests.
export async function requireLookupKey(client: PoolClient, keys: IdentityKeyring): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(680068, 2)');
  const mismatch = await client.query(
    `SELECT 1 FROM identity_contacts WHERE lookup_key_id<>$1
     UNION ALL SELECT 1 FROM identity_invitations WHERE state='pending' AND lookup_key_id<>$1
     UNION ALL SELECT 1 FROM identity_challenges
       WHERE consumed_at IS NULL AND revoked_at IS NULL AND expires_at>clock_timestamp() AND lookup_key_id<>$1
     LIMIT 1`,
    [keys.lookup.id],
  );
  if (mismatch.rowCount) throw notReady('identity lookup key unavailable');
}
