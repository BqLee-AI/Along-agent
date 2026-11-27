import {
  ArrowUpRight,
  BookOpen,
  Cable,
  ListChecks,
  Monitor,
  Sparkles,
  UserRound,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import WorkspaceLink from '@/shell/view/workspace-link';
import { PageHeading } from '@/shared/ui/page';
import { capabilities } from '../model/capabilities';
import type { Capability } from '../model/capabilities';

const icons: Record<Capability, LucideIcon> = {
  journal: BookOpen,
  profile: UserRound,
  skills: Sparkles,
  connectors: Cable,
  devices: Monitor,
  todos: ListChecks,
};

export function CapabilityScreen({ capability }: { capability: Capability }) {
  const page = capabilities[capability];
  const Icon = icons[capability];
  return (
    <div className="w-full min-w-0" data-testid="capability-page">
      <PageHeading title={page.title} description={page.description} />
      <section
        className="flex min-w-0 flex-col items-center rounded-2xl bg-muted px-6 py-14 text-center ring-1 ring-foreground/[0.05]"
        aria-label="开放状态"
      >
        <span className="relative flex size-14 items-center justify-center rounded-2xl bg-foreground/[0.06] ring-1 ring-foreground/[0.08]">
          <Icon className="size-6" strokeWidth={1.5} aria-hidden="true" />
        </span>
        <span className="mt-5 inline-flex h-6 items-center rounded-full bg-foreground/[0.08] px-2.5 text-xs font-medium text-secondary-foreground">
          暂未开放
        </span>
        {page.boundary && (
          <p className="mt-3 max-w-sm text-sm leading-6 text-muted-foreground">{page.boundary}</p>
        )}
        {page.related.length ? (
          <nav
            aria-label="相关入口"
            className="mt-6 flex flex-wrap items-center justify-center gap-2"
          >
            {page.related.map((link) => (
              <WorkspaceLink
                key={link.href}
                href={link.href}
                className="inline-flex h-9 items-center gap-1.5 rounded-full bg-foreground px-4 text-[13px] font-medium text-background transition-opacity hover:opacity-85 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring max-lg:min-h-11"
              >
                {link.label}
                <ArrowUpRight className="size-3.5" aria-hidden="true" />
              </WorkspaceLink>
            ))}
          </nav>
        ) : null}
      </section>
    </div>
  );
}
