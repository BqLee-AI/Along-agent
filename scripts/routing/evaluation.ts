import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type {
  RoutingCandidate,
  RoutingFacts,
  RoutingIntent,
  RoutingSource,
} from '@along/contracts';
import { canonicalJson } from '../../apps/api/src/agent/routing/bundle.js';
import { collectFacts } from '../../apps/api/src/agent/routing/facts.js';
import type { EnabledRoutingPolicy, RoutingInput } from '../../apps/api/src/agent/routing/types.js';
import type { RoutingScores, ScoringMatrix } from '../../apps/api/src/agent/routing/scorer.js';
import { scoreVector, selectIntent } from '../../apps/api/src/agent/routing/scorer.js';
import { normalizeEncodingText } from '../../apps/api/src/agent/routing/facts.js';
import { EncoderRefusal, requestEncoding } from '../../apps/api/src/platform/encoder.js';

const message = z.object({ role: z.enum(['user', 'assistant']), content: z.string() });
export const DatasetRecordSchema = z
  .object({
    id: z.string(),
    split: z.string(),
    text: z.string(),
    intent_id: z.string(),
    expected_takeover: z.boolean(),
    expected_args: z.record(z.unknown()).nullable(),
    expected_sources: z.array(z.record(z.unknown())).optional(),
    family_id: z.string(),
    leakage_group_id: z.string(),
    risk_group: z.string(),
    context_kind: z.string(),
    role: z.string(),
    excluded_intent_ids: z.array(z.string()),
    messages: z.array(message).optional(),
    context: z
      .object({
        prior_messages: z.unknown().optional(),
        system_state: z.record(z.unknown()).optional(),
        material: z.unknown().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
export type DatasetRecord = z.infer<typeof DatasetRecordSchema>;
export type DatasetInput = Pick<DatasetRecord, 'text' | 'messages' | 'context'>;
export interface RoutingDataset {
  records: DatasetRecord[];
  sha256: string;
  metadata: Record<string, unknown>;
}
export interface ScoredRecord {
  id: string;
  text: string;
  expected_intent: string;
  expected_takeover: boolean;
  expected_args: Record<string, unknown> | null;
  expected_sources: Record<string, unknown>[] | null;
  split: string;
  family_id: string;
  leakage_group_id: string;
  risk_group: string;
  context_kind: string;
  eligible: boolean;
  reason: string | null;
  rule_intent: RoutingIntent | null;
  candidates: RoutingCandidate[];
  scores: RoutingScores;
  encoding_reason: string | null;
  encoded: boolean;
  token_count: number | null;
  input_sha256: string;
  elapsed_ms: number;
  encoding_elapsed_ms: number | null;
  encoding_succeeded: boolean;
}
export function readDataset(path: string): RoutingDataset {
  const bytes = readFileSync(path);
  const parsed = z
    .object({ records: z.array(DatasetRecordSchema) })
    .passthrough()
    .parse(JSON.parse(bytes.toString('utf8')));
  if (new Set(parsed.records.map((record) => record.id)).size !== parsed.records.length)
    throw new Error('DUPLICATE_DATASET_ID');
  return {
    records: parsed.records,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    metadata: parsed,
  };
}
export function recordInput(record: DatasetInput): RoutingInput {
  const state = record.context?.system_state ?? {};
  const pending = Object.entries(state).some(
    ([key, value]) =>
      /approval/i.test(key) &&
      (value === true ||
        value === 'pending' ||
        value === 'waiting_approval' ||
        (Array.isArray(value) && value.length > 0 && /pending/i.test(key)) ||
        (typeof value === 'object' &&
          value !== null &&
          'status' in value &&
          value.status === 'pending')),
  );
  const workspace = Object.entries(state).some(
    ([key, value]) =>
      /workspace/i.test(key) && value !== null && value !== false && value !== 'none',
  );
  const history =
    record.messages ??
    z
      .array(
        z.union([message, z.object({ role: z.enum(['user', 'assistant']), text: z.string() })]),
      )
      .parse(record.context?.prior_messages ?? [])
      .map((entry) => ({
        role: entry.role,
        content: 'content' in entry ? entry.content : entry.text,
      }));
  return {
    messageId: '00000000-0000-4000-8000-000000000001',
    text: record.text,
    messages: history,
    hasPendingApproval: pending,
    workspaceSelected: workspace,
  };
}
export function comparableSources(sources: RoutingSource[]): Record<string, unknown>[] {
  return sources
    .map((source) =>
      source.source === 'message'
        ? {
            field: source.field,
            source: source.source,
            raw: source.raw,
            start: source.start,
            end: source.end,
          }
        : { field: source.field, source: source.source },
    )
    .sort((a, b) => String(a.field).localeCompare(String(b.field)));
}
export function candidateCorrect(row: ScoredRecord, candidate: RoutingCandidate): boolean {
  if (
    !row.expected_takeover ||
    row.expected_intent !== candidate.intent ||
    canonicalJson(row.expected_args) !== canonicalJson(candidate.args)
  )
    return false;
  if (
    row.expected_sources !== null &&
    canonicalJson(
      [...row.expected_sources].sort((a, b) => String(a.field).localeCompare(String(b.field))),
    ) !== canonicalJson(comparableSources(candidate.sources))
  )
    return false;
  for (const source of candidate.sources) {
    if (
      source.source === 'message' &&
      Array.from(row.text).slice(source.start, source.end).join('') !== source.raw
    )
      return false;
  }
  return true;
}
export function rowDecision(
  row: ScoredRecord,
  policy: EnabledRoutingPolicy,
): RoutingCandidate | null {
  if (!row.eligible) return null;
  const intent =
    row.rule_intent ?? (row.encoding_reason === null ? selectIntent(row.scores, policy) : null);
  return (
    row.candidates.find(
      (candidate) =>
        candidate.intent === intent && policy.candidate_intents.includes(candidate.intent),
    ) ?? null
  );
}
export async function scoreDataset(
  dataset: RoutingDataset,
  matrix: ScoringMatrix,
  policy: EnabledRoutingPolicy,
  url: string,
): Promise<ScoredRecord[]> {
  const rows: ScoredRecord[] = [];
  for (const record of dataset.records) {
    const rowStart = performance.now();
    const facts: RoutingFacts = collectFacts(recordInput(record), policy);
    const row: ScoredRecord = {
      id: record.id,
      text: record.text,
      expected_intent: record.intent_id,
      expected_takeover: record.expected_takeover,
      expected_args: record.expected_args,
      expected_sources: record.expected_sources ?? null,
      split: record.split,
      family_id: record.family_id,
      leakage_group_id: record.leakage_group_id,
      risk_group: record.risk_group,
      context_kind: record.context_kind,
      eligible: facts.eligible,
      reason: facts.reason,
      rule_intent: facts.rule_intent,
      candidates: facts.candidates,
      scores: [],
      encoding_reason: null,
      encoded: false,
      encoding_succeeded: false,
      elapsed_ms: 0,
      encoding_elapsed_ms: null,
      token_count: null,
      input_sha256: facts.input_sha256,
    };
    if (facts.eligible && facts.rule_intent === null) {
      const start = performance.now();
      row.encoded = true;
      try {
        const text = normalizeEncodingText(record.text);
        const encoded = await requestEncoding({
          text,
          binding: policy.encoding_sha256,
          url,
          signal: new AbortController().signal,
          deadlineMs: 1000 - (performance.now() - rowStart),
          fetch: globalThis.fetch,
        });
        row.token_count = encoded.tokenCount;
        row.scores = scoreVector(encoded.vector, matrix);
        if (performance.now() - rowStart > 1000) throw new EncoderRefusal('ENCODING_DEADLINE');
        row.encoding_succeeded = true;
      } catch (error) {
        if (!(error instanceof EncoderRefusal)) throw error;
        row.encoding_reason = error.message;
        row.scores = [];
      }
      row.encoding_elapsed_ms = performance.now() - start;
    }
    row.elapsed_ms = performance.now() - rowStart;
    rows.push(row);
  }
  return rows;
}
export function evaluationReport(rows: ScoredRecord[], policy: EnabledRoutingPolicy) {
  const records = rows.map((row) => {
    const candidate = rowDecision(row, policy);
    return {
      ...row,
      predicted: candidate,
      correct_accept: candidate !== null && candidateCorrect(row, candidate),
      false_accept: candidate !== null && !candidateCorrect(row, candidate),
      false_reject:
        row.expected_takeover && (candidate === null || !candidateCorrect(row, candidate)),
    };
  });
  const perIntent = Object.fromEntries(
    policy.competition.map((intent) => {
      const expected = records.filter(
        (row) => row.expected_takeover && row.expected_intent === intent,
      );
      const accepted = records.filter((row) => row.predicted?.intent === intent);
      return [
        intent,
        {
          supported: expected.length,
          accepted: accepted.length,
          correct_accept: accepted.filter((row) => row.correct_accept).length,
          false_accept: accepted.filter((row) => row.false_accept).length,
          false_reject: expected.filter((row) => !row.correct_accept).length,
        },
      ];
    }),
  );
  return {
    summary: {
      total: rows.length,
      supported: rows.filter((row) => row.expected_takeover).length,
      eligible: rows.filter((row) => row.eligible).length,
      l1_accept: records.filter((row) => row.rule_intent && row.predicted).length,
      l1_miss: records.filter((row) => !row.rule_intent).length,
      encoding_attempts: rows.filter((row) => row.encoded).length,
      encoding_successes: rows.filter((row) => row.encoding_succeeded).length,
      encoding_refusals: rows.filter((row) => row.encoding_reason).length,
      correct_accept: records.filter((row) => row.correct_accept).length,
      false_accept: records.filter((row) => row.false_accept).length,
      false_reject: records.filter((row) => row.false_reject).length,
    },
    per_intent: perIntent,
    records,
  };
}
