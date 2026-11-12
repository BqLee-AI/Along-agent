import { Skeleton } from '@lorelum/lumen-ui/components/skeleton';

export function BriefLoading() {
  return (
    <div role="status" aria-label="正在读取简报" className="min-w-0 space-y-5 py-2">
      <span className="sr-only">正在读取简报。已有记录不会因此重新执行。</span>
      <div aria-hidden="true" className="space-y-3">
        <Skeleton className="h-5 w-48 max-w-full" />
        <Skeleton className="h-5 w-full" />
        {[0, 1].map((index) => (
          <div key={index} className="space-y-3 border-t border-separator pt-5">
            <Skeleton className="h-7 w-28" />
            <Skeleton className="h-5 w-full max-w-sm" />
            <Skeleton className="h-14 w-full" />
          </div>
        ))}
      </div>
    </div>
  );
}

export function TodayWorkspaceLoadingScreen() {
  return (
    <div className="w-full min-w-0 space-y-6">
      <div aria-hidden="true" className="space-y-2">
        <Skeleton className="h-8 w-36" />
        <Skeleton className="h-[22px] w-full max-w-sm" />
      </div>
      <div aria-hidden="true" className="divide-y divide-separator border-y border-separator">
        {[0, 1, 2].map((index) => (
          <div key={index} className="flex min-h-16 items-center gap-3 py-3">
            <Skeleton className="size-5 shrink-0" />
            <div className="min-w-0 flex-1 space-y-1">
              <Skeleton className="h-7 w-28" />
              <Skeleton className="h-[22px] w-full max-w-60" />
            </div>
          </div>
        ))}
      </div>
      <BriefLoading />
    </div>
  );
}
