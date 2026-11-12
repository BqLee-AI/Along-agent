import { Cpu, Laptop, FolderOpen, MessagesSquare, Plug, Sparkles, UserRound } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import WorkspaceLink from '@/shell/view/workspace-link';
import { settingsGroups } from '../model/capabilities';

const icons: Record<string, LucideIcon> = {
  '/account': UserRound,
  '/models': Cpu,
  '/materials': FolderOpen,
  '/skills': Sparkles,
  '/connectors': Plug,
  '/channels': MessagesSquare,
  '/devices': Laptop,
};

export function SettingsNav({ pathname }: { pathname: string }) {
  return (
    <nav aria-label="设置" className="space-y-5">
      {settingsGroups.map((group) => (
        <section key={group.title} aria-label={group.title}>
          <h2 className="px-2.5 pb-1.5 text-xs font-medium text-muted-foreground">{group.title}</h2>
          <ul className="space-y-0.5">
            {group.items.map((item) => {
              const Icon = icons[item.href];
              const active = pathname === item.href;
              return (
                <li key={item.href}>
                  <WorkspaceLink
                    href={item.href}
                    aria-current={active ? 'page' : undefined}
                    className={`flex h-8 items-center gap-2.5 rounded-control px-2.5 text-[13px] leading-5 transition-colors focus-visible:outline-2 focus-visible:outline-ring max-lg:h-11 ${active ? 'bg-foreground/10 font-medium text-foreground' : 'text-secondary-foreground hover:bg-foreground/5 hover:text-foreground'}`}
                  >
                    {Icon ? <Icon className="size-4 shrink-0" aria-hidden="true" /> : null}
                    <span className="truncate">{item.label}</span>
                  </WorkspaceLink>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </nav>
  );
}
