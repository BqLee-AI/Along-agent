import { expect, test } from 'bun:test';
import type { HarnessR3ContextStart } from '@along/contracts';
import { runNativeHarness } from '../src/agent/harness/harness-process.js';

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
