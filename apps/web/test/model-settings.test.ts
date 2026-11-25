import { afterEach, describe, expect, it } from 'bun:test';
import {
  addModel,
  createProvider,
  deleteProvider,
  listModelProviders,
  removeModel,
  setDefault,
  syncModels,
  testConnection,
  testModel,
  updateProvider,
  type Provider,
} from '../src/features/model-settings/model/http-gateway';
import {
  canSetDefault,
  draftFrom,
  groupModels,
  isConfigured,
  isDirty,
  selectionAfterDefaultChange,
  validateModelId,
  validateDraft,
  type Provider as FormProvider,
} from '../src/features/model-settings/model/model-config';
import { availablePresets } from '../src/features/model-settings/model/provider-presets';
import {
  removeCatalogProvider,
  replaceCatalogProvider,
} from '../src/features/model-settings/model/model-catalog';

const provider: Provider = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Example',
  enabled: true,
  base_url: 'https://old.test/v1',
  has_api_key: true,
  key_hint: null,
  models: ['vendor/model'],
  default_model_id: null,
  model_context_windows: { 'vendor/model': null },
};
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
function envelope(data: unknown, status = 200) {
  return Response.json(
    {
      code: status === 200 ? 0 : status,
      data,
      msg: 'result',
      error:
        status === 200
          ? null
          : { code: 'STATE_CONFLICT', message: '配置已变化', request_id: 'req' },
      request_id: 'req',
    },
    { status },
  );
}
function installFetch(result: unknown, status = 200) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return String(url).endsWith('/me')
      ? envelope({
          user: { id: '00000000-0000-4000-8000-000000000001', display_name: 'User' },
          csrf_token: 'csrf',
          confirmed_timezone: null,
        })
      : envelope(result, status);
  }) as typeof fetch;
  return calls;
}

describe('model settings HTTP contract', () => {
  it('loads the list without credentials in browser storage', async () => {
    const calls = installFetch({ items: [provider], default_selection: null });
    expect(await listModelProviders()).toEqual({ items: [provider], default_selection: null });
    expect(calls[0]?.url).toBe('/api/v1/model-providers');
    expect(calls[0]?.init?.cache).toBe('no-store');
  });
  it('creates and deletes providers through their real write routes', async () => {
    const createCalls = installFetch(provider);
    await createProvider('Example');
    expect(createCalls[1]?.url).toBe('/api/v1/model-providers');
    expect(JSON.parse(String(createCalls[1]?.init?.body))).toEqual({ name: 'Example' });
    const deleteCalls = installFetch({ deleted: true });
    await deleteProvider(provider.id);
    expect(deleteCalls[1]?.url).toBe(`/api/v1/model-providers/${provider.id}/actions/delete`);
    expect(JSON.parse(String(deleteCalls[1]?.init?.body))).toEqual({});
  });
  it('sends CSRF and explicit credential actions on writes and draft tests', async () => {
    const calls = installFetch(provider);
    await updateProvider(provider.id, {
      base_url: 'https://new.test/v1',
      credential: { action: 'clear' },
    });
    expect(calls[1]?.url).toBe(`/api/v1/model-providers/${provider.id}/actions/update`);
    expect(new Headers(calls[1]?.init?.headers).get('x-csrf-token')).toBe('csrf');
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({
      base_url: 'https://new.test/v1',
      credential: { action: 'clear' },
    });
    const result = {
      text_stream: { status: 'passed', latency_ms: 1 },
      tool_round_trip: { status: 'not_tested', latency_ms: null },
      usage: { status: 'failed', latency_ms: 2 },
    } as const;
    const testCalls = installFetch(result);
    expect(
      await testModel(provider.id, {
        base_url: 'https://new.test/v1',
        credential: { action: 'replace', api_key: 'secret' },
        model_id: 'vendor/model',
      }),
    ).toEqual(result);
    expect(testCalls[1]?.url).toBe(`/api/v1/model-providers/${provider.id}/actions/test`);
    expect(new Headers(testCalls[1]?.init?.headers).get('x-csrf-token')).toBe('csrf');
    expect(JSON.parse(String(testCalls[1]?.init?.body))).toEqual({
      base_url: 'https://new.test/v1',
      credential: { action: 'replace', api_key: 'secret' },
      model_id: 'vendor/model',
    });
  });
  it('tests provider connectivity independently with draft credentials and validates the response', async () => {
    const result = { status: 'passed', latency_ms: 23 } as const;
    const calls = installFetch(result);
    const draft = { base_url: 'https://new.test/v1', credential: { action: 'clear' as const } };
    expect(await testConnection(provider.id, draft)).toEqual(result);
    expect(calls[1]?.url).toBe(`/api/v1/model-providers/${provider.id}/actions/test-connection`);
    expect(new Headers(calls[1]?.init?.headers).get('x-csrf-token')).toBe('csrf');
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual(draft);
    installFetch({ status: 'passed', latency_ms: null });
    await expect(testConnection(provider.id, draft)).rejects.toThrow();
    installFetch(null, 409);
    await expect(testConnection(provider.id, draft)).rejects.toThrow('配置已变化');
  });
  it('uses saved configuration for sync and preserves opaque IDs in request bodies', async () => {
    const syncCalls = installFetch({ provider, added_model_ids: ['vendor/model'] });
    await syncModels(provider.id);
    expect(JSON.parse(String(syncCalls[1]?.init?.body))).toEqual({});
    const calls = installFetch(provider);
    await addModel(provider.id, 'vendor/model', null);
    await removeModel(provider.id, 'vendor/model');
    expect(calls[3]?.url).toEndWith('/models/actions/remove');
    expect(JSON.parse(String(calls[3]?.init?.body))).toEqual({ model_id: 'vendor/model' });
  });
  it('sets and clears a provider default with the provider write route', async () => {
    const updated = { ...provider, default_model_id: 'vendor/model' };
    const calls = installFetch(updated);
    expect(await setDefault(provider.id, 'vendor/model')).toEqual(updated);
    expect(calls[1]?.url).toBe(`/api/v1/model-providers/${provider.id}/actions/default-model`);
    expect(new Headers(calls[1]?.init?.headers).get('x-csrf-token')).toBe('csrf');
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({ model_id: 'vendor/model' });
    const clearCalls = installFetch(provider);
    expect(await setDefault(provider.id, null)).toEqual(provider);
    expect(JSON.parse(String(clearCalls[1]?.init?.body))).toEqual({ model_id: null });
    installFetch(null, 409);
    await expect(setDefault(provider.id, null)).rejects.toThrow('配置已变化');
  });
  it('refuses mutations without a CSRF token', async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      calls.push(String(url));
      return envelope({
        user: { id: '00000000-0000-4000-8000-000000000001', display_name: 'User' },
        csrf_token: null,
        confirmed_timezone: null,
      });
    }) as typeof fetch;
    await expect(setDefault(provider.id, null)).rejects.toThrow('CSRF');
    expect(calls).toEqual(['/api/v1/me']);
  });
});

describe('model settings form helpers', () => {
  const formProvider: FormProvider = {
    id: 'p',
    name: 'Example',
    enabled: true,
    apiHost: 'https://example.test/v1',
    hasApiKey: true,
    models: ['a/one', 'a/two', 'plain'],
    defaultModelId: null,
    modelContextWindows: {},
  };

  it('finds presets by alias and excludes providers already added', () => {
    expect(availablePresets([], '智谱').map((item) => item.name)).toContain('智谱 BigModel');
    expect(availablePresets([{ ...formProvider, name: '智谱 BigModel' }], 'bigmodel')).toEqual([]);
    expect(availablePresets([], 'not-a-provider')).toEqual([]);
  });
  it('prefills an empty preset without replacing an existing address or credential', () => {
    const preset = { ...formProvider, name: 'Z.AI', apiHost: '', hasApiKey: false };
    expect(draftFrom(preset).apiHost).toBe('https://api.z.ai/api/paas/v4');
    expect(draftFrom({ ...preset, apiHost: 'https://custom.test/v1' }).apiHost).toBe(
      'https://custom.test/v1',
    );
    expect(draftFrom({ ...preset, hasApiKey: true }).apiHost).toBe('');
  });

  it('binds saved keys to their endpoint and requires a nonempty replacement', () => {
    const draft = draftFrom(formProvider);
    expect(validateDraft(draft, formProvider)).toEqual({});
    const changed = { ...draft, apiHost: 'https://new.test/v1' };
    expect(validateDraft(changed, formProvider).apiKey).toBeDefined();
    expect(validateDraft(changed, { ...formProvider, hasApiKey: false })).toEqual({});
    const replacement = { ...changed, credentialAction: 'replace' as const };
    expect(validateDraft(replacement, formProvider).apiKey).toBeDefined();
    expect(validateDraft({ ...replacement, apiKey: 'new' }, formProvider)).toEqual({});
    expect(validateDraft({ ...changed, credentialAction: 'clear' }, formProvider)).toEqual({});
  });

  it('compares the trimmed host and tracks explicit credential changes', () => {
    const draft = {
      apiHost: ` ${formProvider.apiHost} `,
      apiKey: '',
      credentialAction: 'keep' as const,
    };
    expect(isDirty(draft, formProvider)).toBe(false);
    expect(isDirty({ ...draft, apiKey: 'new', credentialAction: 'replace' }, formProvider)).toBe(
      true,
    );
    expect(isDirty({ ...draft, credentialAction: 'clear' }, formProvider)).toBe(true);
    expect(isConfigured(formProvider)).toBe(true);
    expect(isConfigured({ ...formProvider, apiHost: '' })).toBe(false);
    expect(isConfigured({ ...formProvider, hasApiKey: false })).toBe(true);
  });

  it('allows defaults only for models of an enabled provider with a saved endpoint', () => {
    const keyless = { ...formProvider, hasApiKey: false };
    expect(canSetDefault(keyless, 'a/one')).toBe(true);
    expect(canSetDefault(keyless, null)).toBe(true);
    expect(canSetDefault(keyless, 'other/model')).toBe(false);
    expect(canSetDefault({ ...keyless, apiHost: '' }, 'a/one')).toBe(false);
    expect(canSetDefault({ ...keyless, enabled: false }, 'a/one')).toBe(false);
    expect(canSetDefault({ ...keyless, models: [] }, null)).toBe(false);
  });

  it('updates the global selection without clearing another provider', () => {
    const other = { provider_id: 'other', model_id: 'model' };
    expect(selectionAfterDefaultChange(other, 'p', 'a/one')).toEqual({
      provider_id: 'p',
      model_id: 'a/one',
    });
    expect(selectionAfterDefaultChange(other, 'p', null)).toEqual(other);
    expect(
      selectionAfterDefaultChange({ provider_id: 'p', model_id: 'a/one' }, 'p', null),
    ).toBeNull();
  });

  it('validates model IDs and groups them by vendor prefix', () => {
    expect(validateModelId('', formProvider)).not.toBeNull();
    expect(validateModelId(' a/one ', formProvider)).not.toBeNull();
    expect(validateModelId('b/new', formProvider)).toBeNull();
    expect(groupModels(formProvider)).toEqual([
      { group: 'a', models: ['a/one', 'a/two'] },
      { group: 'Example', models: ['plain'] },
    ]);
  });
});

describe('shared saved model catalog', () => {
  it('updates the saved provider and global default together', () => {
    const snapshot = { items: [provider], default_selection: null };
    const updated = { ...provider, default_model_id: 'vendor/model' };
    const saved = replaceCatalogProvider(snapshot, updated, () => ({
      provider_id: provider.id,
      model_id: 'vendor/model',
    }));
    expect(saved.items[0]).toEqual(updated);
    expect(saved.default_selection).toEqual({ provider_id: provider.id, model_id: 'vendor/model' });
  });

  it('clears only the deleted provider default', () => {
    const selection = { provider_id: provider.id, model_id: 'vendor/model' };
    const snapshot = { items: [provider], default_selection: selection };
    expect(removeCatalogProvider(snapshot, 'another')).toEqual(snapshot);
    expect(removeCatalogProvider(snapshot, provider.id)).toEqual({
      items: [],
      default_selection: null,
    });
  });
});
