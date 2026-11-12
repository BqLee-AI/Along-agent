'use client';

import Link from '@/shell/view/workspace-link';
import { Button } from '@lorelum/lumen-ui/components/button';
import { Badge } from '@lorelum/lumen-ui/components/badge';
import { ArrowUpRight } from 'lucide-react';
import { EmptyState, ErrorNotice } from '@/shared/ui/page';
import { approvalStatusLabels } from '../model/approval';
import { useApprovalList } from '../viewmodel/useApprovalList';
import type { ApprovalListProps } from '../viewmodel/useApprovalList';

export default function ApprovalList(props: ApprovalListProps) {
  const { status } = props;
  const { state, readError, load } = useApprovalList(props);
  return (
    <div className="min-w-0 space-y-6" aria-busy={state.reading}>
      <p className="text-sm leading-[22px] text-muted-foreground" role="status" aria-atomic="true">
        读取到 {state.items.length} 条 · {approvalStatusLabels[status]} ·{' '}
        {state.loaded
          ? state.nextCursor
            ? '仍有后续页，尚未读完'
            : '本筛选读取至末页'
          : '范围尚未读取'}
        。按建立时间倒序，每页最多 50 条。
      </p>
      {state.items.length ? (
        <ul className="divide-y divide-border">
          {state.items.map((item) => (
            <li key={item.approval_id} className="min-w-0 py-4">
              <div className="min-w-0 space-y-3">
                <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 space-y-3">
                    <h3 className="font-semibold leading-6 [overflow-wrap:anywhere]">
                      <Link
                        className="text-foreground underline-offset-4 hover:underline"
                        href={`/approvals/${item.approval_id}`}
                      >
                        {item.title}
                      </Link>
                    </h3>
                    <Badge variant="glass">{approvalStatusLabels[item.status]}</Badge>
                  </div>
                  <div className="min-w-0 space-y-1 text-sm leading-[22px] [overflow-wrap:anywhere]">
                    <p className="text-muted-foreground">有效期至</p>
                    <time dateTime={item.expires_at} className="tabular-nums">
                      {item.expires_at}
                    </time>
                  </div>
                  <Button
                    variant="glass"
                    color="default"
                    role="link"
                    nativeButton={false}
                    render={<Link href={`/approvals/${item.approval_id}`} />}
                  >
                    审阅提议
                    <ArrowUpRight className="size-4" aria-hidden="true" />
                    <span className="sr-only"> · {item.title}</span>
                  </Button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      ) : state.loaded ? (
        <EmptyState
          title="本筛选没有提醒提议"
          description="可切换状态查看已处理的提议；文档批准请从原会话进入。"
        />
      ) : null}
      {readError ? (
        <ErrorNotice message={readError}>
          <p>先前内容与后续游标仍保留；重读只发送 GET。</p>
          <Button
            variant="glass"
            color="default"
            disabled={state.reading}
            onClick={() => void load(!state.loaded || state.resetting)}
          >
            重试{!state.loaded || state.resetting ? '首批读取' : '后续页'}
          </Button>
        </ErrorNotice>
      ) : null}
      {state.reading ? (
        <p role="status" className="text-muted-foreground">
          正在读取提醒确认，已有内容仍可审阅…
        </p>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
        {state.nextCursor ? (
          <Button
            variant="glass"
            color="default"
            disabled={state.reading}
            onClick={() => void load(false)}
          >
            继续读取提醒确认
          </Button>
        ) : null}
        <Button
          variant="clear"
          color="default"
          disabled={state.reading}
          onClick={() => void load(true)}
        >
          重新读取首批
        </Button>
      </div>
    </div>
  );
}
