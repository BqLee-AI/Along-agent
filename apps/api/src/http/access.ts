import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { Actor } from '../features/identity/public.js';
import {
  createActorResolver,
  verifyCsrf,
  type ActorRequest,
  type ActorResolutionContext,
} from './auth.js';
import type { AppDeps } from './contracts.js';
import {
  csrfMismatch,
  ApplicationError,
  notReady,
  unauthorized,
  validationError,
} from '../platform/errors.js';
import { checkDeclaredBodySize, readBody } from './request/body.js';
import { connectionOf } from './transport/metadata.js';

function actorRequest(request: Request): ActorRequest {
  return { method: request.method, url: request.url, headers: Object.fromEntries(request.headers) };
}
export function queryOf(request: Request): Record<string, string | string[] | undefined> {
  const result: Record<string, string | string[] | undefined> = Object.create(null);
  new URL(request.url).searchParams.forEach((value, key) => {
    const previous = result[key];
    result[key] =
      previous === undefined
        ? value
        : Array.isArray(previous)
          ? [...previous, value]
          : [previous, value];
  });
  return result;
}
export function idempotencyKeyOf(request: Request): string | null {
  return request.headers.get('idempotency-key')?.trim() || null;
}

/** The request ID is echoed in HTTP and stored in the bounded checkpoint envelope. */
export function normalizeRequestId(incoming: string | null | undefined): string {
  const value = incoming?.trim();
  return value && value.length <= 200 ? value : randomUUID();
}

export function createAccess(deps: Pick<AppDeps, 'pool' | 'resolveActor'>) {
  const resolve = deps.resolveActor ?? createActorResolver({ pool: deps.pool });
  const actors = new WeakMap<Request, Promise<Actor | null>>();
  const legacyActors = new WeakMap<Request, Promise<Actor | null>>();
  const ids = new WeakMap<Request, string>();
  const admittedWrites = new WeakSet<Request>();
  function requestId(request: Request): string {
    let id = ids.get(request);
    if (!id) {
      id = normalizeRequestId(request.headers.get('x-request-id'));
      ids.set(request, id);
    }
    return id;
  }
  function actor(request: Request, context?: ActorResolutionContext): Promise<Actor | null> {
    const resolver = connectionOf(request).resolveActor ?? resolve;
    const cache = context?.allowLegacyClaim ? legacyActors : actors;
    let pending = cache.get(request);
    if (!pending) {
      pending = resolver(actorRequest(request), context);
      cache.set(request, pending);
    }
    return pending;
  }
  async function requireActor(request: Request): Promise<Actor> {
    let value: Actor | null;
    try {
      value = await actor(request);
    } catch (error) {
      throw error instanceof ApplicationError ? error : notReady();
    }
    if (!value) throw unauthorized();
    return value;
  }
  function csrf(request: Request, value: Actor): void {
    if (!verifyCsrf(actorRequest(request), value)) throw csrfMismatch();
  }
  function modelConnection(request: Request): void {
    const peer = connectionOf(request);
    const loopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];
    const local =
      loopback.includes(peer.remoteAddress ?? '') && loopback.includes(peer.localAddress ?? '');
    const expected = process.env.ALONG_LOCAL_MODEL_PROXY_TOKEN;
    const supplied = request.headers.get('x-along-local-model-proxy');
    const proxy =
      typeof expected === 'string' &&
      /^[0-9a-f]{64}$/.test(expected) &&
      typeof supplied === 'string' &&
      /^[0-9a-f]{64}$/.test(supplied) &&
      timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(supplied, 'hex'));
    if (!peer.encrypted && !local && !proxy)
      throw new ApplicationError(403, 'FORBIDDEN', 'secure connection required');
  }
  async function json(request: Request): Promise<unknown> {
    checkDeclaredBodySize(request.headers.get('content-length') ?? undefined);
    const parsed = await readBody(request);
    if (!parsed) throw validationError('request interrupted');
    return parsed.body;
  }
  function parser(options: { model?: boolean; ready?: () => void } = {}) {
    return async ({ request }: { request: Request }) => {
      csrf(request, await requireActor(request));
      if (options.model) modelConnection(request);
      const body = await json(request);
      options.ready?.();
      return body;
    };
  }
  async function admitWrite(request: Request): Promise<void> {
    await requireActor(request);
    admittedWrites.add(request);
  }
  return {
    actor,
    requireActor,
    requestId,
    csrf,
    json,
    parser,
    admitWrite,
    isAdmittedWrite: (request: Request) => admittedWrites.has(request),
  };
}
export type HttpAccess = ReturnType<typeof createAccess>;
