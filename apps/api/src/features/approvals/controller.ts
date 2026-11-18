import { Elysia } from 'elysia';
import type { Pool } from 'pg';
import type { TimeContext } from '../time/public.js';
import type { HttpAccess } from '../../http/access.js';
import { queryOf } from '../../http/access.js';
import { okEnvelope } from '../../http/errors.js';
import { responses } from '../../http/model.js';
import { literalUuidAt } from '../../http/request/path.js';
import { forbidden } from '../../platform/errors.js';
import { WorkspaceDeniedError } from '../workspaces/public.js';
import { confirmDocumentApproval, rejectDocumentApproval } from '../../agent/operations/public.js';
import { readRunDocumentEvidence } from '../../agent/tools/query.js';
import {
  confirmApproval,
  rejectApproval,
  reviseApproval,
  getApprovalDetail,
  listApprovalsForOwner,
  getDocumentApprovalDetail,
} from './public.js';
import * as model from './model.js';
export const approvalWriteScopes = ['/api/v1/approvals', '/api/v1/document-approvals/'] as const;
function approvalId(path: string, document = false) {
  return literalUuidAt(path, 3, document ? 'document approval not found' : 'approval not found');
}
// Keep path validation after JSON parsing and before body schema validation.
function validateApprovalPath({ path, params }: { path: string; params: { id: string } }) {
  params.id = approvalId(path);
}
function validateDocumentPath({ path, params }: { path: string; params: { id: string } }) {
  params.id = approvalId(path, true);
}
async function documentResult<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof WorkspaceDeniedError) throw forbidden();
    throw error;
  }
}
export function createApprovalController(
  deps: { pool: Pool | null; timeContext: TimeContext },
  access: HttpAccess,
) {
  return new Elysia({ name: 'approvals', strictPath: true })
    .resolve({ as: 'local' }, async ({ request }) => ({
      actor: await access.requireActor(request),
      requestId: access.requestId(request),
    }))
    .get(
      '/api/v1/approvals',
      async ({ actor, request, requestId }) =>
        okEnvelope(await listApprovalsForOwner(deps, actor.ownerId, queryOf(request)), requestId),
      { response: responses(model.ApprovalListSchema) },
    )
    .get(
      '/api/v1/approvals/:id',
      async ({ actor, path, requestId }) =>
        okEnvelope(
          (await getApprovalDetail(deps, actor.ownerId, approvalId(path))).detail,
          requestId,
        ),
      { response: responses(model.ApprovalDetailSchema) },
    )
    .post(
      '/api/v1/approvals/:id/actions/confirm',
      async ({ actor, params, body, requestId }) =>
        okEnvelope(await confirmApproval(deps, actor.ownerId, params.id, body), requestId),
      {
        parse: access.parser(),
        transform: validateApprovalPath,
        body: model.ConfirmBodySchema,
        response: responses(model.ConfirmResultSchema),
      },
    )
    .post(
      '/api/v1/approvals/:id/actions/reject',
      async ({ actor, params, body, requestId }) =>
        okEnvelope(await rejectApproval(deps, actor.ownerId, params.id, body), requestId),
      {
        parse: access.parser(),
        transform: validateApprovalPath,
        body: model.RejectBodySchema,
        response: responses(model.RejectResultSchema),
      },
    )
    .post(
      '/api/v1/approvals/:id/actions/revise',
      async ({ actor, params, body, requestId }) =>
        okEnvelope(await reviseApproval(deps, actor.ownerId, params.id, body), requestId),
      {
        parse: access.parser(),
        transform: validateApprovalPath,
        body: model.ReviseBodySchema,
        response: responses(model.ReviseResultSchema),
      },
    )
    .get(
      '/api/v1/document-approvals/:id',
      async ({ actor, path, requestId }) =>
        okEnvelope(
          await documentResult(() =>
            getDocumentApprovalDetail(
              deps.pool,
              actor.ownerId,
              approvalId(path, true),
              readRunDocumentEvidence,
            ),
          ),
          requestId,
        ),
      { response: responses(model.DocumentApprovalDetailSchema) },
    )
    .post(
      '/api/v1/document-approvals/:id/actions/confirm',
      async ({ actor, params, body, requestId }) =>
        okEnvelope(
          await documentResult(() => confirmDocumentApproval(deps, actor.ownerId, params.id, body)),
          requestId,
        ),
      {
        parse: access.parser(),
        transform: validateDocumentPath,
        body: model.DocumentApprovalConfirmBodySchema,
        response: responses(model.DocumentApprovalActionResultSchema),
      },
    )
    .post(
      '/api/v1/document-approvals/:id/actions/reject',
      async ({ actor, params, body, requestId }) =>
        okEnvelope(
          await documentResult(() => rejectDocumentApproval(deps, actor.ownerId, params.id, body)),
          requestId,
        ),
      {
        parse: access.parser(),
        transform: validateDocumentPath,
        body: model.DocumentApprovalRejectBodySchema,
        response: responses(model.DocumentApprovalActionResultSchema),
      },
    );
}
