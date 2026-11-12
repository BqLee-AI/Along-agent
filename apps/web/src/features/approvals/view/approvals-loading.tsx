import { PageHeading } from '@/shared/ui/page';
import { Skeleton } from '@lorelum/lumen-ui/components/skeleton';

export default function ApprovalsLoading() {
  return (
    <section className="min-w-0 space-y-6" aria-busy="true" aria-label="正在读取提醒确认">
      <PageHeading eyebrow="待确认" title="提醒确认" description="正在读取冻结提议，请稍候…" />
      <div className="space-y-4" aria-hidden="true">
        <Skeleton className="h-11 w-48 max-w-full" />
        {[0, 1, 2].map((item) => (
          <div key={item} className="space-y-3 border-t border-border py-4">
            <Skeleton className="h-6 w-2/3" />
            <Skeleton className="h-5 w-1/2" />
          </div>
        ))}
      </div>
    </section>
  );
}
