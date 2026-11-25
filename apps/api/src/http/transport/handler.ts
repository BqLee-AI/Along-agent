import { httpStatusForError } from '@along/contracts';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createApp } from '../app.js';
import type { AppDeps } from '../contracts.js';
import { requestIdOf, failEnvelope, sendJson } from '../errors.js';
import { ApplicationError, notReady } from '../../platform/errors.js';
import { toWebRequest } from './request.js';
import { attachConnection } from './metadata.js';
import { writeWebResponse } from './response.js';
import { closeUnreadRequest } from './unread-upload.js';

export function createRequestHandler(deps: AppDeps) {
  const app = createApp(deps);
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const abort = new AbortController();
    const onClose = () => abort.abort();
    res.once('close', onClose);
    if (res.destroyed) abort.abort();
    try {
      req.headers['x-request-id'] = requestIdOf(req);
      const request = toWebRequest(req, new URL(req.url ?? '/', 'http://localhost'), abort.signal);
      attachConnection(request, {
        remoteAddress: req.socket.remoteAddress ?? null,
        localAddress: req.socket.localAddress ?? null,
        encrypted: 'encrypted' in req.socket && req.socket.encrypted === true,
        ...(deps.resolveActor
          ? { resolveActor: (_input, context) => deps.resolveActor!(req, context) }
          : {}),
      });
      const response = await app.handle(request);
      if (res.destroyed || req.aborted) {
        // No socket writer will take ownership of this body or cancel its producer.
        void response.body?.cancel().catch(() => {});
        return;
      }
      if (
        !response.headers.get('content-type')?.startsWith('text/event-stream') &&
        !req.readableEnded &&
        req.method !== 'GET' &&
        req.method !== 'HEAD'
      )
        closeUnreadRequest(req, res);
      await writeWebResponse(response, res);
    } catch (error) {
      if (res.headersSent || res.destroyed || req.aborted) return;
      closeUnreadRequest(req, res);
      const failure = error instanceof ApplicationError ? error : notReady();
      const requestId = requestIdOf(req);
      sendJson(res, httpStatusForError(failure.code), failEnvelope(failure, requestId), requestId);
    } finally {
      res.off('close', onClose);
    }
  };
}
