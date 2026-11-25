'use client';

import { useRef } from 'react';
import Link from '@/shell/view/workspace-link';
import { ArrowUp, Bell, ChevronDown, Files, MessageSquare, Plus, Square, X } from 'lucide-react';
import type { GoalResult } from '@along/contracts';
import { Dropdown } from '@lorelum/lumen-ui/components/dropdown';
import { Button } from '@lorelum/lumen-ui/components/button';
import { PromptInput } from '@lorelum/lumen-ui/pro/prompt-input';
import { Label } from '@lorelum/lumen-ui/components/label';
import { Badge } from '@lorelum/lumen-ui/components/badge';
import { Alert } from '@lorelum/lumen-ui/components/alert';
import { Dialog } from '@lorelum/lumen-ui/components/dialog';
import { Select } from '@lorelum/lumen-ui/components/select';
import { Radio } from '@lorelum/lumen-ui/components/radio';
import { AnimatePresence, m, useReducedMotion } from 'motion/react';
import { ErrorNotice } from '@/shared/ui/page';
import {
  runStatusLabel,
  userPauseCanContinue,
} from '@/features/conversations/model/conversation-run';
import { compactCommand, shouldSubmitMessage } from '@/features/conversations/model/task';
import type { ConversationTask } from '@/features/conversations/viewmodel/use-conversation-task';
import { composerBlockedReason } from '../model/presentation';
import { useComposerDisplay } from '../viewmodel/use-composer-display';
import { chatFileAccept } from '../model/chat-files';
import { AssistantMarkdown } from './assistant-markdown';

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
            <li key={path}>{path || '工作区根目录'}</li>
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
            离开将断开当前执行连接，服务端按取消合同处理；已接受的设置、提醒或文件效果不会撤回。此提示不是停止回执，也不保证后台继续。
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

const goalStatusLabel: Record<GoalResult['status'], string> = {
  completed: '目标已完成',
  partial: '目标部分完成',
  blocked: '目标受阻',
  cancelled: '目标已停止',
  unknown: '目标结果未知',
};

const outcomeStatusLabel: Record<GoalResult['outcomes'][number]['status'], string> = {
  achieved: '已达成',
  not_done: '未完成',
  blocked: '受阻',
  unknown: '结果未知',
};

export function GoalResultPanel({
  result,
  showAnswer = true,
}: {
  result: GoalResult;
  showAnswer?: boolean;
}) {
  return (
    <section
      className="min-w-0 space-y-3 [overflow-wrap:anywhere]"
      aria-label="已保存的目标结果"
      data-testid="goal-result"
      data-goal-status={result.status}
    >
      <h3 className="font-medium">{goalStatusLabel[result.status]}</h3>
      {result.outcomes.length ? (
        <ul className="space-y-3">
          {result.outcomes.map((outcome, index) => (
            <li key={index} className="space-y-1" data-outcome-status={outcome.status}>
              <p>
                <span className="font-medium">{outcomeStatusLabel[outcome.status]}</span>
                {' · '}
                {outcome.description}
              </p>
              {outcome.receipt_refs.length ? (
                <details className="text-xs text-secondary-foreground">
                  <summary className="min-h-8 max-lg:min-h-11 content-center">
                    已接受回执 · {outcome.receipt_refs.length}
                  </summary>
                  <ul className="space-y-1 font-mono">
                    {outcome.receipt_refs.map((reference) => (
                      <li key={reference}>{reference}</li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {result.clarification ? (
        <p className="whitespace-pre-wrap">需要补充：{result.clarification.question}</p>
      ) : null}
      {showAnswer ? (
        <details>
          <summary className="min-h-11 content-center text-secondary-foreground">
            查看已保存的最终答复
          </summary>
          <AssistantMarkdown text={result.answer} />
        </details>
      ) : null}
    </section>
  );
}

export function RunStatusPanel({ task }: { task: ConversationTask }) {
  const { run, selected, effectsUnknown } = task;
  if (!selected) return null;
  const transcript = task.transcript.get(selected.runId);
  const goalResult = run?.goal_result ?? transcript?.goal_result;
  const answerVisible =
    Boolean(goalResult && task.liveReply) ||
    Boolean(
      goalResult &&
      task.messages.some(
        (message) => message.role === 'assistant' && message.content === goalResult.answer,
      ),
    );
  const waiting = run?.status === 'suspended_approval';
  const resumable = Boolean(
    run &&
    !['done', 'failed', 'cancelled'].includes(run.status) &&
    run.status !== 'paused' &&
    (run.can_resume || (run.execution_lifecycle !== 'server-owned' && task.retryResume)),
  );
  return (
    <section
      aria-label="此次运行事实"
      className="min-w-0 space-y-3 text-sm [overflow-wrap:anywhere]"
    >
      {effectsUnknown ? (
        <Alert role="alert" color="warning" variant="glass">
          <Alert.Content>
            <Alert.Title>可能已写入，原动作结果未知</Alert.Title>
            <Alert.Description>
              不能重做或另开同目标任务。请只读核对原事实，并联系本机维护者排查。
            </Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}
      {run?.document_effects?.length ? (
        <section className="space-y-3" aria-label="文件效果">
          <h3 className="font-medium">文件效果</h3>
          <ul className="space-y-3">
            {run.document_effects.map((effect) => (
              <li key={effect.invocation_id} className="space-y-1">
                <p className="font-mono">
                  {effect.workspace_id} · {effect.path}
                </p>
                <p>
                  {effect.status === 'verified'
                    ? '已保存并经新全文读取核对。'
                    : effect.status === 'applied'
                      ? '已记录写入，尚未经新全文读取核对。'
                      : effect.status === 'conflict'
                        ? effect.operation === 'create'
                          ? '目标名称已存在，此次未写入，也未覆盖。'
                          : '写前版本冲突，此次未写入。'
                        : effect.status === 'failed'
                          ? '创建未能发布，此次未写入。'
                          : '文件效果未知，可能已写入；不可自动重做。'}
                </p>
                {effect.status === 'conflict' &&
                effect.operation === 'create' &&
                goalResult?.outcomes.some((outcome) =>
                  outcome.create_resolution?.zero_write_invocation_ids.includes(
                    effect.invocation_id,
                  ),
                ) ? (
                  <p>此次撞名未写入；该目标的改名结果见已核对的文件及最终答复。</p>
                ) : null}
                <details className="text-xs text-secondary-foreground">
                  <summary className="min-h-8 max-lg:min-h-11 content-center">查看文件证据</summary>
                  <p>
                    {effect.operation === 'create' ? '创建调用' : '写入调用'}：
                    {effect.invocation_id}
                  </p>
                  <p>新全文读取：{effect.read_invocation_id ?? '尚无'}</p>
                  <p>版本：{effect.version ?? '尚无'}</p>
                </details>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {goalResult ? (
        <>
          {!answerVisible ||
          goalResult.clarification ||
          goalResult.outcomes.some((outcome) => outcome.receipt_refs.length > 0) ||
          goalResult.status === 'unknown' ? (
            <div className="py-2 text-sm">
              <GoalResultPanel result={goalResult} showAnswer={!answerVisible} />
            </div>
          ) : null}
          <ul className="space-y-3" aria-label="此次已创建的提醒">
            {run?.created_reminders?.map((receipt) => (
              <li key={receipt.invocation_id} className="space-y-1">
                <Link className="underline underline-offset-4" href={`/tasks/${receipt.task_id}`}>
                  {receipt.original_note ?? '查看提醒'} · {receipt.wall_time} {receipt.timezone_id}
                </Link>
                <p className="text-xs text-secondary-foreground">
                  已保存；排期、触发和通知请查看任务的真实记录。
                </p>
                <details className="text-xs text-secondary-foreground">
                  <summary className="min-h-8 max-lg:min-h-11 content-center">查看创建回执</summary>
                  <p className="font-mono">{receipt.invocation_id}</p>
                </details>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {run && (run.status === 'running' || run.status === 'paused') ? (
        <section className="space-y-3 border-y border-separator py-4" aria-label="运行暂停控制">
          <p role="status" aria-live="polite" className="font-medium">
            {task.pauseBusy
              ? '正在请求暂停…'
              : run.pause?.status === 'pending'
                ? '已请求暂停，正在等待安全点'
                : run.status === 'paused'
                  ? '运行已暂停'
                  : '运行中'}
          </p>
          {run.pause?.status === 'pending' ? (
            <p className="text-secondary-foreground">
              当前模型流和已接受的工具操作仍需完成裁决；这不是停止或批准。
            </p>
          ) : run.status === 'paused' ? (
            <p className="text-secondary-foreground">
              {run.pause?.reason === 'runtime'
                ? '运行正在等待服务端处理压缩；读取和刷新不会继续运行。'
                : '只有明确继续才会恢复此运行；读取和刷新不会继续。'}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {run.status === 'running' && run.can_pause && !run.pause ? (
              <Button
                variant="glass"
                color="default"
                disabled={task.pauseBusy || task.stopping || task.reading}
                onClick={() => void task.pause()}
              >
                暂停此运行
              </Button>
            ) : null}
            {userPauseCanContinue(run) ? (
              <Button
                disabled={
                  task.busy ||
                  task.pauseBusy ||
                  task.stopping ||
                  task.streaming ||
                  task.reading ||
                  Boolean(task.readError) ||
                  effectsUnknown
                }
                onClick={() => void task.continuePaused()}
              >
                {task.busy ? '正在继续…' : '明确继续此运行'}
              </Button>
            ) : null}
            {run.pause || run.status === 'paused' ? (
              <Button
                variant="glass"
                color="default"
                disabled={task.reading}
                onClick={() => void task.refresh(true)}
              >
                {task.reading ? '正在读取…' : '读取最新状态'}
              </Button>
            ) : null}
            {run.status === 'paused' || run.pause?.status === 'pending' ? (
              <Button
                variant="clear"
                color="default"
                disabled={task.stopping}
                onClick={() => void task.stop()}
              >
                {task.stopping ? '正在停止…' : '停止此运行'}
              </Button>
            ) : null}
          </div>
        </section>
      ) : null}
      {waiting || resumable ? (
        <section className="space-y-4 border-y border-separator py-4" data-testid="run-waiting">
          <p className="font-medium">
            {run?.can_resume ? '已可继续原运行' : '此运行正在等待审阅或继续'}
          </p>
          <p className="text-secondary-foreground">
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
                (!run.can_resume &&
                  (run.execution_lifecycle === 'server-owned' || !task.retryResume))
              }
              onClick={() => void task.resume()}
              data-testid="resume-run"
            >
              {task.busy
                ? '正在继续…'
                : run?.can_resume
                  ? '继续此运行'
                  : task.retryResume && run?.execution_lifecycle !== 'server-owned'
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
          {task.retryResume && run?.execution_lifecycle !== 'server-owned' ? (
            <p className="text-secondary-foreground">
              重试绑定原等待点与原请求键，不会创建新消息或重新批准。
            </p>
          ) : null}
        </section>
      ) : null}
      {!waiting &&
      !resumable &&
      !effectsUnknown &&
      !run?.workspace &&
      (task.streaming || run?.status === 'done') ? null : (
        <details id="run-facts" className="py-1" data-testid="run-facts">
          <summary className="min-h-8 max-lg:min-h-11 cursor-pointer content-center text-[13px] text-muted-foreground hover:text-foreground">
            {task.streaming ? '正在回复' : run ? runStatusLabel[run.status] : '运行状态尚未确认'} ·
            运行详情
          </summary>
          <div className="space-y-4 pb-3 pt-2">
            {run ? (
              <Badge variant="glass">
                {run.execution === 'harness'
                  ? run.workspace
                    ? '资料处理'
                    : 'Along 对话'
                  : '提醒提议'}{' '}
                · 第 {run.attempt_no} 次执行
              </Badge>
            ) : null}
            {run?.workspace ? (
              <div className="space-y-3">
                <h3>冻结资料范围：{run.workspace.label}</h3>
                <ScopePaths title="可读取" paths={run.workspace.readable_paths} />
                <ScopePaths title="可修改" paths={run.workspace.writable_paths} />
                <p className="text-secondary-foreground">
                  仅操作登记的受管文件；若为副本，不直接修改未登记原件。此摘要不会重新授权或扩大原运行范围。
                </p>
              </div>
            ) : null}
            {run?.workspaces?.map((workspace) => (
              <div className="space-y-3" key={workspace.workspace_id}>
                <h3>
                  冻结资料范围：{workspace.label} · {workspace.workspace_id}
                </h3>
                <ScopePaths title="可读取" paths={workspace.readable_paths} />
                <ScopePaths title="可修改" paths={workspace.writable_paths} />
                {workspace.output_directories?.length ? (
                  <>
                    <ScopePaths title="可创建文件的目录" paths={workspace.output_directories} />
                    <p className="text-secondary-foreground">
                      仅可创建新文件，不可覆盖已有名称或创建目录。
                    </p>
                  </>
                ) : null}
                <p className="text-secondary-foreground">
                  此摘要是本次运行冻结的范围，不会重新授权或扩大权限。
                </p>
              </div>
            ))}
            <dl className="space-y-2">
              <div>
                <dt className="text-secondary-foreground">会话</dt>
                <dd className="font-mono">{selected.conversationId}</dd>
              </div>
              <div>
                <dt className="text-secondary-foreground">运行</dt>
                <dd className="font-mono">{selected.runId}</dd>
              </div>
              {run ? (
                <div>
                  <dt className="text-secondary-foreground">本次执行</dt>
                  <dd className="font-mono">{run.attempt_id}</dd>
                </div>
              ) : null}
            </dl>
            <p className="text-secondary-foreground">
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
            </div>
          </div>
        </details>
      )}
    </section>
  );
}

export function TaskComposer({ task }: { task: ConversationTask }) {
  const workspace = task.workspaces.find((item) => item.workspace_id === task.workspaceId);
  const textarea = useComposerDisplay(task.input);
  const composing = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const reduceMotion = useReducedMotion();
  const command = compactCommand(task.input);
  const allowed = command
    ? task.compactAvailable
    : task.eligibility.allowed && !(task.ambiguousProposal && !task.foldChoice);
  const canStop = task.streaming || task.run?.status === 'running';
  const blockedReason = command
    ? task.compactAvailable
      ? null
      : '当前压缩请求尚不可提交。'
    : (composerBlockedReason({
        effectsUnknown: task.effectsUnknown,
        reading: task.reading,
        run: task.run,
        runs: task.runs,
        ambiguous: Boolean(task.ambiguousProposal && !task.foldChoice),
        active: task.active,
        eligibilityReason: task.eligibility.reason,
      }) ?? task.fileBlockedReason);
  return (
    <section
      className="flex max-h-[min(460px,calc(100dvh-14rem))] min-h-0 min-w-0 flex-col gap-2 overflow-y-auto p-1 text-sm leading-[22px]"
      aria-label="对话输入"
      data-testid="chat-composer"
    >
      <input
        ref={fileInput}
        type="file"
        accept={chatFileAccept}
        multiple
        hidden
        onChange={(event) => {
          const files = Array.from(event.currentTarget.files ?? []);
          event.currentTarget.value = '';
          void task.addFiles(files);
        }}
      />
      <AnimatePresence initial={false}>
        {task.fileError ? (
          <m.div exit={{ opacity: 0 }} transition={{ duration: reduceMotion ? 0 : 0.18 }}>
            <ErrorNotice message={task.fileError.message} />
          </m.div>
        ) : null}
      </AnimatePresence>
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
        <Alert role="alert" color="warning" variant="glass">
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
                  className="inline-flex min-h-8 max-lg:min-h-11 items-center text-brand-ink underline"
                  href="/conversations"
                >
                  读取会话历史
                </Link>
              </div>
            </Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}
      {task.compactStatus ? (
        <div
          className="space-y-2 text-sm"
          role={task.compactStatus.message ? 'alert' : 'status'}
          aria-live="polite"
        >
          <p>
            {task.compactStatus.message ??
              (task.compactStatus.phase === 'submitting'
                ? '正在提交压缩请求…'
                : task.compactStatus.phase === 'waiting'
                  ? task.compactStatus.receipt?.status === 'published'
                    ? '摘要已保存，正在等待后续处理与运行裁决…'
                    : '压缩处理中，等待服务端状态…'
                  : task.compactStatus.receipt?.status === 'no_content'
                    ? '没有可压缩的历史。'
                    : task.compactStatus.receipt?.status === 'failed'
                      ? `压缩失败${task.compactStatus.receipt.error_code ? `：${task.compactStatus.receipt.error_code}` : '。'}`
                      : task.compactStatus.receipt?.status === 'cancelled'
                        ? '压缩已取消。'
                        : '压缩已完成；运行状态以原运行记录为准。')}
          </p>
          {task.compactStatus.receipt?.candidate_status === 'failed' ? (
            <p>部分记忆候选未能保存；已保存的摘要不会因此撤销。</p>
          ) : null}
          {task.compactStatus.phase === 'read_error' ? (
            <Button type="button" variant="glass" color="default" onClick={task.refreshCompact}>
              重新读取压缩状态
            </Button>
          ) : null}
          {task.compactRetryAllowed ? (
            <Button
              type="button"
              variant="glass"
              color="default"
              onClick={() => void task.retryCompact()}
            >
              重试原压缩请求（同键）
            </Button>
          ) : task.compactStatus.phase === 'uncertain' ? (
            <p>请保留此会话并联系维护者核对；不会自动创建新的压缩请求。</p>
          ) : null}
        </div>
      ) : null}
      <PromptInput
        variant="glass"
        submitDisabled={!allowed}
        className="chat-composer flex min-h-0 min-w-0 flex-col px-1.5 py-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          if (allowed) void task.send();
        }}
      >
        {task.files.length ? (
          <ul
            aria-label="待发送文件"
            className="flex max-h-28 flex-wrap gap-1.5 overflow-auto px-1 pb-1"
          >
            {task.files.map((file, index) => (
              <li
                key={index}
                className="flex min-w-0 max-w-full items-center gap-1 rounded-control bg-muted pl-2 text-xs"
              >
                <Files aria-hidden="true" className="size-3.5 shrink-0" />
                <span className="truncate" title={file.name}>
                  {file.name}
                </span>
                <button
                  type="button"
                  className="grid size-8 shrink-0 place-items-center rounded-control hover:bg-background focus-visible:outline-2 focus-visible:outline-ring max-lg:size-11"
                  disabled={task.active}
                  aria-label={`移除 ${file.name}`}
                  onClick={() => task.removeFile(index)}
                >
                  <X aria-hidden="true" className="size-3.5" />
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="max-h-[32dvh] min-h-0 space-y-3 overflow-y-auto overscroll-contain">
          {task.intent !== 'chat' ? (
            <div className="flex flex-wrap items-center gap-2">
              <span
                className="inline-flex min-w-0 items-center gap-2 text-sm font-medium text-brand-ink"
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
              className="space-y-3 pb-3"
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
                <Select.Trigger id="workspace" className="w-full max-w-full" variant="glass">
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
                <p role="status" className="text-sm text-secondary-foreground">
                  正在读取登记…
                </p>
              ) : null}
              {task.workspaceError ? <ErrorNotice message={task.workspaceError} /> : null}
              {task.workspaceState === 'ready' && !task.workspaces.length ? (
                <p className="text-sm text-secondary-foreground">
                  没有可选登记，请查看账户中的本机维护说明。不能输入任意宿主路径。
                </p>
              ) : null}
              <details className="py-1 text-sm" data-testid="workspace-scope">
                <summary className="min-h-8 max-lg:min-h-11 content-center">
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
                        <p>此资料模式不可修改，可提出只读资料任务。</p>
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
                      className="inline-flex min-h-8 max-lg:min-h-11 items-center text-brand-ink underline"
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
            <p id="task-help" className="text-sm text-secondary-foreground">
              请包含日期、年份、时间与时区。沿用已确认时区，不从浏览器猜测；批准前不会登记提醒。
            </p>
          ) : null}
          {task.clarificationSourceId && !task.ambiguousProposal ? (
            <Button
              type="button"
              variant="glass"
              color="default"
              aria-pressed={task.clarificationReply}
              disabled={task.active}
              onClick={() => task.setClarificationReply(!task.clarificationReply)}
            >
              补充上一个问题
            </Button>
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
                  <Label className="min-h-8 max-lg:min-h-11 gap-3" key={candidate.fold_choice}>
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
          发给 Along 的消息
        </Label>
        <div className="flex min-w-0 shrink-0 items-end gap-1.5">
          <Dropdown>
            <Dropdown.Trigger
              render={
                <Button
                  type="button"
                  variant="clear"
                  color="default"
                  size="icon"
                  className="chat-composer-tool shrink-0 rounded-full border-0 bg-none! shadow-none!"
                />
              }
              disabled={task.active}
              aria-label="添加文件或工具"
              data-testid="chat-tools"
            >
              <Plus className="size-4" aria-hidden="true" />
            </Dropdown.Trigger>
            <Dropdown.Content
              align="start"
              side="top"
              sideOffset={8}
              className="min-w-52 max-w-[calc(100vw-24px)]"
              aria-label="对话工具"
            >
              <Dropdown.Item
                className="min-h-8 max-lg:min-h-11 gap-3"
                onClick={() => fileInput.current?.click()}
              >
                <Files className="size-4" aria-hidden="true" />
                添加本地文件
              </Dropdown.Item>
              {(
                [
                  { value: 'reminder', label: '创建提醒', icon: Bell },
                  { value: 'document', label: '使用已登记目录', icon: Files },
                  { value: 'chat', label: '普通对话', icon: MessageSquare },
                ] as const
              ).map(({ value, label, icon: Icon }) => (
                <Dropdown.Item
                  key={value}
                  className="min-h-8 max-lg:min-h-11 gap-3"
                  onClick={() => task.setIntent(value)}
                >
                  <Icon className="size-4" aria-hidden="true" />
                  {label}
                </Dropdown.Item>
              ))}
              <Dropdown.Separator />
              <p className="max-w-52 px-3 py-2 text-xs leading-5 text-muted-foreground">
                公开检索可能使用从问题提取的搜索词，请勿输入敏感信息。
              </p>
            </Dropdown.Content>
          </Dropdown>
          <PromptInput.Textarea
            ref={textarea}
            id="task-message"
            aria-label="发给 Along 的消息"
            rows={1}
            autoSize={false}
            submitOnEnter={false}
            className="max-h-40 min-h-8 min-w-0 flex-1 resize-none border-0 bg-transparent! px-1.5 py-1 text-base leading-6 shadow-none! outline-none ring-0! focus-visible:ring-0 lg:text-[15px]"
            placeholder={
              task.files.length
                ? '告诉 Along 怎样处理这些文件'
                : task.intent === 'document'
                  ? '你希望如何处理这些资料？'
                  : task.intent === 'reminder'
                    ? '你希望什么时候提醒什么？'
                    : '有什么想聊的？'
            }
            value={task.input}
            disabled={task.sendUncertain || task.admitting}
            aria-describedby={`task-ai-note${blockedReason ? ' task-send-reason' : ''}${task.intent === 'reminder' ? ' task-help' : ''}${task.error ? ' task-form-error' : ''}`}
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
          {task.intent !== 'reminder' ? (
            <Dropdown>
              <Dropdown.Trigger
                render={
                  <Button
                    type="button"
                    variant="clear"
                    color="default"
                    className="max-w-48 shrink-0 gap-1 rounded-full border-0 bg-transparent! bg-none! text-secondary-foreground shadow-none! hover:bg-muted! hover:text-foreground"
                  />
                }
                disabled={task.sendUncertain}
                aria-label="选择模型"
              >
                <span className="hidden truncate sm:inline">
                  {task.modelSelection?.model_id ?? task.defaultSelection?.model_id ?? '选择模型'}
                </span>
                <ChevronDown className="size-3.5 shrink-0" aria-hidden="true" />
              </Dropdown.Trigger>
              <Dropdown.Content
                align="start"
                side="top"
                sideOffset={8}
                className="max-h-72 min-w-52 max-w-[calc(100vw-24px)] overflow-y-auto"
                aria-label="选择模型"
              >
                <Dropdown.Item onClick={() => task.setModelSelection(null)}>
                  使用默认模型
                  {task.defaultSelection ? ` · ${task.defaultSelection.model_id}` : '（未设置）'}
                </Dropdown.Item>
                {task.modelProviders
                  .filter((provider) => provider.enabled)
                  .flatMap((provider) =>
                    provider.models.map((model_id) => (
                      <Dropdown.Item
                        key={JSON.stringify([provider.id, model_id])}
                        onClick={() =>
                          task.setModelSelection({ provider_id: provider.id, model_id })
                        }
                      >
                        {provider.name} · {model_id}
                      </Dropdown.Item>
                    )),
                  )}
                {task.modelState === 'loading' ? (
                  <Dropdown.Item disabled>正在读取模型…</Dropdown.Item>
                ) : null}
                {task.modelError ? (
                  <Dropdown.Item onClick={() => void task.readModels()}>
                    读取失败，点击重试
                  </Dropdown.Item>
                ) : null}
                <Dropdown.Item render={<Link href="/models" />}>模型设置</Dropdown.Item>
              </Dropdown.Content>
            </Dropdown>
          ) : null}
          {canStop ? (
            <Button
              type="button"
              size="icon"
              variant="glass"
              color="default"
              className="shrink-0 rounded-full"
              disabled={task.stopping || !task.selected}
              aria-label={task.stopping ? '正在停止' : '停止回复'}
              title="停止"
              onClick={() => void task.stop()}
              data-testid="stop-reply"
            >
              <Square className="size-3.5 fill-current" aria-hidden="true" />
            </Button>
          ) : null}
          {!canStop || command ? (
            <Button
              type="submit"
              size="icon"
              color="primary"
              className="chat-composer-send shrink-0 rounded-full bg-none! shadow-none!"
              disabled={!allowed}
              aria-label={command ? '执行压缩命令' : '发送消息'}
              data-testid="send-message"
            >
              <ArrowUp className="size-4" aria-hidden="true" />
            </Button>
          ) : null}
        </div>
      </PromptInput>
      {blockedReason ? (
        <p id="task-send-reason" className="px-1 text-xs leading-5 text-muted-foreground">
          {blockedReason}
        </p>
      ) : null}
      <p id="task-ai-note" className="px-1 text-center text-xs leading-5 text-muted-foreground">
        内容由 AI 生成，仅供参考。
      </p>
    </section>
  );
}
