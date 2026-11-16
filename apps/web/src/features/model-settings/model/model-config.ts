import type { Selection } from './http-gateway';
import { providerPresets } from './provider-presets';

export interface Provider {
  id: string;
  name: string;
  enabled: boolean;
  apiHost: string;
  hasApiKey: boolean;
  models: string[];
  defaultModelId: string | null;
  modelContextWindows: Record<string, number | null>;
}

export interface ProviderDraft {
  apiHost: string;
  apiKey: string;
  credentialAction: 'keep' | 'replace' | 'clear';
}
export type DraftField = keyof ProviderDraft;
export type DraftErrors = Partial<Record<DraftField, string>>;
export type DefaultSelection = Selection | null;

export function draftFrom(provider: Provider | null): ProviderDraft {
  const preset = providerPresets.find((item) => item.name === provider?.name);
  return {
    apiHost: provider?.apiHost || (!provider?.hasApiKey ? (preset?.apiHost ?? '') : ''),
    apiKey: '',
    credentialAction: 'keep',
  };
}
export function isConfigured(provider: Provider): boolean {
  return Boolean(provider.apiHost);
}
export function canSetDefault(provider: Provider, modelId: string | null): boolean {
  return (
    provider.enabled &&
    isConfigured(provider) &&
    provider.models.length > 0 &&
    (modelId === null || provider.models.includes(modelId))
  );
}
export function selectionAfterDefaultChange(
  current: DefaultSelection,
  providerId: string,
  modelId: string | null,
): DefaultSelection {
  return modelId !== null
    ? { provider_id: providerId, model_id: modelId }
    : current?.provider_id === providerId
      ? null
      : current;
}
export function validateDraft(draft: ProviderDraft, saved: Provider | null): DraftErrors {
  const errors: DraftErrors = {};
  if (
    draft.apiHost.trim() !== (saved?.apiHost ?? '') &&
    saved?.hasApiKey &&
    draft.credentialAction === 'keep'
  )
    errors.apiKey = '地址已更改，请替换或清除密钥，不能沿用旧地址的密钥。';
  else if (draft.credentialAction === 'replace' && !draft.apiKey)
    errors.apiKey = '请输入用于替换的密钥。';
  return errors;
}
export function isDirty(draft: ProviderDraft, saved: Provider | null): boolean {
  return draft.apiHost.trim() !== (saved?.apiHost ?? '') || draft.credentialAction !== 'keep';
}
export function validateModelId(modelId: string, provider: Provider): string | null {
  const id = modelId.trim();
  if (!id) return '请填写模型 ID。';
  if (provider.models.includes(id)) return '这个模型已经在列表里了。';
  return null;
}
export function groupModels(provider: Provider): { group: string; models: string[] }[] {
  const groups = new Map<string, string[]>();
  for (const id of provider.models) {
    const slash = id.indexOf('/');
    const group = slash > 0 ? id.slice(0, slash) : provider.name;
    const models = groups.get(group) ?? [];
    models.push(id);
    groups.set(group, models);
  }
  return [...groups].map(([group, models]) => ({ group, models }));
}
export function modelLabel(modelId: string): string {
  const slash = modelId.indexOf('/');
  return slash > 0 ? modelId.slice(slash + 1) : modelId;
}
