import { describe, expect, it } from 'bun:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import {
  botHref,
  createBotConversation,
  readBotConversations,
  readBots,
  readSelectedBot,
  saveBot,
  type PersonalBot,
} from '../src/features/conversations/model/personal-bot';
import {
  useConversationTask,
  type ConversationTask,
} from '../src/features/conversations/viewmodel/use-conversation-task';
import { createBrowserApi } from '../src/shared/http/eden';

const a = '11111111-1111-4111-8111-111111111111';
const b = '22222222-2222-4222-8222-222222222222';
const cid = '33333333-3333-4333-8333-333333333333';
const secondCid = '44444444-4444-4444-8444-444444444444';
const key = '55555555-5555-4555-8555-555555555555';
const me = { user: { id: b, display_name: 'Owner' }, csrf_token: 'csrf', confirmed_timezone: null };
const empty = { items: [], next_cursor: null };
const scope = {
  introduction: '简介',
  role: '角色',
  instructions: '行为指令',
  model_selection: null,
  tool_ids: [],
  workspace_ids: [],
};
const botA: PersonalBot = { id: a, revision: 1, config: { name: 'Alpha', ...scope } };
const botB: PersonalBot = { id: b, revision: 1, config: { name: 'Beta', ...scope } };
const base = 'http://bots.test';
const signal = () => new AbortController().signal;
const ok = (data: unknown) =>
  Response.json({ code: 0, data, msg: 'ok', error: null, request_id: 'web-bots' });
const rejected = (status: number, code: string) =>
  Response.json(
    {
      code: status,
      data: null,
      msg: 'failed',
      error: { code, message: 'rejected', request_id: 'web-bots' },
      request_id: 'web-bots',
    },
    { status },
  );

function listing(id: string) {
  return {
    conversation_id: id,
    status: 'open',
    title: '',
    title_message_id: null,
    created_at: '2026-11-26T12:00:00.000000Z',
    last_activity_at: null,
  };
}

describe('Bot navigation and settings over the Web proxy', () => {
  it('reads old-style deep links by an authenticated parent lookup, and refuses a mismatched explicit parent', async () => {
    const requests: string[] = [];
    const client = createBrowserApi(async (input, init) => {
      expect(init?.method).toBe('GET');
      const url = String(input);
      requests.push(url);
      if (url === `/api/v1/conversations/${cid}/bot`) return ok({ bot_id: a });
      if (url === `/api/v1/bots/${a}`) return ok(botA);
      throw new Error(`unexpected request: ${url}`);
    });
    await expect(readSelectedBot(null, cid, signal(), client)).resolves.toEqual(botA);
    await expect(readSelectedBot(b, cid, signal(), client)).rejects.toThrow(
      '此会话不属于所选的 Bot',
    );
    expect(requests).toEqual([
      `/api/v1/conversations/${cid}/bot`,
      `/api/v1/bots/${a}`,
      `/api/v1/conversations/${cid}/bot`,
    ]);
    expect(botHref(a, cid)).toBe(`/conversations?bot_id=${a}&conversation_id=${cid}`);
  });

  it('scopes every history page to the selected Bot, forwarding the opaque cursor and abort signal', async () => {
    const pageCursor = 'opaque+cursor/=& ?';
    const controller = new AbortController();
    const calls: [string, string | null][] = [];
    const client = createBrowserApi(async (input, init) => {
      const url = new URL(String(input), base);
      const cursor = url.searchParams.get('cursor');
      calls.push([url.pathname, cursor]);
      expect(init?.method).toBe('GET');
      expect(init?.signal).toBe(controller.signal);
      if (url.pathname === `/api/v1/bots/${a}/conversations`) {
        return ok(
          cursor
            ? { ...empty, items: [listing(secondCid)] }
            : { items: [listing(cid)], next_cursor: pageCursor },
        );
      }
      if (url.pathname === `/api/v1/bots/${b}/conversations`) return ok(empty);
      throw new Error(`unexpected request: ${url}`);
    });
    const first = await readBotConversations(a, null, controller.signal, client);
    expect(first.items.map((item) => item.conversation_id)).toEqual([cid]);
    const next = await readBotConversations(a, first.next_cursor, controller.signal, client);
    expect(next.items.map((item) => item.conversation_id)).toEqual([secondCid]);
    expect(await readBotConversations(b, null, controller.signal, client)).toEqual(empty);
    expect(calls).toEqual([
      [`/api/v1/bots/${a}/conversations`, null],
      [`/api/v1/bots/${a}/conversations`, pageCursor],
      [`/api/v1/bots/${b}/conversations`, null],
    ]);
  });

  it('only creates an empty conversation on explicit submit and keeps the same key for a deliberate retry', async () => {
    const posts: string[] = [];
    const client = createBrowserApi(async (input, init) => {
      const url = String(input);
      if (url === '/api/v1/me') return ok(me);
      if (url === `/api/v1/bots/${a}/conversations?limit=20` && init?.method === 'GET')
        return ok(empty);
      if (url !== `/api/v1/bots/${a}/conversations` || init?.method !== 'POST')
        throw new Error(`unexpected request: ${url}`);
      expect(JSON.parse(String(init.body))).toEqual({});
      const headers = new Headers(init.headers);
      expect(headers.get('x-csrf-token')).toBe('csrf');
      posts.push(headers.get('idempotency-key') ?? 'missing');
      if (posts.length === 1) throw new Error('connection interrupted after send');
      return ok({ conversation_id: cid });
    });
    await readBotConversations(a, null, signal(), client);
    expect(posts).toEqual([]);
    await expect(createBotConversation(a, key, signal(), client)).rejects.toThrow(
      'connection interrupted',
    );
    expect(posts).toEqual([key]);
    await expect(createBotConversation(a, key, signal(), client)).resolves.toBe(cid);
    expect(posts).toEqual([key, key]);
  });

  it('writes a complete config with the edited Bot revision, never updating or replaying through another Bot', async () => {
    let alpha = botA;
    let writes = 0;
    const client = createBrowserApi(async (input, init) => {
      const url = String(input);
      if (url === '/api/v1/me') return ok(me);
      if (url === '/api/v1/bots' && init?.method === 'GET') return ok({ items: [alpha, botB] });
      if (url === `/api/v1/bots/${a}` && init?.method === 'POST') {
        writes++;
        expect(new Headers(init.headers).get('x-csrf-token')).toBe('csrf');
        const { revision, ...config } = JSON.parse(String(init.body));
        if (revision !== alpha.revision) return rejected(409, 'STATE_CONFLICT');
        alpha = { id: a, revision: revision + 1, config };
        return ok(alpha);
      }
      throw new Error(`unexpected request: ${url}`);
    });
    const config = {
      ...botA.config,
      role: '另一个角色',
      model_selection: { provider_id: b, model_id: 'chosen' },
      tool_ids: ['workspace_read'],
      workspace_ids: [key],
    };
    await expect(saveBot(botA, config, signal(), client)).resolves.toEqual({
      id: a,
      config,
      revision: 2,
    });
    await expect(saveBot(botA, botA.config, signal(), client)).rejects.toMatchObject({
      status: 409,
    });
    expect(writes).toBe(2);
    expect((await readBots(null, signal(), client)).items).toEqual([alpha, botB]);
  });
});

it('loads an empty existing conversation with GET and sends the first message only on explicit submit', async () => {
  const browser = new Window({ url: `${base}${botHref(a, cid)}` });
  const globals = {
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    location: browser.location,
    sessionStorage: browser.sessionStorage,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const original = new Map(
    Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const oldFetch = globalThis.fetch;
  const submitted: Record<string, unknown>[] = [];
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input), base);
    if (init?.method === 'POST' && url.pathname === '/api/v1/conversations/messages') {
      submitted.push(JSON.parse(String(init.body)));
      return rejected(403, 'FORBIDDEN');
    }
    if (url.pathname === '/api/v1/me') return ok(me);
    if (
      url.pathname === `/api/v1/conversations/${cid}/runs` ||
      url.pathname === `/api/v1/conversations/${cid}/messages`
    )
      return ok(empty);
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;
  const root = createRoot(document.createElement('div'));
  let task!: ConversationTask;
  function Consumer() {
    task = useConversationTask({ botId: a, conversationId: cid, workspaceIds: [], toolIds: [] });
    return null;
  }
  try {
    await act(async () => {
      root.render(createElement(Consumer));
    });
    expect(task.reading).toBe(false);
    expect(task.messages).toEqual([]);
    expect(task.runs).toEqual([]);
    await act(async () => {
      task.setInput('第一条消息');
    });
    expect(submitted).toEqual([]);
    await act(async () => {
      await task.send();
    });
    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toMatchObject({ conversation_id: cid, raw_text: '第一条消息' });
    expect(submitted[0]).not.toHaveProperty('model_selection');
    expect(task.messages).toEqual([]);
    expect(task.sendUncertain).toBe(false);
    expect(task.eligibility.allowed).toBe(true);
  } finally {
    await act(async () => {
      root.unmount();
    });
    globalThis.fetch = oldFetch;
    for (const [key, descriptor] of original)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    await browser.happyDOM.close();
  }
});
