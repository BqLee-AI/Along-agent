import { Skeleton } from '@lorelum/lumen-ui/components/skeleton';

export default function Loading() {
  return (
    <div role="status" aria-label="正在读取页面" className="mx-auto w-full max-w-3xl min-w-0">
      <span className="sr-only">正在读取页面，已有记录不会因此重新执行。</span>
      <div className="py-12 sm:py-20">
        <div className="mb-6 flex items-center gap-3">
          <Skeleton className="size-10 rounded-2xl" />
          <Skeleton className="h-4 w-24" />
        </div>
        <Skeleton className="h-11 w-full max-w-md" />
        <Skeleton className="mt-4 h-6 w-full max-w-sm" />
        <Skeleton className="mt-8 h-12 w-36 rounded-full" />
        <div className="mt-8 flex gap-4">
          <Skeleton className="h-11 w-24" />
          <Skeleton className="h-11 w-24" />
        </div>
      </div>
      <div className="flex min-h-20 items-center justify-between gap-4 border-y border-border py-5">
        <div className="space-y-2">
          <Skeleton className="h-5 w-24" />
          <Skeleton className="h-4 w-52 max-w-full" />
        </div>
        <Skeleton className="size-4 shrink-0" />
      </div>
    </div>
  );
}
