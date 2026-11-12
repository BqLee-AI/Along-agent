'use client';

import { memo } from 'react';
import Link from '@/shell/view/workspace-link';
import { ArrowUpRight, CheckCheck, Files, History, ShieldCheck } from 'lucide-react';
import { Badge } from '@lorelum/lumen-ui/components/badge';
import { Button } from '@lorelum/lumen-ui/components/button';
import { runStatusLabel } from '../model/conversation-run';
import type { ConversationContextProjection } from '../model/presentation';

export const ConversationContext = memo(function ConversationContext({
  context,
  locate,
}: {
  context: ConversationContextProjection;
  locate: (id: string) => void;
}) {
  const { selected, status, workspace, waiting, effectsUnknown, streaming } = context;
  return (
    <div className="min-w-0 space-y-6 text-sm leading-[22px]">
      {selected ? (
        <section className="min-w-0 space-y-4" aria-label="当前运行摘要">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm leading-6 font-semibold">当前运行</h3>
            <Badge variant="glass">{status ? runStatusLabel[status] : '状态待核实'}</Badge>
          </div>
          <p className="text-secondary-foreground">
            {effectsUnknown
              ? '原操作可能已有文件效果。请核对原事实，不要重新执行。'
              : waiting
                ? '有待审阅或继续的内容。请到消息中的原批准与结果核对，再明确操作。'
                : streaming
                  ? '正在接收真实回复，完成状态以原运行记录为准。'
                  : '原话、批准与实际结果保留在同一次运行中。'}
          </p>
          <dl className="space-y-2 text-secondary-foreground">
            <div className="min-w-0">
              <dt>所选运行</dt>
              <dd className="font-mono text-xs leading-5 [overflow-wrap:anywhere]">
                {selected.runId}
              </dd>
            </div>
          </dl>
          <div className="flex flex-wrap gap-2">
            <Button
              variant={waiting || effectsUnknown ? 'flat' : 'clear'}
              color="default"
              onClick={() => locate('run-results')}
            >
              定位批准与结果
              <ArrowUpRight className="size-4" aria-hidden="true" />
            </Button>
            <Button variant="clear" color="default" onClick={() => locate('run-facts')}>
              运行详情
            </Button>
          </div>
        </section>
      ) : (
        <section className="space-y-3" aria-label="当前运行摘要">
          <h3 className="text-sm leading-6 font-semibold">从一段对话开始</h3>
          <p className="text-secondary-foreground">
            发送后，这里会呈现原运行的状态和关联内容。你仍在消息中的原批准与结果审阅和决定下一步。
          </p>
        </section>
      )}
      {workspace ? (
        <section
          className="min-w-0 space-y-3 border-t border-separator pt-6"
          aria-label="关联资料范围"
        >
          <h3 className="flex items-center gap-2 text-sm leading-6 font-semibold">
            <Files className="size-4 shrink-0" aria-hidden="true" />
            原运行的资料
          </h3>
          <p className="font-medium [overflow-wrap:anywhere]">{workspace.label}</p>
          <p className="text-secondary-foreground">以下是原运行冻结的范围，不是新的授权。</p>
          <details open>
            <summary className="min-h-8 max-lg:min-h-11 cursor-pointer content-center font-medium">
              完整读写范围
            </summary>
            <div className="min-w-0 space-y-4 pt-2">
              <div className="min-w-0 space-y-2">
                <p className="font-medium">可读取</p>
                <ul className="min-w-0 space-y-2 font-mono text-secondary-foreground">
                  {workspace.readable_paths.map((path) => (
                    <li className="whitespace-pre-wrap [overflow-wrap:anywhere]" key={path}>
                      {path}
                    </li>
                  ))}
                </ul>
              </div>
              <div className="min-w-0 space-y-2">
                <p className="font-medium">可修改</p>
                {workspace.writable_paths.length ? (
                  <ul className="min-w-0 space-y-2 font-mono text-secondary-foreground">
                    {workspace.writable_paths.map((path) => (
                      <li className="whitespace-pre-wrap [overflow-wrap:anywhere]" key={path}>
                        {path}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-secondary-foreground">无</p>
                )}
              </div>
            </div>
          </details>
        </section>
      ) : null}
      <nav className="space-y-2 border-t border-separator pt-6" aria-label="相关事项入口">
        <h3 className="mb-3 text-sm font-medium text-secondary-foreground">事项与资料</h3>
        {[
          { href: '/approvals', label: '待确认的提醒', icon: CheckCheck },
          { href: '/activity', label: '已记录的活动', icon: History },
          { href: '/account', label: '账户与资料登记', icon: Files },
        ].map(({ href, label, icon: Icon }) => (
          <Link
            href={
              selected
                ? `${href}?${new URLSearchParams({ conversation_id: selected.conversationId, run_id: selected.runId })}`
                : href
            }
            key={href}
            className="flex min-h-8 max-lg:min-h-11 items-center gap-3 text-brand-ink underline-offset-4 hover:underline focus-visible:rounded-control focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
          >
            <Icon className="size-4 shrink-0" strokeWidth={1.75} aria-hidden="true" />
            <span className="min-w-0 flex-1">{label}</span>
            <ArrowUpRight className="size-4 shrink-0" aria-hidden="true" />
          </Link>
        ))}
      </nav>
      <p className="flex items-start gap-2 text-secondary-foreground">
        <ShieldCheck className="mt-1 size-4 shrink-0" aria-hidden="true" />
        批准、执行和核对分别记录。这里仅展示关联信息；打开、定位或查看不会执行任务。
      </p>
    </div>
  );
});
