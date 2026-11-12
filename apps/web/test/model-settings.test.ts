import { afterEach, describe, expect, it } from 'bun:test';
import {
  addModel,
  createProvider,
  deleteProvider,
  listModelProviders,
  removeModel,
  setDefault,
  syncModels,
  testProvider,
  updateProvider,
  validateDraft,
  type Provider,
} from '../src/features/model-settings/model/http-gateway';
import {
  validateDraft as validateFormDraft,
  type Provider as FormProvider,
} from '../src/features/model-settings/model/model-config';

const provider: Provider = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Example',
  enabled: true,
  base_url: 'https://old.test/v1',
  has_api_key: true,
  key_hint: null,
  models: ['vendor/model'],
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
  it('allows a new keyless endpoint but never carries a saved key to a changed address', () => {
    const saved: FormProvider = {
      id: provider.id,
      name: provider.name,
      enabled: true,
      apiHost: provider.base_url,
      hasApiKey: true,
      models: [],
    };
    const changed = {
      apiHost: 'https://new.test/v1',
      apiKey: '',
      credentialAction: 'keep' as const,
    };
    expect(validateFormDraft(changed, saved).apiKey).toBeDefined();
    expect(validateFormDraft(changed, { ...saved, hasApiKey: false })).toEqual({});
    expect(
      validateFormDraft({ ...changed, apiKey: 'replacement', credentialAction: 'replace' }, saved),
    ).toEqual({});
    expect(validateFormDraft({ ...changed, credentialAction: 'clear' }, saved)).toEqual({});
  });
  it('requires an explicit replacement or clearing when the draft address changes', () => {
    expect(
      validateDraft(provider, { base_url: provider.base_url, credential: { action: 'keep' } }),
    ).toBeNull();
    expect(
      validateDraft(provider, { base_url: 'https://new.test/v1', credential: { action: 'keep' } }),
    ).not.toBeNull();
    expect(
      validateDraft(provider, {
        base_url: 'https://new.test/v1',
        credential: { action: 'replace', api_key: '' },
      }),
    ).not.toBeNull();
    expect(
      validateDraft(provider, {
        base_url: 'https://new.test/v1',
        credential: { action: 'replace', api_key: 'new' },
      }),
    ).toBeNull();
    expect(
      validateDraft(provider, { base_url: 'https://new.test/v1', credential: { action: 'clear' } }),
    ).toBeNull();
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
      await testProvider(provider.id, {
        base_url: 'https://new.test/v1',
        credential: { action: 'replace', api_key: 'secret' },
        model_id: 'vendor/model',
      }),
    ).toEqual(result);
    expect(JSON.parse(String(testCalls[1]?.init?.body))).toEqual({
      base_url: 'https://new.test/v1',
      credential: { action: 'replace', api_key: 'secret' },
      model_id: 'vendor/model',
    });
  });
  it('uses saved configuration for sync and preserves opaque IDs in request bodies', async () => {
    const syncCalls = installFetch({ provider, added_model_ids: ['vendor/model'] });
    await syncModels(provider.id);
    expect(JSON.parse(String(syncCalls[1]?.init?.body))).toEqual({});
    const calls = installFetch(provider);
    await addModel(provider.id, 'vendor/model');
    await removeModel(provider.id, 'vendor/model');
    expect(calls[3]?.url).toEndWith('/models/actions/remove');
    expect(JSON.parse(String(calls[3]?.init?.body))).toEqual({ model_id: 'vendor/model' });
  });
  it('clears the default explicitly and surfaces conflict responses', async () => {
    const calls = installFetch({ selection: null });
    await setDefault(null);
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({ selection: null });
    installFetch(null, 409);
    await expect(syncModels(provider.id)).rejects.toThrow('配置已变化');
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
    await expect(setDefault(null)).rejects.toThrow('CSRF');
    expect(calls).toEqual(['/api/v1/me']);
  });
});
