import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jsonDigest, matrixDigest } from '../src/modules/conversations/routing/bundle.js';
import type { RoutingBundle } from '../src/modules/conversations/routing/bundle.js';
import { PINNED_ENCODING_FILES } from '../src/modules/conversations/routing/encoding-manifest.js';
import { REVISIONS, ROUTING_INTENTS } from '../src/modules/conversations/routing/types.js';

export interface RoutingTestFixture {
  directory: string;
  path: string;
  bundle: RoutingBundle;
}

// Synthetic orthogonal vectors are unit-test fixtures only, never release assets.
export function createRoutingFixture(): RoutingTestFixture {
  const competition = [
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
  const manifest = {
    revision: 'r2b-encoding/1',
    model: { id: 'Xenova/bge-small-zh-v1.5', revision: '75c43b069aac4d136ba6bc1122f995fedcfd2781' },
    files: PINNED_ENCODING_FILES.map((file) => ({
      ...file,
      license_evidence: 'license-evidence.json',
    })),
    graph: {
      inputs: ['input_ids', 'attention_mask', 'token_type_ids'].map((name) => ({
        name,
        type: 'tensor(int64)',
        shape: ['batch_size', 'sequence_length'],
      })),
      outputs: [
        {
          name: 'last_hidden_state',
          type: 'tensor(float)',
          shape: ['batch_size', 'sequence_length', 512],
        },
      ],
    },
    encoding: {
      normalization: ['CRLF_to_LF', 'NFC', 'strip_ecmascript_whitespace'],
      prefix: '',
      special_tokens: true,
      max_tokens: 256,
      truncate: false,
      pooling: 'last_hidden_state[:,0,:]',
      dtype: 'float32',
      dimension: 512,
      normalization_output: 'L2_float32',
      batch_size: 1,
      provider: 'CPUExecutionProvider',
      execution_mode: 'ORT_SEQUENTIAL',
      intra_op_threads: 4,
      inter_op_threads: 1,
      sessions: 1,
      max_inflight: 2,
    },
    dependencies: {
      fastapi: 'fixture',
      uvicorn: 'fixture',
      transformers: 'fixture',
      tokenizers: 'fixture',
      onnxruntime: 'fixture',
      numpy: 'fixture',
    },
    license_evidence_sha256: '0'.repeat(64),
    dependency_licenses_sha256: '0'.repeat(64),
    license_status: {
      base_model: 'MIT',
      quantized_distribution: 'not_declared',
      production_distribution_cleared: false,
    },
  };
  const catalogue = competition.map((intent) => ({
    intent,
    families: Array.from({ length: 4 }, (_, family) => ({
      id: `${intent}.family${family}`,
      sample_ids: [`${intent}.sample${family}`],
    })),
  }));
  const familyVectors = competition.flatMap((_, index) =>
    Array.from({ length: 4 }, () =>
      Array.from({ length: 512 }, (_, dimension) => (dimension === index ? 1 : 0)),
    ).flat(),
  );
  const exclusions = ROUTING_INTENTS.map((intent) => ({ intent, sample_id: `${intent}.exclude` }));
  const exclusionVectors = exclusions.flatMap(() =>
    Array.from({ length: 512 }, (_, dimension) => (dimension === 511 ? 1 : 0)),
  );
  const body: Omit<RoutingBundle, 'bundle_sha256'> = {
    schema_version: 'r2b-bundle/1',
    encoding_sha256: jsonDigest(manifest),
    encoding_manifest: manifest,
    normalization: 'NFC_CRLF_LF_ECMASCRIPT_TRIM/1',
    prefix: '',
    candidate_intents: [...ROUTING_INTENTS],
    catalogue,
    exclusions,
    family_vectors: familyVectors,
    exclusion_vectors: exclusionVectors,
    catalogue_sha256: jsonDigest({ catalogue, exclusions }),
    matrix_sha256: matrixDigest(familyVectors, exclusionVectors),
    thresholds: {
      task_list_bounded: { tau_intent: 0.6, tau_gap: 0.1 },
      prefs_timezone_read: { tau_intent: 0.6, tau_gap: 0.1 },
      brief_cards_read: { tau_intent: 0.6, tau_gap: 0.1 },
    },
    revisions: REVISIONS,
    calibration: {
      dataset_sha256: '1'.repeat(64),
      index_sha256: '2'.repeat(64),
      ledger_sha256: '3'.repeat(64),
      method: 'zero_false_accept_max_correct_high_tau_intent_high_tau_gap/1',
      split_revision: 'unit-fixture/1',
    },
  };
  const bundle: RoutingBundle = { ...body, bundle_sha256: jsonDigest(body) };
  const parent = join(tmpdir(), 'along-routing-tests');
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, 'fixture-'));
  const path = join(directory, 'bundle.json');
  writeFileSync(path, JSON.stringify(bundle));
  return { directory, path, bundle };
}
