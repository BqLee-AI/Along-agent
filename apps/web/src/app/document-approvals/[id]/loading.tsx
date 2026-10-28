import { Skeleton } from '@/components/ui/skeleton';

export default function LoadingDocumentApproval() {
  return (
    <section className="space-y-8" aria-busy="true" aria-label="正在读取文档批准全文">
      <div className="space-y-3">
        <h1 className="text-2xl font-semibold">文档批准</h1>
        <p className="text-muted-foreground" role="status">
          正在读取服务端冻结全文。正文未核验前不能批准。
        </p>
      </div>
      <div className="space-y-6 rounded-xl border border-border bg-card p-4 sm:p-8">
        <Skeleton className="h-6 w-2/3" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    </section>
  );
}
