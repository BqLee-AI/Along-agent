import { PageHeading } from '@/components/page';
import { Skeleton } from '@lorelum/lumen-ui/components/skeleton';

export default function ActivityLoading() {
  return (
    <section className="space-y-8" aria-busy="true" aria-label="正在读取提醒活动">
      <PageHeading title="提醒活动" description="正在读取任务范围与已选任务…" />
      <div className="grid gap-8 lg:grid-cols-[280px_minmax(0,1fr)]">
        <div className="space-y-4">
          <h2 className="text-lg font-semibold">任务范围索引</h2>
          {[0, 1, 2].map((row) => (
            <Skeleton key={row} className="h-24 w-full" />
          ))}
        </div>
        <div className="space-y-4">
          <h2 className="text-lg font-semibold">任务事件区域</h2>
          <Skeleton className="h-32 w-full" />
        </div>
      </div>
    </section>
  );
}
