import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { verifyCsrf, type ActorResolver } from '../../http/auth.js';
import {
  csrfMismatch,
  failEnvelope,
  HttpError,
  isUuid,
  notFound,
  notReady,
  okEnvelope,
  requestIdOf,
  sendJson,
  unauthorized,
  validationError,
} from '../../http/errors.js';
import type { MemoryService } from './service.js';

const correctionSchema = z
  .object({
    content: z.string().min(1).max(12000),
    conversationId: z.string().uuid(),
    messageIds: z.array(z.string().uuid()).min(1).max(128),
    expectedRevision: z.number().int().positive().safe(),
    expiresAt: z.string().nullable().optional(),
  })
  .strict();
const stopSchema = z.object({ expectedRevision: z.number().int().positive().safe() }).strict();

export interface MemoryRouteDeps {
  service: MemoryService | null;
  resolveActor: ActorResolver;
  body?: unknown;
}

export async function handleMemoryRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: MemoryRouteDeps,
): Promise<boolean> {
  if (url.pathname !== '/api/v1/memories' && !url.pathname.startsWith('/api/v1/memories/'))
    return false;
  const requestId = requestIdOf(req);
  try {
    const actor = await deps.resolveActor(req);
    if (!actor) throw unauthorized();
    const service = deps.service;
    if (!service) throw notReady('memory unavailable');
    if (req.method === 'GET' && url.pathname === '/api/v1/memories') {
      const keys = [...url.searchParams.keys()];
      if (
        keys.some((key) => key !== 'limit' && key !== 'cursor') ||
        url.searchParams.getAll('limit').length > 1 ||
        url.searchParams.getAll('cursor').length > 1
      )
        throw validationError('invalid memory query');
      const rawLimit = url.searchParams.get('limit');
      if (rawLimit !== null && !/^[1-9][0-9]*$/.test(rawLimit))
        throw validationError('invalid memory limit');
      const result = await service.list(actor.ownerId, {
        ...(rawLimit !== null ? { limit: Number(rawLimit) } : {}),
        ...(url.searchParams.has('cursor') ? { cursor: url.searchParams.get('cursor')! } : {}),
      });
      sendJson(res, 200, okEnvelope(result, requestId), requestId, { 'cache-control': 'no-store' });
      return true;
    }
    const match = /^\/api\/v1\/memories\/([^/]+)(?:\/actions\/(correct|stop-recall))?$/.exec(
      url.pathname,
    );
    if (!match) return false;
    const memoryId = match[1] ?? '';
    if (!isUuid(memoryId)) throw notFound('memory not found');
    if (req.method === 'GET' && !match[2]) {
      const memory = await service.get(actor.ownerId, memoryId);
      if (!memory) throw notFound('memory not found');
      sendJson(res, 200, okEnvelope(memory, requestId), requestId, { 'cache-control': 'no-store' });
      return true;
    }
    if (req.method === 'POST' && match[2]) {
      if (!verifyCsrf(req, actor)) throw csrfMismatch();
      if (match[2] === 'correct') {
        const parsed = correctionSchema.safeParse(deps.body);
        if (!parsed.success) throw validationError('invalid memory correction');
        const result = await service.correct(actor.ownerId, memoryId, parsed.data);
        sendJson(res, 200, okEnvelope(result, requestId), requestId, {
          'cache-control': 'no-store',
        });
      } else {
        const parsed = stopSchema.safeParse(deps.body);
        if (!parsed.success) throw validationError('invalid memory stop request');
        await service.stopRecall(actor.ownerId, memoryId, parsed.data.expectedRevision);
        sendJson(res, 200, okEnvelope({ id: memoryId, status: 'stopped' }, requestId), requestId, {
          'cache-control': 'no-store',
        });
      }
      return true;
    }
    return false;
  } catch (err) {
    if (err instanceof HttpError) {
      sendJson(res, err.httpStatus, failEnvelope(err, requestId), requestId, {
        'cache-control': 'no-store',
      });
      return true;
    }
    sendJson(
      res,
      500,
      {
        code: 500,
        data: null,
        msg: 'internal error',
        error: { code: 'INTERNAL_ERROR', message: 'internal error', request_id: requestId },
        request_id: requestId,
      },
      requestId,
      { 'cache-control': 'no-store' },
    );
    return true;
  }
}
