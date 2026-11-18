import { describe, expect, it } from 'bun:test';
import { loadMemorySemanticConfig } from '../src/features/memory/recall/semantic.js';

const binding = 'a'.repeat(64);
describe('memory semantic configuration', () => {
  it('is off unless all independent settings are present and valid', () => {
    expect(loadMemorySemanticConfig({})).toBeUndefined();
    expect(() =>
      loadMemorySemanticConfig({ MEMORY_ENCODER_URL: 'http://localhost:9000' }),
    ).toThrow();
    expect(() =>
      loadMemorySemanticConfig({
        MEMORY_ENCODER_URL: 'https://example.com',
        MEMORY_ENCODER_BINDING_SHA256: binding,
        MEMORY_ENCODER_DEADLINE_MS: '1000',
      }),
    ).toThrow();
    expect(() =>
      loadMemorySemanticConfig({
        MEMORY_ENCODER_URL: 'http://localhost:9000',
        MEMORY_ENCODER_BINDING_SHA256: binding,
        MEMORY_ENCODER_DEADLINE_MS: '0',
      }),
    ).toThrow();
    expect(
      loadMemorySemanticConfig({
        MEMORY_ENCODER_URL: 'http://localhost:9000',
        MEMORY_ENCODER_BINDING_SHA256: binding,
        MEMORY_ENCODER_DEADLINE_MS: '1000',
      }),
    ).toEqual({ encoderUrl: 'http://localhost:9000', bindingSha256: binding, deadlineMs: 1000 });
  });
});
