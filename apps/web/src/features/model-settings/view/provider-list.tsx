'use client';

import { useState } from 'react';
import { Plus } from 'lucide-react';
import { Button } from '@lorelum/lumen-ui/components/button';
import { Input } from '@lorelum/lumen-ui/components/input';
import type { Provider } from '../model/model-config';
import { availablePresets } from '../model/provider-presets';
import { ProviderIcon } from './provider-icon';

export function ProviderList({
  providers,
  previewName,
  selectedId,
  disabled,
  onSelect,
  onPreview,
  onAdd,
}: {
  providers: Provider[];
  previewName: string | null;
  selectedId: string | null;
  disabled: boolean;
  onPreview: (name: string) => void;
  onSelect: (id: string) => void;
  onAdd: (name: string, apiHost?: string) => Promise<boolean>;
}) {
  const [query, setQuery] = useState('');
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const visible = providers.filter((item) =>
    item.name.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const presets = availablePresets(providers, query);

  return (
    <div className="flex min-w-0 flex-col gap-2 lg:w-52 lg:shrink-0">
      <div className="relative">
        <Input
          variant="glass"
          placeholder="搜索服务商"
          aria-label="搜索服务商"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>

      {visible.length > 0 ? (
        <p className="px-2 pt-1 text-xs text-muted-foreground">已添加</p>
      ) : null}
      <ul
        className="flex max-h-64 min-h-0 flex-col gap-0.5 overflow-y-auto"
        aria-label="模型服务商"
      >
        {visible.map((provider) => {
          const active = provider.id === selectedId;
          return (
            <li key={provider.id}>
              <button
                type="button"
                disabled={disabled}
                aria-current={active ? 'true' : undefined}
                className={`flex min-h-12 w-full items-center gap-2.5 rounded-lg px-2 text-left text-sm transition-colors disabled:opacity-60 ${
                  active ? 'bg-foreground/10 font-medium' : 'hover:bg-foreground/5'
                }`}
                onClick={() => onSelect(provider.id)}
              >
                <ProviderIcon name={provider.name} />
                <span className="min-w-0 flex-1 truncate">{provider.name}</span>
                {provider.enabled ? (
                  <span className="size-1.5 shrink-0 rounded-full bg-success" title="已启用">
                    <span className="sr-only">已启用</span>
                  </span>
                ) : null}
              </button>
            </li>
          );
        })}
        {visible.length === 0 && presets.length === 0 ? (
          <li className="px-2.5 py-2 text-[13px] text-muted-foreground">没有匹配的服务商。</li>
        ) : null}
      </ul>

      {presets.length > 0 ? (
        <div className="space-y-1 border-t border-separator pt-2">
          <p className="px-2 text-xs text-muted-foreground">常用服务商</p>
          <ul className="max-h-64 space-y-1 overflow-y-auto" aria-label="常用服务商">
            {presets.map((preset) => (
              <li
                key={preset.name}
                className={`flex items-center rounded-lg transition-colors ${previewName === preset.name ? 'bg-foreground/10' : 'hover:bg-foreground/5'}`}
              >
                <button
                  type="button"
                  disabled={disabled}
                  aria-current={previewName === preset.name ? 'true' : undefined}
                  className="flex min-h-12 min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2 text-left text-sm disabled:opacity-60"
                  onClick={() => onPreview(preset.name)}
                >
                  <ProviderIcon name={preset.name} />
                  <span className="min-w-0 flex-1 truncate">{preset.name}</span>
                </button>
                <button
                  type="button"
                  disabled={disabled}
                  aria-label={`添加 ${preset.name}`}
                  title={`添加 ${preset.name}`}
                  className="mr-1 grid size-9 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-foreground/10 hover:text-foreground disabled:opacity-60"
                  onClick={() => void onAdd(preset.name, preset.apiHost)}
                >
                  <Plus className="size-4" aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {adding ? (
        <form
          className="flex flex-col gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            if (!name.trim()) return;
            void onAdd(name).then((ok) => {
              if (ok) {
                setName('');
                setAdding(false);
              }
            });
          }}
        >
          <Input
            autoFocus
            variant="glass"
            placeholder="服务商名称"
            aria-label="服务商名称"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <div className="flex gap-1.5">
            <Button
              type="submit"
              variant="solid"
              className="flex-1"
              disabled={disabled || !name.trim()}
            >
              添加
            </Button>
            <Button
              type="button"
              variant="glass"
              color="default"
              disabled={disabled}
              onClick={() => {
                setAdding(false);
                setName('');
              }}
            >
              取消
            </Button>
          </div>
        </form>
      ) : (
        <Button
          type="button"
          variant="glass"
          color="default"
          disabled={disabled}
          onClick={() => setAdding(true)}
        >
          <Plus className="size-4" aria-hidden="true" />
          添加服务商
        </Button>
      )}
    </div>
  );
}
