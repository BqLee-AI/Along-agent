import {
  ProviderListSchema,
  ProviderTestResultSchema,
  ProviderViewSchema,
  type ModelSelection,
  type ProviderUpdate as SharedProviderUpdate,
  type ProviderView,
} from '@along/contracts';
import { z } from 'zod';
import { readEnvelope } from '@/shared/http/client';
import { MeSchema } from '@/shared/session/identity';

export type Provider = ProviderView;
export type Selection = ModelSelection;
export type ProviderList = z.infer<typeof ProviderListSchema>;
export type TestResult = z.infer<typeof ProviderTestResultSchema>;
export type ProviderUpdate = SharedProviderUpdate;
export type Credential = NonNullable<ProviderUpdate['credential']>;
export type Draft = { base_url: string; credential: Credential };
const ConnectionResultSchema = z.object({ status: z.literal('passed'), latency_ms: z.number() });
export type ConnectionResult = z.infer<typeof ConnectionResultSchema>;

// A saved credential is bound to its saved endpoint, including for draft tests.
export function validateDraft(provider: Provider, draft: Draft): string | null {
  if (draft.base_url !== provider.base_url && draft.credential.action === 'keep')
    return '地址已更改，请替换 Key 或明确选择清除 Key，不能沿用旧地址的 Key。';
  if (draft.credential.action === 'replace' && !draft.credential.api_key)
    return '请输入用于替换的 Key，或选择保留／清除。';
  return null;
}

async function get(path: string): Promise<unknown> {
  return readEnvelope(await fetch(`/api/v1${path}`, { cache: 'no-store' }));
}
async function post(path: string, body: unknown): Promise<unknown> {
  const me = MeSchema.parse(await get('/me'));
  if (!me.csrf_token) throw new Error('当前会话没有 CSRF 凭据，请重新登录。');
  return readEnvelope(
    await fetch(`/api/v1${path}`, {
      method: 'POST',
      cache: 'no-store',
      headers: { 'content-type': 'application/json', 'x-csrf-token': me.csrf_token },
      body: JSON.stringify(body),
    }),
  );
}
const providerPath = (id: string) => `/model-providers/${encodeURIComponent(id)}`;
export async function listModelProviders() {
  return ProviderListSchema.parse(await get('/model-providers'));
}
export async function updateProvider(id: string, body: ProviderUpdate) {
  return ProviderViewSchema.parse(await post(`${providerPath(id)}/actions/update`, body));
}
export async function createProvider(name: string) {
  return ProviderViewSchema.parse(await post('/model-providers', { name }));
}
export async function deleteProvider(id: string) {
  return z
    .object({ deleted: z.literal(true) })
    .parse(await post(`${providerPath(id)}/actions/delete`, {}));
}
export async function syncModels(id: string) {
  return z
    .object({ provider: ProviderViewSchema, added_model_ids: z.array(z.string()) })
    .parse(await post(`${providerPath(id)}/models/actions/sync`, {}));
}
export async function addModel(id: string, model_id: string, context_window_tokens: number | null) {
  return ProviderViewSchema.parse(
    await post(`${providerPath(id)}/models`, { model_id, context_window_tokens }),
  );
}
export async function updateModelContextWindow(
  id: string,
  model_id: string,
  context_window_tokens: number | null,
) {
  return ProviderViewSchema.parse(
    await post(`${providerPath(id)}/models/actions/context-window`, {
      model_id,
      context_window_tokens,
    }),
  );
}
export async function removeModel(id: string, model_id: string) {
  return ProviderViewSchema.parse(
    await post(`${providerPath(id)}/models/actions/remove`, { model_id }),
  );
}
export async function testConnection(id: string, draft: Draft) {
  return ConnectionResultSchema.parse(
    await post(`${providerPath(id)}/actions/test-connection`, draft),
  );
}
export async function testModel(id: string, draft: Draft & { model_id: string }) {
  return ProviderTestResultSchema.parse(await post(`${providerPath(id)}/actions/test`, draft));
}
export async function setDefault(id: string, model_id: string | null) {
  return ProviderViewSchema.parse(
    await post(`${providerPath(id)}/actions/default-model`, { model_id }),
  );
}
