'use client';

import { useState } from 'react';
import { CheckCircle2 } from 'lucide-react';
import { Button } from '@lorelum/lumen-ui/components/button';
import { Skeleton } from '@lorelum/lumen-ui/components/skeleton';
import { ErrorNotice } from '@/shared/ui/page';
import { providerPresets } from '../model/provider-presets';
import { useModelSettings } from '../viewmodel/use-model-settings';
import { ProviderDetail } from './provider-detail';
import { ProviderIcon } from './provider-icon';
import { ProviderList } from './provider-list';

export default function ModelSettingsScreen() {
  const vm = useModelSettings();
  const [previewName, setPreviewName] = useState<string | null>(null);
  const preview = providerPresets.find((preset) => preset.name === previewName) ?? null;
  const add = async (name: string, apiHost?: string) => {
    const added = await vm.addProvider(name, apiHost);
    if (added) setPreviewName(null);
    return added;
  };

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
        previewName={previewName}
        selectedId={preview ? null : (vm.selected?.id ?? null)}
        disabled={vm.working}
        onSelect={(id) => {
          setPreviewName(null);
          vm.select(id);
        }}
        onPreview={setPreviewName}
        onAdd={add}
      />
      {preview ? (
        <div className="min-w-0 flex-1 space-y-6 pt-1">
          <div className="flex items-center gap-4">
            <ProviderIcon name={preview.name} large />
            <div className="min-w-0 space-y-1">
              <h2 className="text-base font-semibold">{preview.name}</h2>
              <p className="text-sm text-muted-foreground">常用服务商 · 尚未添加</p>
            </div>
          </div>
          <div className="space-y-2 rounded-xl border border-border bg-foreground/[0.025] p-4">
            <p className="text-sm font-medium">baseURL</p>
            <p className="break-all text-sm text-muted-foreground">{preview.apiHost}</p>
            <p className="text-xs leading-5 text-muted-foreground">
              添加后可修改地址，填写服务商提供的 API 密钥并保存。
            </p>
          </div>
          <Button
            type="button"
            variant="solid"
            disabled={vm.working}
            onClick={() => void add(preview.name, preview.apiHost)}
          >
            添加 {preview.name}
          </Button>
          {vm.notice?.kind === 'failed' ? <ErrorNotice message={vm.notice.message} /> : null}
        </div>
      ) : vm.selected ? (
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
