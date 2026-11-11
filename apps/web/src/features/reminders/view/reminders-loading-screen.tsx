import { Skeleton } from '@lorelum/lumen-ui/components/skeleton';
import { PageHeading } from '@/shared/ui/page';

export function RemindersLoadingScreen({ activity = false }: { activity?: boolean }) {
  return (
    <section
      className="min-w-0 space-y-6"
      aria-busy="true"
      aria-label={activity ? '正在读取提醒活动' : '正在读取提醒任务'}
    >
      <PageHeading
        eyebrow={activity ? '事项 / 活动' : '事项 / 提醒'}
        title={activity ? '提醒活动' : '提醒任务'}
        description={activity ? '正在读取提醒范围与已选提醒…' : '正在读取冻结时间与任务记录…'}
      />
      <Skeleton className="h-11 w-56 max-w-full" />
      <div className="divide-y divide-separator">
        {[0, 1, 2].map((row) => (
          <div key={row} className="min-w-0 space-y-3 py-5">
            <Skeleton className="h-6 w-48 max-w-full" />
            <Skeleton className="h-5 w-64 max-w-full" />
            <Skeleton className="h-5 w-28" />
          </div>
        ))}
      </div>
    </section>
  );
}
