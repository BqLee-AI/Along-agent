import type { PoolClient } from 'pg';

/** Append the event for a state version in the caller's transaction. */
export async function appendTaskEvent(
  client: PoolClient,
  args: {
    ownerId: string;
    taskId: string;
    stateVersion: number;
    type: string;
    evidenceRef: string;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO task_events (id, owner_id, task_id, state_version, type, evidence_ref)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)`,
    [args.ownerId, args.taskId, args.stateVersion, args.type, args.evidenceRef],
  );
}
