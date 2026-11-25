import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { commitTerminal } from '../../src/agent/execution/result/commit.js';
import { withTransaction } from '../../src/db/transaction.js';
import {
  lockIdleCompactRequest,
  saveIdleCompactRequest,
} from '../../src/features/conversations/compact/idle-compact.js';
import {
  freezeR3Context,
  freezeR3ControlContext,
} from '../../src/features/conversations/compact/r3-context.js';
import { listMessageHistory } from '../../src/features/conversations/history/history-repository.js';
import {
  conversationMemorySources,
  readMemorySource,
} from '../../src/features/conversations/history/memory-sources.js';
import { insertAttempt, insertRun } from '../../src/features/conversations/run/repository.js';
import {
  insertMessage,
  listHarnessMessageRefs,
  readHarnessMessages,
} from '../../src/features/conversations/run/messages.js';
import { appendEvent } from '../../src/features/conversations/run/run-state.js';
import { createIntegrationDatabase, databaseUrl, seedAdmittedSession } from './setup.js';

const run = databaseUrl ? test : test.skip;

run('Feishu-derived answers stay in UI history only', async () => {
  const db = await createIntegrationDatabase();
  try {
    const { userId: ownerId } = await seedAdmittedSession(db.pool);
    const conversationId = randomUUID();
    await db.pool.query('INSERT INTO conversations(id,owner_id) VALUES($1,$2)', [
      conversationId,
      ownerId,
    ]);
    const scope = { ownerId, conversationId };
    const tx = <T>(f: (client: PoolClient) => Promise<T>) => withTransaction(db.pool, f);
    const sourceInput = await insertMessage(db.pool, {
      ...scope,
      role: 'user',
      content: 'original request',
      requestId: null,
    });
    async function finish(outcome: 'denied' | 'success', delta: string, cancelled = false) {
      const binding = {
        ...scope,
        runId: randomUUID(),
        attemptId: randomUUID(),
        requestId: randomUUID(),
      };
      await tx(async (client) => {
        await insertRun(client, {
          ...binding,
          inputMessageId: sourceInput,
          agentRevision: 'test',
          mode: 'chat',
          maxIterations: 10,
          maxTokens: 4096,
          execution: 'harness',
          allowlist: ['feishu_docx_read'],
          frozenContext: {},
        });
        await insertAttempt(client, { ...binding, attemptNo: 1 });
        await client.query(
          `INSERT INTO tool_invocations(invocation_id,owner_id,conversation_id,run_id,call_key,
             first_attempt_id,first_request_id,tool_id,args_hash,args_bytes,execution_kind,frozen_context,
             state,outcome_kind,result_version,accepted_result,accepted_attempt_id,accepted_request_id,accepted_at)
           VALUES(gen_random_uuid(),$1,$2,$3,'harness/1',$4,$5,'feishu_docx_read',repeat('a',64),2,
             'read_only','{}','completed',$6,1,'{}',$4,$5,now())`,
          [ownerId, conversationId, binding.runId, binding.attemptId, binding.requestId, outcome],
        );
        const eventScope = { conversation_id: conversationId, run_id: binding.runId };
        const event = await appendEvent(client, binding, 'message.delta', { ...eventScope, delta });
        if (cancelled) {
          await client.query(
            'INSERT INTO feishu_pending_disclosures(run_id,event_seq,is_terminal) VALUES($1,$2,false)',
            [binding.runId, event.seq],
          );
          await commitTerminal(client, binding, 'cancelled', eventScope);
        } else {
          await commitTerminal(client, binding, 'done', { ...eventScope, approval_id: null });
        }
      });
      return binding.runId;
    }
    const ordinary = 'no private receipt';
    const privateAnswer = 'synthetic Feishu-derived response';
    await finish('denied', ordinary);
    const sourceRunId = await finish('success', privateAnswer);

    const visible = await listMessageHistory(db.pool, { ...scope, cursor: null, limit: 20 });
    const ordinaryId = visible.find((message) => message.content === ordinary)?.message_id;
    const privateId = visible.find((message) => message.content === privateAnswer)?.message_id;
    if (!ordinaryId || !privateId) throw new Error('expected both published answers in UI history');
    const input = await insertMessage(db.pool, {
      ...scope,
      role: 'user',
      content: 'later request without a grant',
      requestId: null,
    });
    const binding = { ...scope, userMessageId: input, runId: randomUUID() };
    const expectedHistory = [sourceInput, ordinaryId];
    const refs = await listHarnessMessageRefs(db.pool, binding);
    expect(refs).toEqual([...expectedHistory, input]);
    expect(
      (await readHarnessMessages(db.pool, binding, refs)).map((message) => message.message_id),
    ).toEqual(refs);
    await expect(readHarnessMessages(db.pool, binding, [privateId, input])).rejects.toThrow(
      'snapshot message reference conflict',
    );
    const r3 = await tx(async (client) => {
      await insertRun(client, {
        ...binding,
        inputMessageId: input,
        agentRevision: 'test',
        mode: 'chat',
        maxIterations: 10,
        maxTokens: 4096,
        execution: 'harness',
        allowlist: [],
        frozenContext: { execution_profile: 'compact-memory/1' },
      });
      return freezeR3Context(client, binding);
    });
    expect(r3.manifest.message_ids).toEqual(expectedHistory);
    expect(r3.messages.map((message) => message.message_id)).toEqual(expectedHistory);
    expect(r3.input.message_id).toBe(input);

    const idle = await tx(async (client) => {
      const control = { ...scope, runId: randomUUID() };
      await client.query(
        `INSERT INTO agent_runs(id,owner_id,conversation_id,agent_revision,mode,status,budget_max_iterations,
           budget_max_tokens,execution,frozen_context) VALUES($1,$2,$3,'test','chat','running',10,4096,'harness',$4)`,
        [
          control.runId,
          ownerId,
          conversationId,
          { execution_profile: 'compact-memory/1', execution_lifecycle: 'server-owned' },
        ],
      );
      return freezeR3ControlContext(client, control);
    });
    expect(idle.manifest.message_ids).toEqual([...expectedHistory, input]);
    expect(idle.messages.map((message) => message.message_id)).toEqual([...expectedHistory, input]);
    await expect(
      tx((client) => readMemorySource(client, { ...scope, messageId: privateId })),
    ).rejects.toThrow('memory source not found');
    await expect(
      tx((client) =>
        conversationMemorySources.validate(client, {
          ...scope,
          purpose: 'read',
          messageIds: [privateId],
        }),
      ),
    ).rejects.toThrow('memory source not found');
    const { rows } = await db.pool.query(
      'SELECT id,source_run_id FROM messages WHERE id=ANY($1::uuid[]) ORDER BY created_at,id',
      [[ordinaryId, privateId]],
    );
    expect(rows).toEqual([
      { id: ordinaryId, source_run_id: null },
      { id: privateId, source_run_id: sourceRunId },
    ]);

    const cancelledRunId = await finish('success', 'undelivered private delta', true);
    expect(
      (await db.pool.query('SELECT 1 FROM messages WHERE source_run_id=$1', [cancelledRunId]))
        .rowCount,
    ).toBe(0);

    // Model a conversation whose only uncovered UI message is marked private.
    const emptyScope = { ownerId, conversationId: randomUUID() };
    const emptyRunId = randomUUID();
    await tx(async (client) => {
      await client.query('INSERT INTO conversations(id,owner_id) VALUES($1,$2)', [
        emptyScope.conversationId,
        ownerId,
      ]);
      await client.query(
        `INSERT INTO agent_runs(id,owner_id,conversation_id,agent_revision,mode,status,
           budget_max_iterations,budget_max_tokens) VALUES($1,$2,$3,'test','chat','done',10,4096)`,
        [emptyRunId, ownerId, emptyScope.conversationId],
      );
      await insertMessage(client, {
        ...emptyScope,
        role: 'assistant',
        content: privateAnswer,
        requestId: null,
        sourceRunId: emptyRunId,
      });
      const key = randomUUID();
      expect(
        await lockIdleCompactRequest(client, ownerId, emptyScope.conversationId, key),
      ).toBeNull();
      expect(
        await saveIdleCompactRequest(client, ownerId, emptyScope.conversationId, key, null),
      ).toEqual({ status: 'no_content', runId: null });
    });
  } finally {
    await db.close();
  }
});
