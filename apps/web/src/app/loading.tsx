import { Skeleton } from '@/components/ui/skeleton';

export default function Loading() {
  return (
    <div role="status" aria-label="正在读取页面" className="space-y-8">
      <span className="sr-only">正在读取页面，已有记录不会因此重新执行。</span>
      <div className="space-y-3">
        <Skeleton className="h-9 w-40" />
        <Skeleton className="h-5 w-64 max-w-full" />
      </div>
      <div className="space-y-4">
        {[0, 1, 2].map((row) => (
          <Skeleton key={row} className="h-[88px] w-full rounded-xl" />
        ))}
      </div>
    </div>
  );
}
