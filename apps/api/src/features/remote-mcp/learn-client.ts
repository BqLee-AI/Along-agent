import { LearnDocsQuerySchema, LearnDocsSearchPayloadSchema } from '@along/contracts';
import { Client, ProtocolError, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { z } from 'zod';

const ENDPOINT = 'https://learn.microsoft.com/api/mcp';
const TOOL = 'microsoft_docs_search';
const DEADLINE_MS = 15_000;
const RESPONSE_BYTES = 131_072;
const RPC_SEQUENCE = ['initialize', 'notifications/initialized', 'tools/list', 'tools/call'];

type Fetch = (url: string | URL, init?: RequestInit) => Promise<Response>;
type Input = { query: string; signal?: AbortSignal; authorized: () => Promise<boolean> };
type FailureCode =
  | 'REMOTE_MCP_TIMEOUT'
  | 'REMOTE_MCP_SERVICE_FAILED'
  | 'REMOTE_MCP_PROTOCOL_ERROR'
  | 'REMOTE_MCP_RESULT_TOO_LARGE';
type Failure = { status: 'failed'; code: FailureCode } | { status: 'denied' };
type Outcome = Failure | { status: 'ok'; result: z.infer<typeof LearnDocsSearchPayloadSchema> };

const denied = { status: 'denied' } as const;
const failure = (code: FailureCode) => ({ status: 'failed' as const, code });
const service = failure('REMOTE_MCP_SERVICE_FAILED');
const protocol = failure('REMOTE_MCP_PROTOCOL_ERROR');
const capacity = failure('REMOTE_MCP_RESULT_TOO_LARGE');

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringQuerySchema(schema: Record<string, unknown>) {
  return (
    record(record(schema.properties)?.query)?.type === 'string' &&
    (schema.required === undefined ||
      (Array.isArray(schema.required) && schema.required.every((key) => key === 'query')))
  );
}

function projectResult(response: { structuredContent?: unknown }, query: string): Outcome {
  const results = record(response.structuredContent)?.results;
  if (!Array.isArray(results)) return protocol;
  if (results.length > 10) return capacity;

  const items = [];
  for (const raw of results) {
    const item = record(raw);
    const title = item?.title;
    const url = item?.contentUrl;
    const content = item?.content;
    if (typeof title !== 'string' || typeof url !== 'string' || typeof content !== 'string')
      return protocol;
    if (
      Buffer.byteLength(title) > 512 ||
      Buffer.byteLength(url) > 2048 ||
      Buffer.byteLength(content) > 4096
    )
      return capacity;
    // URL normalizes empty credentials away. Require an explicit authority with no userinfo.
    if (!/^https:\/\/[^/@\\?#]+(?:[/?#]|$)/iu.test(url)) return protocol;
    items.push({ title, url, content });
  }
  const payload = {
    kind: 'learn_docs_search',
    query,
    fetched_at: new Date().toISOString(),
    representation: 'search_excerpts',
    items,
  } as const;
  if (Buffer.byteLength(JSON.stringify(payload)) > 65_536) return capacity;
  const parsed = LearnDocsSearchPayloadSchema.safeParse(payload);
  return parsed.success ? { status: 'ok', result: parsed.data } : protocol;
}

// notifications/initialized does not inherit the SDK's request signal. Make the
// authorization wait itself interruptible so closing never waits on a DB round trip.
async function waitForAuthorization(check: Promise<boolean>, signal: AbortSignal) {
  const interrupted = Promise.withResolvers<never>();
  const onAbort = () => interrupted.reject(signal.reason);
  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) onAbort();
  try {
    return await Promise.race([check, interrupted.promise]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

// Buffer only within the wire budget before handing any bytes to the SDK. In
// particular, an early SSE result cannot hide oversized trailing response data.
async function boundedResponse(response: Response, signal: AbortSignal, overflow: () => never) {
  if (Number(response.headers.get('content-length')) > RESPONSE_BYTES) {
    void response.body?.cancel().catch(() => {});
    overflow();
  }
  const reader = response.body?.getReader();
  if (!reader) return response;
  const cancel = () => {
    void reader.cancel(signal.reason).catch(() => {});
  };
  signal.addEventListener('abort', cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const next = await reader.read();
      signal.throwIfAborted();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > RESPONSE_BYTES) overflow();
      if (next.value.byteLength) chunks.push(next.value);
    }
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
  let index = 0;
  return new Response(
    new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (index === chunks.length) controller.close();
          else controller.enqueue(chunks[index++]!);
        },
      },
      { highWaterMark: 0 },
    ),
    {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    },
  );
}

export async function searchMicrosoftLearn(input: Input, request: Fetch = fetch): Promise<Outcome> {
  if (
    !input ||
    !Object.hasOwn(input, 'query') ||
    typeof input.query !== 'string' ||
    Object.keys(input).some((key) => key !== 'query' && key !== 'signal' && key !== 'authorized')
  )
    return denied;
  const query = input.query;
  if (!LearnDocsQuerySchema.safeParse(query).success || input.signal?.aborted) return denied;

  const operation = new AbortController();
  const signal = input.signal
    ? AbortSignal.any([input.signal, operation.signal])
    : operation.signal;
  let stopped: Failure | undefined;
  const stop = (reason: Failure) => {
    if (signal.aborted) return;
    stopped = reason;
    operation.abort(reason);
  };
  const fail = (reason: Failure): never => {
    stop(reason);
    throw signal.reason;
  };
  const timer = setTimeout(() => stop(failure('REMOTE_MCP_TIMEOUT')), DEADLINE_MS);
  let authorizationFailure: { error: unknown } | undefined;
  let nextRpc = 0;
  const client = new Client(
    { name: 'along-microsoft-learn', version: '1.0.0' },
    {
      versionNegotiation: { mode: 'legacy' },
      enforceStrictCapabilities: true,
    },
  );
  const transport = new StreamableHTTPClientTransport(new URL(ENDPOINT), {
    reconnectionOptions: {
      maxRetries: 0,
      maxReconnectionDelay: 0,
      initialReconnectionDelay: 0,
      reconnectionDelayGrowFactor: 1,
    },
    requestInit: { redirect: 'error', credentials: 'omit' },
    async fetch(url, init) {
      if (String(url) !== ENDPOINT) return fail(protocol);
      // Suppress the SDK's optional GET SSE subscription and local cancellation
      // notification without sending either to Microsoft.
      if (init?.method === 'GET') return new Response(null, { status: 405 });
      if (init?.method !== 'POST' || typeof init.body !== 'string') return fail(protocol);
      const rpc = JSON.parse(init.body) as { method?: string; id?: number | string };
      if (rpc.method === 'notifications/cancelled') return new Response(null, { status: 202 });
      if (nextRpc >= RPC_SEQUENCE.length || rpc.method !== RPC_SEQUENCE[nextRpc++])
        return fail(protocol);

      const dispatchSignal = init.signal ? AbortSignal.any([signal, init.signal]) : signal;
      dispatchSignal.throwIfAborted();
      let allowed: boolean;
      try {
        allowed = await waitForAuthorization(input.authorized(), dispatchSignal);
      } catch (error) {
        if (!dispatchSignal.aborted) authorizationFailure = { error };
        throw error;
      }
      dispatchSignal.throwIfAborted();
      if (!allowed) return fail(denied);

      try {
        const response = await request(ENDPOINT, {
          ...init,
          redirect: 'error',
          credentials: 'omit',
          signal: dispatchSignal,
        });
        if (
          dispatchSignal.aborted ||
          !response.ok ||
          response.redirected ||
          (rpc.id !== undefined && (response.status === 202 || !response.body))
        ) {
          void response.body?.cancel().catch(() => {});
          dispatchSignal.throwIfAborted();
          return fail(response.ok && !response.redirected ? protocol : service);
        }
        return await boundedResponse(response, dispatchSignal, () => fail(capacity));
      } catch {
        return fail(service);
      }
    },
  });
  client.onerror = () => stop(protocol);

  try {
    const options = { signal };
    await client.connect(transport, options);
    // Use SDK primitives, not listTools() (auto-pagination) or callTool()
    // (compiles discovered provider schemas). Only our fixed contract is used.
    const discovery = await client.request({ method: 'tools/list' }, options);
    if (discovery.tools.length > 16) return capacity;
    if (discovery.nextCursor !== undefined) return protocol;
    const matches = discovery.tools.filter((tool) => tool.name === TOOL);
    const tool = matches[0];
    if (
      matches.length !== 1 ||
      !tool ||
      tool.annotations?.readOnlyHint !== true ||
      tool.annotations.destructiveHint === true ||
      !stringQuerySchema(tool.inputSchema) ||
      record(record(tool.outputSchema?.properties)?.results)?.type !== 'array'
    )
      return protocol;

    const response = await client.request(
      {
        method: 'tools/call',
        params: { name: TOOL, arguments: { query } },
      },
      options,
    );
    signal.throwIfAborted();
    if (response.isError) return service;
    if (response.content.some((block) => block.type !== 'text')) return protocol;
    return projectResult(response, query);
  } catch (error) {
    if (authorizationFailure) throw authorizationFailure.error;
    if (signal.aborted) return stopped ?? denied;
    return ProtocolError.isInstance(error) ? service : protocol;
  } finally {
    clearTimeout(timer);
    operation.abort();
    await client.close();
  }
}
