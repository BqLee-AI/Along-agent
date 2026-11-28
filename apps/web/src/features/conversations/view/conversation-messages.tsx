'use client';

import { memo } from 'react';
import { decodeChatMessage, type MessageHistoryItem, type RunView } from '@along/contracts';
import { Message } from '@lorelum/lumen-ui/pro/message';
import { Tooltip } from '@lorelum/lumen-ui/components/tooltip';
import { Badge } from '@lorelum/lumen-ui/components/badge';
import { Info } from 'lucide-react';
import { modelSelectionLabel, runStatusLabel, type RunTranscript } from '../model/conversation-run';
import { AssistantMarkdown } from './assistant-markdown';
import { CopyReplyButton } from './copy-reply-button';

const bubbleClass =
  'min-w-0 self-start rounded-xl! bg-(--chat-bubble)! text-sm leading-6 [overflow-wrap:anywhere] after:pointer-events-none after:absolute after:top-3.5 after:h-2.5 after:w-2 after:bg-(--chat-bubble) after:content-[""]';
const userBubbleClass = `${bubbleClass} [--chat-bubble:color-mix(in_oklab,var(--brand-ink)_26%,var(--background))] after:-right-1.5 after:[clip-path:polygon(0_0,100%_50%,0_100%)]`;
const assistantBubbleClass = `${bubbleClass} [--chat-bubble:color-mix(in_oklab,var(--foreground)_10%,var(--background))] after:-left-1.5 after:[clip-path:polygon(100%_0,0_50%,100%_100%)]`;

function UserMessage({ content, skill }: { content: string; skill?: MessageHistoryItem['skill'] }) {
  const attached = decodeChatMessage(content);
  return (
    <>
      {skill ? (
        <Badge
          variant="glass"
          className="mb-1 max-w-full whitespace-normal [overflow-wrap:anywhere]"
        >
          技能 · {skill.name} · 版本 {skill.revision}
        </Badge>
      ) : null}
      {attached?.files_to_analyze_as_data.length ? (
        <ul aria-label="附件" className="mb-1 space-y-1 text-xs">
          {attached.files_to_analyze_as_data.map((file, index) => (
            <li key={index}>
              <details>
                <summary className="cursor-pointer">{file.name}</summary>
                <pre className="max-h-60 overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere]">
                  {file.text}
                </pre>
              </details>
            </li>
          ))}
        </ul>
      ) : null}
      <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">
        {attached?.instruction ?? content}
      </p>
    </>
  );
}

type ReplyRun = Pick<RunView, 'status' | 'model_selection'>;
type ReplyFacts = Pick<RunTranscript, 'goal_result' | 'usage'>;

const goalLabels = {
  completed: '已完成',
  partial: '部分完成',
  blocked: '待补充或处理',
  cancelled: '已停止',
  unknown: '结果待核对',
} satisfies Record<NonNullable<ReplyFacts['goal_result']>['status'], string>;

const outcomeLabels = {
  achieved: '已完成',
  not_done: '未完成',
  blocked: '受阻',
  unknown: '待核对',
} satisfies Record<NonNullable<ReplyFacts['goal_result']>['outcomes'][number]['status'], string>;

const tokenFormat = new Intl.NumberFormat('zh-CN');

function ReplyActions({
  text,
  run,
  facts,
}: {
  text: string;
  run?: ReplyRun | null;
  facts?: ReplyFacts;
}) {
  const goal = facts?.goal_result;
  const usage = facts?.usage;
  const tokens = usage?.tokens;
  const completed = goal?.outcomes.filter((outcome) => outcome.status === 'achieved').length;
  return (
    <div className="flex items-center gap-1">
      <CopyReplyButton text={text} />
      {run ? (
        <Tooltip>
          <Tooltip.Trigger
            type="button"
            aria-label="本次运行信息"
            className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring max-lg:size-11"
          >
            <Info className="size-4" aria-hidden="true" />
          </Tooltip.Trigger>
          <Tooltip.Content
            className="w-72 max-w-[calc(100vw-2rem)] wrap-anywhere"
            side="bottom"
            align="start"
          >
            <div className="space-y-2 text-left">
              <div className="flex items-center justify-between gap-3">
                <span className="font-medium">任务结果</span>
                <span>
                  {goal
                    ? goalLabels[goal.status]
                    : run.status === 'done'
                      ? '未记录任务结果'
                      : runStatusLabel[run.status]}
                </span>
              </div>
              {goal ? (
                <ul className="space-y-1 border-b border-separator pb-2">
                  {goal.outcomes.slice(0, 3).map((outcome, index) => (
                    <li key={index} className="line-clamp-2">
                      <span className="text-muted-foreground">
                        {outcomeLabels[outcome.status]} ·{' '}
                      </span>
                      {outcome.description}
                    </li>
                  ))}
                  {goal.outcomes.length > 3 ? (
                    <li className="text-muted-foreground">
                      {completed}/{goal.outcomes.length} 项完成
                    </li>
                  ) : null}
                </ul>
              ) : null}
              <dl className="space-y-1">
                <div className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">Token 用量</dt>
                  <dd className="tabular-nums">
                    {tokens == null ? '未记录' : tokenFormat.format(tokens)}
                  </dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">模型费用</dt>
                  <dd>未提供</dd>
                </div>
              </dl>
              <p className="border-t border-separator pt-2 text-muted-foreground">
                {modelSelectionLabel(run.model_selection)}
              </p>
            </div>
          </Tooltip.Content>
        </Tooltip>
      ) : null}
    </div>
  );
}

export const MessageRow = memo(function MessageRow({
  message,
  run,
  facts,
}: {
  message: MessageHistoryItem;
  run?: ReplyRun | null;
  facts?: ReplyFacts;
}) {
  return (
    <li className="min-w-0 space-y-2" data-message-role={message.role}>
      <Message from={message.role === 'user' ? 'user' : 'assistant'}>
        <Message.Content
          variant="bubble"
          className={message.role === 'user' ? userBubbleClass : assistantBubbleClass}
        >
          {message.role === 'user' ? (
            <UserMessage content={message.content} skill={message.skill} />
          ) : (
            <AssistantMarkdown text={message.content} />
          )}
        </Message.Content>
      </Message>
      {message.role === 'assistant' ? (
        <ReplyActions text={message.content} run={run} facts={facts} />
      ) : null}
    </li>
  );
});

export function StreamingMessage({
  original,
  skill,
  text,
  streaming,
  answerFinal = false,
  run,
  facts,
}: {
  original: string | null;
  skill?: MessageHistoryItem['skill'];
  text: string;
  streaming: boolean;
  /** A saved goal answer is durable; it is no longer a partial stream. */
  answerFinal?: boolean;
  run?: ReplyRun | null;
  facts?: ReplyFacts;
}) {
  return (
    <section id="run-reply" className="min-w-0 space-y-6" aria-label="当前回复">
      {original !== null ? (
        <Message from="user" data-message-role="user">
          <Message.Content variant="bubble" className={userBubbleClass}>
            <UserMessage content={original} skill={skill} />
          </Message.Content>
        </Message>
      ) : null}
      <Message from="assistant" data-message-role="assistant" aria-busy={streaming}>
        <Message.Content variant="bubble" className={assistantBubbleClass}>
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
        </Message.Content>
        {!streaming && text ? <ReplyActions text={text} run={run} facts={facts} /> : null}
      </Message>
    </section>
  );
}
