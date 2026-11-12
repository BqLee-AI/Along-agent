'use client';

import { useState } from 'react';
import { Plus } from 'lucide-react';
import { Button } from '@lorelum/lumen-ui/components/button';
import { Input } from '@lorelum/lumen-ui/components/input';
import type { DefaultSelection, Provider } from '../model/model-config';

export function ProviderList({
  providers,
  selectedId,
  disabled,
  selection,
  onClearDefault,
  onSelect,
  onAdd,
}: {
  providers: Provider[];
  selectedId: string | null;
  disabled: boolean;
  selection: DefaultSelection;
  onClearDefault: () => void;
  onSelect: (id: string) => void;
  onAdd: (name: string) => Promise<boolean>;
}) {
  const [query, setQuery] = useState('');
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const visible = providers.filter((item) =>
    item.name.toLowerCase().includes(query.trim().toLowerCase()),
  );

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

      <ul className="flex min-h-0 flex-col gap-0.5" aria-label="模型服务商">
        {visible.map((provider) => {
          const active = provider.id === selectedId;
          return (
            <li key={provider.id}>
              <button
                type="button"
                disabled={disabled}
                aria-current={active ? 'true' : undefined}
                className={`flex h-9 w-full items-center gap-2 rounded-md px-2.5 text-left text-sm transition-colors disabled:opacity-60 ${
                  active ? 'bg-foreground/10 font-medium' : 'hover:bg-foreground/5'
                }`}
                onClick={() => onSelect(provider.id)}
              >
                <span
                  className="grid size-5 shrink-0 place-items-center rounded bg-foreground/10 text-[11px] font-semibold"
                  aria-hidden="true"
                >
                  {provider.name.slice(0, 1)}
                </span>
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
        {visible.length === 0 ? (
          <li className="px-2.5 py-2 text-[13px] text-muted-foreground">没有匹配的服务商。</li>
        ) : null}
      </ul>

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

      <div className="mt-2 space-y-1 border-t border-separator pt-3">
        <p className="text-xs leading-5 text-muted-foreground">
          默认模型：
          {selection
            ? `${providers.find((item) => item.id === selection.provider_id)?.name ?? selection.provider_id} / ${selection.model_id}`
            : '尚未设置'}
        </p>
        {selection ? (
          <Button
            type="button"
            variant="clear"
            color="default"
            disabled={disabled}
            onClick={onClearDefault}
          >
            清除默认模型
          </Button>
        ) : null}
      </div>
    </div>
  );
}
