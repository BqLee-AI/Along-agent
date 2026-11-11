import { Skeleton } from '@lorelum/lumen-ui/components/skeleton';

export default function AccountLoading({ summary = false }: { summary?: boolean }) {
  return (
    <section
      className={
        summary
          ? 'min-w-0 space-y-7'
          : 'mx-auto w-full min-w-0 max-w-md space-y-7 px-5 py-8 sm:py-12'
      }
      aria-busy="true"
    >
      <header className="space-y-3">
        <h1 className="text-xl font-semibold leading-7">{summary ? '账户' : 'Along'}</h1>
        <p className="text-sm leading-[22px] text-muted-foreground" role="status">
          正在读取账户与原安装状态…
        </p>
      </header>
      <div className="min-w-0 space-y-5" aria-hidden="true">
        <Skeleton className="h-6 w-1/2" />
        <Skeleton className="h-11 w-full" />
        <Skeleton className="h-6 w-1/3" />
        <Skeleton className="h-11 w-full" />
        <Skeleton className="h-11 w-full" />
      </div>
    </section>
  );
}
