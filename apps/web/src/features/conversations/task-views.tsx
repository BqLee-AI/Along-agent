'use client';

import { useEffect, useRef } from 'react';
import Link from 'next/link';
import { ArrowUp, Bell, Files, MessageSquare, Plus, Square, X } from 'lucide-react';
import { Dropdown } from '@lorelum/lumen-ui/components/dropdown';
import { Button } from '@lorelum/lumen-ui/components/button';
import { Textarea } from '@lorelum/lumen-ui/components/textarea';
import { Label } from '@lorelum/lumen-ui/components/label';
import { Badge } from '@lorelum/lumen-ui/components/badge';
import { Alert } from '@lorelum/lumen-ui/components/alert';
import { Dialog } from '@lorelum/lumen-ui/components/dialog';
import { Select } from '@lorelum/lumen-ui/components/select';
import { Radio } from '@lorelum/lumen-ui/components/radio';
import { Card } from '@lorelum/lumen-ui/components/card';
import { ErrorNotice } from '@/components/page';
import { runStatusLabel } from '@/lib/conversation-run';
import { shouldSubmitMessage } from './task-model';
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
  const returnFocus = useRef<HTMLElement | null>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  return (
    <Dialog open={task.leaving} onOpenChange={task.setLeaving} disablePointerDismissal>
      <Dialog.Content
        role="alertdialog"
        showCloseButton={false}
        initialFocus={() => {
          const active =
            document.activeElement instanceof HTMLElement ? document.activeElement : null;
          const menu = active?.closest<HTMLElement>('[role="menu"]');
          // Base UI labels a menu with its trigger, including during its closing transition.
          const triggerId = menu?.getAttribute('aria-labelledby');
          returnFocus.current = menu
            ? ((triggerId ? document.getElementById(triggerId) : null) ??
              document.querySelector<HTMLElement>(`[aria-controls="${menu.id}"]`) ??
              active)
            : active;
          return cancel.current;
        }}
        finalFocus={() => {
          const target = returnFocus.current;
          return target?.isConnected ? target : document.getElementById('main-content');
        }}
      >
        <Dialog.Header>
          <Dialog.Title>离开并断开当前执行连接？</Dialog.Title>
          <Dialog.Description>
            离开将断开当前执行连接，服务端按取消合同处理；已发生的文件效果不会撤回。此提示不是停止回执，也不保证后台继续。
          </Dialog.Description>
        </Dialog.Header>
        <Dialog.Footer>
          <Dialog.Close render={<Button ref={cancel} variant="glass" color="default" />}>
            留在此页
          </Dialog.Close>
          <Button onClick={task.leave}>离开并断开</Button>
        </Dialog.Footer>
      </Dialog.Content>
    </Dialog>
  );
}

export function RunStatusPanel({ task }: { task: ConversationTask }) {
  const { run, selected, effectsUnknown } = task;
  if (!selected) return null;
  const waiting = run?.status === 'suspended_approval';
  const resumable = Boolean(
    run &&
    !['done', 'failed', 'cancelled'].includes(run.status) &&
    (run.can_resume || task.retryResume),
  );
  return (
    <section
      aria-label="此次运行事实"
      className="min-w-0 space-y-3 text-sm [overflow-wrap:anywhere]"
    >
      {effectsUnknown ? (
        <Alert role="alert" color="warning">
          <Alert.Content>
            <Alert.Title>可能已写入，原动作结果未知</Alert.Title>
            <Alert.Description>
              不能重做或另开同目标任务。请只读核对原事实，并联系本机维护者排查。
            </Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}
      {waiting || resumable ? (
        <div className="space-y-3 p-4" data-testid="run-waiting">
          <p className="font-medium">
            {run?.can_resume ? '已可继续原运行' : '此运行正在等待审阅或继续'}
          </p>
          <p className="text-muted-foreground">
            请核对下方批准与结果。提醒可就地确认并继续；文档批准不会自动继续，也不表示文件已保存。
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
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
              data-testid="resume-run"
            >
              {task.busy
                ? '正在继续…'
                : run?.can_resume
                  ? '继续此运行'
                  : task.retryResume
                    ? '重试原继续请求（同键）'
                    : '等待继续资格'}
            </Button>
            <Button
              variant="glass"
              color="default"
              disabled={task.reading}
              onClick={() => void task.refresh(true)}
            >
              {task.reading ? '正在读取…' : '读取最新状态'}
            </Button>
            <Button
              variant="clear"
              color="default"
              disabled={task.stopping || task.streaming}
              onClick={() => void task.stop()}
            >
              {task.stopping ? '正在停止…' : '停止此运行'}
            </Button>
          </div>
          {task.retryResume ? (
            <p className="text-muted-foreground">
              重试绑定原等待点与原请求键，不会创建新消息或重新批准。
            </p>
          ) : null}
        </div>
      ) : null}
      <details className="px-4 py-2" data-testid="run-facts">
        <summary className="min-h-11 content-center text-muted-foreground">
          {task.streaming ? '正在回复' : run ? runStatusLabel[run.status] : '运行状态尚未确认'} ·
          运行详情
        </summary>
        <div className="space-y-4 pb-3 pt-2">
          {run ? (
            <Badge variant="glass">
              {run.execution === 'harness'
                ? run.workspace
                  ? '资料处理'
                  : 'Agent 对话'
                : '提醒提议'}{' '}
              · 第 {run.attempt_no} 次执行
            </Badge>
          ) : null}
          {run?.workspace ? (
            <div className="space-y-3">
              <h3>冻结资料范围：{run.workspace.label}</h3>
              <ScopePaths title="可读取" paths={run.workspace.readable_paths} />
              <ScopePaths title="可修改" paths={run.workspace.writable_paths} />
              <p className="text-muted-foreground">
                仅操作登记的受管文件；若为副本，不直接修改未登记原件。此摘要不会重新授权或扩大原运行范围。
              </p>
            </div>
          ) : null}
          <dl className="space-y-2">
            <div>
              <dt className="text-muted-foreground">会话</dt>
              <dd className="font-mono">{selected.conversationId}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">运行</dt>
              <dd className="font-mono">{selected.runId}</dd>
            </div>
            {run ? (
              <div>
                <dt className="text-muted-foreground">本次执行</dt>
                <dd className="font-mono">{run.attempt_id}</dd>
              </div>
            ) : null}
          </dl>
          <p className="text-muted-foreground">
            刷新与历史链接只读取；停止不撤回已发生的效果，断开连接不是停止回执。
          </p>
          <div className="flex flex-wrap gap-3">
            <Button
              variant="glass"
              color="default"
              disabled={task.reading}
              onClick={() => void task.refresh(true)}
            >
              读取最新状态
            </Button>
            <a
              className="inline-flex min-h-11 items-center text-primary underline"
              href="#run-results"
            >
              查看批准与结果
            </a>
          </div>
        </div>
      </details>
    </section>
  );
}

export function TaskComposer({ task }: { task: ConversationTask }) {
  const workspace = task.workspaces.find((item) => item.workspace_id === task.workspaceId);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const allowed = task.eligibility.allowed && !(task.ambiguousProposal && !task.foldChoice);
  const canStop = task.streaming || task.run?.status === 'running';
  useEffect(() => {
    const input = textarea.current;
    if (!input) return;
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
  }, [task.input]);
  const blockedReason = task.effectsUnknown
    ? '原操作效果未知，不能重新发送；请只读核对。'
    : task.reading
      ? '正在读取会话…'
      : task.run?.status === 'suspended_approval' ||
          task.runs.some((run) => run.status === 'suspended_approval')
        ? '请先审阅并明确继续原运行，不能另发消息绕过等待点。'
        : task.run?.status === 'running' || task.runs.some((run) => run.status === 'running')
          ? '原运行仍在处理。'
          : task.ambiguousProposal && !task.foldChoice
            ? '请选择一次时刻，再明确提交。'
            : task.active
              ? task.eligibility.reason
              : null;
  return (
    <section
      className="flex max-h-[calc(100dvh-10rem)] min-h-0 min-w-0 flex-col gap-2 overflow-y-auto p-1"
      aria-label="对话输入"
      data-testid="chat-composer"
    >
      {task.error ? (
        <div id="task-form-error">
          <ErrorNotice message={task.error} />
        </div>
      ) : null}
      {task.readError ? (
        <div className="space-y-2">
          <ErrorNotice message={`会话事实未完整读取，暂不能发送。${task.readError}`} />
          <Button
            variant="glass"
            color="default"
            disabled={task.reading}
            onClick={() => void task.refresh()}
          >
            重新读取会话
          </Button>
        </div>
      ) : null}
      {task.sendUncertain ? (
        <Alert role="alert" color="warning">
          <Alert.Content>
            <Alert.Title>发送结果尚未确认</Alert.Title>
            <Alert.Description>
              <p>先读取历史核实，不要另开同目标任务。仅可显式重试同一原文与请求键。</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button
                  variant="glass"
                  color="default"
                  disabled={task.busy || task.effectsUnknown}
                  onClick={() => void task.send(true)}
                >
                  重试原发送（同键）
                </Button>
                <Link
                  className="inline-flex min-h-11 items-center text-primary underline"
                  href="/conversations"
                >
                  读取会话历史
                </Link>
              </div>
            </Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}
      <Card material="panel" size="sm" className="min-h-0 min-w-0">
        <form
          className="flex min-h-0 min-w-0 flex-col p-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (allowed) void task.send();
          }}
        >
          <div className="max-h-[32dvh] min-h-0 space-y-3 overflow-y-auto overscroll-contain">
            {task.intent !== 'chat' ? (
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className="inline-flex min-w-0 items-center gap-1 pl-3 text-sm"
                  data-testid="selected-tool"
                >
                  {task.intent === 'reminder' ? (
                    <Bell className="size-4" aria-hidden="true" />
                  ) : (
                    <Files className="size-4" aria-hidden="true" />
                  )}
                  {task.intent === 'reminder' ? '创建提醒' : '处理资料'}
                  <Button
                    type="button"
                    variant="clear"
                    color="default"
                    size="icon"
                    disabled={task.active}
                    aria-label="移除工具，返回普通对话"
                    onClick={() => task.setIntent('chat')}
                  >
                    <X aria-hidden="true" />
                  </Button>
                </span>
              </div>
            ) : null}
            {task.intent === 'document' ? (
              <section
                className="space-y-2 pb-2"
                aria-label="资料范围"
                aria-busy={task.workspaceState === 'loading'}
              >
                <Label htmlFor="workspace" className="text-sm">
                  选择已登记资料
                </Label>
                <Select
                  items={[
                    { value: '', label: '请选择资料范围' },
                    ...task.workspaces.map((item) => ({
                      value: item.workspace_id,
                      label: item.label,
                    })),
                  ]}
                  value={task.workspaceId}
                  disabled={task.active || task.workspaceState !== 'ready'}
                  onValueChange={(value) => {
                    if (value !== null) task.setWorkspaceId(value);
                  }}
                >
                  <Select.Trigger id="workspace" className="w-full max-w-full">
                    <Select.Value />
                  </Select.Trigger>
                  <Select.Content>
                    <Select.Item value="">请选择资料范围</Select.Item>
                    {task.workspaces.map((item) => (
                      <Select.Item key={item.workspace_id} value={item.workspace_id}>
                        {item.label}
                      </Select.Item>
                    ))}
                  </Select.Content>
                </Select>
                {task.workspaceState === 'loading' ? (
                  <p role="status" className="text-sm text-muted-foreground">
                    正在读取登记…
                  </p>
                ) : null}
                {task.workspaceError ? <ErrorNotice message={task.workspaceError} /> : null}
                {task.workspaceState === 'ready' && !task.workspaces.length ? (
                  <p className="text-sm text-muted-foreground">
                    没有可选登记，请查看账户中的本机维护说明。不能输入任意宿主路径。
                  </p>
                ) : null}
                <details className="px-3 py-1 text-sm" data-testid="workspace-scope">
                  <summary className="min-h-11 content-center">
                    {workspace && task.workspaceState === 'ready'
                      ? `${workspace.label} · 查看登记范围`
                      : '资料登记与范围说明'}
                  </summary>
                  <div className="space-y-3 pb-3 pt-2">
                    <p>
                      只操作此登记的受管文件；若为副本，不直接修改未登记原件。修改前先审阅冻结预览，批准后仍需明确继续。
                    </p>
                    {workspace && task.workspaceState === 'ready' ? (
                      <>
                        <ScopePaths title="可读取" paths={workspace.readable_paths} />
                        <ScopePaths title="可修改" paths={workspace.writable_paths} />
                        {!workspace.writable_paths.length ? (
                          <p>此登记不可修改，可提出只读资料任务。</p>
                        ) : null}
                      </>
                    ) : null}
                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        variant="glass"
                        color="default"
                        disabled={task.workspaceState === 'loading'}
                        onClick={() => void task.readWorkspaces()}
                      >
                        重新读取登记
                      </Button>
                      <Link
                        className="inline-flex min-h-11 items-center text-primary underline"
                        href="/account"
                      >
                        账户与本机维护说明
                      </Link>
                    </div>
                  </div>
                </details>
              </section>
            ) : null}
            {task.intent === 'reminder' ? (
              <p id="task-help" className="text-sm text-muted-foreground">
                请包含日期、年份、时间与时区。沿用已确认时区，不从浏览器猜测；批准前不会登记提醒。
              </p>
            ) : null}
            {task.ambiguousProposal ? (
              <fieldset className="space-y-2 p-3">
                <legend className="text-sm font-medium">此时刻出现两次，请选择</legend>
                <p className="text-sm">
                  {task.ambiguousProposal.wall_time}（{task.ambiguousProposal.timezone_id}
                  ）。选择本身不会创建提醒。
                </p>
                <Radio.Group<'first' | 'second' | ''>
                  name="fold-choice"
                  aria-label="选择重复时刻"
                  value={task.foldChoice}
                  onValueChange={task.setFoldChoice}
                >
                  {task.ambiguousProposal.candidates.map((candidate) => (
                    <Label className="min-h-11 gap-3" key={candidate.fold_choice}>
                      <Radio value={candidate.fold_choice} />
                      {candidate.fold_choice === 'first' ? '第一次' : '第二次'}（偏移{' '}
                      {candidate.offset_seconds > 0 ? '+' : ''}
                      {candidate.offset_seconds} 秒）
                    </Label>
                  ))}
                </Radio.Group>
              </fieldset>
            ) : null}
          </div>
          <Label htmlFor="task-message" className="sr-only">
            发给 Agent 的消息
          </Label>
          <Textarea
            ref={textarea}
            id="task-message"
            autoSize={false}
            variant="glass"
            className="max-h-40 min-h-16 resize-none"
            placeholder={
              task.intent === 'document'
                ? '你希望如何处理这些资料？'
                : task.intent === 'reminder'
                  ? '你希望什么时候提醒什么？'
                  : '有什么想聊的？'
            }
            value={task.input}
            disabled={task.active}
            aria-describedby={`task-send-reason${task.intent === 'reminder' ? ' task-help' : ''}${task.error ? ' task-form-error' : ''}`}
            onChange={(event) => task.setInput(event.target.value)}
            onCompositionStart={() => {
              composing.current = true;
            }}
            onCompositionEnd={() => {
              composing.current = false;
            }}
            onKeyDown={(event) => {
              if (
                shouldSubmitMessage({
                  key: event.key,
                  shiftKey: event.shiftKey,
                  isComposing: composing.current || event.nativeEvent.isComposing,
                  keyCode: event.nativeEvent.keyCode,
                })
              ) {
                event.preventDefault();
                if (allowed) event.currentTarget.form?.requestSubmit();
              }
            }}
          />
          <div className="flex min-w-0 shrink-0 items-center justify-between gap-2">
            <Dropdown>
              <Dropdown.Trigger
                render={<Button type="button" variant="clear" color="default" size="icon" />}
                disabled={task.active}
                aria-label="添加工具"
                data-testid="chat-tools"
              >
                <Plus className="size-5" aria-hidden="true" />
              </Dropdown.Trigger>
              <Dropdown.Content
                align="start"
                side="top"
                sideOffset={8}
                className="min-w-52 max-w-[calc(100vw-24px)]"
                aria-label="对话工具"
              >
                {(
                  [
                    { value: 'reminder', label: '创建提醒', icon: Bell },
                    { value: 'document', label: '处理资料', icon: Files },
                    { value: 'chat', label: '普通对话', icon: MessageSquare },
                  ] as const
                ).map(({ value, label, icon: Icon }) => (
                  <Dropdown.Item
                    key={value}
                    className="min-h-11 gap-3"
                    onClick={() => task.setIntent(value)}
                  >
                    <Icon className="size-4" aria-hidden="true" />
                    {label}
                  </Dropdown.Item>
                ))}
              </Dropdown.Content>
            </Dropdown>
            <span className="hidden text-xs text-muted-foreground sm:block">
              Enter 发送 · Shift + Enter 换行
            </span>
            {canStop ? (
              <Button
                type="button"
                variant="flat"
                color="default"
                disabled={task.stopping || !task.selected}
                aria-label="停止回复"
                onClick={() => void task.stop()}
                data-testid="stop-reply"
              >
                <Square className="size-4 fill-current" aria-hidden="true" />
                {task.stopping ? '正在停止' : '停止'}
              </Button>
            ) : (
              <Button
                type="submit"
                size="icon"
                disabled={!allowed}
                aria-label="发送消息"
                data-testid="send-message"
              >
                <ArrowUp className="size-5" aria-hidden="true" />
              </Button>
            )}
          </div>
        </form>
      </Card>
      <p
        id="task-send-reason"
        className={blockedReason ? 'px-2 text-xs leading-5 text-muted-foreground' : 'sr-only'}
      >
        {blockedReason ?? 'Enter 发送，Shift + Enter 换行。'}
      </p>
    </section>
  );
}
