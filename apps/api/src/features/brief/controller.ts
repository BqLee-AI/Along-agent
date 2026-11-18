import { Elysia } from 'elysia';
import type { HttpAccess } from '../../http/access.js';
import { queryOf } from '../../http/access.js';
import { okEnvelope } from '../../http/errors.js';
import { responses } from '../../http/model.js';
import { getBrief, type BriefDeps } from './public.js';
import { BriefResponseSchema } from './model.js';
export function createBriefController(deps: BriefDeps, access: HttpAccess) {
  return new Elysia({ name: 'brief', strictPath: true }).get(
    '/api/v1/brief',
    async ({ request }) => {
      const actor = await access.requireActor(request);
      const requestId = access.requestId(request);
      return okEnvelope(
        await getBrief(deps, actor.ownerId, actor.timezoneId, queryOf(request), requestId),
        requestId,
      );
    },
    { response: responses(BriefResponseSchema) },
  );
}
