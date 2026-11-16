'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { listModelProviders } from '../model/http-gateway';
import type { ModelCatalogSnapshot } from '../model/model-catalog';

type Catalog = {
  snapshot: ModelCatalogSnapshot;
  state: 'loading' | 'ready' | 'error';
  error: string | null;
  refresh: () => Promise<void>;
  update: (change: (snapshot: ModelCatalogSnapshot) => ModelCatalogSnapshot) => void;
};

const ModelCatalogContext = createContext<Catalog | null>(null);
const emptySnapshot: ModelCatalogSnapshot = { items: [], default_selection: null };

export function ModelCatalogProvider({ children }: { children: ReactNode }) {
  const [snapshot, setSnapshot] = useState<ModelCatalogSnapshot>(emptySnapshot);
  const [state, setState] = useState<Catalog['state']>('loading');
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const mounted = useRef(false);
  const refresh = useCallback(async () => {
    if (!mounted.current) return;
    const request = ++generation.current;
    setState('loading');
    setError(null);
    try {
      const data = await listModelProviders();
      if (!mounted.current || request !== generation.current) return;
      setSnapshot(data);
      setState('ready');
    } catch (failure) {
      if (!mounted.current || request !== generation.current) return;
      setState('error');
      setError(failure instanceof Error ? failure.message : '模型列表读取失败。');
    }
  }, []);
  const update = useCallback((change: (current: ModelCatalogSnapshot) => ModelCatalogSnapshot) => {
    generation.current++;
    setSnapshot(change);
    setState('ready');
    setError(null);
  }, []);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
      generation.current++;
    };
  }, [refresh]);
  return (
    <ModelCatalogContext value={{ snapshot, state, error, refresh, update }}>
      {children}
    </ModelCatalogContext>
  );
}

export function useModelCatalog(): Catalog {
  const catalog = useContext(ModelCatalogContext);
  if (!catalog) throw new Error('ModelCatalogProvider is required');
  return catalog;
}
