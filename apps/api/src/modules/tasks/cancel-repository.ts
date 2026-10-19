// Cancel repository: raw SQL for the cancel path. No writes to
// agent_runs/run_attempts/run_checkpoints/tool_calls (owned by #9).
import type { PoolClient } from "pg";

export interface CancelTaskRow {
  id: string;
  owner_id: string;
  state: string;
  state_version: number;
}

export async function lockTaskForCancel(
  client: PoolClient,
  taskId: string,
): Promise<CancelTaskRow | null> {
  const { rows } = await client.query<CancelTaskRow>(
    `SELECT id, owner_id, state, state_version FROM tasks
     WHERE id = $1 FOR UPDATE`,
    [taskId],
  );
  return rows[0] ?? null;
}

export async function findCancelRowByKey(
  client: PoolClient,
  idempotencyKey: string,
): Promise<{ task_id: string } | null> {
  const { rows } = await client.query<{ task_id: string }>(
    `SELECT task_id FROM outbox
     WHERE idempotency_key = $1 AND command->>'kind' = 'cancel'`,
    [idempotencyKey],
  );
  return rows[0] ?? null;
}

export async function insertCancelCommand(
  client: PoolClient,
  args: {
    ownerId: string;
    taskId: string;
    expectedStateVersion: number;
    fireAtIso: string;
    idempotencyKey: string;
    reason: string | null;
  },
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO outbox (id, owner_id, task_id, expected_state_version,
       command, idempotency_key, status)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 'pending')
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id`,
    [
      args.ownerId,
      args.taskId,
      args.expectedStateVersion,
      JSON.stringify({
        kind: "cancel",
        task_id: args.taskId,
        fire_at_utc: args.fireAtIso,
        expected_state_version: args.expectedStateVersion,
        idempotency_key: args.idempotencyKey,
        reason: args.reason,
      }),
      args.idempotencyKey,
    ],
  );
  if (rows[0]) return rows[0].id;
  const existing = await findCancelRowByKey(client, args.idempotencyKey);
  void existing;
  const { rows: again } = await client.query<{ id: string }>(
    "SELECT id FROM outbox WHERE idempotency_key = $1",
    [args.idempotencyKey],
  );
  if (!again[0]) throw new Error("cancel outbox insert lost");
  return again[0].id;
}
