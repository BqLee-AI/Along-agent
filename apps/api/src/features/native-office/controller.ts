import { Elysia } from 'elysia';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { HttpAccess } from '../../http/access.js';
import { idempotencyKeyOf } from '../../http/access.js';
import { okEnvelope } from '../../http/errors.js';
import { ApplicationError, notReady, validationError } from '../../platform/errors.js';
import { readOfficeUpload } from './upload.js';
import { createOfficeStorage } from './storage/public.js';
import { readOfficeObservationKey } from './private/observation-key.js';

const uuid = z.string().uuid();

export function createOfficeMaterialsController(pool: Pool | null, access: HttpAccess) {
  const storage = pool ? createOfficeStorage(pool) : null;
  return new Elysia({ name: 'office-materials', strictPath: true })
    .get('/api/v1/conversations/office-capabilities', async ({ request }) => {
      await access.requireActor(request);
      return okEnvelope(
        {
          admission_enabled:
            !!storage &&
            process.env.ALONG_NATIVE_OFFICE_ADMISSION === '1' &&
            !!readOfficeObservationKey(),
        },
        access.requestId(request),
      );
    })
    .post(
      '/api/v1/conversations/attachments',
      async ({ request }) => {
        const actor = await access.requireActor(request);
        access.csrf(request, actor);
        if (!actor.sessionId)
          throw new ApplicationError(403, 'FORBIDDEN', 'Signed session required');
        if (!storage) throw notReady();
        const url = new URL(request.url);
        const draftId = uuid.safeParse(url.searchParams.get('draft_id'));
        const conversationValue = url.searchParams.get('conversation_id');
        const conversationId =
          conversationValue === null ? null : uuid.safeParse(conversationValue);
        const key = uuid.safeParse(idempotencyKeyOf(request));
        if (!draftId.success || !key.success || (conversationId && !conversationId.success))
          throw validationError('invalid attachment request');
        const upload = await readOfficeUpload(request);
        const result = await storage.stageAttachment({
          ownerId: actor.ownerId,
          sessionId: actor.sessionId,
          draftId: draftId.data,
          conversationId: conversationId?.data ?? null,
          idempotencyKey: key.data,
          filename: upload.filename,
          format: upload.format,
          bytes: upload.bytes,
        });
        return okEnvelope(
          {
            attachment_id: result.attachmentId,
            filename: result.filename,
            format: result.format,
            byte_length: result.sizeBytes,
            expires_at: result.expiresAt,
            status: result.status,
          },
          access.requestId(request),
        );
      },
      { parse: 'none' },
    )
    .post(
      '/api/v1/conversations/attachments/:id/actions/revoke',
      async ({ request, params }) => {
        const actor = await access.requireActor(request);
        access.csrf(request, actor);
        if (!actor.sessionId)
          throw new ApplicationError(403, 'FORBIDDEN', 'Signed session required');
        if (!storage) throw notReady();
        const url = new URL(request.url);
        const attachmentId = uuid.safeParse(params.id);
        const draft = url.searchParams.get('draft_id');
        const conversation = url.searchParams.get('conversation_id');
        if (
          !attachmentId.success ||
          (draft !== null && !uuid.safeParse(draft).success) ||
          (conversation !== null && !uuid.safeParse(conversation).success)
        )
          throw validationError('invalid attachment request');
        await storage.revokeAttachment({
          ownerId: actor.ownerId,
          sessionId: actor.sessionId,
          attachmentId: attachmentId.data,
          ...(draft === null ? {} : { draftId: draft }),
          ...(conversation === null ? {} : { conversationId: conversation }),
        });
        return okEnvelope({ revoked: true }, access.requestId(request));
      },
      { parse: 'none' },
    )
    .get(
      '/api/v1/conversations/:id/runs/:run/artifacts/:artifact/content',
      async ({ request, params }) => {
        const actor = await access.requireActor(request);
        if (!storage) throw notReady();
        if (
          !uuid.safeParse(params.id).success ||
          !uuid.safeParse(params.run).success ||
          !uuid.safeParse(params.artifact).success
        )
          throw validationError('invalid artifact request');
        const result = await storage.downloadArtifact({
          ownerId: actor.ownerId,
          ...(actor.sessionId ? { sessionId: actor.sessionId } : {}),
          conversationId: params.id,
          runId: params.run,
          artifactId: params.artifact,
        });
        const filename = encodeURIComponent(result.filename).replace(
          /['()*]/g,
          (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
        );
        return new Response(new Uint8Array(result.bytes), {
          headers: {
            'content-type':
              result.format === 'csv' ? 'text/csv; charset=utf-8' : 'text/markdown; charset=utf-8',
            'content-disposition': `attachment; filename*=UTF-8''${filename}`,
            'content-length': String(result.sizeBytes),
            'x-content-type-options': 'nosniff',
            'cache-control': 'private, no-store, no-transform',
          },
        });
      },
    );
}
