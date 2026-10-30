import { Skeleton } from '@lorelum/lumen-ui/components/skeleton';

export default function AccountLoading({ summary = false }: { summary?: boolean }) {
  return (
    <section
      className={
        summary
          ? 'mx-auto w-full min-w-0 max-w-[640px] space-y-6'
          : 'mx-auto w-full min-w-0 max-w-[400px] space-y-6'
      }
      aria-busy="true"
    >
      <h1 className="text-3xl font-semibold leading-9">稍等片刻</h1>
      <p className="text-base leading-7 text-muted-foreground" role="status">
        正在读取账户…
      </p>
      <div className="space-y-6 py-4" aria-hidden="true">
        <Skeleton className="h-6 w-1/2" />
        <Skeleton className="h-11 w-full" />
        <Skeleton className="h-6 w-1/3" />
        <Skeleton className="h-11 w-full" />
        <Skeleton className="h-11 w-full" />
      </div>
    </section>
  );
}
