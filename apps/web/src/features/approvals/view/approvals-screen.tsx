import { PageHeading } from '@/shared/ui/page';
import type { PageQuery } from '@/shared/session/navigation';
import { readApprovals } from '../model/approvals.server';
import ApprovalList from './ApprovalList';
import { ApprovalStatusFilter } from './ApprovalStatusFilter';

export default async function ApprovalsScreen({ query }: { query: PageQuery }) {
  const data = await readApprovals(query);
  return (
    <section className="min-w-0 space-y-6 text-sm leading-6">
      <PageHeading
        eyebrow="待确认"
        title="提醒确认"
        description="核对提醒创建或取消的冻结内容，再明确提交决定。"
      />
      <section className="min-w-0" aria-labelledby="approval-list-title">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-separator pb-4">
          <h2 id="approval-list-title" className="text-sm font-semibold">
            提醒提议
          </h2>
          <ApprovalStatusFilter key={data.status} status={data.status} />
        </div>
        <div className="py-4">
          <ApprovalList key={data.status} {...data} />
        </div>
      </section>
      <section
        className="space-y-2 border-t border-border pt-5 text-sm leading-[22px] text-muted-foreground"
        aria-label="确认规则"
      >
        <p>此页只读取提议。切换筛选、重读和翻页都不会创建提醒或代替你确认。</p>
        <p>文档批准请从原会话的“修改与结果”进入，保留对应的版本上下文。</p>
      </section>
    </section>
  );
}
