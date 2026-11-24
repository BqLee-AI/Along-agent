import { expect, test } from 'bun:test';
import { searchMicrosoftLearn } from '../src/features/remote-mcp/learn-client.js';

type Input = Parameters<typeof searchMicrosoftLearn>[0];
type Rpc = { method: string; id?: number; params?: unknown };

const endpoint = 'https://learn.microsoft.com/api/mcp';
const tool = {
  name: 'microsoft_docs_search',
  annotations: { readOnlyHint: true },
  inputSchema: { type: 'object', properties: { query: { type: 'string', default: null } } },
  outputSchema: { type: 'object', properties: { results: { type: 'array' } } },
};
const article = {
  title: 'Backup and restore',
  contentUrl: 'https://learn.microsoft.com/azure/postgresql/backup-restore#retention',
  content: 'The service stores automated backups.',
  extensionData: { uri: 'https://other.invalid/ignored' },
};
const defaultInput: Input = {
  query: '  Azure PostgreSQL 备份，retention? 🧪  ',
  authorized: async (enqueue) => {
    enqueue();
    return true;
  },
};
const posts = ['initialize', 'notifications/initialized', 'tools/list', 'tools/call'];
const encoder = new TextEncoder();
const invalidProtocol = { status: 'failed', code: 'REMOTE_MCP_PROTOCOL_ERROR' } as const;
const tooLarge = { status: 'failed', code: 'REMOTE_MCP_RESULT_TOO_LARGE' } as const;
const serviceFailed = { status: 'failed', code: 'REMOTE_MCP_SERVICE_FAILED' } as const;

function rpcResult(rpc: Rpc, result: unknown, sse = false) {
  const message = { jsonrpc: '2.0', id: rpc.id, result };
  return sse
    ? new Response(`event: message\ndata: ${JSON.stringify(message)}\n\n`, {
        headers: { 'content-type': 'text/event-stream' },
      })
    : Response.json(message);
}

function controlled(
  options: {
    sse?: boolean;
    list?: unknown;
    result?: unknown;
    beforeReply?: (rpc: Rpc, signal: AbortSignal) => Response | Promise<Response> | undefined;
  } = {},
) {
  const requests: Array<{ url: string; init: RequestInit; rpc: Rpc }> = [];
  const request = async (url: string | URL, init?: RequestInit) => {
    if (!init || typeof init.body !== 'string' || !init.signal)
      throw new Error('Unexpected HTTP request');
    const rpc = JSON.parse(init.body) as Rpc;
    requests.push({ url: String(url), init, rpc });
    const override = options.beforeReply?.(rpc, init.signal);
    if (override) return override;
    const reply = (result: unknown) => rpcResult(rpc, result, options.sse);
    switch (rpc.method) {
      case 'initialize': {
        const response = reply({
          protocolVersion: '2025-06-18',
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: 'microsoft learn fixture', version: '1' },
        });
        response.headers.set('mcp-session-id', 'fixture-session');
        return response;
      }
      case 'notifications/initialized':
        return new Response(null, { status: 202 });
      case 'tools/list':
        return reply(
          options.list ?? {
            tools: [tool, { ...tool, name: 'microsoft_docs_fetch', annotations: {} }],
          },
        );
      case 'tools/call':
        return reply(
          options.result ?? {
            content: [{ type: 'text', text: '{"results":["must not be used"]}' }],
            structuredContent: { results: [article], nextLink: 'https://other.invalid/never' },
          },
        );
      default:
        throw new Error(`Unexpected method ${rpc.method}`);
    }
  };
  return { request, requests };
}

for (const sse of [false, true]) {
  test(`projects structured Microsoft Learn excerpts and never follows links (${sse ? 'SSE' : 'JSON'})`, async () => {
    const { request, requests } = controlled({ sse });
    let checks = 0;
    const result = await searchMicrosoftLearn(
      {
        ...defaultInput,
        authorized: async (enqueue) => {
          ++checks;
          enqueue();
          expect(requests).toHaveLength(checks);
          return true;
        },
      },
      request,
    );
    expect(result).toEqual({
      status: 'ok',
      result: {
        kind: 'learn_docs_search',
        query: defaultInput.query,
        representation: 'search_excerpts',
        fetched_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u),
        items: [{ title: article.title, url: article.contentUrl, content: article.content }],
      },
    });
    expect(checks).toBe(posts.length);
    expect(requests.map(({ rpc }) => rpc.method)).toEqual(posts);
    expect(requests.at(-1)?.rpc.params).toEqual({
      name: 'microsoft_docs_search',
      arguments: { query: defaultInput.query },
    });
    for (const { init, url } of requests) {
      expect(url).toBe(endpoint);
      expect(init.method).toBe('POST');
      expect(init.redirect).toBe('error');
      expect(init.credentials).toBe('omit');
      const headers = new Headers(init.headers);
      expect(headers.get('authorization')).toBeNull();
      expect(headers.get('cookie')).toBeNull();
    }
    expect(new Headers(requests.at(-1)?.init.headers).get('mcp-session-id')).toBe(
      'fixture-session',
    );
  });
}

test('denies missing, extra, and invalid local input before authorization or HTTP', async () => {
  const { request, requests } = controlled();
  let checks = 0;
  const authorized: Input['authorized'] = async (enqueue) => {
    ++checks;
    enqueue();
    return true;
  };
  const badInputs = [
    {},
    { query: undefined },
    { query: 3 },
    { query: ' \n ' },
    { query: 'x'.repeat(501) },
    { query: 'valid', endpoint: 'https://other.invalid/mcp' },
    { query: 'valid', name: 'another_tool' },
  ];
  for (const bad of badInputs) {
    expect(await searchMicrosoftLearn({ ...bad, authorized } as Input, request)).toEqual({
      status: 'denied',
    });
  }
  expect(checks).toBe(0);
  expect(requests).toHaveLength(0);
});

test('rechecks authorization at each actual dispatch and preserves local database errors', async () => {
  const denied = controlled();
  let checks = 0;
  expect(
    await searchMicrosoftLearn(
      {
        ...defaultInput,
        authorized: async (enqueue) => {
          if (++checks === 4) return false;
          enqueue();
          return true;
        },
      },
      denied.request,
    ),
  ).toEqual({ status: 'denied' });
  expect(checks).toBe(4);
  expect(denied.requests.map(({ rpc }) => rpc.method)).toEqual(posts.slice(0, 3));

  const broken = controlled();
  const databaseError = new Error('fixture database error');
  checks = 0;
  const call = searchMicrosoftLearn(
    {
      ...defaultInput,
      authorized: async (enqueue) => {
        if (++checks === 2) throw databaseError;
        enqueue();
        return true;
      },
    },
    broken.request,
  );
  await expect(call).rejects.toBe(databaseError);
  expect(broken.requests.map(({ rpc }) => rpc.method)).toEqual(['initialize']);
});

test('does not start HTTP if the caller is already canceled', async () => {
  const { request, requests } = controlled();
  const signal = AbortSignal.abort();
  expect(await searchMicrosoftLearn({ ...defaultInput, signal }, request)).toEqual({
    status: 'denied',
  });
  expect(requests).toHaveLength(0);
});

for (const [label, list, expected] of [
  [
    'excess tools',
    { tools: [tool, ...Array.from({ length: 16 }, (_, i) => ({ ...tool, name: `other_${i}` }))] },
    tooLarge,
  ],
  ['next cursor', { tools: [tool], nextCursor: 'second-page' }, invalidProtocol],
  ['duplicate fixed tool', { tools: [tool, tool] }, invalidProtocol],
  ['missing fixed tool', { tools: [{ ...tool, name: 'microsoft_docs_fetch' }] }, invalidProtocol],
  [
    'non-readonly tool',
    { tools: [{ ...tool, annotations: { readOnlyHint: false } }] },
    invalidProtocol,
  ],
  [
    'incompatible query',
    {
      tools: [
        {
          ...tool,
          inputSchema: { ...tool.inputSchema, properties: { query: { type: 'number' } } },
        },
      ],
    },
    invalidProtocol,
  ],
  [
    'incompatible output',
    {
      tools: [
        {
          ...tool,
          outputSchema: { ...tool.outputSchema, properties: { results: { type: 'string' } } },
        },
      ],
    },
    invalidProtocol,
  ],
] as const) {
  test(`rejects ${label} without pagination or a tool call`, async () => {
    const { request, requests } = controlled({ list });
    expect(await searchMicrosoftLearn(defaultInput, request)).toEqual(expected);
    expect(requests.map(({ rpc }) => rpc.method)).toEqual(posts.slice(0, 3));
  });
}

test('accepts actual empty structured results, not a text-only substitute', async () => {
  const empty = controlled({ result: { content: [], structuredContent: { results: [] } } });
  const success = await searchMicrosoftLearn(defaultInput, empty.request);
  expect(success.status).toBe('ok');
  if (success.status === 'ok') expect(success.result.items).toEqual([]);
  const textOnly = controlled({ result: { content: [{ type: 'text', text: '{"results":[]}' }] } });
  expect(await searchMicrosoftLearn(defaultInput, textOnly.request)).toEqual(invalidProtocol);
});

for (const [label, items, expected] of [
  ['extra items', Array.from({ length: 11 }, () => article), tooLarge],
  ['overlong UTF-8 title', [{ ...article, title: '界'.repeat(171) }], tooLarge],
  [
    'overlong source',
    [{ ...article, contentUrl: `${article.contentUrl}${'x'.repeat(2048)}` }],
    tooLarge,
  ],
  ['overlong UTF-8 excerpt', [{ ...article, content: '界'.repeat(1366) }], tooLarge],
  [
    'overlong serialized projection',
    Array.from({ length: 4 }, () => ({ ...article, content: '\u0001'.repeat(4096) })),
    tooLarge,
  ],
  [
    'nonofficial source',
    [{ ...article, contentUrl: 'https://learn.microsoft.com.other.invalid/page' }],
    invalidProtocol,
  ],
  [
    'non-HTTPS source',
    [{ ...article, contentUrl: 'http://learn.microsoft.com/page' }],
    invalidProtocol,
  ],
  [
    'source with userinfo',
    [{ ...article, contentUrl: 'https://visitor@learn.microsoft.com/page' }],
    invalidProtocol,
  ],
  [
    'source with empty userinfo',
    [{ ...article, contentUrl: 'https://@learn.microsoft.com/page' }],
    invalidProtocol,
  ],
  [
    'source with a non-default port',
    [{ ...article, contentUrl: 'https://learn.microsoft.com:444/page' }],
    invalidProtocol,
  ],
  ['null excerpt', [{ ...article, content: null }], invalidProtocol],
] as const) {
  test(`rejects a result with ${label}`, async () => {
    const { request } = controlled({
      result: { content: [], structuredContent: { results: items } },
    });
    expect(await searchMicrosoftLearn(defaultInput, request)).toEqual(expected);
  });
}

test('rejects nontext blocks even when the structured excerpt is valid', async () => {
  const { request } = controlled({
    result: {
      content: [{ type: 'image', mimeType: 'image/png', data: 'AA==' }],
      structuredContent: { results: [article] },
    },
  });
  expect(await searchMicrosoftLearn(defaultInput, request)).toEqual(invalidProtocol);
});

for (const type of ['application/json', 'text/event-stream']) {
  test(`aborts and cancels oversized streamed ${type} before SDK decoding`, async () => {
    let canceled = false;
    let fetchAborted = false;
    const { request, requests } = controlled({
      beforeReply: (rpc, signal) => {
        if (rpc.method !== 'tools/call') return;
        signal.addEventListener(
          'abort',
          () => {
            fetchAborted = true;
          },
          { once: true },
        );
        const valid = JSON.stringify({
          jsonrpc: '2.0',
          id: rpc.id,
          result: { content: [], structuredContent: { results: [] } },
        });
        const prefix = encoder.encode(type === 'text/event-stream' ? `data: ${valid}\n\n` : valid);
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(prefix);
            },
            pull(controller) {
              controller.enqueue(encoder.encode(' '.repeat(65_536)));
            },
            cancel() {
              canceled = true;
            },
          }),
          { headers: { 'content-type': type } },
        );
      },
    });
    expect(await searchMicrosoftLearn(defaultInput, request)).toEqual(tooLarge);
    expect(fetchAborted).toBe(true);
    expect(canceled).toBe(true);
    expect(requests.map(({ rpc }) => rpc.method)).toEqual(posts);
  });
}

for (const [label, reply, expected] of [
  [
    'redirect',
    () => new Response(null, { status: 302, headers: { location: 'https://other.invalid/' } }),
    serviceFailed,
  ],
  [
    'HTTP 401',
    () => new Response(null, { status: 401, headers: { 'www-authenticate': 'Bearer' } }),
    serviceFailed,
  ],
  [
    'network failure',
    async () => {
      throw new Error('fixture DNS failure');
    },
    serviceFailed,
  ],
  [
    'JSON-RPC error',
    (rpc: Rpc) =>
      Response.json({ jsonrpc: '2.0', id: rpc.id, error: { code: -32603, message: 'fixture' } }),
    serviceFailed,
  ],
  ['provider error', (rpc: Rpc) => rpcResult(rpc, { isError: true, content: [] }), serviceFailed],
  [
    'invalid JSON',
    () => new Response('{', { headers: { 'content-type': 'application/json' } }),
    invalidProtocol,
  ],
  [
    'invalid SSE result',
    () => new Response('data: {\n\n', { headers: { 'content-type': 'text/event-stream' } }),
    invalidProtocol,
  ],
] as const) {
  test(`classifies ${label} without retry, fallback, or a second request`, async () => {
    const { request, requests } = controlled({
      beforeReply: (rpc) => (rpc.method === 'tools/call' ? reply(rpc) : undefined),
    });
    expect(await searchMicrosoftLearn(defaultInput, request)).toEqual(expected);
    expect(requests.map(({ rpc }) => rpc.method)).toEqual(posts);
  });
}

function stuckSearch() {
  const entered = Promise.withResolvers<AbortSignal>();
  const { request, requests } = controlled({
    beforeReply: (rpc, signal) => {
      if (rpc.method !== 'tools/call') return;
      const pending = Promise.withResolvers<Response>();
      signal.addEventListener('abort', () => pending.reject(signal.reason), { once: true });
      entered.resolve(signal);
      return pending.promise;
    },
  });
  return { request, requests, entered: entered.promise };
}

test('caller cancellation denies locally and aborts the pending legacy fetch', async () => {
  const caller = new AbortController();
  const { request, requests, entered } = stuckSearch();
  const result = searchMicrosoftLearn({ ...defaultInput, signal: caller.signal }, request);
  const wireSignal = await entered;
  expect(wireSignal.aborted).toBe(false);
  caller.abort();
  expect(wireSignal.aborted).toBe(true);
  expect(await result).toEqual({ status: 'denied' });
  expect(requests.map(({ rpc }) => rpc.method)).toEqual(posts);
});

test('one 15-second deadline aborts the pending fetch and is distinct from caller cancellation', async () => {
  const { request, requests, entered } = stuckSearch();
  const caller = new AbortController();
  try {
    const result = searchMicrosoftLearn({ ...defaultInput, signal: caller.signal }, request);
    const wireSignal = await entered;
    expect(wireSignal.aborted).toBe(false);
    expect(caller.signal.aborted).toBe(false);
    expect(await result).toEqual({ status: 'failed', code: 'REMOTE_MCP_TIMEOUT' });
    expect(wireSignal.aborted).toBe(true);
    expect(requests.map(({ rpc }) => rpc.method)).toEqual(posts);
  } finally {
    caller.abort();
  }
}, 30_000);
