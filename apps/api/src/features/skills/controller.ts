import {
  SkillDetailSchema,
  SkillDisableSchema,
  SkillImportPreviewSchema,
  SkillInputSchema,
  SkillListPageSchema,
  SkillUpdateSchema,
} from '@along/contracts';
import { Elysia } from 'elysia';
import type { Pool } from 'pg';
import { idempotencyKeyOf, queryOf, type HttpAccess } from '../../http/access.js';
import { okEnvelope } from '../../http/errors.js';
import { responses } from '../../http/model.js';
import { literalUuidAt } from '../../http/request/path.js';
import { notReady, validationError } from '../../platform/errors.js';
import { invalidSkill, parseSkillFields, parseSkillFile, readSkillFile } from './import.js';
import {
  createPersonalSkill,
  disablePersonalSkill,
  getPersonalSkill,
  listPersonalSkills,
  updatePersonalSkill,
} from './public.js';

const root = '/api/v1/skills';
export const skillWriteScopes = [root] as const;
export function isSkillPatch(method: string, pathname: string) {
  return method === 'PATCH' && (pathname === root || pathname.startsWith(`${root}/`));
}

function skillId(path: string) {
  return literalUuidAt(path, 3, 'skill not found');
}

function isSkillFile(request: Request) {
  const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  return (
    mediaType === 'text/markdown' ||
    mediaType === 'text/plain' ||
    mediaType === 'application/octet-stream'
  );
}

export function createSkillController(pool: Pool | null, access: HttpAccess) {
  function db() {
    if (!pool) throw notReady();
    return pool;
  }
  const json = access.parser({ ready: db });
  const file = async ({ request }: { request: Request }) => {
    access.csrf(request, await access.requireActor(request));
    if (!isSkillFile(request)) throw invalidSkill('SKILL.md must be sent as a raw UTF-8 file');
    return readSkillFile(request);
  };

  return new Elysia({ name: 'skills', strictPath: true })
    .resolve({ as: 'local' }, async ({ request }) => ({
      actor: await access.requireActor(request),
      requestId: access.requestId(request),
    }))
    .get(
      root,
      async ({ actor, request, requestId }) =>
        okEnvelope(await listPersonalSkills(db(), actor.ownerId, queryOf(request)), requestId),
      { response: responses(SkillListPageSchema) },
    )
    .get(
      `${root}/:id`,
      async ({ actor, path, requestId }) =>
        okEnvelope(await getPersonalSkill(db(), actor.ownerId, skillId(path)), requestId),
      { response: responses(SkillDetailSchema) },
    )
    .post(
      `${root}/actions/preview-import`,
      ({ body, requestId }) => okEnvelope(parseSkillFile(body as string), requestId),
      { parse: file, response: responses(SkillImportPreviewSchema) },
    )
    .post(
      root,
      async ({ actor, body, request, requestId }) => {
        const key = idempotencyKeyOf(request);
        if (!key || key.length > 200) throw validationError('invalid idempotency key');
        const rawFile = isSkillFile(request) ? (body as string) : undefined;
        let input;
        if (rawFile !== undefined) {
          const { name, description, body } = parseSkillFile(rawFile);
          input = { name, description, body };
        } else input = parseSkillFields(SkillInputSchema, body);
        return okEnvelope(await createPersonalSkill(db(), actor, key, input, rawFile), requestId);
      },
      {
        parse: (context) => (isSkillFile(context.request) ? file(context) : json(context)),
        response: responses(SkillDetailSchema),
      },
    )
    .patch(
      `${root}/:id`,
      async ({ actor, body, path, requestId }) => {
        const id = skillId(path);
        const { expected_revision, ...input } = parseSkillFields(SkillUpdateSchema, body);
        return okEnvelope(
          await updatePersonalSkill(db(), actor, id, expected_revision, input),
          requestId,
        );
      },
      { parse: json, response: responses(SkillDetailSchema) },
    )
    .post(
      `${root}/:id/actions/disable`,
      async ({ actor, body, path, requestId }) => {
        const id = skillId(path);
        const { expected_revision } = parseSkillFields(SkillDisableSchema, body);
        return okEnvelope(
          await disablePersonalSkill(db(), actor, id, expected_revision),
          requestId,
        );
      },
      { parse: json, response: responses(SkillDetailSchema) },
    );
}
