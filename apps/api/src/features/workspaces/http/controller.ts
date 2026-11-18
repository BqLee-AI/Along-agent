import { Elysia } from 'elysia';
import type { HttpAccess } from '../../../http/access.js';
import { okEnvelope } from '../../../http/errors.js';
import { responses } from '../../../http/model.js';
import { listWorkspaces } from '../public.js';
import { WorkspacesSchema } from './model.js';
export function createWorkspaceController(access: HttpAccess) {
  return new Elysia({ name: 'workspaces', strictPath: true }).get(
    '/api/v1/workspaces',
    async ({ request }) => {
      const actor = await access.requireActor(request);
      return okEnvelope({ items: listWorkspaces(actor.ownerId) }, access.requestId(request));
    },
    { response: responses(WorkspacesSchema) },
  );
}
