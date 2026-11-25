import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { withClient, withTransaction } from '../../../db/transaction.js';
import {
  approvalExpired,
  approvalSuperseded,
  forbidden,
  ApplicationError,
  notFound,
  notReady,
  stateConflict,
  validationError,
} from '../../../platform/errors.js';
import {
  normalizeTime,
  requireTimeContext,
  utcSecondIso,
  type TimeContext,
} from '../../time/public.js';
import { createTaskApproval, wallTextOf } from './create.js';
import {
  findSuccessorId,
  getApproval,
  getApprovalForUpdate,
  persistExpiredIfDue,
} from './repository.js';
import { ReviseBodySchema, type ReviseBody } from './schemas.js';

export interface ReviseDeps {
  pool: Pool | null;
  timeContext?: TimeContext;
}

export interface ReviseResult {
  approval_id: string;
  successor_approval_id: string;
  duplicate: boolean;
}

interface RevisionRequest {
  target_approval_id: string;
  request_hash: string;
  anchor_received_at_utc: Date;
  successor_approval_id: string | null;
}

export function revisionRequestHash(targetId: string, body: ReviseBody): string {
  const fields = [
    'along-approval-revise/v1',
    targetId.toLowerCase(),
    body.raw_text,
    body.confirmed_timezone,
    body.fold_choice,
  ];
  const canonical = fields.map((value) => `${Buffer.byteLength(value, 'utf8')}:${value}`).join('');
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function matchRequest(request: RevisionRequest, targetId: string, hash: string): void {
  if (request.target_approval_id !== targetId || request.request_hash !== hash) {
    throw stateConflict('revision key already used for a different request');
  }
}

function resultOf(request: RevisionRequest, duplicate: boolean): ReviseResult {
  if (!request.successor_approval_id) throw new Error('revision has no committed result');
  return {
    approval_id: request.target_approval_id,
    successor_approval_id: request.successor_approval_id,
    duplicate,
  };
}

function requireContext(context: TimeContext | undefined): TimeContext {
  // Missing wiring is unavailable, never an invitation to load another ruleset.
  if (!context) {
    throw new ApplicationError(
      400006,
      'TZDB_UNAVAILABLE',
      '时区规则库暂不可用，现在无法排期，请稍后再试。',
    );
  }
  requireTimeContext(context);
  return context;
}

async function readRequest(
  client: PoolClient,
  ownerId: string,
  key: string,
  lock = false,
): Promise<RevisionRequest | null> {
  const { rows } = await client.query<RevisionRequest>(
    `SELECT target_approval_id, request_hash, anchor_received_at_utc, successor_approval_id
     FROM approval_revision_requests WHERE owner_id = $1 AND idempotency_key = $2${lock ? ' FOR UPDATE' : ''}`,
    [ownerId, key],
  );
  return rows[0] ?? null;
}

export async function reviseApproval(
  deps: ReviseDeps,
  ownerId: string,
  approvalId: string,
  body: unknown,
): Promise<ReviseResult> {
  const parsed = ReviseBodySchema.safeParse(body);
  if (!parsed.success) throw validationError('invalid revise body');
  const input = parsed.data;
  const pool = deps.pool;
  if (!pool) throw notReady();
  const targetId = approvalId.toLowerCase();
  const hash = revisionRequestHash(targetId, input);

  // Read-only security boundary, including replay. Never expire another owner.
  const existing = await withClient(pool, async (client) => {
    const lookup = await getApproval(client, ownerId, targetId);
    if (!lookup.found) throw notFound('approval not found');
    if (lookup.forbidden) throw forbidden('approval not found');
    return readRequest(client, ownerId, input.idempotency_key);
  });
  if (existing) {
    matchRequest(existing, targetId, hash);
    if (existing.successor_approval_id) return resultOf(existing, true);
  } else {
    // Current actual rules must be available before accepting a new reservation.
    requireContext(deps.timeContext);
  }

  // This COMMIT is the acceptance point, independent of the replacement txn.
  await withTransaction(pool, async (client) => {
    await client.query(
      `INSERT INTO approval_revision_requests
         (owner_id, idempotency_key, target_approval_id, request_hash, anchor_received_at_utc)
       VALUES ($1,$2,$3,$4,clock_timestamp())
       ON CONFLICT (owner_id, idempotency_key) DO NOTHING`,
      [ownerId, input.idempotency_key, targetId, hash],
    );
    const request = await readRequest(client, ownerId, input.idempotency_key);
    if (!request) throw new Error('revision reservation missing');
    matchRequest(request, targetId, hash);
  });

  try {
    const result = await withTransaction(pool, async (client): Promise<ReviseResult | null> => {
      // All revisions use reservation -> target lock order.
      const request = await readRequest(client, ownerId, input.idempotency_key, true);
      if (!request) throw new Error('revision reservation missing');
      matchRequest(request, targetId, hash);
      if (request.successor_approval_id) return resultOf(request, true);

      const row = await getApprovalForUpdate(client, targetId);
      if (!row) throw notFound('approval not found');
      if (row.owner_id !== ownerId) throw forbidden('approval not found');
      if (row.kind !== 'create_task')
        throw stateConflict('only create_task approvals can be revised');
      if (row.state === 'superseded')
        throw approvalSuperseded(await findSuccessorId(client, row.id));
      if (row.state === 'consumed') {
        throw stateConflict('approval already consumed, use cancel', {
          task_id: row.consumed_task_id,
        });
      }
      if (row.state === 'rejected') throw stateConflict('approval already rejected');
      if (row.state === 'expired') throw approvalExpired();
      if (await persistExpiredIfDue(client, row.id)) return null;

      const context = requireContext(deps.timeContext);
      const anchor = utcSecondIso(request.anchor_received_at_utc);
      const time = normalizeTime(context, {
        raw_text: input.raw_text,
        anchorReceivedAtUtc: anchor,
        receivedAtUtc: anchor,
        confirmedTimezone: input.confirmed_timezone,
        foldChoice: input.fold_choice,
        requireCompleteReminder: true,
      });
      if (time.kind === 'clarify') {
        throw validationError(
          '请完整重述提醒内容、明确日期（含年份）和具体时刻，并确认时区；不支持模糊时间。',
        );
      }
      if (time.kind === 'error') {
        const numeric = {
          NONEXISTENT_LOCAL_TIME: 400004,
          AMBIGUOUS_LOCAL_TIME: 400005,
          TZDB_UNAVAILABLE: 400006,
          UNKNOWN_TIMEZONE: 400007,
        }[time.error.code];
        throw new ApplicationError(
          numeric,
          time.error.code,
          time.error.message,
          time.error.details,
        );
      }

      // Fresh DB clock after normalization; never transaction-start now().
      if (await persistExpiredIfDue(client, row.id)) return null;
      const { rows } = await client.query<{ future: boolean }>(
        'SELECT $1::timestamptz > clock_timestamp() AS future',
        [time.normalized.fire_at_utc],
      );
      if (!rows[0]?.future) return null;

      const successor = await createTaskApproval(client, {
        ownerId,
        conversationId: row.conversation_id,
        originalText: input.raw_text,
        wallTime: wallTextOf(time.wall_time),
        timezoneId: time.timezone_id,
        fold: time.normalized.fold,
        foldChoice: input.fold_choice,
        offsetSeconds: time.normalized.offset_seconds,
        fireAtUtc: time.normalized.fire_at_utc,
        tzdbVersion: time.tzdb_version,
        supersedesApprovalId: row.id,
      });
      await client.query("UPDATE approvals SET state = 'superseded' WHERE id = $1", [row.id]);
      await client.query(
        `UPDATE approval_revision_requests SET successor_approval_id = $3
         WHERE owner_id = $1 AND idempotency_key = $2`,
        [ownerId, input.idempotency_key, successor.approvalId],
      );
      return {
        approval_id: row.id,
        successor_approval_id: successor.approvalId,
        duplicate: false,
      };
    });
    if (!result) throw approvalExpired();
    return result;
  } catch (error) {
    // Only the known successor uniqueness violation gets a state re-read.
    const pg = error as { code?: string; constraint?: string };
    if (pg.code === '23505' && pg.constraint === 'approvals_supersedes_approval_id_uniq') {
      await withClient(pool, async (client) => {
        const lookup = await getApproval(client, ownerId, targetId);
        if (!lookup.found) throw notFound('approval not found');
        if (lookup.forbidden) throw forbidden('approval not found');
        if (lookup.row.state === 'superseded') {
          throw approvalSuperseded(await findSuccessorId(client, targetId));
        }
      });
    }
    throw error;
  }
}
