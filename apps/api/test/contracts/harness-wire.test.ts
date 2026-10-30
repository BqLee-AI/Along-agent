import { afterAll, beforeAll, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, open, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import {
  HARNESS_PROTOCOL_VERSION,
  HarnessModelReplySchema,
  HarnessReplySchema,
  HarnessRequestSchema,
  HarnessStartSchema,
  type HarnessRequest,
  type HarnessReply,
  type HarnessModelReply,
} from '@along/contracts';
import {
  executeNonTransactionalInvocation,
  reserveInvocation,
} from '../../src/modules/tools/invocations.js';
import { createIntegrationDatabase, type IntegrationDatabase } from '../integration/setup.js';
import { appendFileEffect } from '../integration/tool-invocations-file-effect.js';
import { args, fileLines, seedContext, toolId } from '../integration/tool-invocations-probe.js';

let database: IntegrationDatabase;
let directory: string;
let binaryPath: string;
beforeAll(async () => {
  binaryPath = process.env.HARNESS_BINARY ?? '';
  if (!binaryPath || process.platform !== 'linux') {
    throw new Error('D8 wire requires Linux and HARNESS_BINARY from the current production build');
  }
  database = await createIntegrationDatabase();
  directory = await mkdtemp(join(tmpdir(), 'along-native-wire-'));
});
afterAll(async () => {
  try {
    await database?.close();
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
  }
});

// Raw stdin is intentional: runNativeHarness validates start before spawning,
// so using its invalid-start rejection would NOT prove the native consumer.
// Replies originate from the real producer when testing tool outcome structure;
// only a JSON wire copy is damaged, never the persisted accepted result.
test('D8.wire-rejection', async () => {
  for (const kind of [
    'start-version',
    'reply-correlation',
    'reply-extra',
    'outcome-shape',
  ] as const) {
    const ctx = await seedContext(database.pool);
    const path = join(directory, `${ctx.runId}.effect.jsonl`);
    const journal = join(directory, `${ctx.runId}.protocol.jsonl`);
    const start = HarnessStartSchema.parse({
      protocol: HARNESS_PROTOCOL_VERSION,
      type: 'start',
      messages: [{ message_id: randomUUID(), role: 'user', content: 'Run the fsync probe once.' }],
      tools: [
        { name: toolId, description: 'Test-only append and fsync.', parameters: {}, risk: 'low' },
      ],
      budget: { max_iterations: 4, max_tokens: 100 },
      snapshot: null,
      observations: [],
      approval: null,
    });
    const requests: HarnessRequest[] = [];
    let modelCalls = 0;
    let pendingModel: { ref: string; reply: HarnessModelReply } | null = null;
    let invocationId = '';
    let actualOutcome: unknown;
    let acceptedBefore: unknown[] = [];
    let effectBefore = Buffer.alloc(0);
    let auditBefore: unknown[] = [];
    const runBefore = (
      await database.pool.query('SELECT * FROM agent_runs WHERE id=$1', [ctx.runId])
    ).rows;
    const attemptsBefore = (
      await database.pool.query('SELECT * FROM run_attempts WHERE run_id=$1', [ctx.runId])
    ).rows;
    const child = spawn(binaryPath, [], {
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Process-lifetime safety bound, not a wait used to establish ordering.
      timeout: 10_000,
      killSignal: 'SIGKILL',
      env: {
        LANG: 'C.UTF-8',
        LC_ALL: 'C.UTF-8',
        TZ: 'UTC',
        ...(process.env.HARNESS_LIBRARY_PATH
          ? { LD_LIBRARY_PATH: process.env.HARNESS_LIBRARY_PATH }
          : {}),
      },
    });
    const completed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => resolve({ code, signal }));
      },
    );
    let stderr = '';
    child.stderr.on('data', (bytes: Buffer) => {
      stderr += bytes.toString();
    });
    let stdinError: Error | undefined;
    child.stdin.on('error', (error) => {
      stdinError = error;
    });
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    let exit: { code: number | null; signal: NodeJS.Signals | null };
    try {
      child.stdin.write(
        `${JSON.stringify(
          kind === 'start-version' ? { ...start, protocol: 'harness/v1' } : start,
        )}\n`,
      );
      for await (const line of lines) {
        const request = HarnessRequestSchema.parse(JSON.parse(line));
        requests.push(request);
        let value: unknown;
        switch (request.type) {
          case 'model': {
            modelCalls++;
            const modelReply = HarnessModelReplySchema.parse({
              message:
                modelCalls === 1
                  ? {
                      content: null,
                      tool_calls: [
                        {
                          id: 'provider-not-invocation',
                          type: 'function',
                          function: {
                            name: toolId,
                            arguments: JSON.stringify(args),
                          },
                        },
                      ],
                    }
                  : { content: 'The probe returned a result.', tool_calls: [] },
              usage: { total_tokens: 5 },
            });
            if (modelReply.message.content) {
              pendingModel = { ref: request.request_ref, reply: modelReply };
              value = { type: 'delta', delta: modelReply.message.content };
            } else value = { type: 'complete', reply: modelReply };
            break;
          }
          case 'model_next': {
            if (!pendingModel || request.model_ref !== pendingModel.ref)
              throw new Error('unexpected model continuation');
            value = { type: 'complete', reply: pendingModel.reply };
            pendingModel = null;
            break;
          }
          case 'reserve': {
            const reserved = await reserveInvocation(database.pool, ctx, {
              callKey: request.call_key,
              toolId: request.tool_id,
              args: request.args,
              executionKind: 'non_transactional',
            });
            invocationId = reserved.invocationId;
            value = { invocation_id: invocationId };
            break;
          }
          case 'invoke': {
            const actual = await executeNonTransactionalInvocation(
              database.pool,
              ctx,
              {
                invocationId: request.invocation_id,
                toolId: request.tool_id,
                args: request.args,
              },
              { execute: (binding) => appendFileEffect(path, binding) },
            );
            actualOutcome = actual;
            // Save genuine producer facts BEFORE damaging the serialized copy.
            acceptedBefore = (
              await database.pool.query('SELECT * FROM tool_invocations WHERE run_id=$1', [
                ctx.runId,
              ])
            ).rows;
            auditBefore = (
              await database.pool.query('SELECT * FROM tool_calls WHERE run_id=$1 ORDER BY id', [
                ctx.runId,
              ])
            ).rows;
            effectBefore = await readFile(path);
            value = { ...actual, replayed: 'not-a-boolean' };
            break;
          }
          case 'snapshot':
          case 'finish':
          case 'answer': {
            // If a broken parser accepts the malformed frame, let it continue
            // legally; the assertions below detect its actual requests/effects.
            const checkpointRef = request.type === 'snapshot' ? randomUUID() : null;
            const file = await open(journal, 'a');
            try {
              await file.writeFile(
                `${JSON.stringify({ checkpoint_ref: checkpointRef, request })}\n`,
              );
              await file.sync();
            } finally {
              await file.close();
            }
            value = checkpointRef ? { checkpoint_ref: checkpointRef } : { accepted: true };
            break;
          }
          case 'suspend':
            throw new Error('file probe has no approval result');
        }
        const reply: HarnessReply = HarnessReplySchema.parse({
          protocol: HARNESS_PROTOCOL_VERSION,
          type: 'reply',
          reply_to: request.request_ref,
          value,
        });
        const wire =
          kind === 'reply-correlation' && request.type === 'model'
            ? { ...reply, reply_to: `${request.request_ref}-wrong` }
            : kind === 'reply-extra' && request.type === 'model'
              ? { ...reply, extra_authority: true }
              : reply;
        child.stdin.write(`${JSON.stringify(wire)}\n`);
        if (request.type === 'finish') child.stdin.end();
      }
      exit = await completed;
    } finally {
      lines.close();
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await completed;
    }
    expect(stdinError).toBeUndefined();
    expect(exit).toEqual({ code: 2, signal: null });
    expect(stderr).toBe('HARNESS_PROTOCOL_ERROR\n');
    expect(requests.map((request) => request.type)).toEqual(
      kind === 'start-version'
        ? []
        : kind === 'outcome-shape'
          ? ['model', 'reserve', 'invoke']
          : ['model'],
    );
    expect(await fileLines(journal)).toEqual([]);
    expect(
      (await database.pool.query('SELECT * FROM agent_runs WHERE id=$1', [ctx.runId])).rows,
    ).toEqual(runBefore);
    expect(
      (await database.pool.query('SELECT * FROM run_attempts WHERE run_id=$1', [ctx.runId])).rows,
    ).toEqual(attemptsBefore);
    expect(
      (
        await database.pool.query('SELECT id FROM run_checkpoints WHERE attempt_id=$1', [
          ctx.attemptId,
        ])
      ).rows,
    ).toEqual([]);
    if (kind === 'outcome-shape') {
      expect(actualOutcome).toMatchObject({
        status: 'ok',
        invocationId,
        replayed: false,
        result: { kind: 'effect_evidence', evidence_ref: expect.stringContaining(invocationId) },
      });
      expect(acceptedBefore).toEqual([
        expect.objectContaining({
          invocation_id: invocationId,
          state: 'completed',
          execution_kind: 'non_transactional',
          accepted_result: expect.objectContaining({ status: 'ok' }),
        }),
      ]);
      expect(
        (await database.pool.query('SELECT * FROM tool_invocations WHERE run_id=$1', [ctx.runId]))
          .rows,
      ).toEqual(acceptedBefore);
      expect(
        (
          await database.pool.query('SELECT * FROM tool_calls WHERE run_id=$1 ORDER BY id', [
            ctx.runId,
          ])
        ).rows,
      ).toEqual(auditBefore);
      expect(await fileLines(path)).toHaveLength(1);
      expect(await readFile(path)).toEqual(effectBefore);
    } else {
      expect(await fileLines(path)).toEqual([]);
      expect(
        (
          await database.pool.query('SELECT invocation_id FROM tool_invocations WHERE run_id=$1', [
            ctx.runId,
          ])
        ).rows,
      ).toEqual([]);
      expect(
        (await database.pool.query('SELECT id FROM tool_calls WHERE run_id=$1', [ctx.runId])).rows,
      ).toEqual([]);
    }
  }
}, 60_000);
