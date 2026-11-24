'use client';

import { OfficeMaterials } from '@/features/conversations/view/office-materials';
import Link from '@/shell/view/workspace-link';
import { PageHeading } from '@/shared/ui/page';
import { Files, FolderOpen, Paperclip } from 'lucide-react';
import { Badge } from '@lorelum/lumen-ui/components/badge';
import { Button } from '@lorelum/lumen-ui/components/button';
import { Card } from '@lorelum/lumen-ui/components/card';

export default function MaterialsPage() {
  return (
    <div className="min-w-0 space-y-5">
      <PageHeading title="资料" />
      <Card className="relative isolate overflow-hidden border-brand-ink/20 bg-background py-0">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(ellipse_at_top_right,var(--brand-ink),transparent_68%)] opacity-15"
        />
        <Card.Content className="grid items-center gap-6 p-5 sm:grid-cols-[1fr_auto] sm:p-7">
          <div className="min-w-0 space-y-4">
            <div className="inline-flex size-10 items-center justify-center rounded-xl bg-brand-ink/15 text-brand-ink">
              <Paperclip className="size-5" aria-hidden="true" />
            </div>
            <h2 className="text-lg font-semibold">聊天附件</h2>
            <div className="flex flex-wrap gap-1.5">
              {['TXT', 'Markdown', 'CSV', 'JSON'].map((format) => (
                <Badge key={format} variant="glass">
                  {format}
                </Badge>
              ))}
            </div>
            <Button
              render={<Link href="/conversations?surface=chat" />}
              nativeButton={false}
              role="link"
              color="primary"
              variant="solid"
            >
              去聊天
            </Button>
          </div>
          <div
            aria-hidden="true"
            className="relative mr-4 hidden size-32 shrink-0 place-items-center rounded-3xl border border-dashed border-brand-ink/35 bg-background/40 sm:grid"
          >
            <div className="absolute size-16 -translate-x-3 rotate-[-14deg] rounded-xl border border-brand-ink/25 bg-background" />
            <div className="z-10 grid size-16 translate-x-1 rotate-12 place-items-center rounded-xl border border-brand-ink/35 bg-background text-brand-ink shadow-md">
              <Files className="size-7" />
            </div>
          </div>
        </Card.Content>
      </Card>
      <Card variant="soft" className="py-0">
        <Card.Content className="flex flex-wrap items-center gap-3 px-4 py-3">
          <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted text-secondary-foreground">
            <FolderOpen className="size-4" aria-hidden="true" />
          </div>
          <h2 className="min-w-0 flex-1 text-sm font-medium">工作区登记</h2>
          <Button
            render={<Link href="/account?section=workspace" />}
            nativeButton={false}
            role="link"
            variant="glass"
            color="default"
            size="sm"
          >
            查看登记
          </Button>
        </Card.Content>
      </Card>
      <OfficeMaterials />
    </div>
  );
}
