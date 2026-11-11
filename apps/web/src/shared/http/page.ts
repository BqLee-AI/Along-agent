import type { z } from 'zod';
import { readEnvelope } from './client';
export async function readHistoryCollectionPage<T>(
  url: string,
  schema: z.ZodType<{ items: T[]; next_cursor: string | null }>,
  signal?: AbortSignal,
): Promise<{ items: T[]; next_cursor: string | null }> {
  const response = await fetch(url, { method: 'GET', cache: 'no-store', signal });
  return schema.parse(await readEnvelope(response));
}
export interface HistoryPageState<T> {
  target: string;
  request: number;
  items: T[];
  nextCursor: string | null;
  loaded: boolean;
  reading: boolean;
  resetting: boolean;
  error: string | null;
}

export type HistoryPageAction<T> =
  | { type: 'start'; target: string; request: number; reset: boolean }
  | { type: 'success'; target: string; request: number; items: T[]; nextCursor: string | null }
  | { type: 'failure'; target: string; request: number; error: string };

export function initialHistoryPage<T>(target: string): HistoryPageState<T> {
  return {
    target,
    request: 0,
    items: [],
    nextCursor: null,
    loaded: false,
    reading: false,
    resetting: false,
    error: null,
  };
}

// Each resource has its own reducer and request identity. Failed pages never
// advance a cursor; stale reads cannot replace a newly selected URL's facts.
export function historyPageReducer<T>(
  state: HistoryPageState<T>,
  action: HistoryPageAction<T>,
): HistoryPageState<T> {
  if (action.type === 'start') {
    const current = state.target === action.target ? state : initialHistoryPage<T>(action.target);
    return {
      ...current,
      request: action.request,
      reading: true,
      resetting: action.reset,
      error: null,
    };
  }
  if (state.target !== action.target || state.request !== action.request) return state;
  if (action.type === 'failure') return { ...state, reading: false, error: action.error };
  return {
    ...state,
    items: state.resetting ? action.items : [...state.items, ...action.items],
    nextCursor: action.nextCursor,
    loaded: true,
    reading: false,
    error: null,
  };
}
