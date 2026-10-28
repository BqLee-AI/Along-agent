import { Skeleton } from '@/components/ui/skeleton';

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
      <h1 className="text-2xl font-semibold leading-9">正在读取账户</h1>
      <p className="text-base leading-7 text-muted-foreground" role="status">
        正在核验原安装状态，尚未开放账户操作。
      </p>
      <div className="space-y-6 rounded-xl border border-border bg-card p-6" aria-hidden="true">
        <Skeleton className="h-6 w-1/2" />
        <Skeleton className="h-11 w-full" />
        <Skeleton className="h-6 w-1/3" />
        <Skeleton className="h-11 w-full" />
        <Skeleton className="h-11 w-full" />
      </div>
    </section>
  );
}
