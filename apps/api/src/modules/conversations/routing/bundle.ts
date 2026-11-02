import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { RoutingPolicySchema } from '@along/contracts';
import { REVISIONS, ROUTING_INTENTS } from './types.js';
import type { EnabledRoutingPolicy } from './types.js';
import type { ScoringMatrix } from './scorer.js';
import { EncodingManifestSchema } from './encoding-manifest.js';

const sha = z.string().regex(/^[a-f0-9]{64}$/);
const label = z.string().min(1).max(128);
const vectorValues = z.array(z.number().finite());
const family = z.object({ id: label, sample_ids: z.array(label).min(1).max(4) }).strict();
export const RoutingBundleSchema = z
  .object({
    schema_version: z.literal('r2b-bundle/1'),
    bundle_sha256: sha,
    encoding_sha256: sha,
    encoding_manifest: z.record(z.unknown()),
    normalization: z.literal('NFC_CRLF_LF_ECMASCRIPT_TRIM/1'),
    prefix: z.literal(''),
    candidate_intents: z.array(z.enum(ROUTING_INTENTS)).max(3),
    catalogue: z
      .array(z.object({ intent: label, families: z.array(family).length(4) }).strict())
      .min(2),
    exclusions: z
      .array(z.object({ intent: z.enum(ROUTING_INTENTS), sample_id: label }).strict())
      .min(3),
    family_vectors: vectorValues,
    exclusion_vectors: vectorValues,
    catalogue_sha256: sha,
    matrix_sha256: sha,
    thresholds: z
      .object({
        task_list_bounded: z
          .object({
            tau_intent: z.number().finite().min(-1).max(1),
            tau_gap: z.number().finite().min(0).max(2),
          })
          .strict(),
        prefs_timezone_read: z
          .object({
            tau_intent: z.number().finite().min(-1).max(1),
            tau_gap: z.number().finite().min(0).max(2),
          })
          .strict(),
        brief_cards_read: z
          .object({
            tau_intent: z.number().finite().min(-1).max(1),
            tau_gap: z.number().finite().min(0).max(2),
          })
          .strict(),
      })
      .strict(),
    revisions: z
      .object({
        guard_revision: label,
        parser_revision: label,
        handler_revision: label,
        renderer_revision: label,
        scorer_revision: label,
      })
      .strict(),
    calibration: z
      .object({
        dataset_sha256: sha,
        index_sha256: sha,
        ledger_sha256: sha,
        method: z.literal('zero_false_accept_max_correct_high_tau_intent_high_tau_gap/1'),
        split_revision: label,
      })
      .strict(),
  })
  .strict();
export type RoutingBundle = z.infer<typeof RoutingBundleSchema>;
export interface LoadedRoutingBundle {
  bundle: RoutingBundle;
  matrix: ScoringMatrix;
}

// Only JSON primitives are accepted; recursively sorted UTF-16 keys match Python's
// ASCII manifest keys and do not normalize any content-bearing string.
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null)
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
      )
      .join(',')}}`;
  throw new Error('NON_CANONICAL_JSON');
}
export function jsonDigest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}
export function freezeJson<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const entry of Object.values(value)) freezeJson(entry);
    Object.freeze(value);
  }
  return value;
}
export function matrixDigest(families: readonly number[], exclusions: readonly number[]): string {
  const hash = createHash('sha256');
  const bytes = Buffer.allocUnsafe((families.length + exclusions.length) * 4);
  let offset = 0;
  for (const value of families) {
    bytes.writeFloatLE(value, offset);
    offset += 4;
  }
  for (const value of exclusions) {
    bytes.writeFloatLE(value, offset);
    offset += 4;
  }
  return hash.update(bytes).digest('hex');
}
export function validateBundle(input: unknown): LoadedRoutingBundle {
  const bundle = RoutingBundleSchema.parse(input);
  const { bundle_sha256, ...body } = bundle;
  if (jsonDigest(body) !== bundle_sha256) throw new Error('BUNDLE_HASH_MISMATCH');
  if (
    bundle.catalogue_sha256 !==
    jsonDigest({ catalogue: bundle.catalogue, exclusions: bundle.exclusions })
  )
    throw new Error('CATALOGUE_HASH_MISMATCH');
  if (bundle.matrix_sha256 !== matrixDigest(bundle.family_vectors, bundle.exclusion_vectors))
    throw new Error('MATRIX_HASH_MISMATCH');
  if (
    Object.entries(REVISIONS).some(
      ([key, revision]) => bundle.revisions[key as keyof typeof REVISIONS] !== revision,
    )
  )
    throw new Error('BUNDLE_REVISION_MISMATCH');
  const competition = bundle.catalogue.map((entry) => entry.intent);
  const requiredCompetition = [
    ...ROUTING_INTENTS,
    'task_create',
    'task_cancel',
    'task_query_other',
    'prefs_write',
    'brief_analysis',
    'material_read',
    'ordinary_chat',
    'result_verify',
    'control_followup',
    'quoted_discussion',
    'out_of_scope',
  ];
  if (
    new Set(competition).size !== competition.length ||
    requiredCompetition.some((intent) => !competition.includes(intent)) ||
    ROUTING_INTENTS.some((intent) => !bundle.exclusions.some((entry) => entry.intent === intent)) ||
    new Set(bundle.candidate_intents).size !== bundle.candidate_intents.length
  )
    throw new Error('BUNDLE_COMPETITION_INCOMPLETE');
  const familyIds = new Set<string>();
  const samples = new Set<string>();
  const manifest = bundle.encoding_manifest;
  if (jsonDigest(manifest) !== bundle.encoding_sha256)
    throw new Error('ENCODING_MANIFEST_HASH_MISMATCH');
  EncodingManifestSchema.parse(manifest);
  for (const entry of bundle.catalogue)
    for (const group of entry.families) {
      if (familyIds.has(group.id)) throw new Error('BUNDLE_DUPLICATE_FAMILY');
      familyIds.add(group.id);
      for (const id of group.sample_ids) {
        if (samples.has(id)) throw new Error('BUNDLE_DUPLICATE_POSITIVE');
        samples.add(id);
      }
    }
  const exclusionKeys = new Set<string>();
  for (const entry of bundle.exclusions) {
    const key = `${entry.intent}:${entry.sample_id}`;
    if (samples.has(entry.sample_id) || exclusionKeys.has(key))
      throw new Error('BUNDLE_EXCLUSION_LEAK');
    exclusionKeys.add(key);
  }
  if (
    bundle.family_vectors.length !== competition.length * 4 * 512 ||
    bundle.exclusion_vectors.length !== bundle.exclusions.length * 512
  )
    throw new Error('BUNDLE_MATRIX_SHAPE');
  for (const values of [bundle.family_vectors, bundle.exclusion_vectors]) {
    for (let offset = 0; offset < values.length; offset += 512) {
      let norm = 0;
      for (let dimension = 0; dimension < 512; dimension++) {
        const value = values[offset + dimension]!;
        if (Math.fround(value) !== value) throw new Error('BUNDLE_NOT_FLOAT32');
        norm += value * value;
      }
      if (Math.abs(norm - 1) > 1e-5) throw new Error('BUNDLE_NOT_UNIT_VECTOR');
    }
  }
  return {
    bundle: freezeJson(bundle),
    matrix: {
      competition: Object.freeze(competition),
      familyVectors: new Float32Array(bundle.family_vectors),
      exclusionVectors: new Float32Array(bundle.exclusion_vectors),
      exclusionClasses: Object.freeze(bundle.exclusions.map((entry) => entry.intent)),
    },
  };
}
export function loadBundle(path: string): LoadedRoutingBundle {
  if (!isAbsolute(path)) throw new Error('BUNDLE_PATH_MUST_BE_ABSOLUTE');
  const bytes = readFileSync(path);
  if (bytes.byteLength > 32 * 1024 * 1024) throw new Error('BUNDLE_CAPACITY');
  return validateBundle(JSON.parse(bytes.toString('utf8')));
}
export function bundlePolicy(
  bundle: RoutingBundle,
  mode: 'shadow' | 'enforce',
  intents: readonly (typeof ROUTING_INTENTS)[number][],
): EnabledRoutingPolicy {
  if (intents.some((intent) => !bundle.candidate_intents.includes(intent)))
    throw new Error('ROUTING_INTENT_NOT_CALIBRATED');
  return freezeJson(
    RoutingPolicySchema.parse({
      revision: 'r2b/1',
      mode,
      bundle_sha256: bundle.bundle_sha256,
      encoding_sha256: bundle.encoding_sha256,
      candidate_intents: bundle.candidate_intents,
      direct_intents: mode === 'enforce' ? [...intents] : [],
      thresholds: bundle.thresholds,
      competition: bundle.catalogue.map((entry) => entry.intent),
      deadline_ms: 1000,
      max_inflight: 2,
      ...bundle.revisions,
    }) as EnabledRoutingPolicy,
  );
}
