import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { ApprovalDetailSchema } from '@along/contracts';
import { confirmApproval, rejectApproval } from '../../src/modules/approvals/confirm.js';
import { createCancelTaskApproval } from '../../src/modules/approvals/create.js';
import { readApprovalDecision } from '../../src/modules/approvals/decision.js';
import { reviseApproval } from '../../src/modules/approvals/revise.js';
import { loadTimeContext } from '../../src/modules/time/context.js';
import { getApprovalDetail, listApprovalsForOwner } from '../../src/modules/approvals/service.js';
import {
  createIntegrationDatabase,
  databaseUrl,
  type IntegrationDatabase,
  seedApproval,
} from './setup.js';

const maybe = databaseUrl ? describe : describe.skip;

async function confirm(pool: Pool, ownerId: string, approvalId: string) {
  const { detail } = await getApprovalDetail({ pool }, ownerId, approvalId);
  return confirmApproval({ pool }, ownerId, approvalId, {
    presentation_hash: detail.presentation_hash,
    seen_content: detail.echo_text,
    idempotency_key: randomUUID(),
  });
}

async function historyFacts(pool: Pool, ownerId: string) {
  const facts: Record<string, unknown[]> = {};
  for (const table of [
    'approvals',
    'approval_revision_requests',
    'tasks',
    'task_events',
    'outbox',
    'notifications',
    'agent_runs',
    'run_attempts',
    'tool_invocations',
    'tool_calls',
    'document_approval_decisions',
  ]) {
    facts[table] = (
      await pool.query(
        `SELECT to_jsonb(t) AS fact FROM ${table} t WHERE owner_id = $1 ORDER BY to_jsonb(t)::text`,
        [ownerId],
      )
    ).rows;
  }
  return facts;
}

maybe('approvals read routes', () => {
  let database: IntegrationDatabase;
  let pool: Pool;
  beforeAll(async () => {
    database = await createIntegrationDatabase();
    pool = database.pool;
  });
  afterAll(async () => {
    await database?.close();
  });

  it('lists only pending by default with keyset pagination', async () => {
    const owner = randomUUID();
    await seedApproval(pool, { ownerId: owner });
    await seedApproval(pool, { ownerId: owner });
    const first = await listApprovalsForOwner({ pool }, owner, { limit: '1' });
    expect(first.items).toHaveLength(1);
    expect(first.items[0]?.status).toBe('pending');
    expect(first.next_cursor).not.toBeNull();
    const second = await listApprovalsForOwner({ pool }, owner, {
      limit: '1',
      cursor: first.next_cursor ?? undefined,
    });
    expect(second.items).toHaveLength(1);
    expect(second.items[0]?.approval_id).not.toBe(first.items[0]?.approval_id);
  });

  it('projects effective expired without writing', async () => {
    const owner = randomUUID();
    const seed = await seedApproval(pool, { ownerId: owner, expiresInHours: -1 });
    const { detail } = await getApprovalDetail({ pool }, owner, seed.id);
    expect(detail.status).toBe('expired');
    expect(detail.result).toEqual({ task_id: null, successor_approval_id: null });
    const { rows } = await pool.query<{ state: string }>(
      'SELECT state FROM approvals WHERE id = $1',
      [seed.id],
    );
    expect(rows[0]?.state).toBe('pending');
  });

  it('detail exposes frozen snapshot and echo', async () => {
    const owner = randomUUID();
    const seed = await seedApproval(pool, { ownerId: owner });
    const { detail } = await getApprovalDetail({ pool }, owner, seed.id);
    expect(detail.approval_id).toBe(seed.id);
    expect(detail.presentation_hash).toBe(seed.presentationHash);
    expect(detail.echo_text).toContain('请确认');
    expect(detail.snapshot.timezone_id).toBe('Asia/Shanghai');
    expect(detail.result).toEqual({ task_id: null, successor_approval_id: null });
  });

  it('cross-owner reads are forbidden, missing rows are 404', async () => {
    const seed = await seedApproval(pool, {});
    await expect(getApprovalDetail({ pool }, randomUUID(), seed.id)).rejects.toMatchObject({
      httpStatus: 403,
    });
    await expect(getApprovalDetail({ pool }, seed.ownerId, randomUUID())).rejects.toMatchObject({
      httpStatus: 404,
    });
  });

  it('recovers the actual created task without replaying confirmation or adding effects', async () => {
    const seed = await seedApproval(pool);
    const consumed = await confirm(pool, seed.ownerId, seed.id);
    const before = await historyFacts(pool, seed.ownerId);
    for (let read = 0; read < 2; read++) {
      const { detail, successorId } = await getApprovalDetail({ pool }, seed.ownerId, seed.id);
      expect(ApprovalDetailSchema.parse(detail)).toMatchObject({
        status: 'consumed',
        result: { task_id: consumed.task_id, successor_approval_id: null },
      });
      expect(successorId).toBeNull();
    }
    expect(await historyFacts(pool, seed.ownerId)).toEqual(before);
  });

  it('recovers the actual cancelled target, not a consumed creation reference', async () => {
    const seed = await seedApproval(pool);
    const created = await confirm(pool, seed.ownerId, seed.id);
    const cancel = await createCancelTaskApproval(pool, {
      ownerId: seed.ownerId,
      conversationId: randomUUID(),
      originalText: '取消喝水提醒',
      wallTime: '2026-11-02 09:20',
      timezoneId: 'Asia/Shanghai',
      fold: 0,
      offsetSeconds: 28800,
      tzdbVersion: '2024a',
      fireAtUtc: new Date(Date.now() + 25 * 3600_000).toISOString(),
      targetTaskId: created.task_id,
      expectedStateVersion: 1,
    });
    const consumed = await confirm(pool, seed.ownerId, cancel.approvalId);
    expect(consumed.task_id).toBe(created.task_id);
    const before = await historyFacts(pool, seed.ownerId);
    const { detail } = await getApprovalDetail({ pool }, seed.ownerId, cancel.approvalId);
    expect(ApprovalDetailSchema.parse(detail)).toMatchObject({
      kind: 'cancel_task',
      status: 'consumed',
      result: { task_id: created.task_id, successor_approval_id: null },
    });
    const stored = await pool.query('SELECT consumed_task_id FROM approvals WHERE id = $1', [
      cancel.approvalId,
    ]);
    expect(stored.rows[0].consumed_task_id).toBeNull();
    expect(await historyFacts(pool, seed.ownerId)).toEqual(before);
    await expect(
      getApprovalDetail({ pool }, randomUUID(), cancel.approvalId),
    ).rejects.toMatchObject({
      httpStatus: 403,
    });
  });

  it('keeps actual successor and predecessor links without writing revision decisions', async () => {
    const seed = await seedApproval(pool);
    const revised = await reviseApproval(
      { pool, timeContext: loadTimeContext('fixture-v1') },
      seed.ownerId,
      seed.id,
      {
        raw_text: '2027-11-02 09:20 喝水',
        confirmed_timezone: 'Asia/Shanghai',
        idempotency_key: randomUUID(),
      },
    );
    const before = await historyFacts(pool, seed.ownerId);
    const { detail, successorId } = await getApprovalDetail({ pool }, seed.ownerId, seed.id);
    expect(ApprovalDetailSchema.parse(detail)).toMatchObject({
      status: 'superseded',
      result: { task_id: null, successor_approval_id: revised.successor_approval_id },
    });
    expect(successorId).toBe(revised.successor_approval_id);
    const successor = await getApprovalDetail(
      { pool },
      seed.ownerId,
      revised.successor_approval_id,
    );
    expect(successor.detail.recreated_from).toBe(seed.id);
    expect(successor.detail.result).toEqual({ task_id: null, successor_approval_id: null });
    expect(await historyFacts(pool, seed.ownerId)).toEqual(before);
  });

  it('uses one effective instant for status, remaining lifetime and result at expiry', async () => {
    const seed = await seedApproval(pool);
    const boundary = new Date('2099-11-01T00:00:00.000Z');
    await pool.query('UPDATE approvals SET expires_at = $2, fire_at_utc = $3 WHERE id = $1', [
      seed.id,
      boundary,
      new Date('2099-11-02T00:00:00.000Z'),
    ]);
    let calls = 0;
    const before = await historyFacts(pool, seed.ownerId);
    const pending = await getApprovalDetail(
      {
        pool,
        now: () => {
          calls++;
          return calls === 1 ? new Date(boundary.getTime() - 1000) : boundary;
        },
      },
      seed.ownerId,
      seed.id,
    );
    expect(calls).toBe(1);
    expect(pending.detail).toMatchObject({
      status: 'pending',
      expires_in_seconds: 1,
      result: { task_id: null, successor_approval_id: null },
    });
    const expired = await getApprovalDetail({ pool, now: () => boundary }, seed.ownerId, seed.id);
    expect(expired.detail).toMatchObject({
      status: 'expired',
      expires_in_seconds: 0,
      result: { task_id: null, successor_approval_id: null },
    });
    expect(await historyFacts(pool, seed.ownerId)).toEqual(before);
  });

  it('projects fire-time expiry and rejected details without result references or effects', async () => {
    const due = await seedApproval(pool, { fireInHours: -1 });
    const rejected = await seedApproval(pool);
    await rejectApproval({ pool }, rejected.ownerId, rejected.id, {
      idempotency_key: randomUUID(),
    });
    for (const [seed, status] of [
      [due, 'expired'],
      [rejected, 'rejected'],
    ] as const) {
      const before = await historyFacts(pool, seed.ownerId);
      const { detail } = await getApprovalDetail({ pool }, seed.ownerId, seed.id);
      expect(ApprovalDetailSchema.parse(detail)).toMatchObject({
        status,
        result: { task_id: null, successor_approval_id: null },
      });
      const client = await pool.connect();
      try {
        expect(await readApprovalDecision(client, seed.ownerId, seed.id)).toMatchObject({
          status,
          task_id: null,
          successor_id: null,
        });
      } finally {
        client.release();
      }
      expect(await historyFacts(pool, seed.ownerId)).toEqual(before);
    }
  });

  it('reports a corrupt consumed result instead of null success and still enforces owner', async () => {
    const seed = await seedApproval(pool, { state: 'consumed' });
    const before = await historyFacts(pool, seed.ownerId);
    await expect(getApprovalDetail({ pool }, seed.ownerId, seed.id)).rejects.toMatchObject({
      httpStatus: 409,
      errorCode: 'STATE_CONFLICT',
    });
    await expect(getApprovalDetail({ pool }, randomUUID(), seed.id)).rejects.toMatchObject({
      httpStatus: 403,
    });
    const client = await pool.connect();
    try {
      await expect(readApprovalDecision(client, seed.ownerId, seed.id)).rejects.toMatchObject({
        httpStatus: 409,
        errorCode: 'STATE_CONFLICT',
      });
    } finally {
      client.release();
    }
    expect(await historyFacts(pool, seed.ownerId)).toEqual(before);
  });
});
