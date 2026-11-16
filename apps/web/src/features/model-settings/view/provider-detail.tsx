'use client';

import { useEffect, useRef, useState } from 'react';
import {
  Activity,
  CheckCircle2,
  ChevronDown,
  Eye,
  EyeOff,
  FlaskConical,
  LoaderCircle,
  KeyRound,
  Minus,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Settings2,
  Trash2,
} from 'lucide-react';
import { Badge } from '@lorelum/lumen-ui/components/badge';
import { Button } from '@lorelum/lumen-ui/components/button';
import { Input } from '@lorelum/lumen-ui/components/input';
import { Label } from '@lorelum/lumen-ui/components/label';
import { Select } from '@lorelum/lumen-ui/components/select';
import { Switch } from '@lorelum/lumen-ui/components/switch';
import { Toast, useToastManager } from '@lorelum/lumen-ui/components/toast';
import { ErrorNotice } from '@/shared/ui/page';
import {
  canSetDefault,
  groupModels,
  isConfigured,
  modelLabel,
  type Provider,
} from '../model/model-config';
import type { useModelSettings } from '../viewmodel/use-model-settings';
import { ModelPanel } from './model-panel';

type Vm = ReturnType<typeof useModelSettings>;

function FieldError({ id, message }: { id: string; message?: string }) {
  return message ? (
    <p id={id} className="text-[13px] leading-5 text-destructive">
      {message}
    </p>
  ) : null;
}

function ModelList({ provider, vm }: { provider: Provider; vm: Vm }) {
  const [panel, setPanel] = useState<{ modelId: string | null } | null>(null);
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const groups = groupModels(provider);
  const defaultOptions = provider.models.map((model) => ({ value: model, label: model }));

  return (
    <section aria-label="模型" className="space-y-2">
      <div className="space-y-1.5 pb-3">
        <Label htmlFor="default-model">默认模型</Label>
        <Select
          items={[{ value: '', label: '未设置默认模型' }, ...defaultOptions]}
          value={provider.defaultModelId ?? ''}
          disabled={vm.working || !canSetDefault(provider, null)}
          onValueChange={(value) => void vm.setDefault(value || null)}
        >
          <Select.Trigger id="default-model" className="w-full max-w-full" variant="glass">
            <Select.Value />
          </Select.Trigger>
          <Select.Content className="!bg-popover">
            <Select.Item value="">未设置默认模型</Select.Item>
            {defaultOptions.map((option) => (
              <Select.Item key={option.value} value={option.value}>
                {option.label}
              </Select.Item>
            ))}
          </Select.Content>
        </Select>
      </div>
      <div className="flex items-center gap-2">
        <h3 className="text-sm leading-5 font-semibold">模型</h3>
        <span className="text-xs text-muted-foreground">{provider.models.length}</span>
        <div className="ml-auto flex items-center gap-1">
          <Button
            type="button"
            variant="glass"
            color="default"
            size="icon"
            aria-label="同步模型"
            title="同步模型"
            disabled={vm.working || !isConfigured(provider)}
            onClick={() => void vm.syncModels()}
          >
            <RefreshCw
              className={`size-4 ${vm.busy === 'syncing' ? 'animate-spin' : ''}`}
              aria-hidden="true"
            />
          </Button>
          <Button
            type="button"
            variant="glass"
            color="default"
            size="icon"
            aria-label="手动添加模型"
            aria-haspopup="dialog"
            disabled={vm.working}
            onClick={() => setPanel({ modelId: null })}
          >
            <Plus className="size-4" aria-hidden="true" />
          </Button>
        </div>
      </div>

      {groups.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-[13px] leading-5 text-muted-foreground">
          还没有模型。
          {isConfigured(provider) ? '点“同步模型”，或手动添加模型 ID。' : '先保存 baseURL。'}
        </p>
      ) : (
        <div className="space-y-2">
          {groups.map(({ group, models }) => {
            const folded = closed[group] === true;
            return (
              <div key={group} className="rounded-lg bg-foreground/5 p-1">
                <button
                  type="button"
                  aria-expanded={!folded}
                  className="flex h-8 w-full items-center gap-1.5 rounded-md px-2 text-left text-[13px] font-medium"
                  onClick={() => setClosed((all) => ({ ...all, [group]: !folded }))}
                >
                  <ChevronDown
                    className={`size-4 text-muted-foreground transition-transform ${folded ? '-rotate-90' : ''}`}
                    aria-hidden="true"
                  />
                  {group}
                </button>
                {folded ? null : (
                  <ul>
                    {models.map((id) => {
                      const test = vm.modelTests[id];
                      return (
                        <li key={id} className="rounded-md px-2 text-sm">
                          <div className="flex min-h-9 items-center gap-2">
                            <span className="min-w-0 flex-1 truncate" title={id}>
                              {modelLabel(id)}
                            </span>
                            <Button
                              type="button"
                              variant="clear"
                              color="default"
                              size="icon"
                              aria-label={`设置 ${id}`}
                              title="模型设置"
                              disabled={vm.working}
                              onClick={() => setPanel({ modelId: id })}
                            >
                              <Settings2 className="size-4" aria-hidden="true" />
                            </Button>
                            <Button
                              type="button"
                              variant="clear"
                              color="default"
                              size="icon"
                              aria-label={`检测模型 ${id}`}
                              title={`检测模型 ${id}`}
                              disabled={vm.working}
                              onClick={() => void vm.runModelTest(id)}
                            >
                              {test?.kind === 'testing' ? (
                                <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
                              ) : (
                                <FlaskConical className="size-4" aria-hidden="true" />
                              )}
                            </Button>
                            <Button
                              type="button"
                              variant="clear"
                              color="default"
                              size="icon"
                              aria-label={`移除 ${id}`}
                              disabled={vm.working}
                              onClick={() => {
                                if (window.confirm(`移除模型 ${id}？`)) void vm.removeModel(id);
                              }}
                            >
                              <Minus className="size-4" aria-hidden="true" />
                            </Button>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      )}
      {panel ? (
        <ModelPanel
          key={panel.modelId ?? 'new'}
          provider={provider}
          modelId={panel.modelId}
          working={vm.working}
          error={vm.notice?.kind === 'failed' ? vm.notice.message : null}
          onSave={panel.modelId ? vm.updateModel : vm.addModel}
          onClose={() => setPanel(null)}
        />
      ) : null}
    </section>
  );
}

export function ProviderDetail(props: { provider: Provider; vm: Vm }) {
  return (
    <Toast.Provider placement="top-end" timeout={10000} variant="solid">
      <ProviderDetailContent {...props} />
    </Toast.Provider>
  );
}

function ProviderDetailContent({ provider, vm }: { provider: Provider; vm: Vm }) {
  const [showKey, setShowKey] = useState(false);
  const configured = isConfigured(provider);
  const toast = useToastManager();
  const previous = useRef({ connection: vm.connectionTest, models: vm.modelTests });
  useEffect(() => {
    const before = previous.current;
    if (before.connection !== vm.connectionTest) {
      const test = vm.connectionTest;
      if (test.kind === 'ok') {
        toast.add({
          type: 'success',
          title: '服务商接口已响应',
          description: `${test.result.latency_ms} ms · 不代表模型可用`,
        });
      } else if (test.kind === 'failed') {
        toast.add({
          type: 'error',
          title: '服务商检测失败',
          description: test.message,
          timeout: 10000,
        });
      }
    }
    for (const [id, test] of Object.entries(vm.modelTests)) {
      if (before.models[id] === test) continue;
      if (test.kind === 'ok') {
        const entries = [
          ['文本／流', test.result.text_stream],
          ['工具往返', test.result.tool_round_trip],
          ['用量', test.result.usage],
        ] as const;
        const complete = entries.every(([, result]) => result.status === 'passed');
        const description = entries
          .map(
            ([label, result]) =>
              `${label} ${result.status === 'passed' ? '通过' : result.status === 'failed' ? '失败' : '未测试'}${result.latency_ms === null ? '' : ` ${result.latency_ms} ms`}`,
          )
          .join(' · ');
        toast.add({
          type: complete ? 'success' : 'warning',
          title: `${id} 检测${complete ? '通过' : '未全部通过'}`,
          description,
        });
      } else if (test.kind === 'failed') {
        toast.add({
          type: 'error',
          title: `${id} 检测失败`,
          description: test.message,
          timeout: 10000,
        });
      }
    }
    previous.current = { connection: vm.connectionTest, models: vm.modelTests };
  }, [toast, vm.connectionTest, vm.modelTests]);

  return (
    <div className="min-w-0 flex-1 space-y-6" aria-busy={vm.working}>
      <div className="flex items-center gap-2 pr-10">
        <h2 className="min-w-0 truncate text-base leading-6 font-semibold">{provider.name}</h2>
        <Badge variant="glass">{configured ? '已配置' : '未配置'}</Badge>
        <Button
          type="button"
          className="ml-auto"
          variant="clear"
          color="danger"
          size="icon"
          aria-label="删除接入"
          title="删除接入"
          disabled={vm.working}
          onClick={() => {
            if (
              window.confirm(
                '删除该接入？依赖它的运行后续可能无法调用；已发送的数据和已接受的效果不能撤回。',
              )
            )
              void vm.deleteProvider();
          }}
        >
          <Trash2 className="size-4" aria-hidden="true" />
        </Button>
        <Switch
          className="shrink-0"
          color="success"
          aria-label={`启用 ${provider.name}`}
          checked={provider.enabled}
          disabled={vm.working}
          onCheckedChange={(checked) => void vm.setEnabled(checked)}
        />
      </div>

      {!configured ? (
        <p className="text-[13px] leading-5 text-muted-foreground">
          配置 baseURL 后可同步模型，也可使用不需要密钥的端点。
        </p>
      ) : null}

      <form
        className="space-y-5"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void vm.save();
        }}
      >
        <div className="space-y-1.5">
          <Label htmlFor="provider-api-key">API 密钥</Label>
          <div className="flex gap-2">
            <div className="relative min-w-0 flex-1">
              <Input
                id="provider-api-key"
                className="pr-10"
                type={showKey ? 'text' : 'password'}
                name="model-service-key"
                autoComplete="off"
                data-1p-ignore
                data-lpignore="true"
                data-form-type="other"
                spellCheck={false}
                value={vm.draft.apiKey}
                readOnly={vm.working}
                placeholder={provider.hasApiKey ? '已保存密钥（留空沿用）' : 'sk-…'}
                aria-invalid={Boolean(vm.errors.apiKey)}
                aria-describedby="provider-api-key-error"
                variant="glass"
                onChange={(event) => vm.edit('apiKey', event.target.value)}
              />
              <Button
                type="button"
                variant="clear"
                color="default"
                size="icon"
                className="absolute top-0 right-0"
                aria-label={showKey ? '隐藏 API 密钥' : '显示 API 密钥'}
                aria-pressed={showKey}
                onClick={() => setShowKey((visible) => !visible)}
              >
                {showKey ? (
                  <EyeOff className="size-4" aria-hidden="true" />
                ) : (
                  <Eye className="size-4" aria-hidden="true" />
                )}
              </Button>
            </div>
            <Button
              type="button"
              variant="glass"
              color="default"
              size="icon"
              aria-label={vm.connectionTest.kind === 'testing' ? '检测服务商中' : '检测服务商连接'}
              title="检测服务商连接"
              disabled={vm.working}
              onClick={() => void vm.runTest()}
            >
              {vm.connectionTest.kind === 'testing' ? (
                <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
              ) : (
                <Activity className="size-4" aria-hidden="true" />
              )}
            </Button>
            {provider.hasApiKey ? (
              <Button
                type="button"
                variant="clear"
                color="danger"
                size="icon"
                aria-label="清除密钥"
                title="清除密钥"
                disabled={vm.working}
                onClick={() => {
                  if (window.confirm('清除密钥会使使用旧密钥的运行无法继续调用模型。确定清除？'))
                    void vm.clearKey();
                }}
              >
                {vm.busy === 'clearing' ? (
                  <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
                ) : (
                  <KeyRound className="size-4" aria-hidden="true" />
                )}
              </Button>
            ) : null}
          </div>
          <FieldError id="provider-api-key-error" message={vm.errors.apiKey} />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="provider-api-host">baseURL</Label>
          <Input
            id="provider-api-host"
            type="url"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            value={vm.draft.apiHost}
            readOnly={vm.working}
            placeholder="https://api.example.com/v1"
            aria-invalid={Boolean(vm.errors.apiHost)}
            aria-describedby="provider-api-host-error"
            variant="glass"
            onChange={(event) => vm.edit('apiHost', event.target.value)}
          />
          <FieldError id="provider-api-host-error" message={vm.errors.apiHost} />
        </div>

        <div className="space-y-2" aria-live="polite">
          {vm.notice?.kind === 'failed' ? (
            <ErrorNotice message={`没有完成：${vm.notice.message}`} />
          ) : null}
          {vm.notice?.kind === 'ok' ? (
            <p className="flex items-center gap-1.5 text-[13px] leading-5 text-success">
              <CheckCircle2 className="size-4" aria-hidden="true" />
              {vm.notice.message}
            </p>
          ) : null}
        </div>

        <div className="flex gap-2">
          {vm.dirty ? (
            <>
              <Button
                type="submit"
                variant="solid"
                size="icon"
                aria-label="保存"
                title="保存"
                disabled={vm.working}
              >
                {vm.busy === 'saving' ? (
                  <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
                ) : (
                  <Save className="size-4" aria-hidden="true" />
                )}
              </Button>
              <Button
                type="button"
                variant="glass"
                color="default"
                size="icon"
                aria-label="还原修改"
                title="还原修改"
                disabled={vm.working}
                onClick={vm.reset}
              >
                <RotateCcw className="size-4" aria-hidden="true" />
              </Button>
            </>
          ) : null}
        </div>
      </form>

      <ModelList key={provider.id} provider={provider} vm={vm} />
    </div>
  );
}
