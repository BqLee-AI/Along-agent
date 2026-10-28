import { PageHeading } from '@/components/page';
import { Skeleton } from '@/components/ui/skeleton';

export default function TasksLoading() {
  return (
    <section className="space-y-8" aria-busy="true" aria-label="正在读取提醒任务">
      <PageHeading title="提醒任务" description="正在读取冻结时间与任务记录…" />
      <div className="space-y-4">
        {[0, 1, 2].map((row) => (
          <div key={row} className="space-y-3 border-b border-border py-4">
            <Skeleton className="h-6 w-48" />
            <Skeleton className="h-5 w-64 max-w-full" />
          </div>
        ))}
      </div>
    </section>
  );
}
