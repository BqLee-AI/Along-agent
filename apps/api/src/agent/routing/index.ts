import {
  RoutingEmbeddingSchema,
  RoutingFactsSchema,
  RoutingIntentSchema,
  RoutingPolicySchema,
  type RoutingEmbedding,
  type RoutingFacts,
  type RoutingPolicy,
} from '@along/contracts';
import {
  bundlePolicy,
  canonicalJson,
  freezeJson,
  loadBundle,
  type LoadedRoutingBundle,
} from './bundle.js';
import { EncoderRefusal, requestEncoding, validateEncoderUrl } from '../../platform/encoder.js';
import { collectFacts, inputDigest, normalizeEncodingText } from './facts.js';
import { renderRoutingResult } from './renderer.js';
import { scoreVector, selectIntent } from './scorer.js';
import type { RoutingRuntime, RoutingRuntimeSettings } from './types.js';

export type {
  RoutingInput,
  RoutingRuntime,
  RoutingRuntimeSettings,
  EnabledRoutingPolicy,
} from './types.js';
export { REVISIONS, ROUTING_INTENTS } from './types.js';
export { normalizeEncodingText } from './facts.js';

export function createRoutingRuntime(settings: RoutingRuntimeSettings = {}): RoutingRuntime {
  const mode = settings.mode ?? process.env.HARNESS_ROUTING_MODE ?? 'off';
  if (!['off', 'shadow', 'enforce'].includes(mode)) throw new Error('ROUTING_MODE_INVALID');
  let loaded: LoadedRoutingBundle | null = null;
  let url: string | null = null;
  let policy: RoutingPolicy = freezeJson({ revision: 'r2b/1', mode: 'off' });
  // Off deliberately never reads bundle, URL, model or cache.
  if (mode !== 'off') {
    try {
      const configuredIntents =
        settings.intents ??
        process.env.HARNESS_ROUTING_INTENTS?.split(',')
          .map((intent) => intent.trim())
          .filter(Boolean) ??
        [];
      const intents = configuredIntents.map((intent) => RoutingIntentSchema.parse(intent));
      if (new Set(intents).size !== intents.length) throw new Error('ROUTING_INTENTS_DUPLICATE');
      loaded = loadBundle(settings.bundlePath ?? process.env.HARNESS_ROUTING_BUNDLE ?? '');
      url = validateEncoderUrl(
        settings.encoderUrl ?? process.env.HARNESS_ROUTING_ENCODER_URL ?? '',
      );
      policy = bundlePolicy(loaded.bundle, mode as 'shadow' | 'enforce', intents);
    } catch {
      loaded = null;
      url = null;
      const reason = 'ROUTING_CONFIG_UNAVAILABLE';
      if (settings.onUnavailable) settings.onUnavailable(reason);
      else console.warn(reason);
    }
  }
  const transport = settings.fetch ?? globalThis.fetch;
  const evidence = new WeakMap<RoutingFacts, { text: string; startedAt: number }>();
  const encoded = new WeakSet<RoutingFacts>();
  const frozenPolicy = canonicalJson(policy);
  function assertPolicy(input: RoutingPolicy): void {
    if (canonicalJson(RoutingPolicySchema.parse(input)) !== frozenPolicy)
      throw new Error('ROUTING_POLICY_BINDING');
  }
  return {
    policy() {
      return policy;
    },
    facts(input, suppliedPolicy) {
      assertPolicy(suppliedPolicy);
      const startedAt = performance.now();
      const facts = freezeJson(RoutingFactsSchema.parse(collectFacts(input, policy)));
      evidence.set(facts, { text: input.text, startedAt });
      return facts;
    },
    async embedding(text, facts, suppliedPolicy, signal) {
      assertPolicy(suppliedPolicy);
      signal.throwIfAborted();
      const frozenInput = evidence.get(facts);
      if (!frozenInput || frozenInput.text !== text || inputDigest(text) !== facts.input_sha256)
        throw new Error('ROUTING_FACTS_BINDING');
      if (encoded.has(facts)) throw new Error('ROUTING_DUPLICATE_ENCODING');
      encoded.add(facts);
      const result: RoutingEmbedding = {
        facts_ref: facts.facts_ref,
        input_sha256: facts.input_sha256,
        bundle_sha256: facts.bundle_sha256,
        reason: null,
        scores: [],
      };
      if (policy.mode === 'off' || !loaded || !url || !facts.eligible || facts.rule_intent !== null)
        return freezeJson({ ...result, reason: 'ENCODING_INELIGIBLE' });
      const start = frozenInput.startedAt;
      try {
        const normalized = normalizeEncodingText(text);
        const encoding = await requestEncoding({
          text: normalized,
          binding: policy.encoding_sha256,
          url,
          signal,
          deadlineMs: policy.deadline_ms - (performance.now() - start),
          fetch: transport,
        });
        signal.throwIfAborted();
        const scores = scoreVector(encoding.vector, loaded.matrix);
        if (performance.now() - start > policy.deadline_ms)
          throw new EncoderRefusal('ENCODING_DEADLINE');
        return freezeJson(RoutingEmbeddingSchema.parse({ ...result, scores }));
      } catch (error) {
        signal.throwIfAborted();
        if (!(error instanceof EncoderRefusal)) throw error;
        return freezeJson({ ...result, reason: error.message });
      }
    },
    choose(facts, embedding, suppliedPolicy) {
      assertPolicy(suppliedPolicy);
      RoutingFactsSchema.parse(facts);
      if (!evidence.has(facts)) throw new Error('ROUTING_FACTS_BINDING');
      if (policy.mode === 'off' || !facts.eligible || facts.bundle_sha256 !== policy.bundle_sha256)
        return null;
      if (facts.rule_intent !== null)
        return facts.candidates.some((candidate) => candidate.intent === facts.rule_intent)
          ? facts.rule_intent
          : null;
      if (embedding === null) return null;
      RoutingEmbeddingSchema.parse(embedding);
      if (
        embedding.facts_ref !== facts.facts_ref ||
        embedding.input_sha256 !== facts.input_sha256 ||
        embedding.bundle_sha256 !== facts.bundle_sha256
      )
        throw new Error('ROUTING_EMBEDDING_BINDING');
      if (embedding.reason !== null) return null;
      const intent = selectIntent(embedding.scores, policy);
      return intent !== null && facts.candidates.some((candidate) => candidate.intent === intent)
        ? intent
        : null;
    },
    render: renderRoutingResult,
  };
}
