import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { HarnessR3ContextStartSchema, type HarnessR3ContextStart } from '@along/contracts';
import { runNativeHarness } from '../src/agent/harness/harness-process.js';
import { forbidden } from '../src/platform/errors.js';

test('a physically oversized v8 start reports context capacity before spawning', async () => {
  const start = {
    protocol: 'harness/v8',
    r3_context: { input: { content: 'x'.repeat(1_048_577) } },
  } as unknown as HarnessR3ContextStart;
  await expect(
    runNativeHarness({
      start,
      services: {
        binaryPath: 'unused',
      },
      signal: new AbortController().signal,
      handleRequest: async () => ({}),
    }),
  ).rejects.toMatchObject({ errorCode: 'HARNESS_CONTEXT_LIMIT' });
});

test('revoked start handoff does not release the native start frame', async () => {
  const start = HarnessR3ContextStartSchema.parse({
    type: 'start',
    protocol: 'harness/v8',
    trusted_context: null,
    r3_context: {
      manifest: { message_ids: [] },
      summary: null,
      messages: [],
      input: { type: 'user', message_id: randomUUID(), content: 'fixture' },
    },
    tools: [],
    context_policy: {
      revision: 'r2a/1',
      completion_cap: 32,
      model_window_tokens: null,
      input_meter: 'unavailable',
      meter_revision: 'unavailable/1',
      reserve_tokens: 0,
      model_binding: { model: 'fixture', adapter_revision: 'openai-chat/v1' },
    },
    routing_policy: null,
    eligible_phase: 'disabled',
    budget: { max_iterations: 4, max_tokens: 100 },
    snapshot: null,
    observations: [],
    approval: null,
  });
  const checked = Promise.withResolvers<void>();
  const revoked = Promise.withResolvers<void>();
  let allowed = true;
  const running = runNativeHarness({
    start,
    services: { binaryPath: 'not-a-native-binary' },
    signal: new AbortController().signal,
    guardStart: async (enqueue) => {
      checked.resolve();
      await revoked.promise;
      if (!allowed) throw forbidden();
      enqueue();
    },
    handleRequest: async () => {
      throw new Error('unreachable after revocation');
    },
  });
  await checked.promise;
  allowed = false;
  revoked.resolve();
  await expect(running).rejects.toMatchObject({ errorCode: 'FORBIDDEN' });
});
