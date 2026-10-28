'use client';

import { useEffect, useRef } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
} from '@/components/ui/alert-dialog';
import { ErrorNotice } from '@/components/page';
import { conversationHref, runStatusLabel } from '@/lib/conversation-run';
import type { ConversationTask } from './use-conversation-task';

export function ScopePaths({ title, paths }: { title: string; paths: readonly string[] }) {
  return (
    <div className="min-w-0 space-y-2">
      <h4 className="font-medium">
        {title}{' '}
        <span className="text-sm text-muted-foreground">（登记范围 {paths.length} 项）</span>
      </h4>
      {paths.length ? (
        <ul className="space-y-1 font-mono text-sm [overflow-wrap:anywhere]">
          {paths.map((path) => (
            <li key={path}>{path}</li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">无</p>
      )}
    </div>
  );
}

export function LeaveRunDialog({ task }: { task: ConversationTask }) {
  return (
    <AlertDialog open={task.leaving} onOpenChange={task.setLeaving}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>离开并断开当前执行连接？</AlertDialogTitle>
          <AlertDialogDescription>
            离开将断开当前执行连接，服务端按取消合同处理；已发生的文件效果不会撤回。此提示不是停止回执，也不保证后台继续。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>留在此页</AlertDialogCancel>
          <AlertDialogAction onClick={task.leave}>离开并断开</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function RunStatusPanel({ task }: { task: ConversationTask }) {
  const { run, selected, effectsUnknown } = task;
  if (!selected) return null;
  return (
    <section
      aria-label="此次运行事实"
      className="min-w-0 space-y-4 border-l-2 border-primary pl-4 [overflow-wrap:anywhere]"
      aria-busy={task.reading}
    >
      <div className="space-y-2">
        <h2 className="text-lg font-semibold">此次运行</h2>
        <p role="status">
          {task.streaming
            ? '执行连接中 · 持续接收真实事件'
            : run
              ? runStatusLabel[run.status]
              : '运行状态尚未确认'}
        </p>
        {run ? (
          <Badge variant="outline">
            {run.execution === 'harness' ? '资料处理' : '提醒提议'} · 第 {run.attempt_no} 次执行
          </Badge>
        ) : null}
      </div>
      {run?.workspace ? (
        <div className="space-y-3">
          <h3 className="font-medium">冻结资料范围：{run.workspace.label}</h3>
          <ScopePaths title="可读取" paths={run.workspace.readable_paths} />
          <ScopePaths title="可修改" paths={run.workspace.writable_paths} />
          <p className="text-sm text-muted-foreground">
            仅操作登记的受管文件；若为副本，不直接修改未登记原件。此摘要不会重新授权或扩大原运行范围。
          </p>
        </div>
      ) : null}
      {run && !run.can_resume ? (
        <p className="text-sm text-muted-foreground">
          {run.status === 'running'
            ? '运行仍在处理；当前不可继续。'
            : '当前不可继续，请读取最新状态。'}{' '}
          资格值本身不表示尚未批准。
        </p>
      ) : null}
      {run?.status === 'cancelled' ? (
        <p>运行已停止；已发生的文件效果不会撤回，请分别核对下方结果。</p>
      ) : null}
      {effectsUnknown ? (
        <Alert>
          <AlertTitle>可能已写入，原动作结果未知</AlertTitle>
          <AlertDescription>
            仅可读取原事实与维护排查；不能盲目重做、覆盖或另开同目标任务。
          </AlertDescription>
        </Alert>
      ) : null}
      <Button variant="outline" disabled={task.reading} onClick={() => void task.refresh(true)}>
        {task.reading ? '正在读取状态…' : '读取最新状态'}
      </Button>
      <a
        className="block py-2 text-sm text-primary underline underline-offset-4"
        href="#run-results"
      >
        查看修改与结果 ↓
      </a>
      <details className="rounded-lg border border-border bg-card p-4">
        <summary className="cursor-pointer font-medium">此运行的操作</summary>
        <div className="mt-4 space-y-4">
          <p className="text-sm text-muted-foreground">
            展开和读取都不会执行。只有明确继续才处理原等待点，停止以服务端回执为准。
          </p>
          <Button
            className="w-full"
            disabled={
              effectsUnknown ||
              task.busy ||
              task.reading ||
              Boolean(task.readError) ||
              task.stopping ||
              !run ||
              ['done', 'failed', 'cancelled'].includes(run.status) ||
              (!run.can_resume && !task.retryResume)
            }
            onClick={() => void task.resume()}
          >
            {task.busy
              ? '正在继续…'
              : run?.can_resume
                ? '继续此运行'
                : task.retryResume && run && !['done', 'failed', 'cancelled'].includes(run.status)
                  ? '重试原继续请求（同键）'
                  : '当前不可继续'}
          </Button>
          {task.retryResume ? (
            <p className="text-sm text-muted-foreground">
              重试仍绑定原等待点与原请求键，不会创建新消息、重新批准或新运行。
            </p>
          ) : null}
          <div className="border-t border-border pt-4">
            <Button
              variant="outline"
              disabled={
                task.stopping ||
                !(
                  task.streaming ||
                  run?.status === 'running' ||
                  run?.status === 'suspended_approval'
                )
              }
              onClick={() => void task.stop()}
            >
              {task.stopping ? '正在停止…' : '停止此运行'}
            </Button>
            <p className="mt-2 text-sm text-muted-foreground">
              停止不撤回已发生效果；断开连接本身不是停止回执。
            </p>
          </div>
        </div>
      </details>
      {task.error ? <ErrorNotice message={task.error} /> : null}
      {task.readError ? (
        <ErrorNotice message={`运行状态未读取成功，先前内容保留。${task.readError}`} />
      ) : null}
      <details className="text-sm text-muted-foreground">
        <summary className="cursor-pointer py-2">运行技术信息</summary>
        <dl className="space-y-2">
          <div>
            <dt>会话</dt>
            <dd className="font-mono">{selected.conversationId}</dd>
          </div>
          <div>
            <dt>运行</dt>
            <dd className="font-mono">{selected.runId}</dd>
          </div>
          {run ? (
            <div>
              <dt>本次执行</dt>
              <dd className="font-mono">{run.attempt_id}</dd>
            </div>
          ) : null}
        </dl>
      </details>
      <p className="text-sm text-muted-foreground">
        刷新、重登和历史链接只读取，不会自动继续或重新发送。
      </p>
    </section>
  );
}

export function TaskComposer({ task }: { task: ConversationTask }) {
  const workspace = task.workspaces.find((item) => item.workspace_id === task.workspaceId);
  const errorSummary = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (task.error) errorSummary.current?.focus();
  }, [task.error]);
  return (
    <section
      className="space-y-6 rounded-xl border border-border bg-card p-4 md:p-6"
      aria-label="开始新任务"
    >
      <div>
        <h2 className="text-lg font-semibold">开始一件事</h2>
        <p className="mt-2 text-muted-foreground">先选目标，再明确提交。选择和填写本身不会执行。</p>
      </div>
      <fieldset disabled={task.active || task.sendUncertain} className="grid gap-3 sm:grid-cols-2">
        <legend className="mb-3 font-medium">你想做什么</legend>
        {(
          [
            { value: 'reminder', title: '创建提醒', description: '提出提醒，审阅后再登记。' },
            { value: 'document', title: '处理资料', description: '先选受管资料，修改前审阅预览。' },
          ] as const
        ).map((item) => (
          <label
            key={item.value}
            className={`flex min-h-24 cursor-pointer items-start gap-3 rounded-lg border p-4 ${task.intent === item.value ? 'border-primary bg-accent' : 'border-border'}`}
          >
            <input
              type="radio"
              name="task-intent"
              className="mt-1 h-5 w-5 accent-primary"
              checked={task.intent === item.value}
              onChange={() => task.setIntent(item.value)}
            />
            <span>
              <span className="block font-medium">{item.title}</span>
              <span className="mt-1 block text-sm text-muted-foreground">{item.description}</span>
            </span>
          </label>
        ))}
      </fieldset>
      {task.intent ? (
        <form
          className="space-y-6"
          onSubmit={(event) => {
            event.preventDefault();
            void task.send();
          }}
        >
          {task.intent === 'document' ? (
            <section className="space-y-4" aria-busy={task.workspaceState === 'loading'}>
              <h3 className="font-semibold">1 选择资料范围</h3>
              <div className="space-y-2">
                <Label htmlFor="workspace">已登记资料（必须明确选择）</Label>
                <select
                  id="workspace"
                  className="h-11 w-full rounded-lg border border-input bg-card px-3 text-base"
                  value={task.workspaceId}
                  disabled={task.active || task.sendUncertain || task.workspaceState !== 'ready'}
                  onChange={(event) => task.setWorkspaceId(event.target.value)}
                >
                  <option value="">请选择读取成功的登记</option>
                  {task.workspaces.map((item) => (
                    <option key={item.workspace_id} value={item.workspace_id}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </div>
              {task.workspaceState === 'loading' ? (
                <p role="status" className="text-muted-foreground">
                  正在读取登记；范围尚未核验，暂不能开始处理。目标仍可编辑。
                </p>
              ) : null}
              {task.workspaceError ? <ErrorNotice message={task.workspaceError} /> : null}
              {task.workspaceState === 'ready' && !task.workspaces.length ? (
                <Alert>
                  <AlertTitle>没有可选登记</AlertTitle>
                  <AlertDescription>
                    资料登记不是文件目录。请由本机维护者按账户中的说明配置受管资料，不能输入任意宿主路径。
                  </AlertDescription>
                </Alert>
              ) : null}
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  type="button"
                  variant="outline"
                  disabled={task.workspaceState === 'loading'}
                  onClick={() => void task.readWorkspaces()}
                >
                  重新读取登记
                </Button>
                <Link
                  className="py-2 text-sm text-primary underline underline-offset-4"
                  href="/account"
                >
                  账户与本机维护说明
                </Link>
              </div>
              {workspace && task.workspaceState === 'ready' ? (
                <div className="space-y-4 rounded-lg bg-muted p-4">
                  <h4 className="font-medium">{workspace.label}</h4>
                  <p className="text-sm">
                    只操作此登记的受管文件；若为副本，不直接修改未登记原件。
                  </p>
                  <div className="grid gap-4 md:grid-cols-2">
                    <ScopePaths title="可读取" paths={workspace.readable_paths} />
                    <ScopePaths title="可修改" paths={workspace.writable_paths} />
                  </div>
                  {!workspace.writable_paths.length ? (
                    <p className="text-sm">此登记不可修改，可提出只读资料任务。</p>
                  ) : null}
                </div>
              ) : null}
            </section>
          ) : null}
          <div className="space-y-2">
            <Label htmlFor="task-message">
              {task.intent === 'document' ? '2 你希望完成什么（完整原话）' : '提醒原话'}
            </Label>
            <Textarea
              id="task-message"
              className="min-h-36"
              value={task.input}
              disabled={task.active || task.sendUncertain}
              aria-describedby={`task-help task-send-reason${task.error ? ' task-form-error' : ''}`}
              onChange={(event) => task.setInput(event.target.value)}
            />
            <p id="task-help" className="text-sm text-muted-foreground">
              {task.intent === 'document'
                ? '说明目标、资料与修改要求。修改前先给冻结预览；批准后还需回到原运行，读取状态并明确继续。资料能力不可用时会明确报错，不切换提醒路径。'
                : '请包含明确日期、年份、时间与时区。沿用你已确认的时区，不从浏览器猜测；提交只是提议，批准前不会登记提醒。'}
            </p>
          </div>
          {task.ambiguousProposal ? (
            <fieldset className="space-y-3 rounded-lg border border-border p-4">
              <legend className="font-medium">重复时刻：先选择，再提交</legend>
              <p>
                {task.ambiguousProposal.wall_time}（{task.ambiguousProposal.timezone_id}
                ）出现两次。选择不确认或创建提醒。
              </p>
              {task.ambiguousProposal.candidates.map((candidate) => (
                <label className="flex min-h-11 items-center gap-3" key={candidate.fold_choice}>
                  <input
                    type="radio"
                    name="fold-choice"
                    className="h-5 w-5 accent-primary"
                    checked={task.foldChoice === candidate.fold_choice}
                    onChange={() => task.setFoldChoice(candidate.fold_choice)}
                  />
                  {candidate.fold_choice === 'first' ? '第一次' : '第二次'}（偏移{' '}
                  {candidate.offset_seconds > 0 ? '+' : ''}
                  {candidate.offset_seconds} 秒）
                </label>
              ))}
            </fieldset>
          ) : null}
          {task.error ? (
            <div id="task-form-error" ref={errorSummary} tabIndex={-1}>
              <ErrorNotice message={task.error} />
            </div>
          ) : null}
          <div className="space-y-2">
            <Button
              type="submit"
              disabled={
                !task.eligibility.allowed || Boolean(task.ambiguousProposal && !task.foldChoice)
              }
            >
              {task.busy ? '正在提交…' : task.intent === 'document' ? '开始处理' : '提交提醒提议'}
            </Button>
            <p id="task-send-reason" className="text-sm text-muted-foreground">
              {task.eligibility.reason ??
                (task.ambiguousProposal && !task.foldChoice
                  ? '请选择一次时刻，再明确提交。'
                  : '将按上方目标和范围创建新运行。')}
            </p>
          </div>
        </form>
      ) : null}
      {task.sendUncertain ? (
        <Alert>
          <AlertTitle>首次发送结果尚未确认</AlertTitle>
          <AlertDescription>
            <p>
              尚未取得真实运行身份。请先读取会话历史核实；不要另开同目标任务。仅可显式重试同一原文与请求键。
            </p>
            <div className="mt-3 flex flex-wrap gap-3">
              <Button variant="outline" disabled={task.busy} onClick={() => void task.send(true)}>
                重试原发送（同键）
              </Button>
              <Link className="py-2 text-primary underline" href="/conversations">
                读取会话历史
              </Link>
            </div>
          </AlertDescription>
        </Alert>
      ) : null}
      {task.selected ? (
        <Link
          className="inline-flex min-h-11 items-center text-primary underline underline-offset-4"
          href={conversationHref(task.selected.conversationId, task.selected.runId)}
        >
          查看此运行的只读历史
        </Link>
      ) : null}
    </section>
  );
}
