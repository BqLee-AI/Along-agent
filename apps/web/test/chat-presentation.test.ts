import { describe, expect, it } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RunViewSchema, type GoalResult } from '@along/contracts';
import { archivedReplyRuns } from '../src/features/conversations/model/presentation';
import { AssistantMarkdown } from '../src/features/conversations/view/assistant-markdown';
import {
  MessageRow,
  StreamingMessage,
} from '../src/features/conversations/view/conversation-messages';
import { RunStatusPanel, TaskComposer } from '../src/features/conversations/view/task-views';
import type { ConversationTask } from '../src/features/conversations/viewmodel/use-conversation-task';
import { RunResults } from '../src/features/conversations/view/run-results';

const botName = 'Research Bot';

function composerTask(overrides: Partial<ConversationTask> = {}): ConversationTask {
  return {
    input: 'A real message',
    setInput() {},
    files: [],
    fileError: null,
    fileBlockedReason: null,
    async addFiles() {},
    removeFile() {},
    intent: 'chat',
    setIntent() {},
    workspaces: [],
    workspaceId: '',
    setWorkspaceId() {},
    workspaceState: 'ready',
    workspaceError: null,
    async readWorkspaces() {},
    reminderAllowed: true,
    documentAllowed: true,
    events: [],
    messages: [],
    runs: [],
    liveReply: false,
    liveOriginal: null,
    run: null,
    selected: null,
    error: null,
    readError: null,
    busy: false,
    reading: false,
    stopping: false,
    pauseBusy: false,
    compactStatus: null,
    compactBusy: false,
    compactAvailable: true,
    compactRetryAllowed: false,
    async retryCompact() {},
    refreshCompact() {},
    streaming: false,
    retryResume: null,
    sendUncertain: false,
    admitting: false,
    clarificationSourceId: null,
    clarificationReply: false,
    setClarificationReply() {},
    ambiguousProposal: null,
    foldChoice: '',
    setFoldChoice() {},
    eligibility: { allowed: true, reason: null },
    active: false,
    effectsUnknown: false,
    observeEffect() {},
    transcript: new Map(),
    async send() {},
    reminderResults: {},
    reminderError: null,
    async confirmReminder() {},
    documentResults: {},
    documentError: null,
    async confirmDocument() {},
    async resume() {},
    async pause() {},
    async continuePaused() {},
    async stop() {},
    async refresh() {},
    leaving: false,
    setLeaving() {},
    leave() {},
    ...overrides,
  };
}

function openingTag(markup: string, testId: string): string {
  const tag = markup.match(new RegExp(`<[^>]*data-testid="${testId}"[^>]*>`));
  expect(tag).not.toBeNull();
  return tag![0];
}

describe('assistant Markdown consumer', () => {
  it('renders real Markdown structure identically for partial and final text', async () => {
    const partial = '# Heading\n\n- first\n- **second**\n\n```ts\nconst answer = 42;';
    const final = `${partial}\n\`\`\`\n\n[reference](https://example.com)\n\n| A | B |\n| - | - |\n| 1 | 2 |`;
    for (const text of [partial, final]) {
      const markup = renderToStaticMarkup(createElement(AssistantMarkdown, { text }));
      expect(markup).toContain('<h1>Heading</h1>');
      expect(markup).toContain('<ul>');
      expect(markup).toContain('<strong>second</strong>');
      expect(markup).toContain('const answer = 42;');
    }
    const markup = renderToStaticMarkup(createElement(AssistantMarkdown, { text: final }));
    expect(markup).toMatch(/<table(?:\s|>)/);
    const destinations: string[] = [];
    await new HTMLRewriter()
      .on('a', {
        element(link) {
          const href = link.getAttribute('href');
          if (href) destinations.push(new URL(href).href);
        },
      })
      .transform(new Response(markup))
      .text();
    expect(destinations).toContain(new URL('https://example.com').href);
    expect(markup).toContain('rel="noopener noreferrer"');
  });

  it('does not execute raw HTML, unsafe URLs, or fetch remote Markdown images', () => {
    const markup = renderToStaticMarkup(
      createElement(AssistantMarkdown, {
        text: '<script>alert(1)</script>\n\n<iframe src="https://untrusted.example"></iframe>\n\n[bad](javascript:alert%281%29)\n\n![diagram](https://example.com/pixel.png)',
      }),
    );
    expect(markup).not.toContain('<script');
    expect(markup).not.toContain('<iframe');
    expect(markup).not.toContain('javascript:');
    expect(markup).not.toContain('<img');
    expect(markup).toContain('href="https://example.com/pixel.png"');
  });
});

it('renders assistant Markdown in both streaming and saved messages', () => {
  const saved = renderToStaticMarkup(
    createElement(MessageRow, {
      message: {
        message_id: 'reply',
        role: 'assistant',
        content: '**An answer**',
        created_at: '2026-11-11T00:00:00.000000Z',
      },
    }),
  );
  const streaming = renderToStaticMarkup(
    createElement(StreamingMessage, { original: null, text: '**An answer**', streaming: true }),
  );
  for (const markup of [saved, streaming]) {
    expect(markup).toContain('<strong>An answer</strong>');
  }
});

it('associates a saved reply with its own run and leaves ambiguous legacy replies unlabelled', () => {
  const created_at = '2026-11-11T00:00:00.000000Z';
  const matches = archivedReplyRuns(
    [
      { message_id: 'match', role: 'assistant', content: 'Unique reply', created_at },
      { message_id: 'ambiguous', role: 'assistant', content: 'Duplicate reply', created_at },
      {
        message_id: 'explicit',
        role: 'assistant',
        content: 'Duplicate reply',
        created_at,
        source_run_id: 'run-3',
      },
    ],
    new Map([
      ['run-1', { text: 'Unique reply', approvals: [] }],
      ['run-2', { text: 'Duplicate reply', approvals: [] }],
      ['run-3', { text: 'Duplicate reply', approvals: [] }],
    ]),
  );
  expect([...matches]).toEqual([
    ['match', 'run-1'],
    ['explicit', 'run-3'],
  ]);
});

describe('durable goal result consumer', () => {
  const cid = '11111111-1111-4111-8111-111111111111';
  const rid = '22222222-2222-4222-8222-222222222222';
  const receipt = '33333333-3333-4333-8333-333333333333';
  const result: GoalResult = {
    status: 'partial',
    outcomes: [
      { description: 'Saved Asia/Shanghai', status: 'achieved', receipt_refs: [receipt] },
      { description: 'Destination unresolved', status: 'blocked', receipt_refs: [] },
    ],
    clarification: { kind: 'destination', question: 'Which destination?' },
    answer: '**Accepted setting remains saved.**',
  };
  const run = RunViewSchema.parse({
    run_id: rid,
    conversation_id: cid,
    execution: 'harness',
    model_selection: { state: 'legacy_unavailable' },
    status: 'done',
    attempt_id: cid,
    attempt_no: 1,
    waiting: null,
    can_resume: false,
    authorization_revision: 'delegation/1',
    execution_lifecycle: 'request-bound',
    goal_result: result,
  });

  it('does not render approval history when there are no approval entries', () => {
    const markup = renderToStaticMarkup(
      createElement(RunResults, {
        task: composerTask(),
        conversationId: cid,
        entries: [],
        needsAction: false,
        showReminderResult: false,
      }),
    );
    expect(markup).toBe('');
  });

  it('renders user pause controls separately from approval resume without executing actions', () => {
    let actions = 0;
    const selected = { conversationId: cid, runId: rid };
    const paused = {
      ...run,
      status: 'paused' as const,
      pause: {
        pause_id: rid,
        status: 'paused' as const,
        reason: 'user' as const,
        purpose: 'none' as const,
      },
    };
    const markup = renderToStaticMarkup(
      createElement(RunStatusPanel, {
        task: composerTask({
          selected,
          run: paused,
          async continuePaused() {
            actions++;
          },
          async stop() {
            actions++;
          },
        }),
      }),
    );
    expect(markup).toContain('明确继续此运行');
    expect(markup).toContain('读取和刷新不会继续');
    expect(markup).toContain('停止此运行');
    expect(markup).not.toContain('data-testid="resume-run"');
    expect(actions).toBe(0);

    const pending = renderToStaticMarkup(
      createElement(RunStatusPanel, {
        task: composerTask({
          selected,
          run: { ...paused, status: 'running', pause: { ...paused.pause, status: 'pending' } },
        }),
      }),
    );
    expect(pending).toContain('正在等待安全点');
    expect(pending).not.toContain('明确继续此运行');
    expect(pending).toContain('停止此运行');
  });

  it('keeps each durable goal status independent of Run done and preserves answer, outcomes, clarification and receipts without executing actions', () => {
    let actions = 0;
    for (const status of ['completed', 'partial', 'blocked', 'cancelled', 'unknown'] as const) {
      const markup = renderToStaticMarkup(
        createElement(RunStatusPanel, {
          task: composerTask({
            selected: { conversationId: cid, runId: rid },
            run: { ...run, goal_result: { ...result, status } },
            async send() {
              actions++;
            },
            async resume() {
              actions++;
            },
            async stop() {
              actions++;
            },
            async refresh() {
              actions++;
            },
          }),
        }),
      );
      expect(openingTag(markup, 'goal-result')).toContain(`data-goal-status="${status}"`);
      expect(markup).toContain('data-outcome-status="achieved"');
      expect(markup).toContain('data-outcome-status="blocked"');
      expect(markup).toContain(result.outcomes[0]!.description);
      expect(markup).toContain(result.outcomes[1]!.description);
      expect(markup).toContain(receipt);
      expect(markup).toContain(result.clarification!.question);
      expect(markup).toContain('<strong>Accepted setting remains saved.</strong>');
    }
    expect(actions).toBe(0);
  });

  it('does not repeat a final answer already shown in the chat', () => {
    const task = composerTask({
      selected: { conversationId: cid, runId: rid },
      run,
      liveReply: true,
    });
    const markup = renderToStaticMarkup(createElement(RunStatusPanel, { task }));
    expect(markup).toContain('data-testid="goal-result"');
    expect(markup).not.toContain('<strong>Accepted setting remains saved.</strong>');
  });

  it('shows the separate destination question without repeating the visible answer', () => {
    const goal_result: GoalResult = {
      ...result,
      status: 'blocked',
      outcomes: [{ description: 'Destination unresolved', status: 'blocked', receipt_refs: [] }],
    };
    const task = composerTask({
      selected: { conversationId: cid, runId: rid },
      run: { ...run, goal_result },
      liveReply: true,
    });
    const visible = renderToStaticMarkup(createElement(RunStatusPanel, { task }));
    expect(visible).toContain('Which destination?');
    expect(visible).not.toContain('Accepted setting remains saved.');
    expect(visible).not.toContain('本次运行模型');
    expect(visible).not.toContain('此运行绑定当前连接');
    const composer = renderToStaticMarkup(
      createElement(TaskComposer, { botName, task: { ...task, clarificationSourceId: rid } }),
    );
    expect(composer).toContain('补充上一个问题');
    const unavailable = renderToStaticMarkup(
      createElement(RunStatusPanel, { task: { ...task, liveReply: false } }),
    );
    expect(unavailable).toContain('<strong>Accepted setting remains saved.</strong>');
  });

  it('does not infer a lifecycle or goal result for a completed legacy Run', () => {
    const markup = renderToStaticMarkup(
      createElement(RunStatusPanel, {
        task: composerTask({
          selected: { conversationId: cid, runId: rid },
          run: {
            ...run,
            authorization_revision: undefined,
            execution_lifecycle: undefined,
            goal_result: undefined,
          },
        }),
      }),
    );
    expect(markup).not.toContain('data-testid="request-bound-lifecycle"');
    expect(markup).not.toContain('data-testid="goal-result"');
  });
});

describe('composer consumer states', () => {
  it('keeps normal chat minimal and never sends while rendering or choosing an initial tool', () => {
    let sends = 0;
    for (const intent of ['chat', 'reminder', 'document'] as const) {
      const markup = renderToStaticMarkup(
        createElement(TaskComposer, {
          botName,
          task: composerTask({
            intent,
            async send() {
              sends++;
            },
          }),
        }),
      );
      expect(openingTag(markup, 'chat-tools')).toContain('type="button"');
      expect(openingTag(markup, 'send-message')).toContain('type="submit"');
      expect(markup).not.toContain('name="task-intent"');
      expect(markup).toContain(`aria-label="发给 ${botName} 的消息"`);
      expect(markup.includes('data-testid="selected-tool"')).toBe(intent !== 'chat');
      expect(markup.includes('id="workspace"')).toBe(intent === 'document');
    }
    expect(sends).toBe(0);
  });

  it('exposes real stopping instead of a second send while a stream is active', () => {
    const markup = renderToStaticMarkup(
      createElement(TaskComposer, {
        botName,
        task: composerTask({
          streaming: true,
          active: true,
          selected: { conversationId: 'conversation', runId: 'run' },
          eligibility: { allowed: false, reason: 'blocked' },
        }),
      }),
    );
    expect(openingTag(markup, 'stop-reply')).toContain('type="button"');
    expect(openingTag(markup, 'stop-reply')).not.toMatch(/\sdisabled(?:=|[\s>])/);
    expect(markup).not.toContain('data-testid="send-message"');
    expect(openingTag(markup, 'chat-tools')).toMatch(/\sdisabled(?:=|[\s>])/);
    const input = markup.match(/<textarea\b[^>]*id="task-message"[^>]*>/)?.[0];
    expect(input).toBeDefined();
    expect(input).not.toMatch(/\sdisabled(?:=|[\s>])/);
  });

  it('protects the original draft while a send acknowledgement is unknown', () => {
    const markup = renderToStaticMarkup(
      createElement(TaskComposer, {
        botName,
        task: composerTask({
          sendUncertain: true,
          active: true,
          eligibility: { allowed: false, reason: '原发送待核实' },
        }),
      }),
    );
    const input = markup.match(/<textarea\b[^>]*id="task-message"[^>]*>/)?.[0];
    expect(input).toBeDefined();
    expect(input).toMatch(/\sdisabled(?:=|[\s>])/);
    expect(openingTag(markup, 'send-message')).toMatch(/\sdisabled(?:=|[\s>])/);
  });

  it('offers compact alongside stop while streaming', () => {
    const markup = renderToStaticMarkup(
      createElement(TaskComposer, {
        botName,
        task: composerTask({
          input: '/compact',
          streaming: true,
          active: true,
          selected: { conversationId: 'conversation', runId: 'run' },
          eligibility: { allowed: false, reason: 'blocked' },
        }),
      }),
    );
    expect(openingTag(markup, 'stop-reply')).toContain('type="button"');
    expect(openingTag(markup, 'send-message')).toContain('aria-label="执行压缩命令"');
    expect(openingTag(markup, 'send-message')).not.toMatch(/\sdisabled(?:=|[\s>])/);
  });

  it('reports a status read failure without claiming compact completion', () => {
    const markup = renderToStaticMarkup(
      createElement(TaskComposer, {
        botName,
        task: composerTask({
          compactStatus: {
            phase: 'read_error',
            message: '状态读取失败',
            receipt: {
              status: 'compacting',
              run_id: '22222222-2222-4222-8222-222222222222',
              pause_id: '11111111-1111-4111-8111-111111111111',
            },
          },
          compactAvailable: false,
        }),
      }),
    );
    expect(markup).toContain('状态读取失败');
    expect(markup).toContain('重新读取压缩状态');
    expect(markup).not.toContain('压缩已完成');
  });

  it('explains why an oversized attachment draft cannot be sent', () => {
    const reason = '消息和文件内容超出单条消息的容量。';
    const markup = renderToStaticMarkup(
      createElement(TaskComposer, {
        botName,
        task: composerTask({
          active: false,
          eligibility: { allowed: false, reason },
          fileBlockedReason: reason,
        }),
      }),
    );
    expect(openingTag(markup, 'send-message')).toContain('disabled');
    expect(markup).toContain(reason);
  });

  it('disables new sends for controller-blocked and unresolved DST choices', () => {
    const ambiguousProposal: NonNullable<ConversationTask['ambiguousProposal']> = {
      raw_text: 'original',
      source_run_id: '00000000-0000-4000-8000-000000000092',
      wall_time: '2026-11-01T01:30:00',
      timezone_id: 'America/New_York',
      ruleset_id: 'FIXTURE_V1',
      candidates: [
        { fold_choice: 'first', offset_seconds: -14400, fire_at_utc: '2026-11-01T05:30:00Z' },
        { fold_choice: 'second', offset_seconds: -18000, fire_at_utc: '2026-11-01T06:30:00Z' },
      ],
    };
    for (const overrides of [
      { active: true, effectsUnknown: true, eligibility: { allowed: false, reason: 'unknown' } },
      { intent: 'reminder' as const, ambiguousProposal, foldChoice: '' as const },
    ]) {
      const markup = renderToStaticMarkup(
        createElement(TaskComposer, { botName, task: composerTask(overrides) }),
      );
      expect(openingTag(markup, 'send-message')).toMatch(/\sdisabled(?:=|[\s>])/);
    }
    const chosen = renderToStaticMarkup(
      createElement(TaskComposer, {
        botName,
        task: composerTask({ intent: 'reminder', ambiguousProposal, foldChoice: 'second' }),
      }),
    );
    expect(openingTag(chosen, 'send-message')).not.toMatch(/\sdisabled(?:=|[\s>])/);
  });

  it('keeps registration explicit and puts scope facts in expandable details', () => {
    const markup = renderToStaticMarkup(
      createElement(TaskComposer, {
        botName,
        task: composerTask({
          intent: 'document',
          workspaceId: '',
          workspaces: [
            {
              workspace_id: 'managed',
              label: 'Managed',
              readable_paths: ['a.md'],
              writable_paths: [],
            },
          ],
          eligibility: { allowed: false, reason: 'choose registration' },
        }),
      }),
    );
    expect(openingTag(markup, 'workspace-scope').startsWith('<details')).toBe(true);
    expect(openingTag(markup, 'send-message')).toContain('disabled');
    const selected = renderToStaticMarkup(
      createElement(TaskComposer, {
        botName,
        task: composerTask({
          intent: 'document',
          workspaceId: 'managed',
          workspaces: [
            {
              workspace_id: 'managed',
              label: 'Managed',
              readable_paths: ['a.md'],
              writable_paths: [],
            },
          ],
        }),
      }),
    );
    expect(selected).toContain('a.md');
    expect(openingTag(selected, 'workspace-scope')).not.toContain('open=');
  });

  it('keeps resume actionable outside the collapsed technical facts', () => {
    const markup = renderToStaticMarkup(
      createElement(RunStatusPanel, {
        task: composerTask({
          selected: { conversationId: 'conversation', runId: 'run' },
          run: {
            run_id: 'run',
            conversation_id: 'conversation',
            waiting: {
              checkpoint_id: 'checkpoint',
              invocation_id: 'invocation',
              approval_id: 'approval',
            },
            status: 'suspended_approval',
            can_resume: true,
            execution: 'harness',
            model_selection: { state: 'legacy_unavailable' },
            attempt_no: 1,
            attempt_id: 'attempt',
          },
        }),
      }),
    );
    expect(openingTag(markup, 'resume-run')).not.toMatch(/\sdisabled(?:=|[\s>])/);
    expect(markup.indexOf('data-testid="resume-run"')).toBeLessThan(markup.indexOf('<details'));
    expect(openingTag(markup, 'run-facts')).not.toContain('open=');
  });
});
