import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Pool, PoolClient } from 'pg';
import { ContextPolicySchema, type ContextPolicy } from '@along/contracts';
import { HttpError, notFound } from '../../http/errors.js';

export const CONTEXT_POLICY_REVISION = 'r2a/1' as const;
export const CONTEXT_ADAPTER_REVISION = 'openai-chat/v1' as const;
export const UNAVAILABLE_METER_REVISION = 'unavailable/1' as const;
const POLICY_HASH_DOMAIN = 'harness/context-policy/v1\0';
const positive = z.number().int().positive().safe();
const policyInput = z
  .object({
    completionCap: positive,
    model: z.string().min(1),
    modelWindowTokens: positive.nullable().optional(),
    inputMeter: z.enum(['verified', 'estimated', 'unavailable']).optional(),
    meterRevision: z.string().min(1).max(128).optional(),
    reserveTokens: z.number().int().nonnegative().safe().optional(),
  })
  .strict();

export function createContextPolicy(input: z.input<typeof policyInput>): ContextPolicy {
  const value = policyInput.parse(input);
  return ContextPolicySchema.parse({
    revision: CONTEXT_POLICY_REVISION,
    completion_cap: value.completionCap,
    model_window_tokens: value.modelWindowTokens ?? null,
    input_meter: value.inputMeter ?? 'unavailable',
    meter_revision: value.meterRevision ?? UNAVAILABLE_METER_REVISION,
    reserve_tokens: value.reserveTokens ?? 0,
    model_binding: { model: value.model, adapter_revision: CONTEXT_ADAPTER_REVISION },
  });
}

// Fixed lexicographic object-key order, including the nested binding. Neither
// whitespace nor Unicode in identity strings is normalized. The domain includes
// a NUL separator; policy_hash always covers every strict policy field.
export function digestContextPolicy(input: ContextPolicy): string {
  const policy = ContextPolicySchema.parse(input);
  const canonical = JSON.stringify({
    completion_cap: policy.completion_cap,
    input_meter: policy.input_meter,
    meter_revision: policy.meter_revision,
    model_binding: {
      adapter_revision: policy.model_binding.adapter_revision,
      model: policy.model_binding.model,
    },
    model_window_tokens: policy.model_window_tokens,
    reserve_tokens: policy.reserve_tokens,
    revision: policy.revision,
  });
  return createHash('sha256').update(POLICY_HASH_DOMAIN).update(canonical, 'utf8').digest('hex');
}

type Client = Pick<Pool | PoolClient, 'query'>;

export async function readRunContextPolicy(
  client: Client,
  ownerId: string,
  runId: string,
): Promise<ContextPolicy | null> {
  const row = (
    await client.query<{ policy: unknown; policy_hash: string }>(
      `SELECT p.policy,p.policy_hash FROM run_context_policies p
     JOIN agent_runs r ON r.id=p.run_id AND r.owner_id=p.owner_id
     WHERE p.owner_id=$1 AND p.run_id=$2 AND r.execution='harness'`,
      [ownerId, runId],
    )
  ).rows[0];
  if (!row) return null;
  const parsed = ContextPolicySchema.safeParse(row.policy);
  if (!parsed.success || digestContextPolicy(parsed.data) !== row.policy_hash) {
    throw new HttpError(500, 500, 'HARNESS_PROTOCOL_ERROR', '运行上下文策略损坏。');
  }
  return parsed.data;
}

// Caller owns the admission/resume transaction. Never acquire a second Run lock
// or change frozen_context. ON CONFLICT waits for the winner; the next statement
// sees its immutable value under the existing READ COMMITTED transaction model.
export async function ensureRunContextPolicy(
  client: PoolClient,
  ownerId: string,
  runId: string,
  input: ContextPolicy,
): Promise<ContextPolicy> {
  const policy = ContextPolicySchema.parse(input);
  await client.query(
    `INSERT INTO run_context_policies(run_id,owner_id,policy,policy_hash)
     SELECT id,owner_id,$3::jsonb,$4 FROM agent_runs
     WHERE id=$2 AND owner_id=$1 AND execution='harness'
     ON CONFLICT(run_id) DO NOTHING`,
    [ownerId, runId, JSON.stringify(policy), digestContextPolicy(policy)],
  );
  const frozen = await readRunContextPolicy(client, ownerId, runId);
  if (!frozen) throw notFound('Harness Run not found');
  return frozen;
}
