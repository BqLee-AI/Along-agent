'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import * as api from '../model/http-gateway';
import {
  draftFrom,
  isDirty,
  validateDraft,
  type DraftField,
  type Provider,
  type ProviderDraft,
} from '../model/model-config';

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
export type TestState =
  | { kind: 'idle' }
  | { kind: 'testing' }
  | { kind: 'ok'; result: api.TestResult }
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
  const [load, setLoad] = useState<LoadState>({ kind: 'loading' });
  const [providers, setProviders] = useState<Provider[]>([]);
  const [selection, setSelection] = useState<api.Selection | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, ProviderDraft>>({});
  const [showErrors, setShowErrors] = useState(false);
  const [busy, setBusy] = useState<Busy>('idle');
  const [notice, setNotice] = useState<Notice>(null);
  const [test, setTest] = useState<TestState>({ kind: 'idle' });
  const [testModel, setTestModel] = useState('');
  const epoch = useRef(0);
  const read = useCallback(async () => {
    const mine = ++epoch.current;
    setLoad({ kind: 'loading' });
    try {
      const data = await api.listModelProviders();
      if (mine !== epoch.current) return;
      setProviders(data.items.map(fromApi));
      setSelection(data.default_selection);
      setSelectedId((current) =>
        data.items.some((item) => item.id === current) ? current : (data.items[0]?.id ?? null),
      );
      setDrafts({});
      setShowErrors(false);
      setNotice(null);
      setTest({ kind: 'idle' });
      setLoad({ kind: 'ready' });
    } catch (error) {
      if (mine === epoch.current) setLoad({ kind: 'failed', message: messageOf(error) });
    }
  }, []);
  useEffect(() => {
    void read();
    return () => {
      epoch.current += 1;
    };
  }, [read]);
  const selected = providers.find((item) => item.id === selectedId) ?? null;
  const draft = (selectedId && drafts[selectedId]) || draftFrom(selected);
  const errors = validateDraft(draft, selected);
  const dirty = isDirty(draft, selected);
  const working = busy !== 'idle';
  const replace = (value: api.Provider, resetDraft = false) => {
    const provider = fromApi(value);
    setProviders((list) => list.map((item) => (item.id === provider.id ? provider : item)));
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
      window.dispatchEvent(new Event('along:model-settings-changed'));
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
    setTest({ kind: 'idle' });
    setTestModel('');
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
    setTest({ kind: 'idle' });
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
      setTest({ kind: 'idle' });
    }
  };
  const runTest = async () => {
    if (!selectedId || working) return;
    setShowErrors(true);
    if (Object.keys(errors).length) return;
    setBusy('testing');
    setNotice(null);
    setTest({ kind: 'testing' });
    try {
      const result = await api.testProvider(selectedId, {
        base_url: draft.apiHost.trim(),
        credential: credential(draft, selected),
        ...(testModel.trim() ? { model_id: testModel.trim() } : {}),
      });
      setTest({ kind: 'ok', result });
    } catch (error) {
      setTest({ kind: 'failed', message: messageOf(error) });
    } finally {
      setBusy('idle');
    }
  };
  const reset = () => {
    if (!selectedId) return;
    setDrafts((all) => ({ ...all, [selectedId]: draftFrom(selected) }));
    setShowErrors(false);
    setNotice(null);
    setTest({ kind: 'idle' });
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
      setTest({ kind: 'idle' });
    }
  };
  const setEnabled = async (enabled: boolean) => {
    if (!selectedId) return;
    await run(
      'toggling',
      async () => {
        replace(await api.updateProvider(selectedId, { enabled }));
        if (!enabled)
          setSelection((current) => (current?.provider_id === selectedId ? null : current));
      },
      enabled ? '已启用。' : '已停用；该接入的默认模型已清除。',
    );
  };
  const addModel = async (id: string) =>
    selectedId
      ? run(
          'models',
          async () => {
            replace(await api.addModel(selectedId, id.trim()));
          },
          '已添加模型。',
        )
      : false;
  const removeModel = async (id: string) => {
    if (!selectedId) return;
    await run(
      'models',
      async () => {
        replace(await api.removeModel(selectedId, id));
        setTestModel((current) => (current === id ? '' : current));
        setTest({ kind: 'idle' });
        setSelection((current) =>
          current?.provider_id === selectedId && current.model_id === id ? null : current,
        );
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
  const addProvider = async (name: string) =>
    run(
      'adding',
      async () => {
        const provider = fromApi(await api.createProvider(name.trim()));
        setProviders((list) => [...list, provider]);
        setSelectedId(provider.id);
        setShowErrors(false);
        setTest({ kind: 'idle' });
        setTestModel('');
      },
      '接入已创建，请填写配置。',
    );
  const deleteProvider = async () => {
    if (!selectedId) return;
    await run(
      'deleting',
      async () => {
        await api.deleteProvider(selectedId);
        setProviders((list) => list.filter((item) => item.id !== selectedId));
        setSelectedId(null);
        setDrafts((all) => {
          const next = { ...all };
          delete next[selectedId];
          return next;
        });
        setSelection((current) => (current?.provider_id === selectedId ? null : current));
      },
      '接入已删除。',
    );
  };
  const setDefault = async (value: api.Selection | null) => {
    await run(
      'default',
      async () => {
        setSelection((await api.setDefault(value)).selection);
      },
      value ? '默认模型已设置。' : '默认模型已清除。',
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
    test,
    testModel,
    select,
    edit,
    save,
    reset,
    clearKey,
    runTest,
    setEnabled,
    addModel,
    removeModel,
    syncModels,
    addProvider,
    deleteProvider,
    setDefault,
    setTestModel: (value: string) => {
      setTestModel(value);
      setTest({ kind: 'idle' });
    },
    reload: read,
  };
}
