import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { stateConflict } from '../../http/errors.js';
import type { ConversationDeps, RunContext } from './contracts.js';
import { executeHarness } from './harness-authority.js';
import { latestAttemptId, lockRun } from './repository.js';
import { RunOwnership } from './run-ownership.js';
import { commitTerminal } from './run-state.js';

/** Use the control pool's connection settings, with a separate bounded pool. */
export function createRunDriver(pool: Pool): RunDriver {
  const ownershipPool = new Pool({
    ...pool.options,
    max: 5,
    connectionTimeoutMillis: 3000,
    statement_timeout: 5000,
    query_timeout: 6000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 1000,
  });
  ownershipPool.on('error', () => console.error('[run-owner] idle connection lost'));
  return new RunDriver(ownershipPool, 4);
}

// The lock pool is separate from the control pool: cancellation and reads must
// remain available even while all execution slots are occupied.
export class RunDriver {
  private slots = 0;
  private stopping = false;
  private readonly executions = new Set<Promise<void>>();
  private readonly owners = new Set<RunOwnership>();
  private readonly scanner: NodeJS.Timeout;
  private scanning = false;
  private scanAfter: string | null = null;

  constructor(
    private readonly ownershipPool: Pool,
    private readonly capacity = 4,
  ) {
    this.scanner = setInterval(() => {
      void this.scan();
    }, 2000);
    this.scanner.unref();
    void this.scan();
  }

  async acquire(runId: string, waitForLock = false): Promise<RunOwnership> {
    if (this.stopping || this.slots >= this.capacity)
      throw stateConflict('server-owned execution capacity unavailable');
    this.slots++;
    try {
      const deadline = Date.now() + (waitForLock ? 3000 : 0);
      for (;;) {
        const owner = await RunOwnership.tryAcquire(this.ownershipPool, runId);
        if (owner) {
          if (this.stopping) {
            await owner.close();
            throw stateConflict('server-owned execution is shutting down');
          }
          this.owners.add(owner);
          return owner;
        }
        if (this.stopping || Date.now() >= deadline)
          throw stateConflict('Run already has an execution owner');
        await delay(50);
      }
    } catch (error) {
      this.slots--;
      throw error;
    }
  }

  async release(owner: RunOwnership): Promise<void> {
    if (!this.owners.delete(owner)) return;
    try {
      await owner.close();
    } finally {
      this.slots--;
    }
  }

  start(deps: ConversationDeps, context: RunContext): void {
    const owner = context.ownership;
    if (!owner || !this.owners.has(owner) || this.stopping)
      throw stateConflict('Run execution owner unavailable');
    let checking = false;
    const probe = setInterval(() => {
      if (checking || owner.signal.aborted) return;
      checking = true;
      void owner
        .transaction(async (client) => {
          const locked = await lockRun(client, context, false);
          await owner.assert(client, context.runId, context.attemptId);
          if (
            (locked.run.status !== 'running' && locked.run.status !== 'paused') ||
            (locked.run.status === 'running' && locked.attempt.status !== 'running')
          )
            throw stateConflict('Run attempt cannot execute');
        })
        .catch(() => owner.revoke())
        .finally(() => {
          checking = false;
        });
    }, 1000);
    probe.unref();
    const deadline = setTimeout(() => owner.revoke(), 5 * 60_000);
    deadline.unref();
    const execution = executeHarness(deps, context, async () => true).finally(async () => {
      clearInterval(probe);
      clearTimeout(deadline);
      await this.release(owner);
    });
    this.executions.add(execution);
    void execution.catch(() => undefined).finally(() => this.executions.delete(execution));
  }

  private async scan(): Promise<void> {
    if (this.stopping || this.scanning) return;
    this.scanning = true;
    // The fifth bounded ownership connection is reserved for recovery; using
    // the unbounded control pool can strand every later scan on a blackhole.
    try {
      const candidates = await this.ownershipPool.query<{
        id: string;
        owner_id: string;
        conversation_id: string;
      }>(
        `SELECT id,owner_id,conversation_id FROM agent_runs
         WHERE status='running' AND frozen_context->>'execution_lifecycle'='server-owned'
           AND ($1::uuid IS NULL OR id > $1::uuid)
         ORDER BY id LIMIT 32`,
        [this.scanAfter],
      );
      this.scanAfter = candidates.rows.length === 32 ? candidates.rows[31]!.id : null;
      for (const row of candidates.rows) {
        if (this.stopping) break;
        const owner = await RunOwnership.tryAcquire(this.ownershipPool, row.id);
        if (!owner) continue;
        try {
          await owner.transaction(async (client) => {
            await owner.assert(client, row.id);
            const attemptId = await latestAttemptId(client, row.owner_id, row.id);
            const binding = {
              ownerId: row.owner_id,
              conversationId: row.conversation_id,
              runId: row.id,
              attemptId,
              requestId: randomUUID(),
            };
            const locked = await lockRun(client, binding, false, false);
            if (
              locked.run.status !== 'running' ||
              locked.attempt.status !== 'running' ||
              locked.run.frozen_context?.execution_lifecycle !== 'server-owned'
            )
              return;
            await client.query(
              "UPDATE run_attempts SET status='fenced_out',ended_at=now() WHERE id=$1",
              [attemptId],
            );
            await owner.assert(client, row.id);
            await commitTerminal(
              client,
              binding,
              'failed',
              {
                conversation_id: row.conversation_id,
                run_id: row.id,
                error: {
                  code: 'HARNESS_UNAVAILABLE',
                  message: '服务端执行中断。',
                  http_status: 503,
                },
              },
              { preserveAttemptStatus: true },
            );
          });
        } catch {
          // Another control operation may have won. Retry the bounded scan later.
        } finally {
          await owner.close();
        }
      }
    } catch {
      // Database outages leave facts untouched; a later scan can retry.
    } finally {
      this.scanning = false;
    }
  }

  async shutdown(): Promise<void> {
    this.stopping = true;
    clearInterval(this.scanner);
    for (const owner of this.owners) owner.revoke();
    await Promise.allSettled([...this.executions]);
    await Promise.allSettled([...this.owners].map((owner) => this.release(owner)));
    await this.ownershipPool.end();
  }
}
