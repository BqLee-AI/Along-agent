import { Suspense } from 'react';
import Link from 'next/link';
import { ArrowRight, Bell, ChevronDown, FileText, MessageCircle } from 'lucide-react';
import { apiGet, type ApiResult } from '@/lib/api';
import type { Brief } from '@/lib/types';
import { pageReturnTo, type PageQuery } from '@/lib/account-navigation';
import { Button } from '@lorelum/lumen-ui/components/button';
import { Skeleton } from '@lorelum/lumen-ui/components/skeleton';
import { BriefSectionsContent } from './brief-sections';

export const dynamic = 'force-dynamic';
type BriefRead = Promise<ApiResult<Brief>>;

function AssistantWelcome() {
  return (
    <section aria-labelledby="assistant-welcome" className="py-12 sm:py-20">
      <div className="mb-6 flex items-center gap-3 text-sm font-medium text-primary">
        <span className="flex size-10 items-center justify-center">
          <MessageCircle className="size-5" strokeWidth={1.75} aria-hidden="true" />
        </span>
        你的个人助理
      </div>
      <h1
        id="assistant-welcome"
        className="max-w-xl text-[32px] leading-[1.4] font-semibold tracking-tight text-balance sm:text-[40px]"
      >
        今天，想一起做点什么？
      </h1>
      <p className="mt-4 max-w-lg text-base leading-7 text-muted-foreground">
        从一个问题、一个想法，或一件想做的事开始。
      </p>
      <Button
        size="lg"
        className="mt-8"
        role="link"
        nativeButton={false}
        render={<Link href="/conversations" />}
      >
        开始对话
        <ArrowRight className="size-4" aria-hidden="true" />
      </Button>
      <nav aria-label="助理快捷入口" className="mt-8 flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="text-sm text-muted-foreground">也可以</span>
        <Button
          variant="clear"
          color="default"
          role="link"
          nativeButton={false}
          render={<Link href="/conversations?intent=reminder" />}
        >
          <Bell className="size-4" aria-hidden="true" />
          创建提醒
        </Button>
        <Button
          variant="clear"
          color="default"
          role="link"
          nativeButton={false}
          render={<Link href="/conversations?intent=document" />}
        >
          <FileText className="size-4" aria-hidden="true" />
          处理资料
        </Button>
      </nav>
    </section>
  );
}

function BriefLoading() {
  return (
    <div role="status" aria-label="正在读取今日事项" className="space-y-5 py-6">
      <span className="sr-only">正在读取简报，仍可开始对话。</span>
      <Skeleton className="h-5 w-48 max-w-full" />
      <Skeleton className="h-14 w-full" />
      <Skeleton className="h-14 w-full" />
    </div>
  );
}

async function BriefSections({ result }: { result: BriefRead }) {
  return <BriefSectionsContent response={await result} />;
}

export default async function HomePage({ searchParams }: { searchParams: Promise<PageQuery> }) {
  const result = apiGet<Brief>('/api/v1/brief', pageReturnTo('/', await searchParams));
  return (
    <div className="mx-auto w-full max-w-3xl min-w-0">
      <AssistantWelcome />
      <details id="today-brief" className="group border-y border-border">
        <summary className="flex min-h-20 cursor-pointer list-none items-center justify-between gap-4 py-5 [&::-webkit-details-marker]:hidden">
          <div className="min-w-0">
            <h2 className="text-base font-medium">今日简报</h2>
            <p className="mt-1 text-sm text-muted-foreground">提醒、待确认与已记录的结果</p>
          </div>
          <ChevronDown
            className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180 motion-reduce:transition-none"
            aria-hidden="true"
          />
        </summary>
        <Suspense fallback={<BriefLoading />}>
          <BriefSections result={result} />
        </Suspense>
      </details>
    </div>
  );
}
