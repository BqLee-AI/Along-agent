import { describe, expect, it, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { createContextPolicy, digestContextPolicy } from '../src/features/conversations/public.js';
import {
  AutoCompactPolicySchema,
  type AutoCompactPolicy,
  createAutoCompactPolicy,
} from '../src/features/conversations/compact/auto-compact-policy.js';

describe('strict frozen context policy', () => {
  it('keeps completion cap independent of Run budget and freezes unavailable defaults', () => {
    expect(createContextPolicy({ completionCap: 512, model: 'fixture-model' })).toEqual({
      revision: 'r2a/1',
      completion_cap: 512,
      model_window_tokens: null,
      input_meter: 'unavailable',
      meter_revision: 'unavailable/1',
      reserve_tokens: 0,
      model_binding: { model: 'fixture-model', adapter_revision: 'openai-chat/v1' },
    });
  });

  it('rejects unsafe capacities, unknown fields and invented meter evidence', () => {
    for (const completionCap of [0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity]) {
      expect(() => createContextPolicy({ completionCap, model: 'model' })).toThrow();
    }
    for (const fields of [
      { modelWindowTokens: 0 },
      { reserveTokens: -1 },
      { model: '' },
      { inputMeter: 'verified' },
      { inputMeter: 'estimated' },
      { extra: true },
    ]) {
      expect(() =>
        createContextPolicy({ completionCap: 256, model: 'model', ...fields } as Parameters<
          typeof createContextPolicy
        >[0]),
      ).toThrow();
    }
    expect(
      createContextPolicy({
        completionCap: 256,
        model: 'model',
        inputMeter: 'verified',
        meterRevision: 'fixture-complete-meter/v1',
      }).model_window_tokens,
    ).toBeNull();
  });

  it('hashes every field in fixed lexicographic JSON order without normalizing model identity', () => {
    const policy = createContextPolicy({ completionCap: 256, model: '模型 "x"\\\n' });
    const canonical = JSON.stringify({
      completion_cap: 256,
      input_meter: 'unavailable',
      meter_revision: 'unavailable/1',
      model_binding: { adapter_revision: 'openai-chat/v1', model: '模型 "x"\\\n' },
      model_window_tokens: null,
      reserve_tokens: 0,
      revision: 'r2a/1',
    });
    expect(digestContextPolicy(policy)).toBe(
      createHash('sha256')
        .update('harness/context-policy/v1\0')
        .update(canonical, 'utf8')
        .digest('hex'),
    );
    expect(digestContextPolicy({ ...policy, completion_cap: 257 })).not.toBe(
      digestContextPolicy(policy),
    );
    expect(digestContextPolicy({ ...policy, reserve_tokens: 1 })).not.toBe(
      digestContextPolicy(policy),
    );
    expect(digestContextPolicy({ ...policy, model_window_tokens: 8192 })).not.toBe(
      digestContextPolicy(policy),
    );
    expect(
      digestContextPolicy({
        ...policy,
        model_binding: { ...policy.model_binding, model: 'different' },
      }),
    ).not.toBe(digestContextPolicy(policy));
  });
});

const policy = {
  evidenceId: 'experiment-123',
  model: 'frozen-model',
  adapterRevision: 'adapter/1',
  meterRevision: 'meter/1',
  windowTokens: 10000,
  triggerRatio: 0.7,
  compactInputTokens: 500,
  continuationTokens: 700,
  continuationIterations: 2,
};
const contextPolicy = {
  revision: 'r2a/1' as const,
  completion_cap: 500,
  model_window_tokens: 10000,
  input_meter: 'verified' as const,
  meter_revision: 'meter/1',
  reserve_tokens: 100,
  model_binding: { model: 'frozen-model', adapter_revision: 'adapter/1' },
};

describe('automatic compact policy', () => {
  test('derives an 80% policy from the selected meter and planning window', () => {
    const context = { ...contextPolicy, input_meter: 'estimated' as const };
    const derived = createAutoCompactPolicy(context);
    expect(derived).toMatchObject({
      model: 'frozen-model',
      adapterRevision: 'adapter/1',
      meterRevision: 'meter/1',
      windowTokens: 10000,
      triggerRatio: 0.8,
    });
    const fallback = createAutoCompactPolicy({ ...context, model_window_tokens: null });
    expect(fallback).toMatchObject({
      evidenceId: 'application-envelope-estimate/1',
      triggerRatio: 0.8,
    });
    expect(
      createAutoCompactPolicy({ ...context, model_window_tokens: null }, 8192)?.windowTokens,
    ).toBe(8192);
    expect(
      createAutoCompactPolicy({
        ...context,
        input_meter: 'unavailable',
        meter_revision: 'unavailable/1',
      }),
    ).toBeNull();
  });

  test('rejects malformed frozen policies at admission', () => {
    for (const invalid of [
      { ...policy, surprise: true },
      { ...policy, evidenceId: ' ' },
      { ...policy, triggerRatio: 0 },
      { ...policy, triggerRatio: 1.01 },
      { ...policy, compactInputTokens: 0 },
      { ...policy, continuationTokens: 0 },
      { ...policy, continuationIterations: 0 },
    ] satisfies (AutoCompactPolicy & Record<string, unknown>)[])
      expect(AutoCompactPolicySchema.safeParse(invalid).success).toBe(false);
  });
});
