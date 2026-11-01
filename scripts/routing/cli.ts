import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  bundlePolicy,
  jsonDigest,
  loadBundle,
  matrixDigest,
  validateBundle,
} from '../../apps/api/src/modules/conversations/routing/bundle.js';
import type { RoutingBundle } from '../../apps/api/src/modules/conversations/routing/bundle.js';
import { normalizeEncodingText } from '../../apps/api/src/modules/conversations/routing/facts.js';
import {
  requestEncoding,
  validateEncoderUrl,
} from '../../apps/api/src/modules/conversations/routing/encoder.js';
import { EncodingManifestSchema } from '../../apps/api/src/modules/conversations/routing/encoding-manifest.js';
import { normalizeVector } from '../../apps/api/src/modules/conversations/routing/scorer.js';
import {
  REVISIONS,
  ROUTING_INTENTS,
} from '../../apps/api/src/modules/conversations/routing/types.js';
import type { EnabledRoutingPolicy } from '../../apps/api/src/modules/conversations/routing/types.js';
import { calibrateThresholds } from './calibration.js';
import { evaluationReport, readDataset, scoreDataset } from './evaluation.js';

// Outputs are immutable experiment directories. Never overwrite a previous run,
// retune from a regression/holdout, or download a model from this entry point.
export async function runRoutingExperiment(args: string[]): Promise<void> {
  const parsed = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      index: { type: 'string' },
      dataset: { type: 'string' },
      manifest: { type: 'string' },
      bundle: { type: 'string' },
      encoder: { type: 'string' },
      out: { type: 'string' },
    },
  });
  const command = parsed.positionals[0];
  if (
    parsed.positionals.length !== 1 ||
    !['calibrate', 'evaluate'].includes(command ?? '') ||
    !parsed.values.dataset ||
    !parsed.values.encoder ||
    !parsed.values.out
  )
    throw new Error(
      'Usage: routing <calibrate --index PATH --manifest PATH | evaluate --bundle PATH> --dataset PATH --encoder PRIVATE_ORIGIN --out NEW_EXTERNAL_DIRECTORY',
    );
  const output = resolve(parsed.values.out);
  mkdirSync(output, { recursive: false });
  const url = validateEncoderUrl(parsed.values.encoder);
  const dataset = readDataset(parsed.values.dataset);
  let completed = false;
  try {
    if (command === 'evaluate') {
      if (!parsed.values.bundle || parsed.values.index || parsed.values.manifest)
        throw new Error('EVALUATE_REQUIRES_FROZEN_BUNDLE_ONLY');
      const loaded = loadBundle(resolve(parsed.values.bundle));
      const policy = bundlePolicy(loaded.bundle, 'shadow', []);
      const started = performance.now();
      const rows = await scoreDataset(dataset, loaded.matrix, policy, url);
      const report = evaluationReport(rows, policy);
      writeFileSync(
        join(output, 'evaluation.json'),
        JSON.stringify(
          {
            schema_version: 'r2b-evaluation/1',
            bundle_sha256: loaded.bundle.bundle_sha256,
            encoding_sha256: loaded.bundle.encoding_sha256,
            dataset_sha256: dataset.sha256,
            policy,
            elapsed_ms: performance.now() - started,
            ...report,
          },
          null,
          2,
        ) + '\n',
        { flag: 'wx' },
      );
      completed = true;
      console.log(
        JSON.stringify({ output, bundle_sha256: loaded.bundle.bundle_sha256, ...report.summary }),
      );
      return;
    }
    if (!parsed.values.index || !parsed.values.manifest || parsed.values.bundle)
      throw new Error('CALIBRATE_REQUIRES_INDEX_MANIFEST_ONLY');
    if (dataset.records.some((record) => record.split !== 'calibration'))
      throw new Error('CALIBRATION_SPLIT_REQUIRED');
    const index = readDataset(parsed.values.index);
    if (index.records.some((record) => record.split !== 'index'))
      throw new Error('DEVELOPMENT_INDEX_SPLIT_REQUIRED');
    const indexGroups = new Set(index.records.map((record) => record.leakage_group_id));
    const indexTexts = new Set(index.records.map((record) => normalizeEncodingText(record.text)));
    if (
      dataset.records.some(
        (record) =>
          indexGroups.has(record.leakage_group_id) ||
          indexTexts.has(normalizeEncodingText(record.text)),
      )
    )
      throw new Error('CALIBRATION_INDEX_LEAKAGE');
    const manifest: Record<string, unknown> = JSON.parse(
      readFileSync(parsed.values.manifest, 'utf8'),
    );
    const encodingHash = jsonDigest(manifest);
    const vectors = new Map<string, Float64Array>();
    EncodingManifestSchema.parse(manifest);
    const indexEvidence: {
      id: string;
      input_sha256: string;
      token_count: number;
      elapsed_ms: number;
      vector: number[];
    }[] = [];
    for (const record of index.records) {
      const start = performance.now();
      const text = normalizeEncodingText(record.text);
      if (
        indexEvidence.some(
          (entry) => entry.input_sha256 === createHash('sha256').update(text).digest('hex'),
        )
      )
        throw new Error('DUPLICATE_NORMALIZED_INDEX_TEXT');
      const encoded = await requestEncoding({
        text,
        binding: encodingHash,
        url,
        signal: new AbortController().signal,
        deadlineMs: 1000 - (performance.now() - start),
        fetch: globalThis.fetch,
      });
      vectors.set(record.id, encoded.vector);
      indexEvidence.push({
        id: record.id,
        input_sha256: createHash('sha256').update(text).digest('hex'),
        token_count: encoded.tokenCount,
        elapsed_ms: performance.now() - start,
        vector: Array.from(encoded.vector),
      });
    }
    writeFileSync(
      join(output, 'index-encodings.json'),
      JSON.stringify(
        { encoding_sha256: encodingHash, index_sha256: index.sha256, records: indexEvidence },
        null,
        2,
      ) + '\n',
      { flag: 'wx' },
    );
    const positive = index.records.filter((record) => record.role === 'positive');
    const competition = [...new Set(positive.map((record) => record.intent_id))].sort();
    const catalogue: RoutingBundle['catalogue'] = [];
    const familyVectors: number[] = [];
    for (const intent of competition) {
      const families = [
        ...new Set(
          positive
            .filter((record) => record.intent_id === intent)
            .map((record) => record.family_id),
        ),
      ].sort();
      if (families.length !== 4) throw new Error(`FOUR_FAMILIES_REQUIRED:${intent}`);
      const catalogueFamilies: RoutingBundle['catalogue'][number]['families'] = [];
      for (const familyId of families) {
        const samples = positive
          .filter((record) => record.intent_id === intent && record.family_id === familyId)
          .sort((a, b) => a.id.localeCompare(b.id));
        if (samples.length < 1 || samples.length > 4) throw new Error(`FAMILY_SIZE:${familyId}`);
        const mean = new Float64Array(512);
        for (const sample of samples) {
          const vector = vectors.get(sample.id)!;
          for (let dimension = 0; dimension < 512; dimension++)
            mean[dimension] = mean[dimension]! + vector[dimension]! / samples.length;
        }
        familyVectors.push(...Array.from(normalizeVector(mean), Math.fround));
        catalogueFamilies.push({ id: familyId, sample_ids: samples.map((record) => record.id) });
      }
      catalogue.push({ intent, families: catalogueFamilies });
    }
    const exclusions: RoutingBundle['exclusions'] = [];
    const exclusionVectors: number[] = [];
    for (const record of index.records.filter((entry) => entry.role !== 'positive'))
      for (const intent of ROUTING_INTENTS) {
        if (!record.excluded_intent_ids.includes(intent)) continue;
        exclusions.push({ intent, sample_id: record.id });
        exclusionVectors.push(...Array.from(vectors.get(record.id)!, Math.fround));
      }
    const temporaryThresholds = Object.fromEntries(
      ROUTING_INTENTS.map((intent) => [intent, { tau_intent: -1, tau_gap: 0 }]),
    ) as EnabledRoutingPolicy['thresholds'];
    const body: Omit<RoutingBundle, 'bundle_sha256'> = {
      schema_version: 'r2b-bundle/1',
      encoding_sha256: encodingHash,
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
      thresholds: temporaryThresholds,
      revisions: REVISIONS,
      calibration: {
        dataset_sha256: dataset.sha256,
        index_sha256: index.sha256,
        ledger_sha256: '0'.repeat(64),
        method: 'zero_false_accept_max_correct_high_tau_intent_high_tau_gap/1',
        split_revision: 'r2b-grouped-synthetic/1',
      },
    };
    const provisional = validateBundle({ ...body, bundle_sha256: jsonDigest(body) });
    const basePolicy = bundlePolicy(provisional.bundle, 'shadow', []);
    const rows = await scoreDataset(dataset, provisional.matrix, basePolicy, url);
    const calibration = calibrateThresholds(rows, basePolicy);
    const ledger =
      JSON.stringify(
        {
          schema_version: 'r2b-calibration-ledger/1',
          encoding_sha256: encodingHash,
          catalogue_sha256: body.catalogue_sha256,
          matrix_sha256: body.matrix_sha256,
          dataset_sha256: dataset.sha256,
          index_sha256: index.sha256,
          denominators: {
            total: rows.length,
            eligible: rows.filter((row) => row.eligible).length,
            supported: rows.filter((row) => row.expected_takeover).length,
          },
          ...calibration,
          records: rows,
        },
        null,
        2,
      ) + '\n';
    writeFileSync(join(output, 'calibration-ledger.json'), ledger, { flag: 'wx' });
    const finalBody = {
      ...body,
      thresholds: calibration.thresholds,
      candidate_intents: calibration.candidate_intents,
      calibration: {
        ...body.calibration,
        ledger_sha256: createHash('sha256').update(ledger).digest('hex'),
      },
    };
    const final = validateBundle({ ...finalBody, bundle_sha256: jsonDigest(finalBody) });
    writeFileSync(join(output, 'bundle.json'), JSON.stringify(final.bundle, null, 2) + '\n', {
      flag: 'wx',
    });
    const finalPolicy = bundlePolicy(final.bundle, 'shadow', []);
    const report = evaluationReport(rows, finalPolicy);
    writeFileSync(
      join(output, 'calibration-report.json'),
      JSON.stringify(
        { bundle_sha256: final.bundle.bundle_sha256, dataset_sha256: dataset.sha256, ...report },
        null,
        2,
      ) + '\n',
      { flag: 'wx' },
    );
    completed = true;
    console.log(
      JSON.stringify({
        output,
        bundle_sha256: final.bundle.bundle_sha256,
        candidate_intents: calibration.candidate_intents,
        thresholds: calibration.thresholds,
        ...report.summary,
      }),
    );
  } finally {
    writeFileSync(
      join(output, 'run.json'),
      JSON.stringify(
        {
          completed,
          command,
          dataset_sha256: dataset.sha256,
          note: 'Synthetic offline evidence only; never authorizes production enforce. No automatic retries, threshold retuning or holdout access.',
        },
        null,
        2,
      ) + '\n',
      { flag: 'wx' },
    );
  }
}
if (import.meta.main) await runRoutingExperiment(process.argv.slice(2));
