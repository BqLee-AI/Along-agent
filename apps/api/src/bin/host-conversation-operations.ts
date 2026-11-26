import type { ConversationDeps, StartResult } from '../agent/execution/contracts.js';
import {
  cancelConversationRun,
  continueConversationPause,
  getCompactReceipt,
  getRunView,
  requestConversationPause,
  requestRuntimeCompactPause,
  resumeConversationRun,
  startConversationRun,
  startIdleCompact,
} from '../agent/run/public.js';
import * as model from '../features/conversations/model.js';
import {
  ActionKeySchema,
  ConversationEventsQuerySchema,
  getConversationDetail,
  getConversationList,
  getConversationMessages,
  getConversationRuns,
} from '../features/conversations/public.js';
import { createAccess, idempotencyKeyOf, queryOf } from '../http/access.js';
import type { AppDeps } from '../http/contracts.js';
import { literalUuidAt } from '../http/request/path.js';
import { notFound, validationError } from '../platform/errors.js';
import type { Actor } from '../features/identity/public.js';
import type { z } from 'zod';

type Result = { actor: Actor } & ({ data: unknown } | { stream: StartResult });

export function createHostConversationOperations(deps: AppDeps) {
  const access = createAccess(deps);
  return async function open(
    domain: ConversationDeps,
    operation: string,
    request: Request,
  ): Promise<Result> {
    const requestId = access.requestId(request);
    const actor = await access.requireActor(request);
    const { ownerId, sessionId } = actor;
    const url = new URL(request.url);
    const path = url.pathname;
    const post = request.method === 'POST';
    let body: unknown;
    if (post) {
      access.csrf(request, actor);
      body = await access.json(request);
    }
    const input = <T>(schema: z.ZodType<T>) => {
      const parsed = schema.safeParse(body);
      if (!parsed.success) throw validationError('invalid request body');
      return parsed.data;
    };
    const key = idempotencyKeyOf(request);
    const compactKey = () => {
      if (!ActionKeySchema.safeParse(key).success) throw validationError('invalid compact request');
      return key!;
    };
    const conversationId = (message = 'conversation not found') => literalUuidAt(path, 3, message);
    const runId = (message = 'Run not found') => literalUuidAt(path, 5, message);
    const query = post ? undefined : queryOf(request);
    const read = (data: unknown): Result => ({ actor, data });
    const stream = (started: StartResult): Result => ({ actor, stream: started });

    if (post) {
      if (operation === 'send') {
        return stream(
          await startConversationRun(
            domain,
            ownerId,
            requestId,
            input(model.SendMessageBodySchema),
            key,
            sessionId,
          ),
        );
      }
      if (operation === 'compact-idle') {
        const id = conversationId();
        input(model.CompactRunBodySchema);
        const receipt = await startIdleCompact(domain, ownerId, id, requestId, compactKey());
        return read(
          receipt.status === 'no_content'
            ? { status: 'no_content', run_id: null, pause_id: null }
            : await getCompactReceipt(domain, ownerId, id, receipt.runId, receipt.pauseId),
        );
      }
      const id = conversationId('Run not found');
      const run = runId();
      switch (operation) {
        case 'cancel':
          return read(
            await cancelConversationRun(
              domain,
              ownerId,
              id,
              run,
              requestId,
              input(model.CancelRunBodySchema),
            ),
          );
        case 'pause':
          return read(
            await requestConversationPause(
              domain,
              ownerId,
              id,
              run,
              input(model.PauseRunBodySchema),
              key,
            ),
          );
        case 'resume':
          return stream(
            await resumeConversationRun(
              domain,
              ownerId,
              id,
              run,
              requestId,
              input(model.ResumeRunBodySchema),
            ),
          );
        case 'continue':
          return stream(
            await continueConversationPause(
              domain,
              ownerId,
              id,
              run,
              requestId,
              input(model.ContinueRunBodySchema),
              key,
            ),
          );
        case 'compact-active': {
          input(model.CompactRunBodySchema);
          const pending = await requestRuntimeCompactPause(
            domain,
            ownerId,
            id,
            run,
            'manual_compact',
            compactKey(),
          );
          return read(await getCompactReceipt(domain, ownerId, id, run, pending.pause_id));
        }
      }
    } else if (request.method === 'GET' && query) {
      switch (operation) {
        case 'list':
          return read(await getConversationList(domain, ownerId, query));
        case 'detail':
          return read(await getConversationDetail(domain, ownerId, conversationId(), query));
        case 'messages':
          return read(await getConversationMessages(domain, ownerId, conversationId(), query));
        case 'runs':
          return read(await getConversationRuns(domain, ownerId, conversationId(), query));
        case 'status':
          return read(await getRunView(domain, ownerId, conversationId('Run not found'), runId()));
        case 'compact-receipt': {
          const message = 'compact operation not found';
          return read(
            await getCompactReceipt(
              domain,
              ownerId,
              conversationId(message),
              runId(message),
              literalUuidAt(path, 7, message),
            ),
          );
        }
        case 'events': {
          const id = conversationId('Run not found');
          const run = runId();
          const parsed = ConversationEventsQuerySchema.safeParse(query);
          if (
            !parsed.success ||
            parsed.data.run_id !== undefined ||
            url.searchParams.has('limit')
          ) {
            throw validationError('invalid events query');
          }
          await getRunView(domain, ownerId, id, run);
          return stream({
            conversationId: id,
            runId: run,
            serverOwned: true,
            replay: null,
            context: null,
            afterSeq: parsed.data.after_seq,
          });
        }
      }
    }
    throw notFound('conversation operation not found');
  };
}
