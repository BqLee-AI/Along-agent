import { describe, expect, it } from 'bun:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { Window } from 'happy-dom';
import type { ConversationRunHistoryItem, RunView } from '@along/contracts';
import type {
  OfficeAttachment,
  OfficeSession,
} from '../src/features/conversations/model/office-materials';
import {
  officeAdmissionSession,
  officeViewer,
} from '../src/features/conversations/model/office-materials';
import { AssistantMarkdown } from '../src/features/conversations/view/assistant-markdown';
import { OfficeRunResultsPanel } from '../src/features/conversations/view/office-run-results';
import { RunResults } from '../src/features/conversations/view/run-results';
import { conversationRunEntries } from '../src/features/conversations/model/presentation';
import { TaskComposer } from '../src/features/conversations/view/task-views';
import {
  useConversationTask,
  type ConversationTask,
} from '../src/features/conversations/viewmodel/use-conversation-task';
import { ModelCatalogProvider } from '../src/features/model-settings/viewmodel/model-catalog-context';

const cid = '11111111-1111-4111-8111-111111111111';
const rid = '22222222-2222-4222-8222-222222222222';
const notesId = '33333333-3333-4333-8333-333333333333';
const tasksId = '44444444-4444-4444-8444-444444444444';
const officeSession = {
  ownerId: '55555555-5555-4555-8555-555555555555',
  csrfToken: 'csrf-original',
};
const successRunId = '66666666-6666-4666-8666-666666666666';
const taskId = '77777777-7777-4777-8777-777777777777';
const time = '2026-11-23T02:00:00.000000Z';
const identity = {
  user: { id: officeSession.ownerId, display_name: 'Test user' },
  csrf_token: officeSession.csrfToken,
  confirmed_timezone: 'Asia/Shanghai',
};
const notesFile = new File(['# 纪要'], '讨论 #1.md');
const tasksFile = new File(['id,title\n1,Review'], 'tasks.csv');
const envelope = (data: unknown) =>
  Response.json({ code: 0, msg: 'ok', request_id: 'office-test', data });
const rejected = () =>
  Response.json(
    {
      code: 400,
      msg: 'validation',
      request_id: 'office-test',
      error: { code: 'VALIDATION_ERROR', message: 'rejected', request_id: 'office-test' },
    },
    { status: 400 },
  );

function receipt(id: string, file: File, format: OfficeAttachment['format']) {
  return {
    attachment_id: id,
    filename: file.name,
    format,
    byte_length: file.size,
    expires_at: '2099-01-01T00:00:00.000Z',
    status: 'available',
  };
}

type Selection = {
  conversationId?: string;
  runId?: string;
  officeSession?: OfficeSession;
  initialIntent: 'chat' | 'office';
  showResults?: boolean;
};
type RequestCall = {
  url: URL;
  init: RequestInit;
  respond: (response: Response) => void;
  reject: () => void;
};
type Fixture = {
  readonly task: ConversationTask;
  readonly calls: RequestCall[];
  readonly container: HTMLDivElement;
  select: (selection: Selection) => Promise<void>;
  reload: (selection: Selection) => Promise<void>;
};
const initial: Selection = { officeSession, initialIntent: 'office' };

async function until(check: () => boolean) {
  for (let i = 0; i < 60; i++) {
    if (check()) return;
    await act(async () => {});
  }
  throw new Error('Expected office state did not arrive');
}

async function fixture(
  test: (fixture: Fixture) => Promise<void>,
  selection: Selection = initial,
  read?: (url: URL) => Response | undefined,
) {
  const browser = new Window({ url: 'http://web.test/conversations' });
  const originalFetch = globalThis.fetch;
  const globals = {
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    location: browser.location,
    HTMLElement: browser.HTMLElement,
    sessionStorage: browser.sessionStorage,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const originals = new Map(
    Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const calls: RequestCall[] = [];
  let generation = 0;
  let task!: ConversationTask;
  function Consumer(props: Selection) {
    task = useConversationTask(props);
    return props.showResults ? runResults(task) : null;
  }
  const select = async (props: Selection) => {
    await act(async () => {
      root.render(
        createElement(ModelCatalogProvider, {
          children: createElement(Consumer, { ...props, key: generation }),
        }),
      );
    });
  };
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input), 'http://web.test');
    if (init?.method === 'POST') {
      const { promise, resolve, reject } = Promise.withResolvers<Response>();
      calls.push({
        url,
        init,
        respond: resolve,
        reject: () => reject(new TypeError('transport closed')),
      });
      return promise;
    }
    if (url.pathname.endsWith('/model-providers'))
      return envelope({ items: [], default_selection: null });
    const override = read?.(url);
    if (override) return override;
    if (url.pathname === '/api/v1/me') return envelope(identity);
    if (url.pathname === `/api/v1/conversations/${cid}/runs/${rid}`)
      return envelope({ ...runView(rid), status: 'failed' });
    if (url.pathname === `/api/v1/conversations/${cid}`)
      return envelope({
        conversation_id: cid,
        status: 'open',
        confirmed_timezone_id: null,
        anchor_received_at_utc: null,
        events: [],
        next_after_seq: null,
      });
    if (url.pathname.endsWith('/runs') || url.pathname.endsWith('/messages'))
      return envelope({ items: [], next_cursor: null });
    throw new Error(`Unexpected HTTP request: ${url.pathname}`);
  }) as typeof fetch;
  try {
    await select(selection);
    await test({
      get task() {
        return task;
      },
      container,
      calls,
      select,
      async reload(props) {
        generation++;
        await select(props);
      },
    });
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = originalFetch;
    for (const [key, original] of originals) {
      if (original) Object.defineProperty(globalThis, key, original);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

function composer(task: ConversationTask) {
  return renderToStaticMarkup(createElement(TaskComposer, { task }));
}

function runView(runId: string, goalResult: RunView['goal_result'] = null): RunView {
  return {
    run_id: runId,
    conversation_id: cid,
    execution: 'harness',
    model_selection: { state: 'legacy_unavailable' },
    status: 'done',
    attempt_id: tasksId,
    attempt_no: 1,
    waiting: null,
    can_resume: false,
    authorization_revision: 'delegation/1',
    execution_lifecycle: 'server-owned',
    goal_result: goalResult,
  };
}

function runResults(task: ConversationTask) {
  return createElement(RunResults, {
    task,
    entries: conversationRunEntries(task.runs, task.selected),
    conversationId: cid,
    needsAction: false,
    showReminderResult: false,
    officeHistoryCsrf: officeSession.csrfToken,
  });
}

function canSend(task: ConversationTask) {
  const button = composer(task).match(/<button\b[^>]*data-testid="send-message"[^>]*>/)?.[0];
  expect(button).toBeDefined();
  return !/\sdisabled(?:=|[\s>])/.test(button!);
}

async function reply(call: RequestCall, response: Response) {
  await act(async () => call.respond(response));
}

function headers(call: RequestCall) {
  return new Headers(call.init.headers);
}

describe('native office composer', () => {
  it('requires both a signed viewer and a literal true server capability', () => {
    const viewer = officeViewer(identity);
    expect(viewer).toEqual(officeSession);
    expect(officeAdmissionSession(viewer, { admission_enabled: true })).toEqual(officeSession);
    for (const capability of [
      null,
      {},
      { admission_enabled: 'true' },
      { admission_enabled: false },
    ])
      expect(officeAdmissionSession(viewer, capability)).toBeUndefined();
    expect(
      officeAdmissionSession(officeViewer({ ...identity, csrf_token: null }), {
        admission_enabled: true,
      }),
    ).toBeUndefined();
  });
  it('does not expose or send an office draft when admission has no verified capability', async () => {
    await fixture(
      async (f) => {
        expect(composer(f.task)).not.toContain('本轮会话资料');
        await act(async () => f.task.setIntent('office'));
        expect(f.task.intent).toBe('chat');
        expect(f.calls).toHaveLength(0);
      },
      { initialIntent: 'chat' },
    );
  });

  it('uploads two independent roles, blocks pending and failed sends, and posts only verified IDs', async () => {
    await fixture(async (f) => {
      await act(async () => {
        f.task.setInput('生成报告和任务汇总');
        f.task.office!.choose('notes', notesFile);
        f.task.office!.choose('tasks', tasksFile);
      });
      expect(f.calls).toHaveLength(2);
      const [notes, tasks] = f.calls;
      expect(notes!.url.pathname).toBe('/api/v1/conversations/attachments');
      expect(notes!.url.searchParams.get('conversation_id')).toBeNull();
      expect(notes!.url.searchParams.get('draft_id')).toBe(tasks!.url.searchParams.get('draft_id'));
      expect(notes!.init.body).toBe(notesFile);
      expect(headers(notes!).get('content-type')).toBe('application/octet-stream');
      expect(headers(notes!).get('x-along-filename')).toBe(encodeURIComponent(notesFile.name));
      expect(headers(notes!).get('x-csrf-token')).toBe(officeSession.csrfToken);
      expect(headers(notes!).get('Idempotency-Key')).not.toBe(
        headers(tasks!).get('Idempotency-Key'),
      );
      expect(composer(f.task)).toContain('本轮所选资料将提供给你配置的模型处理');
      expect(composer(f.task)).toContain('正在上传');
      expect(canSend(f.task)).toBe(false);
      await act(async () => f.task.send());
      expect(f.calls).toHaveLength(2);
      await reply(notes!, envelope(receipt(notesId, notesFile, 'markdown')));
      await reply(tasks!, rejected());
      expect(composer(f.task)).toContain('上传未确认');
      expect(canSend(f.task)).toBe(false);
      await act(async () => f.task.send());
      expect(f.calls).toHaveLength(2);
      await act(async () => f.task.office!.retry('tasks'));
      expect(headers(f.calls[2]!).get('Idempotency-Key')).toBe(
        headers(tasks!).get('Idempotency-Key'),
      );
      await reply(f.calls[2]!, envelope(receipt(tasksId, tasksFile, 'csv')));
      expect(canSend(f.task)).toBe(true);
      await act(async () => {
        void f.task.send();
      });
      await until(() => f.calls.length === 4);
      const firstSend = f.calls[3]!;
      const payload = JSON.parse(String(firstSend.init.body));
      expect(firstSend.url.pathname).toBe('/api/v1/conversations/messages');
      expect(payload).toMatchObject({
        raw_text: '生成报告和任务汇总',
        execution: 'harness',
        authorization_revision: 'delegation/1',
        confirmed_timezone: 'Asia/Shanghai',
        office_materials: {
          draft_id: notes!.url.searchParams.get('draft_id')!,
          notes_attachment_id: notesId,
          tasks_attachment_id: tasksId,
        },
      });
      expect(payload).not.toHaveProperty('workspace_id');
      expect(headers(firstSend).get('Idempotency-Key')).toBe(payload.idempotency_key);
      await act(async () => firstSend.reject());
      expect(f.task.sendUncertain).toBe(true);
      await f.reload({ initialIntent: 'chat' });
      expect(f.task.sendUncertain).toBe(true);
      expect(f.calls).toHaveLength(4);
      await act(async () => {
        void f.task.send(true);
      });
      await until(() => f.calls.length === 5);
      expect(f.calls[4]!.init.body).toBe(firstSend.init.body);
      expect(headers(f.calls[4]!).get('Idempotency-Key')).toBe(payload.idempotency_key);
      await reply(f.calls[4]!, rejected());
    });
  });

  it('does not reuse an accepted draft even if the real Run ends in failure', async () => {
    await fixture(async (f) => {
      await act(async () => {
        f.task.setInput('分析纪要');
        f.task.office!.choose('notes', notesFile);
      });
      await reply(f.calls[0]!, envelope(receipt(notesId, notesFile, 'markdown')));
      await act(async () => {
        void f.task.send();
      });
      await until(() => f.calls.length === 2);
      const scope = { conversation_id: cid, run_id: rid };
      const events = [
        {
          type: 'thread.started',
          payload: {
            ...scope,
            stream_protocol_version: 'v2',
            ruleset_id: 'test',
            tzdb_version: 'test',
            authorization_revision: 'delegation/1',
            execution_lifecycle: 'server-owned',
          },
        },
        {
          type: 'thread.failed',
          payload: {
            ...scope,
            error: { code: 'RUN_FAILED', message: 'test failure', http_status: 500 },
            goal_result: {
              status: 'blocked',
              outcomes: [{ description: '未处理纪要', status: 'blocked', receipt_refs: [] }],
              clarification: null,
              answer: '未处理纪要',
            },
          },
        },
      ];
      await reply(
        f.calls[1]!,
        new Response(
          events
            .map(
              (event, index) =>
                `data: ${JSON.stringify({ protocol_version: 'v2', seq: index + 1, request_id: 'office-test', ...event })}\n\n`,
            )
            .join(''),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
      );
      await until(() => !f.task.busy);
      expect(f.task.selected).toEqual({ conversationId: cid, runId: rid });
      expect(f.task.intent).toBe('chat');
      expect(f.task.input).toBe('');
      expect(f.task.office!.slots).toEqual({});
      expect(sessionStorage.getItem('conversation-send:new')).toBeNull();
    });
  });

  it('aborts cancel and scope switches, ignoring late results even after returning to the old route', async () => {
    await fixture(async (f) => {
      await act(async () => f.task.office!.choose('notes', notesFile));
      const original = f.calls[0]!;
      await act(async () => f.task.office!.cancel('notes'));
      expect(original.init.signal?.aborted).toBe(true);
      await act(async () => f.task.office!.retry('notes'));
      const retry = f.calls[1]!;
      expect(headers(retry).get('Idempotency-Key')).toBe(headers(original).get('Idempotency-Key'));
      await reply(original, envelope(receipt(notesId, notesFile, 'markdown')));
      expect(f.task.office!.slots.notes?.state).toBe('uploading');
      await f.select({ ...initial, conversationId: cid });
      expect(retry.init.signal?.aborted).toBe(true);
      await act(async () => f.task.office!.choose('tasks', tasksFile));
      const scoped = f.calls[2]!;
      expect(scoped.url.searchParams.get('conversation_id')).toBe(cid);
      expect(scoped.url.searchParams.get('draft_id')).not.toBe(
        retry.url.searchParams.get('draft_id'),
      );
      await f.select({
        ...initial,
        conversationId: cid,
        officeSession: { ...officeSession, csrfToken: 'relogin' },
      });
      expect(scoped.init.signal?.aborted).toBe(true);
      await f.select(initial);
      await reply(retry, envelope(receipt(notesId, notesFile, 'markdown')));
      await reply(scoped, envelope(receipt(tasksId, tasksFile, 'csv')));
      expect(f.task.office!.slots).toEqual({});
      expect(f.task.office!.submission()).toBeNull();
      expect(f.calls).toHaveLength(3);
    });
  });

  it('requires a live available receipt and removes only after successful revocation', async () => {
    await fixture(async (f) => {
      await act(async () => f.task.office!.choose('tasks', tasksFile));
      await reply(
        f.calls[0]!,
        envelope({ ...receipt(tasksId, tasksFile, 'csv'), status: 'revoked' }),
      );
      expect(f.task.office!.slots.tasks?.state).toBe('failed');
      expect(f.task.office!.submission()).toBeNull();
      await act(async () => f.task.office!.remove('tasks'));
      await act(async () => f.task.office!.choose('notes', notesFile));
      const upload = f.calls[1]!;
      await reply(upload, envelope(receipt(notesId, notesFile, 'markdown')));
      expect(f.task.office!.submission()).toEqual({
        draft_id: upload.url.searchParams.get('draft_id')!,
        notes_attachment_id: notesId,
      });
      await act(async () => {
        void f.task.office!.remove('notes');
      });
      expect(f.task.office!.slots.notes?.state).toBe('revoking');
      const revoke = f.calls[2]!;
      expect(revoke.url.pathname).toBe(
        `/api/v1/conversations/attachments/${notesId}/actions/revoke`,
      );
      expect(revoke.url.search).toBe(upload.url.search);
      await reply(revoke, envelope({ revoked: true }));
      expect(f.task.office!.slots).toEqual({});
      expect(f.task.office!.submission()).toBeNull();
    });
  });
});

describe('native office results', () => {
  const href = `/api/v1/conversations/${cid}/runs/${rid}/artifacts/${notesId}/content`;
  const artifact = {
    artifact_id: notesId,
    run_id: rid,
    filename: '已核验报告.md',
    format: 'markdown',
    status: 'available',
    download_url: href,
    byte_length: 100,
    expires_at: time,
  } as const;

  function history(runId: string, reminder: 'created' | 'unconfirmed'): ConversationRunHistoryItem {
    return {
      run_id: runId,
      conversation_id: cid,
      execution: 'harness',
      model_selection: { state: 'legacy_unavailable' },
      status: 'done',
      created_at: time,
      ended_at: time,
      original: { state: 'legacy_unavailable' },
      office_materials: {
        inputs: [
          { ...receipt(notesId, notesFile, 'markdown'), role: 'notes', status: 'available' },
        ],
        artifacts: [
          artifact,
          {
            ...artifact,
            artifact_id: tasksId,
            filename: '汇总.csv',
            format: 'csv',
            download_url: href.replace(notesId, tasksId),
          },
        ],
        reminder:
          reminder === 'created'
            ? { state: 'created', task_id: taskId, current_status: 'cancelled' }
            : { state: 'unconfirmed' },
      },
    };
  }

  it('reads continuation outputs and revokes a bound source without new admission', async () => {
    await fixture(
      async (f) => {
        await until(() => !f.task.reading);
        expect(f.task.readError).toBeNull();
        const markup = f.container.innerHTML;
        expect(f.task.office).toBeUndefined();
        expect(markup).toContain(`href="${href}"`);
        expect(markup).toContain(`href="${href.replace(notesId, tasksId)}"`);
        expect(markup).not.toContain(href.replace(`/runs/${rid}/`, `/runs/${successRunId}/`));
        expect(markup).toContain(`href="/tasks/${taskId}"`);
        expect(markup).toContain('提醒已创建。当前状态：cancelled。');
        expect(markup).not.toContain('已送达');
        expect(markup).toContain(notesFile.name);
        expect(markup).toContain('撤销');
        expect(f.calls).toHaveLength(0);
        window.confirm = () => false;
        const revoke = Array.from(f.container.querySelectorAll('button')).find(
          (button) => button.textContent === `撤销 ${notesFile.name}`,
        )!;
        await act(async () => revoke.click());
        expect(f.calls).toHaveLength(0);
        window.confirm = () => true;
        await act(async () => revoke.click());
        const request = f.calls[0]!;
        expect(request.url.pathname).toBe(
          `/api/v1/conversations/attachments/${notesId}/actions/revoke`,
        );
        expect(request.url.search).toBe(`?conversation_id=${cid}`);
        expect(headers(request).get('x-csrf-token')).toBe(officeSession.csrfToken);
        await reply(request, envelope({ revoked: true }));
        expect(f.container.textContent).toContain('已撤销');
      },
      { conversationId: cid, runId: successRunId, initialIntent: 'chat', showResults: true },
      (url) => {
        if (url.pathname.endsWith('/runs'))
          return envelope({ items: [history(successRunId, 'created')], next_cursor: null });
        if (url.pathname.endsWith(`/runs/${successRunId}`)) return envelope(runView(successRunId));
      },
    );
  });
  it('preserves files independently of an unconfirmed reminder and keeps known facts on failed history reload', async () => {
    let failHistory = false;
    await fixture(
      async (f) => {
        await until(() => !f.task.reading);
        const complete = renderToStaticMarkup(runResults(f.task));
        expect(complete).toContain('提醒状态未确认。');
        expect(complete).toContain(`href="${href}"`);
        expect(complete).not.toContain('提醒未创建');
        failHistory = true;
        await act(async () => f.task.refresh());
        expect(f.task.readError).toBeTruthy();
        expect(f.task.messages[0]?.content).toBe('原话仍可读取');
        const incomplete = renderToStaticMarkup(runResults(f.task));
        expect(incomplete).toContain('已核验报告.md');
        expect(incomplete).toContain('当前可用性未能确认');
        expect(incomplete).not.toContain(`href="${href}"`);
        expect(incomplete).toContain('未能读取提醒状态');
        expect(f.calls).toHaveLength(0);
      },
      { conversationId: cid, runId: rid, initialIntent: 'chat' },
      (url) => {
        if (url.pathname.endsWith('/runs'))
          return failHistory
            ? new Response('temporarily unavailable', { status: 503 })
            : envelope({ items: [history(rid, 'unconfirmed')], next_cursor: null });
        if (url.pathname.endsWith('/messages'))
          return envelope({
            items: [
              { message_id: taskId, role: 'user', content: '原话仍可读取', created_at: time },
            ],
            next_cursor: null,
          });
        if (url.pathname.endsWith(`/runs/${rid}`)) return envelope(runView(rid));
      },
    );
  });

  it('only exposes a new continuation with admission enabled and replies against the same Run without resending files', async () => {
    const selected: Selection = { conversationId: cid, runId: rid, initialIntent: 'chat' };
    await fixture(
      async (f) => {
        await until(() => !f.task.reading);
        expect(f.task.canReplyToClarification).toBe(false);
        await f.select({ ...selected, officeSession });
        expect(f.task.canReplyToClarification).toBe(true);
        await act(async () => {
          f.task.setInput('Asia/Shanghai');
          f.task.setClarificationReply(true);
        });
        await act(async () => {
          void f.task.send();
        });
        await until(() => f.calls.length === 1);
        const sent = f.calls[0]!;
        const payload = JSON.parse(String(sent.init.body));
        expect(payload).toMatchObject({
          raw_text: 'Asia/Shanghai',
          conversation_id: cid,
          clarification_of_run_id: rid,
          execution: 'harness',
          authorization_revision: 'delegation/1',
        });
        expect(payload).not.toHaveProperty('office_materials');
        expect(headers(sent).get('Idempotency-Key')).toBe(payload.idempotency_key);
        expect(headers(sent).get('x-csrf-token')).toBe(officeSession.csrfToken);
        await reply(sent, rejected());
      },
      selected,
      (url) => {
        if (url.pathname.endsWith('/runs'))
          return envelope({ items: [history(rid, 'unconfirmed')], next_cursor: null });
        if (url.pathname.endsWith(`/runs/${rid}`))
          return envelope(
            runView(rid, {
              status: 'partial',
              outcomes: [
                { description: '文件', status: 'achieved', receipt_refs: [notesId] },
                { description: '提醒', status: 'blocked', receipt_refs: [] },
              ],
              clarification: { kind: 'timezone', question: '请输入时区。' },
              answer: '请输入时区。',
            }),
          );
      },
    );
  });

  it('never links stale, unmatched or externally hosted downloads, or links supplied by the model', () => {
    const markup = renderToStaticMarkup(
      createElement(OfficeRunResultsPanel, {
        conversationId: cid,
        retryRead() {},
        results: {
          artifacts: [
            { ...artifact, status: 'expired' },
            { ...artifact, artifact_id: tasksId },
            { ...artifact, download_url: `https://example.invalid${href}` },
          ],
          reminder: { state: 'unconfirmed' },
        },
      }),
    );
    expect(markup).not.toContain('href=');
    expect(markup).toContain('文件已交付，现已过期');
    expect(markup).toContain('提醒状态未确认');
    expect(markup).toContain('重新读取资料结果');
    const model = renderToStaticMarkup(
      createElement(AssistantMarkdown, {
        text: `[报告已生成](${href})\n\n![another](${href})`,
      }),
    );
    expect(model).toContain('报告已生成');
    expect(model).not.toContain('href=');
  });
});
