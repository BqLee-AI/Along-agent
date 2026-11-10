import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { withTransaction } from '../../db/transaction.js';
import { HttpError, stateConflict } from '../../http/errors.js';

/** One checked-out PostgreSQL session, never reconnected or reused after loss. */
export class RunOwnership {
  readonly token = randomUUID();
  readonly signal: AbortSignal;
  private readonly controller = new AbortController();
  private queue: Promise<void> = Promise.resolve();
  private lost = false;
  private closed = false;
  private readonly onLoss = () => this.lose();

  private constructor(
    private readonly client: PoolClient,
    readonly runId: string,
    private readonly keys: readonly [number, number],
  ) {
    this.signal = this.controller.signal;
    client.on('error', this.onLoss);
    client.on('end', this.onLoss);
  }

  static async tryAcquire(pool: Pool, runId: string): Promise<RunOwnership | null> {
    const digest = createHash('sha256').update('along/run-owner/v1\0').update(runId).digest();
    const keys = [digest.readInt32BE(0), digest.readInt32BE(4)] as const;
    const client = await pool.connect();
    try {
      const result = await client.query<{ acquired: boolean }>(
        'SELECT pg_try_advisory_lock($1::int,$2::int) AS acquired',
        [...keys],
      );
      if (!result.rows[0]?.acquired) {
        client.release();
        return null;
      }
      return new RunOwnership(client, runId, keys);
    } catch (error) {
      client.release(true);
      throw error;
    }
  }

  private lose(): void {
    if (!this.lost) {
      this.lost = true;
      this.controller.abort();
    }
  }
  revoke(): void {
    this.lose();
  }

  async assert(client: PoolClient, runId: string, attemptId?: string): Promise<void> {
    if (this.closed || this.lost || client !== this.client || runId !== this.runId)
      throw stateConflict('Run ownership lost');
    try {
      const result = await client.query<{ held: boolean }>(
        `SELECT ($1::uuid IS NULL OR EXISTS (
           SELECT 1 FROM run_attempts a
           WHERE a.id=$1 AND a.run_id=$2 AND a.lease_token=$3
         )) AND EXISTS (
           SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid()
             AND granted AND mode='ExclusiveLock' AND objsubid=2
             AND classid=$4::bigint::oid AND objid=$5::bigint::oid
         ) AS held`,
        [attemptId ?? null, runId, this.token, this.keys[0] >>> 0, this.keys[1] >>> 0],
      );
      if (!result.rows[0]?.held) throw stateConflict('Run ownership lost');
    } catch (error) {
      this.lose();
      throw error;
    }
  }

  /** No external I/O belongs inside this serialized transaction. */
  async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const { promise, resolve } = Promise.withResolvers<void>();
    const previous = this.queue;
    this.queue = promise;
    await previous;
    try {
      if (this.closed || this.lost) throw stateConflict('Run ownership lost');
      try {
        await this.client.query('BEGIN');
      } catch (error) {
        this.lose();
        throw error;
      }
      let value: T;
      try {
        value = await fn(this.client);
      } catch (error) {
        // A driver/SQL error can leave the session or the COMMIT outcome
        // uncertain. Domain rejections are safe to roll back and continue.
        if (!(error instanceof HttpError)) this.lose();
        // Logical fencing can happen while this backend is still connected.
        // Release its row locks before another session accounts for late effects.
        try {
          await this.client.query('ROLLBACK');
        } catch {
          this.lose();
        }
        throw error;
      }
      if (this.lost || this.closed) {
        try {
          await this.client.query('ROLLBACK');
        } catch {
          this.lose();
        }
        throw stateConflict('Run ownership lost');
      }
      try {
        await this.client.query('COMMIT');
      } catch (error) {
        this.lose();
        throw error;
      }
      return value;
    } finally {
      resolve();
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.queue;
    try {
      if (!this.lost) {
        const result = await this.client.query<{ unlocked: boolean }>(
          'SELECT pg_advisory_unlock($1::int,$2::int) AS unlocked',
          [...this.keys],
        );
        if (!result.rows[0]?.unlocked) this.lose();
      }
    } catch {
      this.lose();
    } finally {
      this.client.removeListener('error', this.onLoss);
      this.client.removeListener('end', this.onLoss);
      this.client.release(this.lost);
    }
  }
}

export async function withRunTransaction<T>(
  pool: Pool,
  ownership: RunOwnership | undefined,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  if (ownership) return ownership.transaction(fn);
  return withTransaction(pool, fn);
}
