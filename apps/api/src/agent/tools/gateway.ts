// The gateway binds each logical tool call before executing local work.
// Approved results, local approval inserts and audit rows commit together.
import type { Pool } from 'pg';
import type { ToolContext, ToolOutcome } from './contracts.js';
import { reserveInvocation } from './invocations/invocations.js';
import { toolDefinition } from './definitions.js';

export function reserveToolInvocation(
  pool: Pool,
  ctx: ToolContext,
  input: { callKey: string; toolId: string; args: unknown },
): Promise<{ invocationId: string }>;
export function reserveToolInvocation(
  pool: Pool,
  ctx: ToolContext,
  input: { callKey: string; toolId: string; args: unknown },
  options: { deferOnPause: true },
): Promise<{ invocationId: string } | { pauseRequested: true }>;
export function reserveToolInvocation(
  pool: Pool,
  ctx: ToolContext,
  input: { callKey: string; toolId: string; args: unknown },
  options?: { deferOnPause: true },
): Promise<{ invocationId: string } | { pauseRequested: true }> {
  const reservation = { ...input, executionKind: toolDefinition(input.toolId).executionKind };
  return options
    ? reserveInvocation(pool, ctx, reservation, options)
    : reserveInvocation(pool, ctx, reservation);
}

export function invokeTool(
  pool: Pool,
  ctx: ToolContext,
  input: { invocationId: string; toolId: string; args: unknown },
): Promise<ToolOutcome> {
  return toolDefinition(input.toolId).invoke(pool, ctx, input);
}
