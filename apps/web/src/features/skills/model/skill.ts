import {
  SKILL_FILE_MAX_BYTES,
  SkillDetailSchema,
  SkillImportPreviewSchema,
  SkillListPageSchema,
  SkillMetadataSchema,
  type SkillDetail,
  type SkillInput,
} from '@along/contracts';
import { z } from 'zod';
import { ApiReadError, readEnvelope } from '@/shared/http/client';
import { api, writeOptions, type ApiClient, type JsonResult } from '@/shared/http/eden';
import { MeSchema } from '@/shared/session/identity';

export const skillCatalogChanged = 'along:personal-skills-changed';

const BotSkillsSchema = z.object({ items: z.array(SkillMetadataSchema) }).strict();
const ErrorDetailsSchema = z.object({ fields: z.record(z.string()).optional() });
const SkillRejectionSchema = z.object({
  reason: z.enum(['SKILL_NOT_ASSIGNED', 'SKILL_DISABLED', 'SKILL_REVISION_CHANGED']),
});

export function skillAdmissionConflict(error: unknown): boolean {
  return (
    error instanceof ApiReadError &&
    error.status === 409 &&
    SkillRejectionSchema.safeParse(error.details).success
  );
}

export function skillFieldErrors(error: unknown): Record<string, string> {
  if (!(error instanceof ApiReadError) || error.status !== 422) return {};
  return ErrorDetailsSchema.safeParse(error.details).data?.fields ?? {};
}

export async function readSkills(
  cursor: string | null,
  signal: AbortSignal,
  client: ApiClient = api,
) {
  const result = await client.api.v1.skills.get({
    query: cursor === null ? {} : { cursor },
    fetch: { signal },
  });
  const page = SkillListPageSchema.parse(await readEnvelope(result));
  return { items: page.items, nextCursor: page.next_cursor };
}

export async function readBotSkills(botId: string, signal: AbortSignal, client: ApiClient = api) {
  const result = await client.api.v1.bots({ botId }).skills.get({ fetch: { signal } });
  return BotSkillsSchema.parse(await readEnvelope(result)).items;
}

async function readSkillDetail(result: JsonResult<SkillDetail>, id?: string) {
  const skill = SkillDetailSchema.parse(await readEnvelope(result));
  if (id && skill.id !== id) throw new Error('技能回执与原技能不匹配。');
  return skill;
}

export async function readSkill(id: string, signal: AbortSignal, client: ApiClient = api) {
  return readSkillDetail(await client.api.v1.skills({ id }).get({ fetch: { signal } }), id);
}

async function skillWriteOptions(client: ApiClient, signal: AbortSignal, key?: string) {
  const me = MeSchema.parse(await readEnvelope(await client.api.v1.me.get({ fetch: { signal } })));
  signal.throwIfAborted();
  return writeOptions(me.csrf_token, signal, key);
}

export async function previewSkillImport(
  file: Blob,
  signal: AbortSignal,
  client: ApiClient = api,
  request: typeof fetch = fetch,
) {
  if (!file.size || file.size > SKILL_FILE_MAX_BYTES)
    throw new Error('请选择非空且不超过 64 KiB 的 SKILL.md 文件。');
  const { headers } = await skillWriteOptions(client, signal);
  // Send original bytes so server-side UTF-8 validation can reject malformed files.
  const response = await request('/api/v1/skills/actions/preview-import', {
    method: 'POST',
    headers: { ...headers, 'content-type': 'text/markdown' },
    credentials: 'same-origin',
    cache: 'no-store',
    signal,
    body: file,
  });
  return SkillImportPreviewSchema.parse(await readEnvelope(response));
}

export async function createSkill(
  input: SkillInput,
  key: string,
  signal: AbortSignal,
  client: ApiClient = api,
) {
  const options = await skillWriteOptions(client, signal, key);
  return readSkillDetail(await client.api.v1.skills.post(input, options));
}

export async function updateSkill(
  id: string,
  revision: number,
  input: SkillInput,
  signal: AbortSignal,
  client: ApiClient = api,
) {
  const options = await skillWriteOptions(client, signal);
  const result = await client.api.v1
    .skills({ id })
    .patch({ ...input, expected_revision: revision }, options);
  return readSkillDetail(result, id);
}

export async function disableSkill(
  id: string,
  revision: number,
  signal: AbortSignal,
  client: ApiClient = api,
) {
  const options = await skillWriteOptions(client, signal);
  const result = await client.api.v1
    .skills({ id })
    .actions.disable.post({ expected_revision: revision }, options);
  return readSkillDetail(result, id);
}
