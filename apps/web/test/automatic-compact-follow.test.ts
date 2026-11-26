import { describe, expect, it } from 'bun:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import type { MessageHistoryItem, RunView } from '@along/contracts';
import {
  useConversationTask,
  type ConversationTask,
} from '../src/features/conversations/viewmodel/use-conversation-task';

const cid = '11111111-1111-4111-8111-111111111111';
const rid = '22222222-2222-4222-8222-222222222222';
const pid = '33333333-3333-4333-8333-333333333333';
const other = '44444444-4444-4444-8444-444444444444';
const envelope = (data: unknown) => Response.json({ code: 0, msg: 'ok', request_id: 'test', data });
const paused = (
  reason: 'user' | 'runtime',
  purpose: 'none' | 'manual_compact' | 'automatic_compact',
): RunView => ({
  run_id: rid,
  conversation_id: cid,
  execution: 'harness',
  model_selection: { state: 'legacy_unavailable' },
  status: 'paused',
  attempt_id: pid,
  attempt_no: 1,
  waiting: null,
  can_resume: false,
  execution_lifecycle: 'server-owned',
  pause: { pause_id: pid, reason, purpose, status: 'paused' },
});

type Selection = { conversationId: string; runId: string };
type HookHost = {
  readonly value: ConversationTask;
  readonly text: string;
  select: (selection: Selection) => Promise<void>;
  unmount: () => Promise<void>;
};
const timers = new Map<number, () => void>();
let nextTimer = -1;
async function advance() {
  await act(async () => {
    for (let i = 0; i < 40; i++) await Promise.resolve();
    const pending = [...timers.values()];
    timers.clear();
    for (const callback of pending) callback();
    for (let i = 0; i < 40; i++) await Promise.resolve();
  });
}

async function host(initial: Selection): Promise<HookHost> {
  let result!: ConversationTask;
  let alive = true;
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  function Consumer(props: Selection) {
    result = useConversationTask({ ...props, botId: other, toolIds: [], workspaceIds: [] });
    return createElement(
      'output',
      null,
      result.liveReply && result.selected
        ? (result.transcript.get(result.selected.runId)?.text ?? '')
        : '',
    );
  }
  await act(async () => {
    root.render(createElement(Consumer, initial));
  });
  return {
    get value() {
      return result;
    },
    get text() {
      return container.textContent ?? '';
    },
    async select(next) {
      await act(async () => {
        root.render(createElement(Consumer, next));
      });
    },
    async unmount() {
      if (!alive) return;
      alive = false;
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

async function until(predicate: () => boolean) {
  for (let i = 0; i < 150; i++) {
    if (predicate()) return;
    await advance();
  }
  throw new Error('consumer state did not arrive');
}

async function fixture(
  run: RunView,
  test: (f: {
    task: HookHost;
    calls: Array<{ url: string; method: string }>;
    setRun: (value: RunView) => void;
    complete: () => void;
    storage: Pick<Storage, 'getItem'>;
    publishArchive: (message: MessageHistoryItem) => void;
  }) => Promise<void>,
  stored?: string,
  pauseFirst = false,
) {
  const originalFetch = globalThis.fetch;
  const originalClearTimeout = globalThis.clearTimeout;
  timers.clear();
  globalThis.clearTimeout = ((id: number | string | NodeJS.Timeout | undefined) => {
    if (typeof id === 'number' && id < 0) timers.delete(id);
    else originalClearTimeout(id);
  }) as typeof clearTimeout;
  const browser = new Window({ url: 'http://web.test/conversations' });
  const globals = {
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    location: browser.location,
    sessionStorage: browser.sessionStorage,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const originals = new Map(
    Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  Object.defineProperty(browser, 'setTimeout', {
    configurable: true,
    value: (callback: () => void) => {
      const id = nextTimer--;
      timers.set(id, callback);
      return id;
    },
  });
  const storage = browser.sessionStorage;
  if (stored) storage.setItem(`conversation-compact:${cid}`, stored);
  let current: RunView = run;
  let archived: MessageHistoryItem | undefined;
  let terminalRunRead = false;
  let eventStream: ReadableStreamDefaultController<Uint8Array> | null = null;
  const complete = () => {
    current = { ...current, status: 'done', pause: null };
    if (eventStream) {
      eventStream.close();
      eventStream = null;
    }
  };
  const calls: Array<{ url: string; method: string }> = [];
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? 'GET' });
    if (url.includes('/events?')) {
      if (pauseFirst) {
        pauseFirst = false;
        current = paused('runtime', 'automatic_compact');
        return new Response('');
      }
      const event = {
        protocol_version: 'v1',
        seq: 1,
        type: 'message.delta',
        request_id: 'test',
        payload: { conversation_id: cid, run_id: rid, delta: '续跑回复' },
      };
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            eventStream = controller;
            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
          },
          cancel() {
            eventStream = null;
          },
        }),
      );
    }
    if (url.includes('/compacts/')) {
      current = { ...current, status: 'running', pause: null, attempt_no: 2 };
      return envelope({ status: 'continued', run_id: rid, pause_id: pid });
    }
    if (url.includes('/messages?'))
      return envelope({ items: terminalRunRead && archived ? [archived] : [], next_cursor: null });
    if (url.includes('/runs?')) return envelope({ items: [], next_cursor: null });
    if (url.includes(`/runs/${rid}`)) {
      if (current.status === 'done') terminalRunRead = true;
      return envelope(current);
    }
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;
  let task: HookHost | null = null;
  try {
    task = await host({ conversationId: cid, runId: rid });
    await test({
      task,
      calls,
      setRun: (value) => {
        current = value;
      },
      complete,
      storage,
      publishArchive: (message) => {
        archived = message;
      },
    });
  } finally {
    if (task) await task.unmount();
    complete();
    globalThis.fetch = originalFetch;
    globalThis.clearTimeout = originalClearTimeout;
    timers.clear();
    for (const [key, original] of originals) {
      if (original) Object.defineProperty(globalThis, key, original);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

describe('automatic compact view model', () => {
  it('tracks a runtime pause and shows the same Run’s resumed reply without sending again', async () => {
    const initial = paused('runtime', 'automatic_compact');
    await fixture(initial, async ({ task, calls, setRun, complete }) => {
      await until(() => task.value.run?.pause?.purpose === 'automatic_compact');
      setRun({ ...initial, status: 'running', pause: null, attempt_no: 2 });
      await until(() => task.value.transcript.get(rid)?.text === '续跑回复');
      expect(task.value.liveReply).toBe(true);
      expect(task.text).toBe('续跑回复');
      await act(async () => {
        complete();
      });
      await until(() => task.value.run?.status === 'done');
      expect(task.value.selected).toEqual({ conversationId: cid, runId: rid });
      expect(calls.filter((call) => call.url.includes('/events?'))).toHaveLength(1);
      expect(calls.filter((call) => call.method !== 'GET')).toHaveLength(0);
      await advance();
      expect(calls.filter((call) => call.url.includes('/events?'))).toHaveLength(1);
    });
  });

  it('keeps the released reply visible when the terminal archive is withheld', async () => {
    const initial: RunView = {
      ...paused('runtime', 'automatic_compact'),
      authorization_revision: 'delegation/1',
      goal_result: null,
      status: 'running',
      pause: null,
    };
    await fixture(initial, async ({ task, complete }) => {
      await until(() => task.text === '续跑回复');
      await act(async () => complete());
      await until(() => task.value.run?.status === 'done' && !task.value.reading);
      expect(task.value.messages).toEqual([]);
      expect(task.text).toBe('续跑回复');
    });
  });

  it('does not duplicate a reply when its archive appears after the Run read', async () => {
    const initial: RunView = {
      ...paused('runtime', 'automatic_compact'),
      authorization_revision: 'delegation/1',
      goal_result: null,
      status: 'running',
      pause: null,
    };
    await fixture(initial, async ({ task, complete, publishArchive }) => {
      await until(() => task.text === '续跑回复');
      await act(async () => {
        publishArchive({
          message_id: other,
          role: 'assistant',
          content: '续跑回复（归档）',
          created_at: '2026-11-20T00:00:00.000000Z',
          source_run_id: rid,
        });
        complete();
      });
      await until(() => task.value.run?.status === 'done' && !task.value.reading);
      expect(task.value.run?.goal_result).toBeNull();
      expect(task.value.messages[0]?.content).toBe('续跑回复（归档）');
      expect(task.value.liveReply).toBe(false);
    });
  });

  it('reconnects after an already-followed attempt enters automatic compact', async () => {
    const running: RunView = {
      ...paused('runtime', 'automatic_compact'),
      status: 'running',
      pause: null,
    };
    await fixture(
      running,
      async ({ task, calls, setRun }) => {
        await until(() => task.value.run?.pause?.purpose === 'automatic_compact');
        setRun({ ...running, attempt_no: 2 });
        await until(() => task.value.transcript.get(rid)?.text === '续跑回复');
        expect(calls.filter((call) => call.url.includes('/events?'))).toHaveLength(2);
        expect(calls.filter((call) => call.method !== 'GET')).toHaveLength(0);
      },
      undefined,
      true,
    );
  });

  it('refreshes a terminal automatic compact without trying to continue it', async () => {
    const initial = paused('runtime', 'automatic_compact');
    await fixture(initial, async ({ task, calls, setRun }) => {
      await until(() => task.value.run?.status === 'paused');
      setRun({ ...initial, status: 'failed', pause: null });
      await until(() => task.value.run?.status === 'failed');
      expect(
        calls.filter((call) => call.url.includes('/events?') || call.method !== 'GET'),
      ).toHaveLength(0);
    });
  });

  it('leaves a confirmed user pause for explicit user continuation', async () => {
    const initial = paused('user', 'none');
    await fixture(initial, async ({ task, calls, setRun }) => {
      await until(() => task.value.run?.pause?.reason === 'user');
      setRun({ ...initial, status: 'running', pause: null });
      await advance();
      expect(task.value.run?.status).toBe('paused');
      expect(
        calls.filter((call) => call.url.includes('/events?') || call.method !== 'GET'),
      ).toHaveLength(0);
    });
  });

  it('stops observing the old pause on selection change and unmount', async () => {
    for (const action of ['select', 'unmount'] as const) {
      await fixture(paused('runtime', 'automatic_compact'), async ({ task, calls }) => {
        await until(() => task.value.run?.pause?.purpose === 'automatic_compact');
        if (action === 'select') await task.select({ conversationId: other, runId: other });
        else await task.unmount();
        const before = calls.filter((call) => call.url.includes(`/runs/${rid}`)).length;
        await advance();
        expect(calls.filter((call) => call.url.includes(`/runs/${rid}`))).toHaveLength(before);
      });
    }
  });

  it('still follows a manually compacted Run after its continued receipt', async () => {
    const receipt = { status: 'pending', run_id: rid, pause_id: pid };
    const stored = JSON.stringify({ conversationId: cid, runId: rid, key: pid, receipt });
    await fixture(
      paused('runtime', 'manual_compact'),
      async ({ task, calls, storage }) => {
        await until(() => task.value.transcript.get(rid)?.text === '续跑回复');
        expect(task.value.compactStatus?.receipt?.status).toBe('continued');
        expect(storage.getItem(`conversation-compact:${cid}`)).toBeNull();
        expect(calls.filter((call) => call.method !== 'GET')).toHaveLength(0);
      },
      stored,
    );
  });
});
