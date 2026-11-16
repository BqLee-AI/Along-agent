import { afterEach, describe, expect, it } from 'bun:test';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import {
  ModelCatalogProvider,
  useModelCatalog,
} from '../src/features/model-settings/viewmodel/model-catalog-context';
import { useModelSettings } from '../src/features/model-settings/viewmodel/use-model-settings';

const providerId = '11111111-1111-4111-8111-111111111111';
const originalFetch = globalThis.fetch;
const provider = {
  id: providerId,
  name: 'Test',
  enabled: true,
  base_url: 'https://old.example',
  has_api_key: false,
  key_hint: null,
  models: [],
  default_model_id: null,
  model_context_windows: {},
};
const envelope = (data: unknown) =>
  Response.json({ code: 0, data, msg: 'ok', error: null, request_id: 'test' });
let root: Root | undefined;
let browser: Window | undefined;
let originals = new Map<string, PropertyDescriptor | undefined>();
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  await browser?.happyDOM.close();
  browser = undefined;
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  originals = new Map();
  globalThis.fetch = originalFetch;
});

describe('model catalog across settings lifetimes', () => {
  it.each(['before', 'after'] as const)(
    'reconciles when the old save commits %s the new save',
    async (oldCommit) => {
      browser = new Window({ url: 'http://web.test/' });
      const globals = {
        window: browser,
        document: browser.document,
        navigator: browser.navigator,
        IS_REACT_ACT_ENVIRONMENT: true,
      };
      originals = new Map(
        Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
      );
      for (const [key, value] of Object.entries(globals))
        Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
      root = createRoot(document.createElement('div'));
      let saved = { ...provider };
      const firstResponse = Promise.withResolvers<Response>();
      let updates = 0;
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/me'))
          return envelope({
            user: { id: providerId, display_name: 'User' },
            csrf_token: 'csrf',
            confirmed_timezone: null,
          });
        if (url.endsWith('/model-providers'))
          return envelope({ items: [saved], default_selection: null });
        if (url.endsWith('/actions/update')) {
          const body = JSON.parse(String(init?.body));
          saved = { ...saved, base_url: body.base_url };
          const response = envelope(saved);
          if (++updates === 1) return firstResponse.promise;
          return response;
        }
        throw new Error(`Unexpected request: ${url}`);
      }) as typeof fetch;
      let vm!: ReturnType<typeof useModelSettings>;
      let visibleHost = '';
      function Settings() {
        vm = useModelSettings();
        return null;
      }
      function Consumer({ children }: { children?: ReactNode }) {
        visibleHost = useModelCatalog().snapshot.items[0]?.base_url ?? '';
        return children;
      }
      const tree = (key: string) =>
        createElement(
          ModelCatalogProvider,
          null,
          createElement(Consumer, null, createElement(Settings, { key })),
        );
      await act(async () => {
        root!.render(tree('first'));
      });
      await act(async () => {
        vm.edit('apiHost', 'https://first.example');
      });
      let first!: Promise<void>;
      await act(async () => {
        first = vm.save();
        await Promise.resolve();
      });
      await act(async () => {
        root!.render(tree('second'));
      });
      await act(async () => {
        vm.edit('apiHost', 'https://second.example');
      });
      await act(async () => {
        await vm.save();
      });
      expect(visibleHost).toBe('https://second.example');
      await act(async () => {
        vm.edit('apiHost', 'https://unsaved.example');
      });
      if (oldCommit === 'after') saved = { ...saved, base_url: 'https://first.example' };
      await act(async () => {
        firstResponse.resolve(envelope({ ...provider, base_url: 'https://first.example' }));
        await first;
      });
      expect(visibleHost).toBe(
        oldCommit === 'before' ? 'https://second.example' : 'https://first.example',
      );
      expect(vm.draft.apiHost).toBe('https://unsaved.example');
    },
  );
});
