'use client';

import { memo } from 'react';
import type { MessageHistoryItem } from '@along/contracts';
import { Message } from '@lorelum/lumen-ui/pro/message';
import { AssistantMarkdown } from './assistant-markdown';
import { CopyReplyButton } from './copy-reply-button';

const userBubbleClass =
  'rounded-2xl bg-[color-mix(in_oklab,var(--brand-ink)_9%,var(--background))]! text-sm leading-6';

export const MessageRow = memo(function MessageRow({ message }: { message: MessageHistoryItem }) {
  return (
    <li className="min-w-0 space-y-2" data-message-role={message.role}>
      <Message from={message.role === 'user' ? 'user' : 'assistant'}>
        <Message.Content
          variant={message.role === 'user' ? 'bubble' : 'plain'}
          className={message.role === 'user' ? userBubbleClass : 'text-sm leading-6'}
        >
          {message.role === 'user' ? (
            <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{message.content}</p>
          ) : (
            <AssistantMarkdown text={message.content} />
          )}
        </Message.Content>
      </Message>
      {message.role === 'assistant' ? <CopyReplyButton text={message.content} /> : null}
    </li>
  );
});

export function StreamingMessage({
  original,
  text,
  streaming,
  answerFinal = false,
}: {
  original: string | null;
  text: string;
  streaming: boolean;
  /** A saved goal answer is durable; it is no longer a partial stream. */
  answerFinal?: boolean;
}) {
  return (
    <section id="run-reply" className="min-w-0 space-y-6" aria-label="当前回复">
      {original !== null ? (
        <Message from="user" data-message-role="user">
          <Message.Content variant="bubble" className={userBubbleClass}>
            <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{original}</p>
          </Message.Content>
        </Message>
      ) : null}
      <Message from="assistant" data-message-role="assistant" aria-busy={streaming}>
        <Message.Content className="text-sm leading-6">
          {text ? <AssistantMarkdown text={text} streaming={streaming && !answerFinal} /> : null}
          {streaming ? (
            <p
              role="status"
              className={`flex items-center gap-2 ${text ? 'mt-2' : ''} text-[13px] text-muted-foreground`}
              data-testid="reply-waiting"
            >
              <span
                className="size-2 animate-pulse rounded-full bg-foreground motion-reduce:animate-none"
                aria-hidden="true"
              />
              {text ? <span className="sr-only">正在回复…</span> : '正在思考…'}
            </p>
          ) : !text ? (
            <p className="text-sm leading-[22px] text-secondary-foreground">
              尚未收到回复，请核对运行状态。
            </p>
          ) : null}
          {!streaming && text ? <CopyReplyButton text={text} /> : null}
        </Message.Content>
      </Message>
    </section>
  );
}
