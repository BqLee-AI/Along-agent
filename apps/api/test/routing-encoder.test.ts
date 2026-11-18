import { afterAll, describe, expect, it } from 'bun:test';
import { rmSync, writeFileSync } from 'node:fs';
import { createRoutingRuntime } from '../src/agent/routing/index.js';
import { jsonDigest, validateBundle } from '../src/agent/routing/bundle.js';
import { requestEncoding, validateEncoderUrl } from '../src/platform/encoder.js';
import type { EncoderDeadline } from '../src/platform/encoder.js';
import type { RoutingFetch } from '../src/agent/routing/types.js';
import { createRoutingFixture } from './routing-fixtures.js';

const fixture = createRoutingFixture();
afterAll(() => rmSync(fixture.directory, { recursive: true, force: true }));
const messageId = '00000000-0000-4000-8000-000000000001';
const input = {
  messageId,
  text: '列出提醒',
  messages: [],
  hasPendingApproval: false,
  workspaceSelected: false,
};
const vector = Array.from({ length: 512 }, (_, index) => (index === 0 ? 1 : 0));
function response(extra: Record<string, unknown> = {}) {
  return Response.json({
    binding_sha256: fixture.bundle.encoding_sha256,
    token_count: 8,
    dimension: 512,
    vector,
    ...extra,
  });
}

describe('immutable routing runtime enabled boundary', () => {
  it('binds and freezes full policy rather than reloading a mutable path', () => {
    const runtime = createRoutingRuntime({
      mode: 'enforce',
      bundlePath: fixture.path,
      encoderUrl: 'http://encoder',
      intents: ['task_list_bounded'],
    });
    const policy = runtime.policy();
    expect(policy.mode).toBe('enforce');
    if (policy.mode === 'off') throw new Error('fixture unavailable');
    expect(policy.direct_intents).toEqual(['task_list_bounded']);
    expect(() => policy.competition.push('invented')).toThrow();
    writeFileSync(fixture.path, '{}');
    expect(runtime.policy()).toBe(policy);
    writeFileSync(fixture.path, JSON.stringify(fixture.bundle));
    const facts = runtime.facts(input, policy);
    expect(() => runtime.choose({ ...facts }, null, policy)).toThrow('ROUTING_FACTS_BINDING');
    expect(() => runtime.facts(input, { ...policy, encoding_sha256: 'c'.repeat(64) })).toThrow(
      'ROUTING_POLICY_BINDING',
    );
  });
  it('disables only optimization for unavailable enabled assets with an explicit diagnostic', () => {
    const diagnostics: string[] = [];
    const runtime = createRoutingRuntime({
      mode: 'shadow',
      bundlePath: '/missing/bundle.json',
      encoderUrl: 'http://encoder',
      onUnavailable: (reason) => diagnostics.push(reason),
    });
    expect(runtime.policy()).toEqual({ revision: 'r2b/1', mode: 'off' });
    expect(diagnostics).toEqual(['ROUTING_CONFIG_UNAVAILABLE']);
  });
  it('rejects tampering, non-f32 matrices and missing exclusion evidence', () => {
    expect(() => validateBundle({ ...fixture.bundle, normalization: 'other' })).toThrow();
    const { bundle_sha256, ...body } = fixture.bundle;
    expect(jsonDigest(body)).toBe(bundle_sha256);
    const bad = { ...body, encoding_sha256: 'a'.repeat(64) };
    expect(() => validateBundle({ ...bad, bundle_sha256: jsonDigest(bad) })).toThrow(
      'ENCODING_MANIFEST_HASH_MISMATCH',
    );
    const incomplete = { ...body, exclusions: fixture.bundle.exclusions.slice(1) };
    expect(() =>
      validateBundle({ ...incomplete, bundle_sha256: jsonDigest(incomplete) }),
    ).toThrow();
  });
  it('encodes the whole normalized input exactly once and refuses forged binding', async () => {
    const bodies: unknown[] = [];
    const transport: RoutingFetch = async (_url, init) => {
      bodies.push(JSON.parse(String(init.body)));
      return response();
    };
    const runtime = createRoutingRuntime({
      mode: 'shadow',
      bundlePath: fixture.path,
      encoderUrl: 'http://encoder',
      fetch: transport,
    });
    const policy = runtime.policy();
    const current = { ...input, text: ' \r\n列出提醒\r\n ' };
    const facts = runtime.facts(current, policy);
    const embedding = await runtime.embedding(
      current.text,
      facts,
      policy,
      new AbortController().signal,
    );
    expect(bodies).toEqual([
      {
        binding_sha256: fixture.bundle.encoding_sha256,
        text: '列出提醒',
        max_tokens: 256,
        truncate: false,
      },
    ]);
    expect(runtime.choose(facts, embedding, policy)).toBe('task_list_bounded');
    expect(policy.mode !== 'off' && policy.direct_intents).toEqual([]);
    await expect(
      runtime.embedding(current.text, facts, policy, new AbortController().signal),
    ).rejects.toThrow('ROUTING_DUPLICATE_ENCODING');
    expect(() =>
      runtime.choose(facts, { ...embedding, input_sha256: 'b'.repeat(64) }, policy),
    ).toThrow('ROUTING_EMBEDDING_BINDING');
    expect(bodies).toHaveLength(1);
  });
  it('never contacts the service for complete commands or ineligible facts', async () => {
    let calls = 0;
    const runtime = createRoutingRuntime({
      mode: 'shadow',
      bundlePath: fixture.path,
      encoderUrl: 'http://encoder',
      fetch: async () => {
        calls++;
        return response();
      },
    });
    const policy = runtime.policy();
    for (const text of ['/timezone', '查全所有提醒']) {
      const facts = runtime.facts({ ...input, text }, policy);
      expect(
        (await runtime.embedding(text, facts, policy, new AbortController().signal)).reason,
      ).toBe('ENCODING_INELIGIBLE');
    }
    expect(calls).toBe(0);
  });
});

describe('single HTTP encoder validation and resource boundary', () => {
  it('rejects nonprivate endpoints and redirects cannot change an encoder origin', () => {
    for (const value of [
      'https://example.com',
      'http://127.example.com',
      'http://10.example.com',
      'http://192.168.example.com',
      'http://172.16.example.com',
      'file:///model',
      'http://encoder?model=x',
      'http://user:secret@encoder',
      'http://encoder/encode',
    ])
      expect(() => validateEncoderUrl(value)).toThrow();
    expect(validateEncoderUrl('http://127.0.0.1:18088')).toBe('http://127.0.0.1:18088/encode');
  });
  it('rejects malformed vectors/count/binding and extra fields without retry', async () => {
    for (const extra of [
      { token_count: 257 },
      { token_count: 0 },
      { dimension: 384 },
      { binding_sha256: 'f'.repeat(64) },
      { vector: Array(512).fill(0) },
      { vector: [1] },
      { vector: [...vector.slice(0, 511), null] },
      { model: 'injected' },
    ]) {
      let calls = 0;
      await expect(
        requestEncoding({
          text: '全文',
          binding: fixture.bundle.encoding_sha256,
          url: 'http://encoder/encode',
          signal: new AbortController().signal,
          deadlineMs: 1000,
          fetch: async () => {
            calls++;
            return response(extra);
          },
        }),
      ).rejects.toThrow();
      expect(calls).toBe(1);
    }
  });
  it('holds both actual client operations until settlement even after a timeout', async () => {
    const deadlines: (() => void)[] = [];
    const scheduleDeadline: EncoderDeadline = (callback) => {
      deadlines.push(callback);
      return () => {};
    };
    const releases: ((reason: Error) => void)[] = [];
    const operations: Promise<void>[] = [];
    let calls = 0;
    const transport: RoutingFetch = () => {
      calls++;
      const pending = new Promise<Response>((_resolve, reject) => releases.push(reject));
      operations.push(
        pending.then(
          () => {},
          () => {},
        ),
      );
      return pending;
    };
    const request = {
      text: '全文',
      binding: fixture.bundle.encoding_sha256,
      url: 'http://encoder/encode',
      signal: new AbortController().signal,
      deadlineMs: 1000,
      fetch: transport,
      scheduleDeadline,
    };
    const first = requestEncoding(request).catch((error: Error) => error.message);
    const second = requestEncoding(request).catch((error: Error) => error.message);
    for (const deadline of deadlines) deadline();
    expect(await first).toBe('ENCODING_DEADLINE');
    expect(await second).toBe('ENCODING_DEADLINE');
    await expect(requestEncoding(request)).rejects.toThrow('ENCODING_CAPACITY');
    expect(calls).toBe(2);
    for (const release of releases) release(new Error('transport completed after abort'));
    await Promise.all(operations);
    const accepted = await requestEncoding({ ...request, fetch: async () => response() });
    expect(accepted.vector[0]).toBe(1);
  });
  it('propagates cancellation instead of converting it into semantic fallback', async () => {
    const controller = new AbortController();
    controller.abort(new Error('run canceled'));
    let calls = 0;
    await expect(
      requestEncoding({
        text: '全文',
        binding: fixture.bundle.encoding_sha256,
        url: 'http://encoder/encode',
        signal: controller.signal,
        deadlineMs: 1000,
        fetch: async () => {
          calls++;
          return response();
        },
      }),
    ).rejects.toThrow('run canceled');
    expect(calls).toBe(0);
  });
});
