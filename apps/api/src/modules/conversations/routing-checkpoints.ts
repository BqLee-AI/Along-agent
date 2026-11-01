import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import {
  HARNESS_PROTOCOL_VERSION,
  RoutingPolicySchema,
  type RoutingPolicy,
  type RoutingFacts,
  type RoutingEmbedding,
  type RoutingCandidate,
  type RoutingDecisionReply,
} from '@along/contracts';
import { stateConflict } from '../../http/errors.js';
import { digestInvocationArgs } from '../tools/invocations.js';
import type { RunContext } from './contracts.js';

export type RoutingBinding = Pick<RunContext, 'ownerId' | 'runId' | 'attemptId' | 'userMessageId'>;
export interface RoutingRecord<T> {
  id: string;
  payload: T;
}
export interface RoutingPolicyPayload {
  owner_id: string;
  run_id: string;
  attempt_id: string;
  message_id: string;
  policy: RoutingPolicy;
}
export interface RoutingDecisionPayload {
  owner_id: string;
  run_id: string;
  attempt_id: string;
  message_id: string;
  policy_ref: string;
  facts: RoutingFacts;
  embedding: RoutingEmbedding | null;
  encoding_count: number;
  decision: 'direct' | 'fallback';
  reason: string;
  intent: RoutingCandidate['intent'] | null;
  tool_id: string | null;
  args: Record<string, unknown> | null;
  args_hash: string | null;
  sources: RoutingCandidate['sources'];
}
export interface RoutingRenderPayload {
  owner_id: string;
  run_id: string;
  attempt_id: string;
  message_id: string;
  decision_ref: string;
  invocation_ref: string;
  template_revision: string;
  body_sha256: string;
  chunk_count: number;
}
type Kind = 'harness_routing_policy' | 'harness_routing_decision' | 'harness_routing_render';

export function routingHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
export function routingIdentity(value: unknown): string {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  )
    return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(routingIdentity).join(',')}]`;
  if (
    typeof value === 'object' &&
    value !== null &&
    Object.getPrototypeOf(value) === Object.prototype
  )
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${routingIdentity(entry)}`)
      .join(',')}}`;
  throw stateConflict('routing identity requires finite JSON');
}
function bindingOf(binding: RoutingBinding) {
  return {
    owner_id: binding.ownerId,
    run_id: binding.runId,
    attempt_id: binding.attemptId,
    message_id: binding.userMessageId,
  };
}
export async function readRoutingRecord<T>(
  client: PoolClient,
  binding: Pick<RoutingBinding, 'ownerId' | 'runId' | 'attemptId'>,
  kind: Kind,
): Promise<RoutingRecord<T> | null> {
  return (
    (
      await client.query<RoutingRecord<T>>(
        `SELECT c.id,c.payload FROM run_checkpoints c JOIN run_attempts a ON a.id=c.attempt_id
     WHERE c.owner_id=$1 AND a.owner_id=$1 AND a.run_id=$2 AND c.attempt_id=$3 AND c.kind=$4`,
        [binding.ownerId, binding.runId, binding.attemptId, kind],
      )
    ).rows[0] ?? null
  );
}
export async function readRoutingPolicy(
  client: PoolClient,
  ownerId: string,
  runId: string,
): Promise<RoutingRecord<RoutingPolicyPayload> | null> {
  const row = (
    await client.query<RoutingRecord<RoutingPolicyPayload>>(
      `SELECT c.id,c.payload FROM run_checkpoints c JOIN run_attempts a ON a.id=c.attempt_id
     WHERE c.owner_id=$1 AND a.owner_id=$1 AND a.run_id=$2 AND a.attempt_no=1 AND c.kind='harness_routing_policy'`,
      [ownerId, runId],
    )
  ).rows[0];
  if (!row) return null;
  return {
    id: row.id,
    payload: { ...row.payload, policy: RoutingPolicySchema.parse(row.payload.policy) },
  };
}
async function appendRoutingRecord<T>(
  client: PoolClient,
  binding: RoutingBinding,
  kind: Kind,
  payload: T,
): Promise<RoutingRecord<T>> {
  const id = randomUUID();
  const inserted = await client.query(
    `INSERT INTO run_checkpoints(id,owner_id,attempt_id,seq,kind,payload,stream_protocol_version)
     SELECT $1,$2,$3,COALESCE(max(seq),0)::int+1,$4,$5::jsonb,$6 FROM run_checkpoints WHERE attempt_id=$3`,
    [
      id,
      binding.ownerId,
      binding.attemptId,
      kind,
      JSON.stringify(payload),
      HARNESS_PROTOCOL_VERSION,
    ],
  );
  if (inserted.rowCount !== 1) throw new Error('routing checkpoint was not persisted');
  return { id, payload };
}
export async function insertRoutingPolicy(
  client: PoolClient,
  binding: RoutingBinding,
  policy: RoutingPolicy,
): Promise<void> {
  await appendRoutingRecord(client, binding, 'harness_routing_policy', {
    ...bindingOf(binding),
    policy: RoutingPolicySchema.parse(policy),
  });
}
export function decisionPayload(
  binding: RoutingBinding,
  policyRef: string,
  facts: RoutingFacts,
  embedding: RoutingEmbedding | null,
  encodingCount: number,
  decision: 'direct' | 'fallback',
  reason: string,
  candidate: RoutingCandidate | null,
): RoutingDecisionPayload {
  return {
    ...bindingOf(binding),
    policy_ref: policyRef,
    facts,
    embedding,
    encoding_count: encodingCount,
    decision,
    reason,
    intent: candidate?.intent ?? null,
    tool_id: candidate?.tool_id ?? null,
    args: candidate?.args ?? null,
    args_hash: candidate ? digestInvocationArgs(candidate.args).argsHash : null,
    sources: candidate?.sources ?? [],
  };
}
export async function acceptRoutingDecision(
  client: PoolClient,
  binding: RoutingBinding,
  payload: RoutingDecisionPayload,
): Promise<RoutingRecord<RoutingDecisionPayload>> {
  const previous = await readRoutingRecord<RoutingDecisionPayload>(
    client,
    binding,
    'harness_routing_decision',
  );
  if (previous) {
    if (routingIdentity(previous.payload) !== routingIdentity(payload))
      throw stateConflict('routing decision is immutable');
    return previous;
  }
  return appendRoutingRecord(client, binding, 'harness_routing_decision', payload);
}
export function routingDecisionReply(
  record: RoutingRecord<RoutingDecisionPayload>,
): RoutingDecisionReply {
  return {
    decision_ref: record.id,
    decision: record.payload.decision,
    intent: record.payload.intent,
    tool_id: record.payload.tool_id,
    args: record.payload.args,
  };
}
export async function insertRoutingRender(
  client: PoolClient,
  binding: RoutingBinding,
  payload: Omit<RoutingRenderPayload, 'owner_id' | 'run_id' | 'attempt_id' | 'message_id'>,
): Promise<void> {
  await appendRoutingRecord(client, binding, 'harness_routing_render', {
    ...bindingOf(binding),
    ...payload,
  });
}
