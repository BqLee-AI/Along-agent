import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Pool } from 'pg';
import type { z } from 'zod';
import {
  ProviderCreateSchema,
  ProviderUpdateSchema,
  ProviderTestSchema,
  ProviderModelSchema,
  ProviderDefaultSchema,
  EmptyActionSchema,
} from '@along/contracts';
import type { ActorResolver } from '../../http/auth.js';
import {
  isUuid,
  notFound,
  notReady,
  okEnvelope,
  requestIdOf,
  sendJson,
  unauthorized,
  validationError,
} from '../../http/errors.js';
import {
  addModel,
  createProvider,
  deleteProvider,
  listProviders,
  removeModel,
  setDefault,
  syncModels,
  testProvider,
  updateProvider,
} from './service.js';
import type { ConversationDeps } from '../conversations/contracts.js';

const providerPath =
  /^\/api\/v1\/model-providers\/([^/]+)(?:\/(actions\/(?:update|delete|test)|models(?:\/actions\/(?:sync|remove))?))?$/;
export function isModelProviderPath(pathname: string): boolean {
  return (
    pathname === '/api/v1/model-providers' ||
    pathname.startsWith('/api/v1/model-providers/') ||
    pathname === '/api/v1/model-selection/actions/set-default'
  );
}
export function isModelProviderWritePath(pathname: string): boolean {
  if (
    pathname === '/api/v1/model-providers' ||
    pathname === '/api/v1/model-selection/actions/set-default'
  )
    return true;
  const match = providerPath.exec(pathname);
  return !!match && !!match[2];
}
function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) throw validationError('invalid request body');
  return result.data;
}
export async function handleModelProviderRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: {
    pool: Pool | null;
    resolveActor: ActorResolver;
    body: unknown;
    modelTransport?: ConversationDeps['modelTransport'];
  },
): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');
  const actor = await deps.resolveActor(req);
  if (!actor) throw unauthorized();
  if (!deps.pool) throw notReady();
  const pool = deps.pool,
    owner = actor.ownerId,
    path = url.pathname;
  let data: unknown;
  if (path === '/api/v1/model-providers' && req.method === 'GET')
    data = await listProviders(pool, owner);
  else if (path === '/api/v1/model-providers' && req.method === 'POST')
    data = await createProvider(pool, owner, parse(ProviderCreateSchema, deps.body).name);
  else if (path === '/api/v1/model-selection/actions/set-default' && req.method === 'POST') {
    const { selection } = parse(ProviderDefaultSchema, deps.body);
    await setDefault(pool, owner, selection);
    data = { selection };
  } else {
    const match = providerPath.exec(path);
    if (!match || !match[2] || req.method !== 'POST') throw notFound();
    const id = match[1]!;
    if (!isUuid(id)) throw validationError('invalid provider id');
    switch (match[2]) {
      case 'actions/update':
        data = await updateProvider(pool, owner, id, parse(ProviderUpdateSchema, deps.body));
        break;
      case 'actions/delete':
        parse(EmptyActionSchema, deps.body);
        await deleteProvider(pool, owner, id);
        data = { deleted: true };
        break;
      case 'actions/test': {
        const controller = new AbortController();
        const onClose = () => controller.abort();
        res.once('close', onClose);
        if (res.destroyed) controller.abort();
        try {
          data = await testProvider(
            pool,
            owner,
            id,
            parse(ProviderTestSchema, deps.body),
            deps.modelTransport,
            controller.signal,
          );
        } finally {
          res.off('close', onClose);
        }
        break;
      }
      case 'models':
        data = await addModel(pool, owner, id, parse(ProviderModelSchema, deps.body).model_id);
        break;
      case 'models/actions/remove':
        data = await removeModel(pool, owner, id, parse(ProviderModelSchema, deps.body).model_id);
        break;
      case 'models/actions/sync':
        parse(EmptyActionSchema, deps.body);
        data = await syncModels(pool, owner, id);
        break;
      default:
        throw notFound();
    }
  }
  const requestId = requestIdOf(req);
  sendJson(res, 200, okEnvelope(data, requestId), requestId);
}
