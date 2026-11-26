import assert from 'node:assert/strict';

const [native, baseline] = process.argv.slice(2);
async function probe(base, path) {
  const response = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(5_000) });
  return [response.status, await response.json()];
}

for (const base of [native, baseline]) {
  for (let attempt = 0; ; attempt++) {
    try {
      assert.deepEqual(await probe(base, '/healthz'), [200, { status: 'ok' }]);
      break;
    } catch (error) {
      if (attempt === 30) throw error;
      await Bun.sleep(200);
    }
  }
}
const expected = await probe(baseline, '/readyz');
assert.equal(expected[0], 200);
const probes = await Promise.all(Array.from({ length: 4 }, () => probe(native, '/readyz')));
for (const result of probes) assert.deepEqual(result, expected);
const stream = await fetch(`${native}/readyz/events`, { signal: AbortSignal.timeout(5_000) });
assert.equal(stream.status, 200);
assert.match(stream.headers.get('content-type') ?? '', /^text\/event-stream\b/);
const reader = stream.body.getReader();
const decoder = new TextDecoder();
let frame = '';
while (!frame.includes('\n\n')) {
  const { done, value } = await reader.read();
  assert.equal(done, false);
  frame += decoder.decode(value, { stream: true });
}
await reader.cancel();
assert.equal(frame, 'event: readiness\ndata: {"status":"ok"}\n\n');
assert.deepEqual(await probe(native, '/healthz'), [200, { status: 'ok' }]);
console.log(
  'Native HTTP and readiness match TS with PostgreSQL. SSE frame and subsequent request passed.',
);
