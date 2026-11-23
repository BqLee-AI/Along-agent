import { expect, it } from 'bun:test';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import type { RunView } from '@along/contracts';
import {
  useConversationTask,
  type ConversationTask,
} from '../src/features/conversations/viewmodel/use-conversation-task';
import { ModelCatalogProvider } from '../src/features/model-settings/viewmodel/model-catalog-context';

const conversationId = '11111111-1111-4111-8111-111111111111';
const queryRunId = '22222222-2222-4222-8222-222222222222';
const chatRunId = '33333333-3333-4333-8333-333333333333';
const providerId = '44444444-4444-4444-8444-444444444444';
const envelope = (data: unknown) => Response.json({ code: 0, msg: 'ok', request_id: 'test', data });
const goalResult = {
  status: 'completed',
  outcomes: [{ description: 'Answered', status: 'achieved', receipt_refs: [] }],
  clarification: null,
  answer: 'Answered.',
} satisfies RunView['goal_result'];

function completedStream(runId: string) {
  const identity = { conversation_id: conversationId, run_id: runId };
  const reply = [
    {
      type: 'thread.started',
      payload: {
        ...identity,
        stream_protocol_version: 'v2',
        ruleset_id: 'test',
        tzdb_version: 'test',
        authorization_revision: 'delegation/1',
        execution_lifecycle: 'server-owned',
      },
    },
    {
      type: 'thread.completed',
      payload: { ...identity, approval_id: null, goal_result: goalResult },
    },
  ];
  return new Response(
    reply
      .map(
        (event, index) =>
          `data: ${JSON.stringify({ ...event, protocol_version: 'v2', seq: index + 1, request_id: 'test' })}\n\n`,
      )
      .join(''),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}

it('submits only the explicit full-text query, preserves it on retry, and returns to ordinary chat', async () => {
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

  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  const sends: string[] = [];
  const firstResponse = Promise.withResolvers<Response>();
  const workspaceId = 'private-material';
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input), browser.location.origin);
    const path = url.pathname;
    requests.push(path);
    if (path === '/api/v1/model-providers') return envelope({ items: [], default_selection: null });
    if (path === '/api/v1/workspaces')
      return envelope({
        items: [
          {
            workspace_id: workspaceId,
            label: '私有资料',
            readable_paths: ['secret.md'],
            writable_paths: [],
          },
        ],
      });
    if (path === '/api/v1/me')
      return envelope({
        user: { id: conversationId, display_name: 'Test' },
        confirmed_timezone: 'Asia/Shanghai',
        csrf_token: 'test-token',
      });
    if (path === '/api/v1/conversations/messages' && init?.method === 'POST') {
      sends.push(String(init.body));
      if (sends.length === 1) return firstResponse.promise;
      return completedStream(sends.length === 2 ? queryRunId : chatRunId);
    }
    const base = `/api/v1/conversations/${conversationId}`;
    if (path === `${base}/runs` || path === `${base}/messages`)
      return envelope({ items: [], next_cursor: null });
    if (path === `${base}/runs/${queryRunId}` || path === `${base}/runs/${chatRunId}`)
      return envelope({
        conversation_id: conversationId,
        run_id: path.split('/').at(-1)!,
        execution: 'harness',
        authorization_revision: 'delegation/1',
        execution_lifecycle: 'server-owned',
        status: 'done',
        goal_result: goalResult,
        model_selection: { state: 'legacy_unavailable' },
        attempt_id: providerId,
        attempt_no: 1,
        waiting: null,
        can_resume: false,
      } satisfies RunView);
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;

  let task!: ConversationTask;
  let root: Root | undefined;
  function Consumer() {
    task = useConversationTask({});
    return null;
  }
  async function mount() {
    root = createRoot(document.createElement('div'));
    await act(async () => {
      root!.render(createElement(ModelCatalogProvider, { children: createElement(Consumer) }));
    });
  }

  try {
    await mount();
    await act(async () => task.setIntent('document'));
    expect(task.workspaceState).toBe('ready');
    await act(async () => {
      task.setWorkspaceId(workspaceId);
      task.setModelSelection({ provider_id: providerId, model_id: 'test-model' });
      task.setInput('处理私有资料');
    });
    expect(task.eligibility.allowed).toBe(true);
    const previousRequests = requests.length;

    await act(async () => task.setIntent('microsoft-learn'));
    for (const text of [' \t\n　', '𠮷'.repeat(501)]) {
      await act(async () => task.setInput(text));
      expect(task.eligibility.allowed).toBe(false);
      await act(async () => task.send());
    }
    const query = `  /compact 查询：${'𠮷'.repeat(482)}！\n\t `;
    expect([...query]).toHaveLength(500);
    await act(async () => task.setInput(query));
    expect(task.eligibility.allowed).toBe(true);
    expect(requests).toHaveLength(previousRequests);

    let firstSend!: Promise<void>;
    await act(async () => {
      firstSend = task.send();
    });
    expect(sends).toHaveLength(1);
    expect(JSON.parse(sends[0]!)).toEqual({
      raw_text: query,
      microsoft_learn_query: query,
      execution: 'harness',
      authorization_revision: 'delegation/1',
      model_selection: { provider_id: providerId, model_id: 'test-model' },
      idempotency_key: expect.any(String),
    });
    expect(task.intent).toBe('chat');
    expect(task.input).toBe('');
    await act(async () => {
      firstResponse.reject(new Error('response lost'));
      await firstSend;
    });
    expect(task.sendUncertain).toBe(true);

    await act(async () => root!.unmount());
    await mount();
    expect(task.intent).toBe('chat');
    expect(task.pendingMicrosoftLearnQuery).toBe(true);
    expect(sends).toHaveLength(1);
    await act(async () => task.send(true));
    expect(sends).toHaveLength(2);
    expect(sends[1]).toBe(sends[0]);
    expect(task.selected?.runId).toBe(queryRunId);
    expect(task.pendingMicrosoftLearnQuery).toBe(false);

    const chat = '再搜索一次';
    await act(async () => task.setInput(chat));
    await act(async () => task.send());
    expect(sends).toHaveLength(3);
    expect(JSON.parse(sends[2]!)).toEqual({
      raw_text: chat,
      conversation_id: conversationId,
      execution: 'harness',
      authorization_revision: 'delegation/1',
      idempotency_key: expect.any(String),
    });
  } finally {
    firstResponse.resolve(new Response());
    if (root) await act(async () => root?.unmount());
    await browser.happyDOM.close();
    for (const [key, original] of originals) {
      if (original) Object.defineProperty(globalThis, key, original);
      else Reflect.deleteProperty(globalThis, key);
    }
    globalThis.fetch = originalFetch;
  }
});
