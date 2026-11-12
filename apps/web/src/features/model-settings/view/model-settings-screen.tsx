'use client';

import { CheckCircle2 } from 'lucide-react';
import { Button } from '@lorelum/lumen-ui/components/button';
import { Skeleton } from '@lorelum/lumen-ui/components/skeleton';
import { ErrorNotice } from '@/shared/ui/page';
import { useModelSettings } from '../viewmodel/use-model-settings';
import { ProviderDetail } from './provider-detail';
import { ProviderList } from './provider-list';

export default function ModelSettingsScreen() {
  const vm = useModelSettings();

  if (vm.load.kind === 'loading') {
    return (
      <div role="status" aria-label="正在读取模型服务" className="flex flex-col gap-6 lg:flex-row">
        <div className="space-y-2 lg:w-52">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
        </div>
        <div className="flex-1 space-y-4">
          <Skeleton className="h-6 w-1/3" />
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      </div>
    );
  }

  if (vm.load.kind === 'failed') {
    return (
      <ErrorNotice message={vm.load.message}>
        <div className="flex gap-2">
          <Button type="button" variant="glass" color="default" onClick={() => void vm.reload()}>
            重试
          </Button>
        </div>
      </ErrorNotice>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-6 lg:flex-row">
      <ProviderList
        providers={vm.providers}
        selectedId={vm.selected?.id ?? null}
        disabled={vm.working}
        selection={vm.selection}
        onClearDefault={() => void vm.setDefault(null)}
        onSelect={vm.select}
        onAdd={vm.addProvider}
      />
      {vm.selected ? (
        <ProviderDetail key={vm.selected.id} provider={vm.selected} vm={vm} />
      ) : (
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">还没有选中服务商，先在左侧选择或添加。</p>
          {vm.notice?.kind === 'failed' ? <ErrorNotice message={vm.notice.message} /> : null}
          {vm.notice?.kind === 'ok' ? (
            <p role="status" className="flex items-center gap-1.5 text-sm text-success">
              <CheckCircle2 className="size-4" />
              {vm.notice.message}
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
}
