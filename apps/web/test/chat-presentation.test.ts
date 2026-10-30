import { describe, expect, it } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AssistantMarkdown } from '../src/features/conversations/assistant-markdown';
import { RunStatusPanel, TaskComposer } from '../src/features/conversations/task-views';
import type { ConversationTask } from '../src/features/conversations/use-conversation-task';

function composerTask(overrides: Partial<ConversationTask> = {}): ConversationTask {
  return {
    input: 'A real message',
    setInput() {},
    intent: 'chat',
    setIntent() {},
    workspaces: [],
    workspaceId: '',
    setWorkspaceId() {},
    workspaceState: 'ready',
    workspaceError: null,
    async readWorkspaces() {},
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
    streaming: false,
    retryResume: null,
    sendUncertain: false,
    ambiguousProposal: null,
    foldChoice: '',
    setFoldChoice() {},
    eligibility: { allowed: true, reason: null },
    active: false,
    effectsUnknown: false,
    observeEffect() {},
    transcript: new Map(),
    async send() {},
    async resume() {},
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

describe('composer consumer states', () => {
  it('keeps normal chat minimal and never sends while rendering or choosing an initial tool', () => {
    let sends = 0;
    for (const intent of ['chat', 'reminder', 'document'] as const) {
      const markup = renderToStaticMarkup(
        createElement(TaskComposer, {
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
      expect(markup.includes('data-testid="selected-tool"')).toBe(intent !== 'chat');
      expect(markup.includes('id="workspace"')).toBe(intent === 'document');
    }
    expect(sends).toBe(0);
  });

  it('exposes real stopping instead of a second send while a stream is active', () => {
    const markup = renderToStaticMarkup(
      createElement(TaskComposer, {
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
  });

  it('disables new sends for controller-blocked and unresolved DST choices', () => {
    const ambiguousProposal: NonNullable<ConversationTask['ambiguousProposal']> = {
      raw_text: 'original',
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
        createElement(TaskComposer, { task: composerTask(overrides) }),
      );
      expect(openingTag(markup, 'send-message')).toMatch(/\sdisabled(?:=|[\s>])/);
    }
    const chosen = renderToStaticMarkup(
      createElement(TaskComposer, {
        task: composerTask({ intent: 'reminder', ambiguousProposal, foldChoice: 'second' }),
      }),
    );
    expect(openingTag(chosen, 'send-message')).not.toMatch(/\sdisabled(?:=|[\s>])/);
  });

  it('keeps registration explicit and puts scope facts in expandable details', () => {
    const markup = renderToStaticMarkup(
      createElement(TaskComposer, {
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
