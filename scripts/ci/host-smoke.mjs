import assert from 'node:assert/strict';
import { connect as tcpConnect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';

const [native, baseline] = process.argv.slice(2);
async function probe(base, path, requestId) {
  const response = await fetch(`${base}${path}`, {
    signal: AbortSignal.timeout(5_000),
    headers: requestId ? { 'x-request-id': requestId } : {},
  });
  const returnedId = response.headers.get('x-request-id');
  if (requestId) assert.equal(returnedId, requestId);
  else assert.match(returnedId ?? '', /^[\da-f-]{36}$/i);
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
const probes = await Promise.all(
  Array.from({ length: 4 }, (_, i) => probe(native, '/readyz', `ready-${i}`)),
);
for (const result of probes) assert.deepEqual(result, expected);
const stream = await fetch(`${native}/readyz/events`, { signal: AbortSignal.timeout(5_000) });
assert.equal(stream.status, 200);
assert.match(stream.headers.get('content-type') ?? '', /^text\/event-stream\b/);
const reader = stream.body.getReader();
const decoder = new TextDecoder();
let frame = '';
while (!frame.includes('event: readiness') || !frame.endsWith('\n\n')) {
  const { done, value } = await reader.read();
  assert.equal(done, false);
  frame += decoder.decode(value, { stream: true });
}
await reader.cancel();
assert.equal(frame, ': readiness\n\nevent: readiness\ndata: {"status":"ok"}\n\n');
assert.deepEqual(await probe(native, '/healthz'), [200, { status: 'ok' }]);

// Keep the upload open until the server sends the complete rejection and closes.
async function rejectUnfinishedUpload(path, status, code, continuous) {
  const url = new URL(native);
  const options = { host: url.hostname, port: Number(url.port) };
  const tls = url.protocol === 'https:';
  const socket = tls
    ? tlsConnect({ ...options, rejectUnauthorized: false, ALPNProtocols: ['http/1.1'] })
    : tcpConnect(options);
  const chunks = [];
  let pump;
  try {
    await new Promise((resolve, reject) => {
      socket.setTimeout(3_000, () =>
        socket.destroy(new Error(`unfinished upload timed out: ${path}`)),
      );
      socket.once(tls ? 'secureConnect' : 'connect', () => {
        socket.write(
          `POST ${path} HTTP/1.1\r\nHost: ${url.host}\r\nContent-Type: application/json\r\n` +
            'Content-Length: 131072\r\nX-Request-Id: incomplete-upload\r\n\r\n{',
        );
        if (continuous) pump = setInterval(() => socket.write(' '.repeat(64)), 10);
      });
      socket.on('data', (chunk) => chunks.push(chunk));
      socket.once('close', resolve);
      socket.once('error', (error) => {
        if (error.code !== 'ECONNRESET' || !chunks.length) reject(error);
      });
    });
  } finally {
    clearInterval(pump);
    socket.destroy();
  }
  const wire = Buffer.concat(chunks).toString();
  const split = wire.indexOf('\r\n\r\n');
  assert.ok(split > 0);
  const head = wire.slice(0, split);
  assert.match(head, new RegExp(`^HTTP/1\\.1 ${status}\\b`));
  assert.match(head, /^connection: close$/im);
  const result = JSON.parse(wire.slice(split + 4));
  assert.equal(result.error.code, code);
  assert.equal(result.request_id, 'incomplete-upload');
}

for (const continuous of [false, true]) {
  await rejectUnfinishedUpload(
    '/api/v1/approvals/00000000-0000-4000-8000-000000000001/actions/confirm',
    401,
    'UNAUTHENTICATED',
    continuous,
  );
  await rejectUnfinishedUpload(
    '/api/v1/conversations/messages',
    401,
    'UNAUTHENTICATED',
    continuous,
  );
  await rejectUnfinishedUpload('/missing', 404, 'NOT_FOUND', continuous);
}
console.log('Unfinished uploads returned complete errors and closed.');
console.log(
  'Native HTTP and readiness match TS with PostgreSQL. SSE frame and subsequent request passed.',
);
