'use client';

import Link from '@/shell/view/workspace-link';
import { memo, useMemo } from 'react';
import { conversationHref, modelSelectionLabel, runStatusLabel } from '../model/conversation-run';
import type { RunTranscript } from '../model/conversation-run';
import { runApprovalReferences } from '../model/presentation';
import type { RunHistoryEntry } from '../model/presentation';
import type { ConversationTask } from '../viewmodel/use-conversation-task';
import { AssistantMarkdown } from './assistant-markdown';
import ApprovalHistory from './approval-history';
import { GoalResultPanel } from './task-views';

const RunHistoryRow = memo(function RunHistoryRow({
  entry,
  reply,
  conversationId,
  isSelected,
  needsAction,
  showReminderResult,
  task,
  observeEffect,
}: {
  entry: RunHistoryEntry;
  reply: RunTranscript | undefined;
  conversationId: string;
  isSelected: boolean;
  needsAction: boolean;
  showReminderResult: boolean;
  task?: ConversationTask;
  observeEffect: ConversationTask['observeEffect'];
}) {
  const waiting = task?.run?.waiting;
  const approvals = useMemo(
    () => runApprovalReferences(reply?.approvals, waiting),
    [reply?.approvals, waiting],
  );
  return (
    <details
      className="min-w-0 border-t border-separator pt-4"
      open={(isSelected && (needsAction || showReminderResult)) || undefined}
      key={entry.runId}
    >
      <summary className="min-h-8 max-lg:min-h-11 content-center text-sm font-medium [overflow-wrap:anywhere]">
        运行 {entry.runId.slice(0, 8)} ·{' '}
        {task?.run
          ? runStatusLabel[task.run.status]
          : entry.history
            ? runStatusLabel[entry.history.status]
            : '状态尚未确认'}
        {isSelected ? ' · 当前所选' : ''}
      </summary>
      <div className="space-y-4 pt-3">
        <p className="text-sm text-secondary-foreground" data-testid="history-model-selection">
          运行模型：
          {modelSelectionLabel(
            entry.history?.model_selection ?? (isSelected ? task?.run?.model_selection : undefined),
          )}
        </p>
        {!isSelected && reply?.goal_result ? <GoalResultPanel result={reply.goal_result} /> : null}
        <Link
          className="inline-flex min-h-8 max-lg:min-h-11 items-center text-sm text-brand-ink underline"
          href={conversationHref(conversationId, entry.runId)}
        >
          读取此运行并操作原等待点
        </Link>
        <details className="text-sm">
          <summary className="min-h-8 max-lg:min-h-11 content-center">原话与运行文本</summary>
          <div className="space-y-3 py-3">
            {entry.history?.original.state === 'available' ? (
              <>
                <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">
                  {entry.history.original.message.content}
                </p>
                <p className="text-sm leading-[22px] text-secondary-foreground [overflow-wrap:anywhere]">
                  引用：{entry.history.original.message.message_id} ·{' '}
                  {entry.history.original.source}
                </p>
              </>
            ) : entry.history ? (
              <p className="text-secondary-foreground">
                {entry.history.original.state === 'invalid_reference'
                  ? '原话引用完整性异常，不猜测关联。'
                  : '旧运行没有可信原话引用，消息仍独立展示。'}
              </p>
            ) : null}
            {reply?.text ? <AssistantMarkdown text={reply.text} /> : null}
          </div>
        </details>
        {approvals.length ? (
          <ul className="divide-y divide-separator">
            {approvals.map((reference) => (
              <ApprovalHistory
                key={`${reference.kind}:${reference.approvalId}`}
                reference={reference}
                conversationId={conversationId}
                runId={entry.runId}
                onUnknownEffect={observeEffect}
                task={task}
              />
            ))}
          </ul>
        ) : (
          <p className="text-sm leading-[22px] text-secondary-foreground">
            当前读取范围尚无批准引用，不推断工具效果。
          </p>
        )}
      </div>
    </details>
  );
});

export function RunResults({
  task,
  conversationId,
  entries,
  needsAction,
  showReminderResult,
}: {
  task: ConversationTask;
  conversationId: string | null;
  entries: RunHistoryEntry[];
  needsAction: boolean;
  showReminderResult: boolean;
}) {
  const selected = task.selected;
  if (!entries.length || !conversationId) return null;
  return (
    <details
      id="run-results"
      open={needsAction || showReminderResult || undefined}
      className="min-w-0"
      data-testid="run-results"
    >
      <summary className="min-h-8 max-lg:min-h-11 cursor-pointer content-center text-[13px] leading-5 text-muted-foreground hover:text-foreground">
        批准与结果 · {entries.length} 次运行
      </summary>
      <div className="space-y-4 py-3">
        <p className="text-sm leading-[22px] text-secondary-foreground">
          助手文本不代表工具已执行。提醒可在此确认并继续原运行；文档批准后仍需明确继续。
        </p>
        {entries.map((entry) => {
          const isSelected = entry.runId === selected?.runId;
          return (
            <RunHistoryRow
              key={entry.runId}
              entry={entry}
              reply={task.transcript.get(entry.runId)}
              conversationId={conversationId}
              isSelected={isSelected}
              needsAction={isSelected && needsAction}
              showReminderResult={isSelected && showReminderResult}
              task={isSelected ? task : undefined}
              observeEffect={task.observeEffect}
            />
          );
        })}
      </div>
    </details>
  );
}
