'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { WorkspaceSummary } from '@along/contracts';
import type { TaskIntent } from '../model/task';
import { readWorkspaceRegistration } from '../model/workspace-registration';

export function useWorkspaceRegistration(
  intent: TaskIntent,
  setWorkspaceId: Dispatch<SetStateAction<string>>,
) {
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [workspaceState, setWorkspaceState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  const mounted = useRef(false);

  const readWorkspaces = useCallback(async () => {
    requestRef.current?.abort();
    const request = new AbortController();
    requestRef.current = request;
    setWorkspaceState('loading');
    setWorkspaceError(null);
    try {
      const items = await readWorkspaceRegistration(request.signal);
      if (!mounted.current || request.signal.aborted) return;
      setWorkspaces(items);
      setWorkspaceState('ready');
      setWorkspaceId((id) => (items.some((item) => item.workspace_id === id) ? id : ''));
    } catch (failure) {
      if (!mounted.current || request.signal.aborted) return;
      setWorkspaceState('error');
      setWorkspaceError(failure instanceof Error ? failure.message : '资料登记读取失败。');
    }
  }, [setWorkspaceId]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      requestRef.current?.abort();
      requestRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (intent === 'document' && !requestRef.current) void readWorkspaces();
  }, [intent, readWorkspaces]);

  return { workspaces, workspaceState, workspaceError, readWorkspaces };
}
