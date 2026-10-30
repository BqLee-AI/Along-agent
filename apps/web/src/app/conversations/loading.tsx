import { Skeleton } from '@lorelum/lumen-ui/components/skeleton';

export default function ConversationsLoading() {
  return (
    <div role="status" aria-label="正在读取对话" className="flex h-full min-h-0 min-w-0 flex-col">
      <span className="sr-only">正在读取对话，已有记录不会因此重新执行。</span>
      <div className="flex h-14 shrink-0 items-center justify-between gap-3 px-4 sm:px-6">
        <Skeleton className="h-5 w-12" />
        <Skeleton className="h-5 w-24" />
      </div>
      <div className="min-h-0 flex-1">
        <div className="mx-auto w-full max-w-3xl px-4 pt-6 sm:px-6 sm:pt-10">
          <div className="flex min-h-[30dvh] flex-col items-center justify-center gap-3">
            <Skeleton className="h-8 w-64 max-w-full" />
            <Skeleton className="h-5 w-32" />
          </div>
        </div>
      </div>
      <div className="shrink-0 px-4 pt-2 pb-[max(1rem,env(safe-area-inset-bottom))] sm:px-6">
        <div className="mx-auto w-full max-w-3xl p-1">
          <Skeleton className="h-36 w-full" />
        </div>
      </div>
    </div>
  );
}
