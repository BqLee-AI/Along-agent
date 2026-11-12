'use client';

import { useState } from 'react';
import {
  CheckCircle2,
  ChevronDown,
  Eye,
  EyeOff,
  LoaderCircle,
  Minus,
  Plus,
  RefreshCw,
} from 'lucide-react';
import { Badge } from '@lorelum/lumen-ui/components/badge';
import { Button } from '@lorelum/lumen-ui/components/button';
import { Input } from '@lorelum/lumen-ui/components/input';
import { Label } from '@lorelum/lumen-ui/components/label';
import { Switch } from '@lorelum/lumen-ui/components/switch';
import { ErrorNotice } from '@/shared/ui/page';
import {
  groupModels,
  isConfigured,
  modelLabel,
  validateModelId,
  type Provider,
} from '../model/model-config';
import type { useModelSettings } from '../viewmodel/use-model-settings';

type Vm = ReturnType<typeof useModelSettings>;

function FieldError({ id, message }: { id: string; message?: string }) {
  return message ? (
    <p id={id} className="text-[13px] leading-5 text-destructive">
      {message}
    </p>
  ) : null;
}

function ModelList({ provider, vm }: { provider: Provider; vm: Vm }) {
  const [adding, setAdding] = useState(false);
  const [modelId, setModelId] = useState('');
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const [touched, setTouched] = useState(false);
  const problem = touched ? validateModelId(modelId, provider) : null;
  const groups = groupModels(provider);

  return (
    <section aria-label="模型" className="space-y-2">
      <div className="flex items-center gap-2">
        <h3 className="text-sm leading-5 font-semibold">模型</h3>
        <span className="text-xs text-muted-foreground">{provider.models.length}</span>
        <div className="ml-auto flex items-center gap-1">
          <Button
            type="button"
            variant="glass"
            color="default"
            disabled={vm.working || !isConfigured(provider)}
            onClick={() => void vm.syncModels()}
          >
            <RefreshCw
              className={`size-4 ${vm.busy === 'syncing' ? 'animate-spin' : ''}`}
              aria-hidden="true"
            />
            同步模型
          </Button>
          <Button
            type="button"
            variant="glass"
            color="default"
            size="icon"
            aria-label="手动添加模型"
            aria-expanded={adding}
            disabled={vm.working}
            onClick={() => setAdding((open) => !open)}
          >
            <Plus className="size-4" aria-hidden="true" />
          </Button>
        </div>
      </div>

      {adding ? (
        <form
          className="flex items-start gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            setTouched(true);
            if (validateModelId(modelId, provider)) return;
            void vm.addModel(modelId).then((ok) => {
              if (ok) {
                setModelId('');
                setTouched(false);
              }
            });
          }}
        >
          <div className="min-w-0 flex-1 space-y-1">
            <Input
              variant="glass"
              spellCheck={false}
              autoComplete="off"
              aria-label="模型 ID"
              aria-invalid={Boolean(problem)}
              placeholder="模型 ID，例如 vendor/model-name"
              value={modelId}
              onChange={(event) => setModelId(event.target.value)}
            />
            <FieldError id="model-id-error" message={problem ?? undefined} />
          </div>
          <Button type="submit" variant="solid" disabled={vm.working}>
            添加
          </Button>
        </form>
      ) : null}

      {groups.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-[13px] leading-5 text-muted-foreground">
          还没有模型。
          {isConfigured(provider) ? '点“同步模型”，或手动添加模型 ID。' : '先填好密钥和地址。'}
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
                    {models.map((id) => (
                      <li key={id} className="flex h-9 items-center gap-2 rounded-md px-2 text-sm">
                        <span className="min-w-0 flex-1 truncate" title={id}>
                          {modelLabel(id)}
                        </span>
                        <Button
                          type="button"
                          variant="clear"
                          color="default"
                          disabled={vm.working}
                          aria-pressed={vm.testModel === id}
                          onClick={() => vm.setTestModel(vm.testModel === id ? '' : id)}
                        >
                          {vm.testModel === id ? '检测模型' : '用于检测'}
                        </Button>
                        {vm.selection?.provider_id === provider.id &&
                        vm.selection.model_id === id ? (
                          <span className="text-xs text-muted-foreground">默认</span>
                        ) : (
                          <Button
                            type="button"
                            variant="clear"
                            color="default"
                            disabled={vm.working || !provider.enabled}
                            onClick={() =>
                              void vm.setDefault({ provider_id: provider.id, model_id: id })
                            }
                          >
                            设为默认
                          </Button>
                        )}
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
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

export function ProviderDetail({ provider, vm }: { provider: Provider; vm: Vm }) {
  const [showKey, setShowKey] = useState(false);
  const configured = isConfigured(provider);

  return (
    <div className="min-w-0 flex-1 space-y-6" aria-busy={vm.working}>
      <div className="flex items-center gap-2 pr-10">
        <h2 className="min-w-0 truncate text-base leading-6 font-semibold">{provider.name}</h2>
        <Badge variant="glass">{configured ? '已配置' : '未配置'}</Badge>
        <Switch
          className="ml-auto"
          color="success"
          aria-label={`启用 ${provider.name}`}
          checked={provider.enabled}
          disabled={vm.working}
          onCheckedChange={(checked) => void vm.setEnabled(checked)}
        />
      </div>

      {!configured ? (
        <p className="text-[13px] leading-5 text-muted-foreground">
          配置 API 地址后可同步模型，也可使用不需要密钥的端点。
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
              disabled={vm.working}
              onClick={() => void vm.runTest()}
            >
              {vm.test.kind === 'testing' ? (
                <>
                  <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
                  检测中
                </>
              ) : (
                '检测'
              )}
            </Button>
          </div>
          <p className="text-xs leading-5 text-muted-foreground">
            {vm.testModel
              ? `检测模型：${vm.testModel}`
              : '可在下方模型列表中选择检测模型；未选择时各项为未测试。'}
          </p>
          <FieldError id="provider-api-key-error" message={vm.errors.apiKey} />
          {provider.hasApiKey ? (
            <p className="flex items-center gap-1 text-xs leading-5 text-muted-foreground">
              已保存密钥，不会回显。
              <Button
                type="button"
                variant="clear"
                color="danger"
                className="h-6 px-1.5 text-xs"
                disabled={vm.working}
                onClick={() => {
                  if (window.confirm('清除密钥会使使用旧密钥的运行无法继续调用模型。确定清除？'))
                    void vm.clearKey();
                }}
              >
                {vm.busy === 'clearing' ? '清除中…' : '清除密钥'}
              </Button>
            </p>
          ) : null}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="provider-api-host">API 地址</Label>
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
          {vm.test.kind === 'ok' ? (
            <div className="text-[13px] leading-5">
              <p className="text-muted-foreground">上一次测试结果：</p>
              <dl>
                {(
                  [
                    ['文本／流', vm.test.result.text_stream],
                    ['工具往返', vm.test.result.tool_round_trip],
                    ['用量', vm.test.result.usage],
                  ] as const
                ).map(([label, result]) => (
                  <div key={label}>
                    <dt className="inline">{label}：</dt>
                    <dd className="inline">
                      {result.status === 'passed'
                        ? '通过'
                        : result.status === 'failed'
                          ? '失败'
                          : '未测试'}
                      {result.latency_ms === null ? '' : `（${result.latency_ms} ms）`}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          ) : null}
          {vm.test.kind === 'failed' ? (
            <ErrorNotice message={`检测失败：${vm.test.message}`} />
          ) : null}
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

        {vm.dirty ? (
          <div className="flex gap-2">
            <Button type="submit" variant="solid" disabled={vm.working}>
              {vm.busy === 'saving' ? '保存中…' : '保存'}
            </Button>
            <Button
              type="button"
              variant="glass"
              color="default"
              disabled={vm.working}
              onClick={vm.reset}
            >
              还原修改
            </Button>
          </div>
        ) : null}
        <Button
          type="button"
          variant="clear"
          color="danger"
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
          删除接入
        </Button>
      </form>

      <ModelList key={provider.id} provider={provider} vm={vm} />
      <p className="text-xs leading-5 text-muted-foreground">
        同步使用已保存的地址和密钥，合并发现结果，不删除已有模型；模型列表不保证调用权限。
      </p>
    </div>
  );
}
