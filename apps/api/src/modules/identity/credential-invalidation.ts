import type { PoolClient } from 'pg';

/** `condition` is a trusted SQL fragment built by identity code, never from input. */
export async function revokeChallenges(client: PoolClient, condition: string, args: unknown[]) {
  await client.query(
    `UPDATE identity_challenges SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE ${condition} AND consumed_at IS NULL`,
    args,
  );
  await client.query(
    `UPDATE identity_mail_deliveries d SET status='suppressed',updated_at=clock_timestamp(),finished_at=clock_timestamp(),payload_ciphertext=NULL,payload_nonce=NULL,payload_tag=NULL,encryption_key_id=NULL,payload_erased_at=clock_timestamp() WHERE d.status='queued' AND d.challenge_id IN (SELECT id FROM identity_challenges WHERE ${condition} AND revoked_at IS NOT NULL)`,
    args,
  );
}

/** Credential change: bump revision, void pending challenges, revoke every session. */
export async function invalidateUser(client: PoolClient, userId: string) {
  await client.query(
    'UPDATE identity_account_admissions SET credential_revision=credential_revision+1 WHERE user_id=$1',
    [userId],
  );
  await revokeChallenges(client, 'user_id=$1', [userId]);
  await client.query(
    'UPDATE sessions SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE user_id=$1',
    [userId],
  );
}
