import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { getApprovalDetail, listApprovalsForOwner } from '../../src/modules/approvals/service.js';
import { databaseUrl, requirePool, seedApproval } from './setup.js';

const maybe = databaseUrl ? describe : describe.skip;

maybe('approvals read routes', () => {
  let pool: Pool;
  beforeAll(() => {
    pool = requirePool();
  });
  afterAll(async () => {
    await pool.end();
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
});
