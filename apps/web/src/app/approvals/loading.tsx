import { Skeleton } from '@/components/ui/skeleton';

export default function LoadingApprovals() {
  return (
    <section className="space-y-8" aria-busy="true" aria-label="正在读取提醒确认">
      <div className="space-y-3">
        <h1 className="text-2xl font-semibold">提醒确认</h1>
        <p className="text-muted-foreground" role="status">
          正在读取冻结提议，请稍候…
        </p>
      </div>
      <Skeleton className="h-11 w-48" />
      <div className="space-y-6 border-y border-border py-6">
        {[0, 1, 2].map((item) => (
          <div key={item} className="space-y-3">
            <Skeleton className="h-6 w-2/3" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        ))}
      </div>
    </section>
  );
}
