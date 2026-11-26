import { createFixtureConversation } from '../helpers/bot-conversation.js';
import { admitTestUser } from './setup.js';
import { expect } from 'bun:test';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { Pool } from 'pg';
import { loadTimeContext } from '../../src/features/time/context.js';
import type { ToolContext } from '../../src/agent/tools/contracts.js';
import type { IntegrationDatabase } from './setup.js';
import type { WorkspaceGrant } from '@along/contracts';

export const toolId = 'internal.file-probe';
export const args = { action: 'append-fsync' };
const worker = fileURLToPath(new URL('./tool-invocations-file-worker.ts', import.meta.url));
const phaseSchema = z.object({ phase: z.string() });

export async function seedContext(
  pool: Pool,
  options: { ownerId?: string; workspaceGrant?: WorkspaceGrant } = {},
): Promise<ToolContext> {
  const ownerId = options.ownerId ?? randomUUID(),
    conversationId = randomUUID(),
    runId = randomUUID(),
    attemptId = randomUUID();
  await pool.query("INSERT INTO users(id,auth_email,display_name) VALUES($1,$2,'file probe')", [
    ownerId,
    `${ownerId}@along.test`,
  ]);
  await admitTestUser(pool, ownerId);
  await createFixtureConversation(pool, ownerId, { id: conversationId });
  await pool.query(
    `UPDATE personal_bots b
     SET config = jsonb_set(b.config, '{tool_ids}', (b.config->'tool_ids') || $2::jsonb)
     FROM conversations c WHERE c.id=$1 AND b.id=c.bot_id`,
    [conversationId, JSON.stringify([toolId, 'internal.local-probe', 'internal.read-probe'])],
  );
  await pool.query(
    "INSERT INTO agent_runs(id,owner_id,conversation_id,agent_revision,mode,budget_max_iterations,budget_max_tokens,frozen_context) VALUES($1,$2,$3,'probe','chat',1,100,$4)",
    [
      runId,
      ownerId,
      conversationId,
      options.workspaceGrant ? JSON.stringify({ workspaceGrant: options.workspaceGrant }) : null,
    ],
  );
  await pool.query('INSERT INTO run_attempts(id,owner_id,run_id,attempt_no) VALUES($1,$2,$3,1)', [
    attemptId,
    ownerId,
    runId,
  ]);
  return {
    ownerId,
    conversationId,
    runId,
    attemptId,
    requestId: randomUUID(),
    allowlist: [toolId, 'internal.local-probe'],
    confirmedTimezone: 'Asia/Shanghai',
    anchorReceivedAtUtc: '2026-10-17T00:00:00Z',
    receivedAtUtc: '2026-10-17T00:00:00Z',
    foldChoice: 'none',
    timeContext: loadTimeContext('fixture-v1'),
    ...(options.workspaceGrant ? { workspaceGrant: options.workspaceGrant } : {}),
  };
}

export async function fileLines(path: string): Promise<string[]> {
  try {
    return (await readFile(path, 'utf8')).split('\n').filter(Boolean);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
}

// Explicit IPC phase notification, not timing sleeps, determines each kill
// window. All effects occur in another process over a real PostgreSQL ledger.
export async function runChild(
  database: IntegrationDatabase,
  ctx: ToolContext,
  invocationId: string,
  path: string,
  mode: 'reserved' | 'permitted' | 'effected' | 'success' | 'not_applied',
  kill: boolean,
): Promise<void> {
  const child = spawn(process.execPath, [worker], {
    env: {
      ...process.env,
      INVOCATION_PROBE_INPUT: JSON.stringify({
        connectionString: database.connectionString,
        ...ctx,
        invocationId,
        path,
        mode,
      }),
    },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '';
  child.stderr?.on('data', (bytes: Buffer) => {
    stderr += bytes.toString();
  });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal }));
    },
  );
  const expected = mode === 'success' || mode === 'not_applied' ? 'accepted' : mode;
  try {
    await new Promise<void>((resolve, reject) => {
      child.on('message', (message: unknown) => {
        const phase = phaseSchema.safeParse(message);
        if (phase.success && phase.data.phase === expected) resolve();
      });
      child.once('error', reject);
      child.once('exit', (code) =>
        reject(new Error(`probe exited before phase ${expected} (${code}): ${stderr}`)),
      );
    });
    if (kill) child.kill('SIGKILL');
    const ended = await exit;
    if (kill) expect(ended.signal).toBe('SIGKILL');
    else {
      expect(stderr).toBe('');
      expect(ended.code).toBe(0);
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}
