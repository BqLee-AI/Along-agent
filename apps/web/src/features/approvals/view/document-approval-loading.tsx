import { PageHeading } from '@/shared/ui/page';
import { Skeleton } from '@lorelum/lumen-ui/components/skeleton';

export default function DocumentApprovalLoading() {
  return (
    <section className="min-w-0 space-y-6" aria-busy="true" aria-label="正在读取文档批准全文">
      <PageHeading title="文档批准" description="正在读取服务端冻结全文。正文未核验前不能批准。" />
      <div className="space-y-6 border-t border-border pt-6" aria-hidden="true">
        <Skeleton className="h-6 w-2/3" />
        <Skeleton className="h-64 w-full" />
        <Skeleton className="h-6 w-2/3" />
        <Skeleton className="h-64 w-full" />
        <Skeleton className="h-6 w-1/3" />
        <Skeleton className="h-48 w-full" />
      </div>
    </section>
  );
}
