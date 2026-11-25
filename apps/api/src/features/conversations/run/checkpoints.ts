import type { Pool, PoolClient } from 'pg';
import { ThreadEventSchema, type ThreadEvent } from '@along/stream-protocol';

export async function readRunEventCursor(client: PoolClient, runId: string): Promise<number> {
  const { rows } = await client.query<{ seq: string }>(
    `SELECT COALESCE(max(c.event_seq),0)::text AS seq FROM run_checkpoints c
     JOIN run_attempts a ON a.id=c.attempt_id WHERE a.run_id=$1`,
    [runId],
  );
  return Number(rows[0]!.seq);
}

/** Caller serializes writes to the same attempt. SSE uses the returned global cursor. */
export async function appendCheckpoint(
  client: PoolClient,
  args: {
    id?: string;
    ownerId: string;
    attemptId: string;
    seq?: number;
    kind: string;
    payloadJson: string;
    protocol: string;
  },
): Promise<number> {
  const { rows } = await client.query<{ event_seq: string }>(
    `INSERT INTO run_checkpoints(id,owner_id,attempt_id,seq,kind,payload,stream_protocol_version)
     VALUES(COALESCE($1,gen_random_uuid()),$2,$3,
       COALESCE($4,(SELECT COALESCE(max(seq),0)::int+1 FROM run_checkpoints WHERE attempt_id=$3)),
       $5,$6::jsonb,$7)
     RETURNING event_seq`,
    [
      args.id ?? null,
      args.ownerId,
      args.attemptId,
      args.seq ?? null,
      args.kind,
      args.payloadJson,
      args.protocol,
    ],
  );
  const seq = rows[0]?.event_seq;
  if (seq === undefined) throw new Error('checkpoint insert returned no row');
  return Number(seq);
}

interface CheckpointRow {
  event_seq: string;
  payload: { type: string; payload: unknown; request_id: string };
  stream_protocol_version: string;
}

function envelopeOf(row: CheckpointRow): ThreadEvent {
  return ThreadEventSchema.parse({
    protocol_version: row.stream_protocol_version,
    seq: Number(row.event_seq),
    type: row.payload.type,
    payload: row.payload.payload,
    request_id: row.payload.request_id,
  });
}

export async function listRunEvents(
  client: Pick<Pool | PoolClient, 'query'>,
  ownerId: string,
  runId: string,
  attemptId?: string,
): Promise<ThreadEvent[]> {
  const { rows } = await client.query<CheckpointRow>(
    `SELECT c.event_seq, c.payload, c.stream_protocol_version
     FROM run_checkpoints c
     JOIN run_attempts a ON a.id = c.attempt_id
     JOIN agent_runs r ON r.id = a.run_id
     WHERE r.owner_id = $1 AND r.id = $2
       AND ($3::uuid IS NULL OR c.attempt_id=$3)
       AND c.kind IN ('thread.started','message.delta','card.proposed','approval_required',
         'thread.completed','thread.failed','thread.cancelled')
       AND NOT EXISTS (SELECT 1 FROM feishu_pending_disclosures p
                       WHERE p.run_id=r.id AND p.event_seq=c.event_seq)
     ORDER BY c.event_seq ASC`,
    [ownerId, runId, attemptId ?? null],
  );
  return rows.map(envelopeOf);
}

export async function listConversationEvents(
  client: Pick<Pool | PoolClient, 'query'>,
  args: {
    ownerId: string;
    conversationId: string;
    afterSeq: number | null;
    limit: number;
    runId?: string;
    includePendingDisclosures?: boolean;
  },
): Promise<ThreadEvent[]> {
  const { rows } = await client.query<CheckpointRow>(
    `SELECT c.event_seq, c.payload, c.stream_protocol_version
     FROM run_checkpoints c
     JOIN run_attempts a ON a.id = c.attempt_id
     JOIN agent_runs r ON r.id = a.run_id
     WHERE r.owner_id = $1 AND r.conversation_id = $2
       AND c.owner_id=$1 AND a.owner_id=$1
       AND EXISTS (SELECT 1 FROM conversations parent WHERE parent.id=r.conversation_id AND parent.owner_id=$1)
       AND ($5::uuid IS NULL OR r.id=$5::uuid)
       AND c.kind IN ('thread.started','message.delta','card.proposed','approval_required',
         'thread.completed','thread.failed','thread.cancelled')
       AND ($3::bigint IS NULL OR c.event_seq > $3::bigint)
       AND ($6::boolean OR NOT EXISTS (SELECT 1 FROM feishu_pending_disclosures p
                       WHERE p.run_id=r.id AND p.event_seq=c.event_seq))
     ORDER BY c.event_seq ASC
     LIMIT $4`,
    [
      args.ownerId,
      args.conversationId,
      args.afterSeq,
      args.limit,
      args.runId ?? null,
      args.includePendingDisclosures ?? false,
    ],
  );
  return rows.map(envelopeOf);
}
