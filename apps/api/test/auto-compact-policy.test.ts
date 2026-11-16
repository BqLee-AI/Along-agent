import { describe, expect, test } from 'bun:test';
import { HARNESS_MAX_FRAME_BYTES } from '@along/contracts';
import {
  AutoCompactPolicySchema,
  shouldAutoCompact,
  createAutoCompactPolicy,
} from '../src/modules/conversations/auto-compact-policy.js';

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
const base: Parameters<typeof shouldAutoCompact>[0] = {
  policy,
  contextPolicy: {
    revision: 'r2a/1',
    completion_cap: 500,
    model_window_tokens: 10000,
    input_meter: 'verified',
    meter_revision: 'meter/1',
    reserve_tokens: 100,
    model_binding: { model: 'frozen-model', adapter_revision: 'adapter/1' },
  },
  measurement: {
    wire_bytes: 100,
    http_bytes: 100,
    output_ceiling: 500,
    limit_reason: null,
    input_meter: { quality: 'verified', input_tokens: 7000, meter_revision: 'meter/1' },
  },
  remainingTokens: 1700,
  maxOutputTokens: 500,
  iterationsRemaining: 3,
  uncoveredMessageCount: 1,
};

describe('automatic compact policy', () => {
  test('derives an estimated 80% policy only from a known frozen window', () => {
    const context = { ...base.contextPolicy, input_meter: 'estimated' as const };
    const derived = createAutoCompactPolicy(context);
    expect(derived).toMatchObject({
      model: 'frozen-model',
      adapterRevision: 'adapter/1',
      meterRevision: 'meter/1',
      windowTokens: 10000,
      triggerRatio: 0.8,
    });
    const candidate = {
      ...base,
      policy: derived,
      contextPolicy: context,
      remainingTokens: 20000,
      measurement: {
        ...base.measurement,
        input_meter: {
          quality: 'estimated' as const,
          input_tokens: 8000,
          meter_revision: 'meter/1',
        },
      },
    };
    expect(shouldAutoCompact(candidate)).toBe(true);
    expect(
      shouldAutoCompact({
        ...candidate,
        measurement: {
          ...candidate.measurement,
          input_meter: { ...candidate.measurement.input_meter, input_tokens: 7999 },
        },
      }),
    ).toBe(false);
    const fallback = createAutoCompactPolicy({ ...context, model_window_tokens: null });
    expect(fallback).toMatchObject({
      evidenceId: 'application-envelope-estimate/1',
      triggerRatio: 0.8,
    });
    expect(
      shouldAutoCompact({
        ...candidate,
        contextPolicy: { ...context, model_window_tokens: null },
        policy: fallback,
        measurement: {
          ...candidate.measurement,
          input_meter: {
            ...candidate.measurement.input_meter,
            input_tokens: Math.ceil(fallback!.windowTokens * 0.8),
          },
        },
      }),
    ).toBe(true);
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

  test('only triggers at the explicitly supplied ratio with sufficient reserves', () => {
    expect(shouldAutoCompact(base)).toBe(true);
    expect(
      shouldAutoCompact({
        ...base,
        measurement: {
          ...base.measurement,
          input_meter: { ...base.measurement.input_meter, input_tokens: 6999 },
        },
      }),
    ).toBe(false);
    expect(shouldAutoCompact({ ...base, remainingTokens: 1699 })).toBe(false);
    expect(shouldAutoCompact({ ...base, iterationsRemaining: 2 })).toBe(false);
    expect(shouldAutoCompact({ ...base, uncoveredMessageCount: 0 })).toBe(false);
    expect(shouldAutoCompact({ ...base, remainingTokens: null })).toBe(true);
  });

  test('requires strict explicit policy and exact model, adapter, meter and window binding', () => {
    expect(shouldAutoCompact({ ...base, policy: null })).toBe(false);
    expect(AutoCompactPolicySchema.safeParse({ ...policy, surprise: true }).success).toBe(false);
    for (const changed of [
      { ...policy, evidenceId: ' ' },
      { ...policy, triggerRatio: 0 },
      { ...policy, triggerRatio: 1.01 },
      { ...policy, model: 'other' },
      { ...policy, adapterRevision: 'adapter/2' },
      { ...policy, meterRevision: 'meter/2' },
      { ...policy, windowTokens: 20000 },
      { ...policy, compactInputTokens: 0 },
      { ...policy, continuationTokens: 0 },
      { ...policy, continuationIterations: 0 },
    ])
      expect(shouldAutoCompact({ ...base, policy: changed })).toBe(false);
    expect(
      shouldAutoCompact({
        ...base,
        contextPolicy: { ...base.contextPolicy, model_window_tokens: null },
      }),
    ).toBe(false);
  });

  test('rejects mismatched, unavailable or internally inconsistent measurements', () => {
    for (const meter of [
      { quality: 'unavailable' as const, input_tokens: null, meter_revision: 'meter/1' },
      { quality: 'verified' as const, input_tokens: 7000, meter_revision: 'other' },
      { quality: 'verified' as const, input_tokens: 10001, meter_revision: 'meter/1' },
    ])
      expect(
        shouldAutoCompact({ ...base, measurement: { ...base.measurement, input_meter: meter } }),
      ).toBe(false);
    expect(
      shouldAutoCompact({
        ...base,
        contextPolicy: { ...base.contextPolicy, input_meter: 'estimated' },
        measurement: {
          ...base.measurement,
          input_meter: {
            ...base.measurement.input_meter,
            quality: 'estimated',
          },
        },
      }),
    ).toBe(true);
    expect(
      shouldAutoCompact({ ...base, measurement: { ...base.measurement, limit_reason: 'context' } }),
    ).toBe(false);
    expect(
      shouldAutoCompact({ ...base, measurement: { ...base.measurement, output_ceiling: 499 } }),
    ).toBe(false);
    expect(
      shouldAutoCompact({
        ...base,
        measurement: { ...base.measurement, wire_bytes: HARNESS_MAX_FRAME_BYTES + 1 },
      }),
    ).toBe(false);
    expect(
      shouldAutoCompact({
        ...base,
        measurement: {
          ...base.measurement,
          input_meter: { ...base.measurement.input_meter, input_tokens: 9500 },
        },
      }),
    ).toBe(false);
  });

  test('fails closed on invalid counters and output budget', () => {
    for (const changed of [
      { remainingTokens: -1 },
      { remainingTokens: Number.MAX_SAFE_INTEGER + 1 },
      { maxOutputTokens: 0 },
      { maxOutputTokens: 501 },
      { iterationsRemaining: 2.5 },
      { uncoveredMessageCount: -1 },
    ])
      expect(shouldAutoCompact({ ...base, ...changed })).toBe(false);
  });
});
