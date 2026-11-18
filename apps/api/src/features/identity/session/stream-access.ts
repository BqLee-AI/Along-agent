import type { PoolClient } from 'pg';
import { isActiveOwner } from '../profile/preferences.js';

// The user lock orders delivery with sign-out and deactivation. The session
// lock also orders delivery with other session revocation paths.
export async function lockViewerAccess(
  client: PoolClient,
  ownerId: string,
  sessionId: string | null,
): Promise<boolean> {
  if (!(await isActiveOwner(client, ownerId, { lock: 'share' }))) return false;
  if (sessionId === null) return true; // local development actor
  const { rows } = await client.query<{ valid: boolean }>(
    `SELECT revoked_at IS NULL AND expires_at > clock_timestamp() AS valid
       FROM sessions WHERE id=$1 AND user_id=$2 FOR SHARE`,
    [sessionId, ownerId],
  );
  return rows[0]?.valid === true;
}
