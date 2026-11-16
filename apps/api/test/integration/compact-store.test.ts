import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import {
  freezeCompact,
  publishCompact,
  readCompactView,
  type CompactBinding,
} from '../../src/modules/conversations/compact-store.js';
import { validateCompactSources } from '../../src/modules/conversations/compact-sources.js';
import {
  freezeR3Context,
  freezeR3ControlContext,
} from '../../src/modules/conversations/r3-context.js';
import { RunOwnership } from '../../src/modules/conversations/run-ownership.js';
import {
  admitTestUser,
  createIntegrationDatabase,
  databaseUrl,
  type IntegrationDatabase,
} from './setup.js';

const suite = databaseUrl ? describe : describe.skip;
suite('R3 compact persistence', () => {
  let db: IntegrationDatabase;
  beforeAll(async () => {
    db = await createIntegrationDatabase();
  });
  afterAll(async () => {
    await db?.close();
  });

  async function tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async function fixture(profile = 'compact-memory/1', forgedControl = false) {
    const ownerId = randomUUID(),
      conversationId = randomUUID(),
      runId = randomUUID(),
      attemptId = randomUUID(),
      pauseId = randomUUID();
    const first = randomUUID(),
      second = randomUUID(),
      current = randomUUID(),
      provider = randomUUID(),
      version = randomUUID();
    await tx(async (client) => {
      await client.query('INSERT INTO users(id,auth_email) VALUES($1,$2)', [
        ownerId,
        `${ownerId}@example.test`,
      ]);
      await admitTestUser(client, ownerId);
      await client.query('INSERT INTO conversations(id,owner_id) VALUES($1,$2)', [
        conversationId,
        ownerId,
      ]);
      for (const [id, role, text, created] of [
        [first, 'user', 'first', '2020-01-01'],
        [second, 'assistant', 'second', '2020-01-02'],
        [current, 'user', 'current', '2020-01-03'],
      ])
        await client.query(
          'INSERT INTO messages(id,owner_id,conversation_id,role,content,created_at) VALUES($1,$2,$3,$4,$5,$6)',
          [id, ownerId, conversationId, role, text, created],
        );
      await client.query(
        `INSERT INTO agent_runs(id,owner_id,conversation_id,agent_revision,mode,status,budget_max_iterations,budget_max_tokens,execution,input_message_id,frozen_context)
       VALUES($1,$2,$3,'test','chat','paused',10,10000,'harness',$4,$5::jsonb)`,
        [
          runId,
          ownerId,
          conversationId,
          current,
          JSON.stringify({ execution_profile: profile, execution_lifecycle: 'request-bound' }),
        ],
      );
      if (forgedControl) {
        await client.query(
          `INSERT INTO r3_context_freezes(run_id,owner_id,conversation_id,input_message_id,context)
          VALUES($1,$2,$3,$4,$5::jsonb)`,
          [
            runId,
            ownerId,
            conversationId,
            current,
            JSON.stringify({
              manifest: { message_ids: [first, second] },
              summary: null,
              messages: [
                { message_id: first, role: 'user', content: 'first' },
                { message_id: second, role: 'assistant', content: 'second' },
              ],
              input: { type: 'compact_control' },
            }),
          ],
        );
      } else {
        await freezeR3Context(client, { ownerId, conversationId, runId, userMessageId: current });
      }
      await client.query(
        `INSERT INTO run_attempts(id,owner_id,run_id,attempt_no,status) VALUES($1,$2,$3,1,'done')`,
        [attemptId, ownerId, runId],
      );
      await client.query(
        `INSERT INTO harness_pauses(id,owner_id,conversation_id,run_id,attempt_id,idempotency_key,reason,purpose,resume_source,state,snapshot)
       VALUES($1,$2,$3,$4,$5,$6,'runtime','manual_compact','runtime','paused','{}')`,
        [pauseId, ownerId, conversationId, runId, attemptId, randomUUID()],
      );
      await client.query(
        `INSERT INTO model_providers(id,owner_id,name,current_version_id) VALUES($1,$2,'provider',$3)`,
        [provider, ownerId, version],
      );
      await client.query(
        `INSERT INTO model_provider_versions(id,owner_id,provider_id,base_url) VALUES($1,$2,$3,'https://example.test')`,
        [version, ownerId, provider],
      );
      await client.query(
        `INSERT INTO model_provider_run_bindings(run_id,owner_id,version_id,provider_id,provider_name,model_id) VALUES($1,$2,$3,$4,'provider','model')`,
        [runId, ownerId, version, provider],
      );
    });
    return {
      binding: { ownerId, conversationId, runId, attemptId, pauseId } satisfies CompactBinding,
      first,
      second,
      current,
      provider,
      version,
    };
  }
  const guard = async () => {};

  test('freezes exact prefix, atomically publishes and leaves late earlier-timestamp messages uncovered', async () => {
    const { binding, first, second, current } = await fixture();
    const frozen = await tx((client) =>
      freezeCompact(client, binding, { messageIds: [first], promptRevision: 'compact/1' }, guard),
    );
    expect(frozen.messages.map((m) => m.id)).toEqual([first]);
    const late = randomUUID();
    await tx(async (client) => {
      await client.query('SELECT id FROM conversations WHERE id=$1 FOR UPDATE', [
        binding.conversationId,
      ]);
      await client.query(
        `INSERT INTO messages(id,owner_id,conversation_id,role,content,created_at) VALUES($1,$2,$3,'user','late','2019-01-01')`,
        [late, binding.ownerId, binding.conversationId],
      );
    });
    await expect(
      tx((client) =>
        freezeCompact(client, binding, { messageIds: [late], promptRevision: 'compact/1' }, guard),
      ),
    ).rejects.toThrow();
    const published = await tx((client) =>
      publishCompact(
        client,
        binding,
        { freezeId: frozen.freezeId, text: 'summary', messageIds: [first] },
        guard,
      ),
    );
    const view = await tx((client) =>
      readCompactView(client, binding.ownerId, binding.conversationId),
    );
    expect(view.summary).toMatchObject({
      id: published.summaryId,
      revision: '1',
      messageIds: [first],
    });
    expect(view.uncoveredIds).toEqual([late, second, current]);
    await tx((client) =>
      validateCompactSources(client, {
        ownerId: binding.ownerId,
        conversationId: binding.conversationId,
        summaryId: published.summaryId,
        messageIds: [first],
      }),
    );
    await expect(
      tx((client) =>
        validateCompactSources(client, {
          ownerId: randomUUID(),
          conversationId: binding.conversationId,
          summaryId: published.summaryId,
          messageIds: [first],
        }),
      ),
    ).rejects.toThrow();
    await expect(
      tx((client) =>
        validateCompactSources(client, {
          ownerId: binding.ownerId,
          conversationId: binding.conversationId,
          summaryId: published.summaryId,
          messageIds: [late],
        }),
      ),
    ).rejects.toThrow();
    const next = await tx((client) =>
      freezeCompact(client, binding, { messageIds: [second], promptRevision: 'compact/1' }, guard),
    );
    expect(next.previous?.messageIds).toEqual([first]);
    const published2 = await tx((client) =>
      publishCompact(
        client,
        binding,
        { freezeId: next.freezeId, text: 'updated', messageIds: [first, second] },
        guard,
      ),
    );
    expect(published2.revision).toBe('2');
  });

  test('a later Run compacts an uncovered message interleaved with existing covered IDs', async () => {
    const { binding, first, second, current, provider, version } = await fixture();
    const frozen = await tx((client) =>
      freezeCompact(
        client,
        binding,
        { messageIds: [first, second], promptRevision: 'compact/1' },
        guard,
      ),
    );
    const original = await tx((client) =>
      publishCompact(
        client,
        binding,
        { freezeId: frozen.freezeId, text: 'summary', messageIds: [first, second] },
        guard,
      ),
    );
    const late = randomUUID(),
      nextInput = randomUUID(),
      runId = randomUUID(),
      attemptId = randomUUID(),
      pauseId = randomUUID();
    const nextBinding: CompactBinding = {
      ownerId: binding.ownerId,
      conversationId: binding.conversationId,
      runId,
      attemptId,
      pauseId,
    };
    const context = await tx(async (client) => {
      await client.query('SELECT id FROM conversations WHERE id=$1 FOR UPDATE', [
        binding.conversationId,
      ]);
      await client.query(
        `INSERT INTO messages(id,owner_id,conversation_id,role,content,created_at) VALUES
        ($1,$3,$4,'user','late','2020-01-01 12:00:00+00'),($2,$3,$4,'user','next','2020-01-04')`,
        [late, nextInput, binding.ownerId, binding.conversationId],
      );
      await client.query(
        `INSERT INTO agent_runs(id,owner_id,conversation_id,agent_revision,mode,status,budget_max_iterations,budget_max_tokens,execution,input_message_id,frozen_context)
        VALUES($1,$2,$3,'test','chat','paused',10,10000,'harness',$4,$5::jsonb)`,
        [
          runId,
          binding.ownerId,
          binding.conversationId,
          nextInput,
          JSON.stringify({
            execution_profile: 'compact-memory/1',
            execution_lifecycle: 'request-bound',
          }),
        ],
      );
      const admitted = await freezeR3Context(client, {
        ownerId: binding.ownerId,
        conversationId: binding.conversationId,
        runId,
        userMessageId: nextInput,
      });
      await client.query(
        `INSERT INTO run_attempts(id,owner_id,run_id,attempt_no,status) VALUES($1,$2,$3,1,'done')`,
        [attemptId, binding.ownerId, runId],
      );
      await client.query(
        `INSERT INTO harness_pauses(id,owner_id,conversation_id,run_id,attempt_id,idempotency_key,reason,purpose,resume_source,state,snapshot)
        VALUES($1,$2,$3,$4,$5,$6,'runtime','manual_compact','runtime','paused','{}')`,
        [pauseId, binding.ownerId, binding.conversationId, runId, attemptId, randomUUID()],
      );
      await client.query(
        `INSERT INTO model_provider_run_bindings(run_id,owner_id,version_id,provider_id,provider_name,model_id)
        VALUES($1,$2,$3,$4,'provider','model')`,
        [runId, binding.ownerId, version, provider],
      );
      return admitted;
    });
    expect(context.manifest.message_ids).toEqual([first, late, second, current]);
    expect(context.summary?.message_ids).toEqual([first, second]);
    expect(context.messages.map((message) => message.message_id)).toEqual([late, current]);
    await expect(
      tx((client) =>
        freezeCompact(
          client,
          nextBinding,
          { messageIds: [current], promptRevision: 'compact/1' },
          guard,
        ),
      ),
    ).rejects.toThrow();
    const next = await tx((client) =>
      freezeCompact(
        client,
        nextBinding,
        { messageIds: [late], promptRevision: 'compact/1' },
        guard,
      ),
    );
    expect(next.previous).toMatchObject({ id: original.summaryId, messageIds: [first, second] });
    expect(next.coverageMessageIds).toEqual([first, late, second]);
    await expect(
      tx((client) =>
        publishCompact(
          client,
          nextBinding,
          { freezeId: next.freezeId, text: 'bad order', messageIds: [first, second, late] },
          guard,
        ),
      ),
    ).rejects.toThrow();
    const published = await tx((client) =>
      publishCompact(
        client,
        nextBinding,
        { freezeId: next.freezeId, text: 'updated', messageIds: next.coverageMessageIds },
        guard,
      ),
    );
    expect(published.revision).toBe('2');
    const view = await tx((client) =>
      readCompactView(client, binding.ownerId, binding.conversationId),
    );
    expect(view.summary?.messageIds).toEqual([first, late, second]);
    expect(view.uncoveredIds).toEqual([current, nextInput]);
    const thirdRun = randomUUID(),
      thirdAttempt = randomUUID(),
      thirdPause = randomUUID(),
      thirdInput = randomUUID();
    const thirdBinding: CompactBinding = {
      ownerId: binding.ownerId,
      conversationId: binding.conversationId,
      runId: thirdRun,
      attemptId: thirdAttempt,
      pauseId: thirdPause,
    };
    const thirdContext = await tx(async (client) => {
      await client.query('SELECT id FROM conversations WHERE id=$1 FOR UPDATE', [
        binding.conversationId,
      ]);
      await client.query(
        `INSERT INTO messages(id,owner_id,conversation_id,role,content,created_at)
        VALUES($1,$2,$3,'user','third','2020-01-05')`,
        [thirdInput, binding.ownerId, binding.conversationId],
      );
      await client.query(
        `INSERT INTO agent_runs(id,owner_id,conversation_id,agent_revision,mode,status,budget_max_iterations,budget_max_tokens,execution,input_message_id,frozen_context)
        VALUES($1,$2,$3,'test','chat','paused',10,10000,'harness',$4,$5::jsonb)`,
        [
          thirdRun,
          binding.ownerId,
          binding.conversationId,
          thirdInput,
          JSON.stringify({
            execution_profile: 'compact-memory/1',
            execution_lifecycle: 'request-bound',
          }),
        ],
      );
      const admitted = await freezeR3Context(client, {
        ownerId: binding.ownerId,
        conversationId: binding.conversationId,
        runId: thirdRun,
        userMessageId: thirdInput,
      });
      await client.query(
        `INSERT INTO run_attempts(id,owner_id,run_id,attempt_no,status) VALUES($1,$2,$3,1,'done')`,
        [thirdAttempt, binding.ownerId, thirdRun],
      );
      await client.query(
        `INSERT INTO harness_pauses(id,owner_id,conversation_id,run_id,attempt_id,idempotency_key,reason,purpose,resume_source,state,snapshot)
        VALUES($1,$2,$3,$4,$5,$6,'runtime','manual_compact','runtime','paused','{}')`,
        [thirdPause, binding.ownerId, binding.conversationId, thirdRun, thirdAttempt, randomUUID()],
      );
      await client.query(
        `INSERT INTO model_provider_run_bindings(run_id,owner_id,version_id,provider_id,provider_name,model_id)
        VALUES($1,$2,$3,$4,'provider','model')`,
        [thirdRun, binding.ownerId, version, provider],
      );
      return admitted;
    });
    expect(thirdContext.summary?.message_ids).toEqual([first, late, second]);
    const third = await tx((client) =>
      freezeCompact(
        client,
        thirdBinding,
        { messageIds: [current], promptRevision: 'compact/1' },
        guard,
      ),
    );
    expect(third.previous?.messageIds).toEqual([first, late, second]);
    expect(third.messages.map((message) => message.id)).toEqual([current]);
    expect(third.coverageMessageIds).toEqual([first, late, second, current]);
  });

  test('rejects non-prefix, current input, forged coverage and changed sources', async () => {
    const { binding, first, second, current } = await fixture();
    for (const ids of [[second], [first, second, current], [randomUUID()]])
      await expect(
        tx((client) =>
          freezeCompact(client, binding, { messageIds: ids, promptRevision: 'compact/1' }, guard),
        ),
      ).rejects.toThrow();
    const frozen = await tx((client) =>
      freezeCompact(client, binding, { messageIds: [first], promptRevision: 'compact/1' }, guard),
    );
    await expect(
      tx((client) =>
        publishCompact(
          client,
          binding,
          { freezeId: frozen.freezeId, text: 'bad', messageIds: [second] },
          guard,
        ),
      ),
    ).rejects.toThrow();
    await db.pool.query(`UPDATE messages SET content='changed' WHERE id=$1`, [first]);
    await expect(
      tx((client) =>
        publishCompact(
          client,
          binding,
          { freezeId: frozen.freezeId, text: 'bad', messageIds: [first] },
          guard,
        ),
      ),
    ).rejects.toThrow();
    expect(
      (
        await db.pool.query('SELECT id FROM compact_summaries WHERE freeze_id=$1', [
          frozen.freezeId,
        ])
      ).rowCount,
    ).toBe(0);
  });

  test('rejects old profile and messages inserted after Run admission', async () => {
    const old = await fixture('pause-memory/1');
    await expect(
      tx((client) =>
        freezeCompact(
          client,
          old.binding,
          { messageIds: [old.first], promptRevision: 'compact/1' },
          guard,
        ),
      ),
    ).rejects.toThrow();
    const { binding, first, second } = await fixture();
    const late = randomUUID();
    await tx(async (client) => {
      await client.query('SELECT id FROM conversations WHERE id=$1 FOR UPDATE', [
        binding.conversationId,
      ]);
      await client.query(
        `INSERT INTO messages(id,owner_id,conversation_id,role,content,created_at) VALUES($1,$2,$3,'assistant','late','2019-01-01')`,
        [late, binding.ownerId, binding.conversationId],
      );
    });
    await expect(
      tx((client) =>
        freezeCompact(client, binding, { messageIds: [late], promptRevision: 'compact/1' }, guard),
      ),
    ).rejects.toThrow();
    await expect(
      tx((client) =>
        freezeCompact(
          client,
          binding,
          { messageIds: [first, late], promptRevision: 'compact/1' },
          guard,
        ),
      ),
    ).rejects.toThrow();
    const frozen = await tx((client) =>
      freezeCompact(
        client,
        binding,
        { messageIds: [first, second], promptRevision: 'compact/1' },
        guard,
      ),
    );
    expect(frozen.messages.map((message) => message.id)).toEqual([first, second]);
  });

  test('rejects a control context bound to a normal user-input Run', async () => {
    await expect(fixture('compact-memory/1', true)).rejects.toThrow();
  });

  test('idle compact uses the null-input control manifest without creating a user message', async () => {
    const { binding, first, second, current, provider, version } = await fixture();
    const runId = randomUUID(),
      attemptId = randomUUID(),
      pauseId = randomUUID();
    const ownership = await RunOwnership.tryAcquire(db.pool, runId);
    if (!ownership) throw new Error('unable to acquire Run ownership');
    const control: CompactBinding = {
      ownerId: binding.ownerId,
      conversationId: binding.conversationId,
      runId,
      attemptId,
      pauseId,
      ownership,
    };
    try {
      const context = await tx(async (client) => {
        await client.query('SELECT id FROM conversations WHERE id=$1 FOR UPDATE', [
          binding.conversationId,
        ]);
        await client.query(
          `INSERT INTO agent_runs(id,owner_id,conversation_id,agent_revision,mode,status,budget_max_iterations,budget_max_tokens,execution,input_message_id,frozen_context)
        VALUES($1,$2,$3,'test','chat','paused',10,10000,'harness',NULL,$4::jsonb)`,
          [
            runId,
            binding.ownerId,
            binding.conversationId,
            JSON.stringify({
              execution_profile: 'compact-memory/1',
              execution_lifecycle: 'server-owned',
            }),
          ],
        );
        const admitted = await freezeR3ControlContext(client, {
          ownerId: binding.ownerId,
          conversationId: binding.conversationId,
          runId,
        });
        await client.query(
          `INSERT INTO run_attempts(id,owner_id,run_id,attempt_no,status,lease_token) VALUES($1,$2,$3,1,'done',$4)`,
          [attemptId, binding.ownerId, runId, ownership.token],
        );
        await client.query(
          `INSERT INTO harness_pauses(id,owner_id,conversation_id,run_id,attempt_id,idempotency_key,reason,purpose,resume_source,state,snapshot)
        VALUES($1,$2,$3,$4,$5,$6,'runtime','manual_compact','runtime','paused','{}')`,
          [pauseId, binding.ownerId, binding.conversationId, runId, attemptId, randomUUID()],
        );
        await client.query(
          `INSERT INTO model_provider_run_bindings(run_id,owner_id,version_id,provider_id,provider_name,model_id)
        VALUES($1,$2,$3,$4,'provider','model')`,
          [runId, binding.ownerId, version, provider],
        );
        return admitted;
      });
      expect(context.input).toEqual({ type: 'compact_control' });
      expect(context.manifest.message_ids).toEqual([first, second, current]);
      await expect(
        ownership.transaction((client) =>
          freezeCompact(
            client,
            control,
            { messageIds: [first], promptRevision: 'compact/1' },
            guard,
          ),
        ),
      ).rejects.toThrow();
      await db.pool.query(
        `INSERT INTO idle_compact_requests(owner_id,idempotency_key,conversation_id,run_id)
      VALUES($1,$2,$3,$4)`,
        [binding.ownerId, randomUUID(), binding.conversationId, runId],
      );
      const late = randomUUID();
      await tx(async (client) => {
        await client.query('SELECT id FROM conversations WHERE id=$1 FOR UPDATE', [
          binding.conversationId,
        ]);
        await client.query(
          `INSERT INTO messages(id,owner_id,conversation_id,role,content,created_at)
        VALUES($1,$2,$3,'user','late','2019-01-01')`,
          [late, binding.ownerId, binding.conversationId],
        );
      });
      await expect(
        ownership.transaction((client) =>
          freezeCompact(
            client,
            control,
            { messageIds: [late], promptRevision: 'compact/1' },
            guard,
          ),
        ),
      ).rejects.toThrow();
      await expect(
        ownership.transaction((client) =>
          freezeCompact(
            client,
            { ...control, ownerId: randomUUID() },
            { messageIds: [first], promptRevision: 'compact/1' },
            guard,
          ),
        ),
      ).rejects.toThrow();
      const frozen = await ownership.transaction((client) =>
        freezeCompact(
          client,
          control,
          { messageIds: [first, second, current], promptRevision: 'compact/1' },
          guard,
        ),
      );
      expect(frozen.coverageMessageIds).toEqual([first, second, current]);
      await ownership.transaction((client) =>
        publishCompact(
          client,
          control,
          { freezeId: frozen.freezeId, text: 'history', messageIds: frozen.coverageMessageIds },
          guard,
        ),
      );
      const view = await tx((client) =>
        readCompactView(client, binding.ownerId, binding.conversationId),
      );
      expect(view.uncoveredIds).toEqual([late]);
      const messages = await db.pool.query(
        'SELECT id FROM messages WHERE owner_id=$1 AND conversation_id=$2',
        [binding.ownerId, binding.conversationId],
      );
      expect(messages.rowCount).toBe(4);
    } finally {
      await ownership.close();
    }
  });

  test('compares source content to admission and passes coverage to the runtime guard', async () => {
    const { binding, first } = await fixture();
    const seen: string[][] = [];
    const runtimeGuard = async (_client: PoolClient, ids: readonly string[]) => {
      seen.push([...ids]);
    };
    const frozen = await tx((client) =>
      freezeCompact(
        client,
        binding,
        { messageIds: [first], promptRevision: 'compact/1' },
        runtimeGuard,
      ),
    );
    await tx((client) =>
      publishCompact(
        client,
        binding,
        { freezeId: frozen.freezeId, text: 'summary', messageIds: [first] },
        runtimeGuard,
      ),
    );
    expect(seen).toEqual([[first], [first]]);
    const changed = await fixture();
    await db.pool.query(`UPDATE messages SET content='changed after admission' WHERE id=$1`, [
      changed.first,
    ]);
    await expect(
      tx((client) =>
        freezeCompact(
          client,
          changed.binding,
          { messageIds: [changed.first], promptRevision: 'compact/1' },
          guard,
        ),
      ),
    ).rejects.toThrow();
  });

  test('concurrent frozen candidates use CAS and only one publishes', async () => {
    const { binding, first } = await fixture();
    const a = await tx((client) =>
      freezeCompact(client, binding, { messageIds: [first], promptRevision: 'compact/1' }, guard),
    );
    const b = await tx((client) =>
      freezeCompact(client, binding, { messageIds: [first], promptRevision: 'compact/1' }, guard),
    );
    const results = await Promise.allSettled(
      [a, b].map((f) =>
        tx((client) =>
          publishCompact(
            client,
            binding,
            { freezeId: f.freezeId, text: 'summary', messageIds: [first] },
            guard,
          ),
        ),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
  });

  test('cancellation, credential revocation and guard failure prevent late publication', async () => {
    for (const reason of ['cancel', 'credential', 'guard'] as const) {
      const { binding, first, version } = await fixture();
      const frozen = await tx((client) =>
        freezeCompact(client, binding, { messageIds: [first], promptRevision: 'compact/1' }, guard),
      );
      if (reason === 'cancel')
        await db.pool.query(`UPDATE agent_runs SET status='cancelled' WHERE id=$1`, [
          binding.runId,
        ]);
      if (reason === 'credential')
        await db.pool.query(`UPDATE model_provider_versions SET revoked_at=now() WHERE id=$1`, [
          version,
        ]);
      const check =
        reason === 'guard'
          ? async () => {
              throw new Error('revoked grant');
            }
          : guard;
      await expect(
        tx((client) =>
          publishCompact(
            client,
            binding,
            { freezeId: frozen.freezeId, text: 'summary', messageIds: [first] },
            check,
          ),
        ),
      ).rejects.toThrow();
      expect(
        (
          await db.pool.query('SELECT id FROM compact_summaries WHERE freeze_id=$1', [
            frozen.freezeId,
          ])
        ).rowCount,
      ).toBe(0);
    }
  });
});
