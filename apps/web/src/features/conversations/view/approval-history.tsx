'use client';

import { Badge } from '@lorelum/lumen-ui/components/badge';
import { Alert } from '@lorelum/lumen-ui/components/alert';
import { Button } from '@lorelum/lumen-ui/components/button';
import { Card } from '@lorelum/lumen-ui/components/card';
import { Bell, Files } from 'lucide-react';
import { approvalStatusLabels } from '@/features/approvals/model/approval';
import { documentEffectLabel } from '@/features/approvals/model/document-loop';
import { useApprovalHistory, useTaskHistoryResult } from '../viewmodel/use-approval-history';
import type { ApprovalHistoryOptions } from '../viewmodel/use-approval-history';
import { ReadControls } from '@/shared/ui/read-controls';

function TaskHistoryResult({ taskId }: { taskId: string }) {
  const { state, read, task } = useTaskHistoryResult(taskId);
  return (
    <div className="space-y-3 border-l-2 border-border pl-4">
      <a
        className="inline-flex min-h-8 max-lg:min-h-11 items-center text-primary underline underline-offset-4"
        href={`/tasks/${encodeURIComponent(taskId)}`}
        target="_blank"
        rel="noopener noreferrer"
      >
        查看真实提醒结果 ↗ 新标签页
      </a>
      {task ? (
        <p>
          提醒{state.error ? '上次获取的' : '本次获取的'}状态：{task.state} · {task.fire_at_local}（
          {task.timezone_id}）。这是提醒调度事实，不代表资料运行状态。
        </p>
      ) : null}
      <ReadControls state={state} read={read} label="提醒结果" />
    </div>
  );
}

export default function ApprovalHistory(props: ApprovalHistoryOptions) {
  const { reference, runId, task } = props;
  const {
    kind,
    approvalId,
    path,
    query,
    state,
    read,
    item,
    currentReminder,
    currentDocument,
    confirmationError,
    documentError,
  } = useApprovalHistory(props);
  return (
    <li className="min-w-0 py-3 [overflow-wrap:anywhere]">
      <Card material="panel" size="sm" className="space-y-4 px-5 py-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h3 className="flex min-w-0 items-center gap-2 text-sm font-semibold">
            {kind === 'document' ? (
              <Files className="size-4 shrink-0 text-primary" aria-hidden="true" />
            ) : (
              <Bell className="size-4 shrink-0 text-primary" aria-hidden="true" />
            )}
            {kind === 'document' ? '文档修改' : '提醒提议'}
            {item?.kind === 'document' ? ` · ${item.detail.relative_path}` : ''}
          </h3>
          <Badge variant="glass">{kind === 'document' ? '文档批准' : '提醒确认'}</Badge>
        </div>
        <a
          className="inline-flex min-h-8 max-lg:min-h-11 items-center text-primary underline underline-offset-4"
          href={`${path}?${query}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          完整预览与批准结果 ↗ 新标签页
        </a>
        <p className="text-sm text-muted-foreground">
          {currentReminder
            ? '本次确认仅授权这条冻结提醒，并继续同一运行；文档修改与后继提议仍需单独批准。'
            : currentDocument
              ? '本次授权仅针对以下冻结内容，并在原等待点有效时继续同一运行。'
              : '本处只读。'}
          {state.error
            ? '最新结果读取失败；下方仅保留上次获取的事实，当前效果尚未确认。'
            : '决议、工具效果与运行终态分别读取，不是原子快照。'}
        </p>
        {item?.kind === 'task' ? (
          <div className="space-y-4">
            <p>提醒决议：{approvalStatusLabels[item.detail.status]}</p>
            <dl className="grid gap-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-muted-foreground">你的原话</dt>
                <dd className="whitespace-pre-wrap">
                  {item.detail.original_text ?? '此旧提议未保留原话。'}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">冻结本地时间与已确认时区</dt>
                <dd>
                  {item.detail.fire_at_local} · {item.detail.snapshot.timezone_id}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">提议有效期</dt>
                <dd>{item.detail.expires_at}</dd>
              </div>
            </dl>
            <h4 className="font-medium">本次完整冻结确认正文</h4>
            <pre className="whitespace-pre-wrap font-sans text-sm leading-7 [overflow-wrap:anywhere]">
              {item.detail.echo_text}
            </pre>
            <p className="text-sm text-muted-foreground">
              到点在调度器运行时尝试通知，不保证准时响；取消不代表已送通知可以撤回。
            </p>
            {currentReminder && item.detail.status === 'pending' && task ? (
              <Button
                disabled={
                  task.busy ||
                  task.reading ||
                  task.stopping ||
                  task.streaming ||
                  task.effectsUnknown ||
                  Boolean(task.readError) ||
                  state.reading ||
                  Boolean(state.error)
                }
                data-testid="confirm-reminder-inline"
                onClick={() => void task.confirmReminder(item.detail)}
              >
                {task.busy
                  ? '正在确认并继续…'
                  : confirmationError
                    ? '核对原确认并继续（同键）'
                    : item.detail.kind === 'cancel_task'
                      ? '确认取消并继续'
                      : '确认创建并继续'}
              </Button>
            ) : null}
            {confirmationError ? (
              <p role="alert" className="text-sm">
                {confirmationError}
              </p>
            ) : null}
            {item.detail.result.task_id ? (
              <TaskHistoryResult
                key={`${item.detail.result.task_id}:${task?.run?.run_id === runId ? task.run.status : 'history'}`}
                taskId={item.detail.result.task_id}
              />
            ) : (
              <p className="text-muted-foreground">没有真实提醒结果引用，不表示已创建或已调度。</p>
            )}
            {item.detail.result.successor_approval_id ? (
              <a
                className="block min-h-8 max-lg:min-h-11 py-2 text-primary underline"
                href={`/approvals/${encodeURIComponent(item.detail.result.successor_approval_id)}?${query}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                查看实际后继提议 ↗
              </a>
            ) : null}
            {item.detail.recreated_from ? (
              <a
                className="block min-h-8 max-lg:min-h-11 py-2 text-primary underline"
                href={`/approvals/${encodeURIComponent(item.detail.recreated_from)}?${query}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                查看前驱提议 ↗
              </a>
            ) : null}
          </div>
        ) : null}
        {item?.kind === 'document' ? (
          <div className="space-y-4">
            <p>
              授权决议：
              {item.detail.state === 'approved'
                ? '已授权'
                : item.detail.state === 'rejected'
                  ? '已拒绝'
                  : '等待审阅'}
              。批准不代表文件已保存。
            </p>
            {item.detail.effect.status === 'unknown' ? (
              <Alert color="warning" variant="glass">
                <Alert.Content>
                  <Alert.Title>可能已写入，原动作结果未知</Alert.Title>
                  <Alert.Description>
                    不能安全重做。只读核对原运行与效果，并联系本机维护者排查；当前内容相同也不能将原调用判为成功。
                  </Alert.Description>
                </Alert.Content>
              </Alert>
            ) : (
              <p
                className={
                  item.detail.effect.status === 'verified' ? 'font-medium text-foreground' : ''
                }
              >
                {item.detail.state === 'approved' && item.detail.effect.status === 'not_started'
                  ? '已授权，尚无保存结果。回到原运行，读取当前资格后明确继续。'
                  : item.detail.effect.status === 'applied'
                    ? '已记录写入，尚未完成后续全文核对。'
                    : item.detail.effect.status === 'verified'
                      ? '✓ 已保存并核对（本项）'
                      : documentEffectLabel[item.detail.effect.status]}
              </p>
            )}
            <dl className="space-y-2 text-sm">
              <div>
                <dt className="text-muted-foreground">目标</dt>
                <dd className="font-mono">{item.detail.relative_path}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">登记标识（原名称见运行冻结范围）</dt>
                <dd className="font-mono">{item.detail.workspace_id}</dd>
              </div>
            </dl>
            {currentDocument && item.detail.state === 'pending' && task ? (
              <div className="space-y-4">
                <h4 className="font-medium">完整冻结修改与授权正文</h4>
                <p>替换前</p>
                <pre className="whitespace-pre-wrap font-mono [overflow-wrap:anywhere]">
                  {item.detail.preview.before}
                </pre>
                <p>替换后</p>
                <pre className="whitespace-pre-wrap font-mono [overflow-wrap:anywhere]">
                  {item.detail.preview.after}
                </pre>
                <p>实际将写入的完整目标</p>
                <pre className="whitespace-pre-wrap font-mono [overflow-wrap:anywhere]">
                  {item.detail.exact_new_content}
                </pre>
                <p>冻结授权正文</p>
                <pre className="whitespace-pre-wrap font-mono [overflow-wrap:anywhere]">
                  {item.detail.preview.body}
                </pre>
                <Button
                  disabled={
                    task.busy ||
                    task.reading ||
                    task.stopping ||
                    task.streaming ||
                    task.effectsUnknown ||
                    Boolean(task.readError) ||
                    state.reading ||
                    Boolean(state.error)
                  }
                  data-testid="confirm-document-inline"
                  onClick={() => void task.confirmDocument(item.detail)}
                >
                  {task.busy
                    ? '正在授权并继续…'
                    : documentError
                      ? '核对原授权并继续（同键）'
                      : '授权并继续'}
                </Button>
              </div>
            ) : null}
            {documentError ? (
              <p role="alert" className="text-sm">
                {documentError}
              </p>
            ) : null}
            <details className="text-sm">
              <summary className="cursor-pointer py-2 font-medium">版本与执行证据</summary>
              <dl className="space-y-3 font-mono">
                <div>
                  <dt>基线 SHA-256</dt>
                  <dd>{item.detail.base_version}</dd>
                </div>
                <div>
                  <dt>目标 SHA-256</dt>
                  <dd>{item.detail.new_version}</dd>
                </div>
                <div>
                  <dt>写入引用</dt>
                  <dd>{item.detail.effect.apply_invocation_id ?? '尚无已接受证据'}</dd>
                </div>
                <div>
                  <dt>新全文读取引用</dt>
                  <dd>{item.detail.effect.read_invocation_id ?? '尚无已接受证据'}</dd>
                </div>
              </dl>
            </details>
            {item.detail.replaces_approval_id ? (
              <a
                className="block min-h-8 max-lg:min-h-11 py-2 text-primary underline"
                href={`/document-approvals/${encodeURIComponent(item.detail.replaces_approval_id)}?${query}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                查看前驱批准 ↗
              </a>
            ) : null}
            {item.detail.effect.successor_approval_id ? (
              <a
                className="block min-h-8 max-lg:min-h-11 py-2 text-primary underline"
                href={`/document-approvals/${encodeURIComponent(item.detail.effect.successor_approval_id)}?${query}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                查看冲突后继提议（需单独批准）↗
              </a>
            ) : null}
          </div>
        ) : null}
        <ReadControls state={state} read={read} label="本项批准与效果" />
        <details className="text-sm text-muted-foreground">
          <summary className="cursor-pointer py-2">批准技术信息</summary>
          <p className="font-mono">{approvalId}</p>
          {item?.kind === 'task' ? (
            <dl className="mt-3 space-y-2">
              <div>
                <dt>展示模板</dt>
                <dd>{item.detail.presentation_version}</dd>
              </div>
              <div>
                <dt>展示校验值</dt>
                <dd className="font-mono">{item.detail.presentation_hash}</dd>
              </div>
              <div>
                <dt>服务端冻结偏移与重复时刻</dt>
                <dd>
                  offset_seconds={item.detail.snapshot.offset_seconds} · fold=
                  {item.detail.snapshot.fold}
                </dd>
              </div>
            </dl>
          ) : null}
          <p>
            {reference.seq
              ? `首次批准事件 seq ${reference.seq}`
              : '从运行等待点取得引用；事件索引仍需读取。'}
          </p>
        </details>
      </Card>
    </li>
  );
}
