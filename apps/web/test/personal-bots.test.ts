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
import { skillCatalogChanged } from '../src/features/skills/model/skill';

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
const rejected = (status: number, code: string, details?: unknown) =>
  Response.json(
    {
      code: status,
      data: null,
      msg: 'failed',
      error: { code, message: 'rejected', request_id: 'web-bots', details },
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
      skill_ids: [secondCid],
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

it.each([
  { newsEditionId: undefined, withSkill: false },
  { newsEditionId: secondCid, withSkill: false },
  { newsEditionId: undefined, withSkill: true },
])(
  'preserves explicit sends and checks skill admission (edition $newsEditionId, skill $withSkill)',
  async ({ newsEditionId, withSkill }) => {
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
    let available = {
      id: key,
      name: 'weekly-report',
      description: 'Organize notes',
      revision: 1,
      disabled_at: null,
    };
    let archived: Record<string, unknown> | undefined;
    globalThis.fetch = (async (input, init) => {
      const url = new URL(String(input), base);
      if (init?.method === 'POST' && url.pathname === '/api/v1/conversations/messages') {
        submitted.push(JSON.parse(String(init.body)));
        if (!withSkill) return rejected(403, 'FORBIDDEN');
        if (submitted.length === 1) {
          available = { ...available, revision: 2 };
          return rejected(409, 'STATE_CONFLICT', { reason: 'SKILL_REVISION_CHANGED' });
        }
        archived = {
          message_id: b,
          role: 'user',
          content: '第一条消息',
          created_at: '2026-11-26T12:00:00.000000Z',
          skill: { id: key, name: available.name, revision: available.revision },
        };
        const sse = [
          {
            type: 'thread.started',
            payload: {
              stream_protocol_version: 'v1',
              ruleset_id: 'rules-v1',
              tzdb_version: '2026a',
            },
          },
          { type: 'thread.completed', payload: { approval_id: null } },
        ]
          .map(
            ({ type, payload }, index) =>
              `data: ${JSON.stringify({
                protocol_version: 'v1',
                seq: index + 1,
                type,
                payload: { conversation_id: cid, run_id: secondCid, ...payload },
                request_id: 'web-bots',
              })}\n\n`,
          )
          .join('');
        return new Response(sse, { headers: { 'content-type': 'text/event-stream' } });
      }
      if (url.pathname === '/api/v1/me') return ok(me);
      if (url.pathname === `/api/v1/bots/${a}/skills`) return ok({ items: [available] });
      if (url.pathname === `/api/v1/conversations/${cid}/runs`) return ok(empty);
      if (url.pathname === `/api/v1/conversations/${cid}/messages`)
        return ok({ ...empty, items: archived ? [archived] : [] });
      if (url.pathname === `/api/v1/conversations/${cid}/runs/${secondCid}`)
        return ok({
          run_id: secondCid,
          conversation_id: cid,
          execution: 'harness',
          model_selection: { state: 'legacy_unavailable' },
          status: 'done',
          attempt_id: b,
          attempt_no: 1,
          waiting: null,
          can_resume: false,
        });
      throw new Error(`unexpected request: ${url}`);
    }) as typeof fetch;
    const root = createRoot(document.createElement('div'));
    let task!: ConversationTask;
    function Consumer() {
      task = useConversationTask({
        botId: a,
        conversationId: cid,
        newsEditionId,
        workspaceIds: [],
        toolIds: [],
        skillIds: withSkill ? [key] : [],
      });
      return null;
    }
    try {
      await act(async () => {
        root.render(createElement(Consumer));
      });
      expect(task.reading).toBe(false);
      expect(task.messages).toEqual([]);
      expect(task.runs).toEqual([]);
      expect(task.pendingNewsEditionId).toBe(newsEditionId ?? null);
      await act(async () => {
        task.setInput('第一条消息');
        if (withSkill) {
          const { id, name, revision } = task.availableSkills[0]!;
          task.setSkill({ id, name, revision });
        }
      });
      expect(submitted).toEqual([]);
      await act(async () => {
        await task.send();
      });
      expect(submitted).toHaveLength(1);
      expect(submitted[0]).toMatchObject({ conversation_id: cid, raw_text: '第一条消息' });
      expect(submitted[0]).not.toHaveProperty('model_selection');
      if (newsEditionId) expect(submitted[0]).toHaveProperty('news_edition_id', newsEditionId);
      else expect(submitted[0]).not.toHaveProperty('news_edition_id');
      expect(task.messages).toEqual([]);
      expect(task.sendUncertain).toBe(false);
      expect(task.eligibility.allowed).toBe(true);
      expect(task.input).toBe('第一条消息');
      if (!withSkill) {
        expect(submitted[0]).not.toHaveProperty('skill');
        return;
      }
      expect(submitted[0]?.skill).toEqual({ id: key, revision: 1 });
      expect(task.skill).toEqual({ id: key, name: 'weekly-report', revision: 1 });
      expect(task.error).toContain('请刷新技能');
      await act(async () => {
        browser.dispatchEvent(new browser.Event(skillCatalogChanged));
      });
      expect(task.skill?.revision).toBe(1);
      expect(task.availableSkills[0]?.revision).toBe(2);
      await act(async () => {
        const { id, name, revision } = task.availableSkills[0]!;
        task.setSkill({ id, name, revision });
      });
      await act(async () => {
        await task.send();
      });
      expect(submitted[1]?.skill).toEqual({ id: key, revision: 2 });
      expect(task.input).toBe('');
      expect(task.skill).toBeNull();
      expect(task.messages[0]?.skill).toEqual({ id: key, name: 'weekly-report', revision: 2 });
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
  },
);
