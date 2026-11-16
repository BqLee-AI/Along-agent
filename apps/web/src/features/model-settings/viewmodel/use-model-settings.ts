'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as api from '../model/http-gateway';
import { removeCatalogProvider, replaceCatalogProvider } from '../model/model-catalog';
import {
  canSetDefault,
  draftFrom,
  isDirty,
  selectionAfterDefaultChange,
  validateDraft,
  type DraftField,
  type Provider,
  type ProviderDraft,
} from '../model/model-config';
import { useModelCatalog } from './model-catalog-context';

export type LoadState =
  | { kind: 'loading' }
  | { kind: 'failed'; message: string }
  | { kind: 'ready' };
export type Busy =
  | 'idle'
  | 'saving'
  | 'clearing'
  | 'testing'
  | 'toggling'
  | 'syncing'
  | 'models'
  | 'adding'
  | 'deleting'
  | 'default';
export type Notice = { kind: 'ok' | 'failed'; message: string } | null;
export type TestState<T> =
  | { kind: 'idle' }
  | { kind: 'testing' }
  | { kind: 'ok'; result: T }
  | { kind: 'failed'; message: string };

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : '操作没有完成，请稍后再试。';
}
function fromApi(provider: api.Provider): Provider {
  return {
    id: provider.id,
    name: provider.name,
    enabled: provider.enabled,
    apiHost: provider.base_url,
    hasApiKey: provider.has_api_key,
    models: provider.models,
    defaultModelId: provider.default_model_id,
    modelContextWindows: provider.model_context_windows,
  };
}
function credential(draft: ProviderDraft, saved: Provider | null): api.Credential {
  if (draft.credentialAction === 'replace') return { action: 'replace', api_key: draft.apiKey };
  if (
    draft.credentialAction === 'keep' &&
    !saved?.hasApiKey &&
    draft.apiHost.trim() !== (saved?.apiHost ?? '')
  )
    return { action: 'clear' };
  return { action: draft.credentialAction };
}

export function useModelSettings() {
  const catalog = useModelCatalog();
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const publish = (change: Parameters<typeof catalog.update>[0]) => {
    if (mounted.current) catalog.update(change);
    else void catalog.refresh();
  };
  const providers = useMemo(() => catalog.snapshot.items.map(fromApi), [catalog.snapshot.items]);
  const selection = catalog.snapshot.default_selection;
  const load: LoadState =
    catalog.state === 'loading'
      ? { kind: 'loading' }
      : catalog.state === 'error'
        ? { kind: 'failed', message: catalog.error ?? '模型列表读取失败。' }
        : { kind: 'ready' };
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, ProviderDraft>>({});
  const [showErrors, setShowErrors] = useState(false);
  const [busy, setBusy] = useState<Busy>('idle');
  const [notice, setNotice] = useState<Notice>(null);
  const [connectionTest, setConnectionTest] = useState<TestState<api.ConnectionResult>>({
    kind: 'idle',
  });
  const [modelTests, setModelTests] = useState<Record<string, TestState<api.TestResult>>>({});
  const clearTests = useCallback(() => {
    setConnectionTest({ kind: 'idle' });
    setModelTests({});
  }, []);
  useEffect(() => {
    setSelectedId((current) =>
      providers.some((item) => item.id === current) ? current : (providers[0]?.id ?? null),
    );
  }, [providers]);
  const selected = providers.find((item) => item.id === selectedId) ?? null;
  const draft = (selectedId && drafts[selectedId]) || draftFrom(selected);
  const errors = validateDraft(draft, selected);
  const dirty = isDirty(draft, selected);
  const working = busy !== 'idle';
  const replace = (
    value: api.Provider,
    resetDraft = false,
    changeSelection: (current: api.Selection | null) => api.Selection | null = (current) => current,
  ) => {
    const provider = fromApi(value);
    publish((current) => replaceCatalogProvider(current, value, changeSelection));
    if (resetDraft) setDrafts((all) => ({ ...all, [provider.id]: draftFrom(provider) }));
  };
  const run = async (
    kind: Exclude<Busy, 'idle'>,
    action: () => Promise<void>,
    message: string,
  ): Promise<boolean> => {
    if (working) return false;
    setBusy(kind);
    setNotice(null);
    try {
      await action();
      setNotice({ kind: 'ok', message });
      return true;
    } catch (error) {
      setNotice({ kind: 'failed', message: messageOf(error) });
      return false;
    } finally {
      setBusy('idle');
    }
  };
  const select = (id: string) => {
    if (working) return;
    setSelectedId(id);
    setShowErrors(false);
    setNotice(null);
    clearTests();
  };
  const edit = (field: DraftField, value: string) => {
    if (!selectedId) return;
    setDrafts((all) => ({
      ...all,
      [selectedId]: {
        ...draft,
        [field]: value,
        ...(field === 'apiKey' ? { credentialAction: value ? 'replace' : 'keep' } : {}),
      },
    }));
    setNotice(null);
    clearTests();
  };
  const save = async () => {
    setShowErrors(true);
    if (!selectedId || Object.keys(errors).length) return;
    if (
      await run(
        'saving',
        async () => {
          replace(
            await api.updateProvider(selectedId, {
              base_url: draft.apiHost.trim(),
              credential: credential(draft, selected),
            }),
            true,
          );
        },
        '已保存。',
      )
    ) {
      setShowErrors(false);
      clearTests();
    }
  };
  const runTest = async (modelId?: string) => {
    if (!selectedId || working) return;
    setShowErrors(true);
    if (Object.keys(errors).length) return;
    setBusy('testing');
    setNotice(null);
    if (modelId) setModelTests((all) => ({ ...all, [modelId]: { kind: 'testing' } }));
    else setConnectionTest({ kind: 'testing' });
    try {
      const request = {
        base_url: draft.apiHost.trim(),
        credential: credential(draft, selected),
      };
      if (modelId) {
        const result = await api.testModel(selectedId, { ...request, model_id: modelId });
        setModelTests((all) => ({ ...all, [modelId]: { kind: 'ok', result } }));
      } else {
        const result = await api.testConnection(selectedId, request);
        setConnectionTest({ kind: 'ok', result });
      }
    } catch (error) {
      const state = { kind: 'failed' as const, message: messageOf(error) };
      if (modelId) setModelTests((all) => ({ ...all, [modelId]: state }));
      else setConnectionTest(state);
    } finally {
      setBusy('idle');
    }
  };
  const reset = () => {
    if (!selectedId) return;
    setDrafts((all) => ({ ...all, [selectedId]: draftFrom(selected) }));
    setShowErrors(false);
    setNotice(null);
    clearTests();
  };
  const clearKey = async () => {
    if (!selectedId) return;
    if (
      await run(
        'clearing',
        async () => {
          replace(await api.updateProvider(selectedId, { credential: { action: 'clear' } }));
          setDrafts((all) => ({
            ...all,
            [selectedId]: { ...draft, apiKey: '', credentialAction: 'keep' },
          }));
        },
        '密钥已清除。',
      )
    ) {
      setShowErrors(false);
      clearTests();
    }
  };
  const setEnabled = async (enabled: boolean) => {
    if (!selectedId) return;
    await run(
      'toggling',
      async () => {
        replace(await api.updateProvider(selectedId, { enabled }), false, (current) =>
          !enabled && current?.provider_id === selectedId ? null : current,
        );
      },
      enabled ? '已启用。' : '已停用；如为全局默认，已清除全局默认。',
    );
  };
  const addModel = async (id: string, contextWindow: number | null) =>
    selectedId
      ? run(
          'models',
          async () => {
            replace(await api.addModel(selectedId, id.trim(), contextWindow));
          },
          '已添加模型。',
        )
      : false;
  const updateModel = async (id: string, contextWindow: number | null) =>
    selectedId
      ? run(
          'models',
          async () => {
            replace(await api.updateModelContextWindow(selectedId, id, contextWindow));
          },
          '模型设置已保存。',
        )
      : false;
  const removeModel = async (id: string) => {
    if (!selectedId) return;
    await run(
      'models',
      async () => {
        replace(await api.removeModel(selectedId, id), false, (current) =>
          current?.provider_id === selectedId && current.model_id === id ? null : current,
        );
        setModelTests((all) => {
          const next = { ...all };
          delete next[id];
          return next;
        });
      },
      '已移除模型。',
    );
  };
  const syncModels = async () => {
    if (selectedId)
      await run(
        'syncing',
        async () => {
          replace((await api.syncModels(selectedId)).provider);
        },
        '模型已同步。',
      );
  };
  const addProvider = async (name: string, apiHost = '') =>
    run(
      'adding',
      async () => {
        const saved = await api.createProvider(name.trim());
        const provider = fromApi(saved);
        publish((current) => ({ ...current, items: [...current.items, saved] }));
        if (apiHost)
          setDrafts((all) => ({
            ...all,
            [provider.id]: { ...draftFrom(provider), apiHost },
          }));
        setSelectedId(provider.id);
        setShowErrors(false);
        clearTests();
      },
      '接入已创建，请填写配置。',
    );
  const deleteProvider = async () => {
    if (!selectedId) return;
    await run(
      'deleting',
      async () => {
        await api.deleteProvider(selectedId);
        publish((current) => removeCatalogProvider(current, selectedId));
        setSelectedId(null);
        setDrafts((all) => {
          const next = { ...all };
          delete next[selectedId];
          return next;
        });
      },
      '接入已删除。',
    );
  };
  const setDefault = async (modelId: string | null) => {
    if (!selectedId || !selected || !canSetDefault(selected, modelId)) return;
    await run(
      'default',
      async () => {
        const updated = await api.setDefault(selectedId, modelId);
        replace(updated, false, (current) =>
          selectionAfterDefaultChange(current, selectedId, modelId),
        );
      },
      modelId !== null ? '默认模型已设置。' : '默认模型已清除。',
    );
  };
  return {
    load,
    providers,
    selected,
    selection,
    draft,
    errors: showErrors ? errors : {},
    dirty,
    busy,
    working,
    notice,
    connectionTest,
    modelTests,
    select,
    edit,
    save,
    reset,
    clearKey,
    runTest,
    setEnabled,
    addModel,
    updateModel,
    removeModel,
    syncModels,
    addProvider,
    deleteProvider,
    setDefault,
    runModelTest: (id: string) => runTest(id),
    reload: catalog.refresh,
  };
}
