'use client';

import { useCallback } from 'react';
import {
  ApprovalDetailSchema,
  DocumentApprovalDetailSchema,
  type ApprovalDetail,
  type DocumentApprovalDetail,
} from '@along/contracts';
import { readEnvelope, type HistoryApprovalReference } from '../../lib/conversation-run';
import { TaskDetailSchema, type TaskDetail } from '../../lib/types';
import { documentEffectLabel } from '../../lib/document-loop';
import { ReadControls, useHistoryPage } from './HistoryResource';

type ApprovalHistoryDetail =
  | { kind: 'task'; detail: ApprovalDetail }
  | { kind: 'document'; detail: DocumentApprovalDetail };

function TaskHistoryResult({ taskId }: { taskId: string }) {
  const loader = useCallback(
    async (_cursor: string | null, signal: AbortSignal) => {
      const detail = TaskDetailSchema.parse(
        await readEnvelope(
          await fetch(`/api/v1/tasks/${encodeURIComponent(taskId)}`, { cache: 'no-store', signal }),
        ),
      );
      if (detail.task_id !== taskId) throw new Error('提醒结果引用不匹配；未确认结果。');
      return { items: [detail], nextCursor: null };
    },
    [taskId],
  );
  const { state, read } = useHistoryPage<TaskDetail>(`task:${taskId}`, loader);
  const task = state.items[0];
  return (
    <div>
      <p>
        <a href={`/tasks/${encodeURIComponent(taskId)}`} target="_blank" rel="noopener noreferrer">
          查看真实提醒结果（新标签页）
        </a>
      </p>
      {task ? (
        <p>
          提醒当前状态：{task.state} · {task.fire_at_local}（{task.timezone_id}
          ）。这是提醒调度事实，不代表资料 Run 状态。
        </p>
      ) : null}
      <ReadControls state={state} read={read} label="提醒结果" />
    </div>
  );
}

export default function ApprovalHistory({
  reference,
  conversationId,
  runId,
}: {
  reference: HistoryApprovalReference;
  conversationId: string;
  runId: string;
}) {
  const { kind, approvalId } = reference;
  const path = `/${kind === 'document' ? 'document-approvals' : 'approvals'}/${encodeURIComponent(approvalId)}`;
  const query = new URLSearchParams({ conversation_id: conversationId, run_id: runId });
  const loader = useCallback(
    async (_cursor: string | null, signal: AbortSignal) => {
      const data = await readEnvelope(await fetch(`/api/v1${path}`, { cache: 'no-store', signal }));
      const item: ApprovalHistoryDetail =
        kind === 'document'
          ? { kind: 'document', detail: DocumentApprovalDetailSchema.parse(data) }
          : { kind: 'task', detail: ApprovalDetailSchema.parse(data) };
      if (item.detail.approval_id !== approvalId) throw new Error('批准引用不匹配；未确认结果。');
      return { items: [item], nextCursor: null };
    },
    [path, kind, approvalId],
  );
  const { state, read } = useHistoryPage<ApprovalHistoryDetail>(`${kind}:${approvalId}`, loader);
  const item = state.items[0];
  return (
    <li className="panel">
      <h3>
        {kind === 'document' ? '文档批准' : '提醒批准'} · 事件 {reference.seq}
      </h3>
      <p>
        <a
          className="history-link"
          href={`${path}?${query}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          查看原批准详情与当前可用操作（新标签页）
        </a>
      </p>
      <p className="muted">{approvalId}。本处只读冻结事实；可读不表示当前可授权。</p>
      {item?.kind === 'task' ? (
        <div>
          <p>批准状态：{item.detail.status}</p>
          <pre className="echo">{item.detail.echo_text}</pre>
          {item.detail.result.task_id ? (
            <TaskHistoryResult
              key={item.detail.result.task_id}
              taskId={item.detail.result.task_id}
            />
          ) : (
            <p>当前没有真实提醒结果引用；不表示已创建或已调度。</p>
          )}
          {item.detail.result.successor_approval_id ? (
            <p>
              <a
                href={`/approvals/${encodeURIComponent(item.detail.result.successor_approval_id)}?${query}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                查看实际后继提议
              </a>
            </p>
          ) : null}
          {item.detail.recreated_from ? (
            <p>
              <a
                href={`/approvals/${encodeURIComponent(item.detail.recreated_from)}?${query}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                查看前驱提议
              </a>
            </p>
          ) : null}
        </div>
      ) : null}
      {item?.kind === 'document' ? (
        <div>
          <p>批准状态：{item.detail.state}。批准不代表文件已保存。</p>
          <p>{documentEffectLabel[item.detail.effect.status]}</p>
          {item.detail.effect.apply_invocation_id ? (
            <p>已存替换证据：{item.detail.effect.apply_invocation_id}</p>
          ) : null}
          {item.detail.effect.read_invocation_id ? (
            <p>已存回读证据：{item.detail.effect.read_invocation_id}</p>
          ) : null}
          {item.detail.replaces_approval_id ? (
            <p>
              <a
                href={`/document-approvals/${encodeURIComponent(item.detail.replaces_approval_id)}?${query}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                查看前驱批准
              </a>
            </p>
          ) : null}
          {item.detail.effect.successor_approval_id ? (
            <p>
              <a
                href={`/document-approvals/${encodeURIComponent(item.detail.effect.successor_approval_id)}?${query}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                查看冲突后继提议（需单独批准）
              </a>
            </p>
          ) : null}
        </div>
      ) : null}
      <ReadControls state={state} read={read} label="批准详情" />
    </li>
  );
}
