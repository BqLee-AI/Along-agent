'use client';

import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Button } from '@lorelum/lumen-ui/components/button';
import { Dialog } from '@lorelum/lumen-ui/components/dialog';
import { Input } from '@lorelum/lumen-ui/components/input';
import { useModelCatalog } from '@/features/model-settings/viewmodel/model-catalog-context';
import { readSkills } from '@/features/skills/model/skill';
import { useHistoryPage } from '@/shared/http/use-page';
import { ErrorNotice } from '@/shared/ui/page';
import { ReadControls } from '@/shared/ui/read-controls';
import {
  readSelectedBot,
  saveBot,
  type PersonalBot,
  type PersonalBotConfig,
} from '../model/personal-bot';
import { readWorkspaceRegistration } from '../model/workspace-registration';

const tools: Record<string, string> = {
  propose_task: '提议创建提醒',
  request_cancel_task: '提议取消提醒',
  list_tasks: '列出提醒',
  create_reminder: '创建提醒',
  cancel_reminder: '取消提醒',
  get_task: '查看单条提醒',
  get_user_prefs: '读取用户偏好',
  set_user_timezone: '设置用户时区',
  read_brief_cards: '读取概览卡片',
  workspace_list: '列出登记资料',
  workspace_grep: '在登记资料中搜索',
  workspace_read: '读取登记资料',
  workspace_propose_replace: '提议修改登记资料',
  workspace_apply_replace: '执行已批准的修改',
  workspace_replace: '修改登记资料',
  workspace_create: '在登记范围内新建文件',
  feishu_docx_read: '读取飞书文档',
  learn_docs_search: '搜索公开文档',
  read_run_observation: '回读运行观察',
  recall_memories: '召回记忆',
  read_memory_source: '读取记忆来源',
  remember_memory: '保存记忆',
};

const emptyConfig: PersonalBotConfig = {
  name: '',
  introduction: '',
  role: '',
  instructions: '',
  model_selection: null,
  tool_ids: [],
  workspace_ids: [],
};
const textClass =
  'min-h-11 w-full rounded-control border border-separator bg-background px-3 py-2 text-base focus-visible:outline-2 focus-visible:outline-ring';

async function readWorkspaceChoices(_cursor: string | null, signal: AbortSignal) {
  return { items: await readWorkspaceRegistration(signal), nextCursor: null };
}

function ScopeChoices({
  title,
  options,
  selected,
  onChange,
}: {
  title: string;
  options: { id: string; label: string }[];
  selected: string[];
  onChange: (values: string[]) => void;
}) {
  return (
    <fieldset className="space-y-1">
      <legend className="font-medium">{title}</legend>
      {options.map(({ id, label }) => (
        <label
          key={id}
          className="flex min-h-10 items-center gap-3 text-sm [overflow-wrap:anywhere]"
        >
          <input
            type="checkbox"
            checked={selected.includes(id)}
            className="size-4 shrink-0 focus-visible:outline-2 focus-visible:outline-ring"
            onChange={(event) =>
              onChange(
                event.target.checked ? [...selected, id] : selected.filter((value) => value !== id),
              )
            }
          />
          <span>{label}</span>
        </label>
      ))}
    </fieldset>
  );
}

export function PersonalBotSettings({
  bot,
  onClose,
  onSaved,
}: {
  bot: PersonalBot | null;
  onClose: () => void;
  onSaved: (bot: PersonalBot) => void;
}) {
  const formId = useId();
  const botId = bot?.id ?? null;
  const [draft, setDraft] = useState(emptyConfig);
  const [base, setBase] = useState<PersonalBot | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [readRevision, setReadRevision] = useState(0);
  const loading = Boolean(botId && !base && !readError);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const catalog = useModelCatalog();
  const workspaces = useHistoryPage('bot-workspace-choices', readWorkspaceChoices);
  const skills = useHistoryPage('bot-skill-choices', readSkills);
  useEffect(() => () => request.current?.abort(), []);
  const refreshModels = catalog.refresh;
  useEffect(() => {
    void refreshModels();
  }, [refreshModels]);
  useEffect(() => {
    if (!botId) return;
    const controller = new AbortController();
    void readSelectedBot(botId, null, controller.signal).then(
      (value) => {
        if (!controller.signal.aborted && value) {
          setBase(value);
          setDraft(value.config);
        }
      },
      (failure: unknown) => {
        if (!controller.signal.aborted)
          setReadError(failure instanceof Error ? failure.message : '设置读取失败。');
      },
    );
    return () => controller.abort();
  }, [botId, readRevision]);

  function reload() {
    setBase(null);
    setReadError(null);
    setError(null);
    setReadRevision((value) => value + 1);
  }

  function setValue<K extends keyof PersonalBotConfig>(field: K, value: PersonalBotConfig[K]) {
    setDraft((current) => ({ ...current, [field]: value }));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (request.current || (botId && !base) || !draft.name.trim()) return;
    const controller = new AbortController();
    request.current = controller;
    setError(null);
    setSaving(true);
    try {
      const saved = await saveBot(base, { ...draft, name: draft.name.trim() }, controller.signal);
      if (!controller.signal.aborted) onSaved(saved);
    } catch (failure) {
      if (!controller.signal.aborted)
        setError(failure instanceof Error ? failure.message : '保存 Bot 失败。');
    } finally {
      if (!controller.signal.aborted) {
        request.current = null;
        setSaving(false);
      }
    }
  }

  const modelValue = draft.model_selection
    ? JSON.stringify([draft.model_selection.provider_id, draft.model_selection.model_id])
    : '';
  const models =
    catalog.state === 'ready'
      ? catalog.snapshot.items
          .filter((provider) => provider.enabled && provider.base_url)
          .flatMap((provider) =>
            provider.models.map((model_id) => ({
              key: JSON.stringify([provider.id, model_id]),
              label: `${provider.name} · ${model_id}`,
              value: { provider_id: provider.id, model_id },
            })),
          )
      : [];
  const workspaceOptions = workspaces.state.items.map((item) => ({
    id: item.workspace_id,
    label: item.label,
  }));
  const missingWorkspaces = draft.workspace_ids.filter(
    (id) => !workspaceOptions.some((item) => item.id === id),
  );
  const unknownTools = draft.tool_ids.filter((id) => !Object.hasOwn(tools, id));
  const assignedSkills = draft.skill_ids ?? [];
  const skillOptions = skills.state.items.filter(
    (item) => !item.disabled_at || assignedSkills.includes(item.id),
  );
  const missingSkills = assignedSkills.filter((id) => !skillOptions.some((item) => item.id === id));
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !request.current) onClose();
      }}
    >
      <Dialog.Content className="flex max-h-[85dvh] max-w-xl flex-col">
        <Dialog.Header>
          <Dialog.Title>{bot ? `${bot.config.name} · Bot 设置` : '创建 Bot'}</Dialog.Title>
          <Dialog.Description>
            设置仅应用于这个 Bot。工具和资料范围不能扩大账户权限。
          </Dialog.Description>
        </Dialog.Header>
        {loading ? (
          <p role="status" className="text-sm text-muted-foreground">
            正在读取 Bot 设置…
          </p>
        ) : null}
        {readError ? (
          <ErrorNotice message={readError}>
            <Button type="button" variant="glass" color="default" onClick={reload}>
              重新读取设置
            </Button>
          </ErrorNotice>
        ) : null}
        <form
          className="min-h-0 space-y-5 overflow-y-auto overscroll-contain px-1 py-2"
          onSubmit={(event) => void submit(event)}
        >
          <fieldset
            disabled={saving || Boolean(botId && !base)}
            hidden={Boolean(botId && !base)}
            className="space-y-5"
          >
            <label className="block space-y-1 font-medium">
              <span>名称（必填）</span>
              <Input
                required
                maxLength={200}
                value={draft.name}
                onChange={(event) => setValue('name', event.target.value)}
              />
            </label>
            {(
              [
                ['introduction', '简介', 2000, 2],
                ['role', '角色说明', 4000, 3],
                ['instructions', '行为指令', 16000, 4],
              ] as const
            ).map(([field, label, maxLength, rows]) => (
              <label key={field} className="block space-y-1 font-medium">
                <span>{label}</span>
                <textarea
                  className={textClass}
                  maxLength={maxLength}
                  rows={rows}
                  value={draft[field]}
                  onChange={(event) => setValue(field, event.target.value)}
                />
              </label>
            ))}
            <div className="space-y-2">
              <label htmlFor={`${formId}-model`} className="font-medium">
                模型
              </label>
              <select
                id={`${formId}-model`}
                className={textClass}
                value={modelValue}
                onChange={(event) =>
                  setValue(
                    'model_selection',
                    models.find((model) => model.key === event.target.value)?.value ?? null,
                  )
                }
              >
                <option value="">
                  继承账户默认模型
                  {catalog.snapshot.default_selection
                    ? ` · ${catalog.snapshot.default_selection.model_id}`
                    : ''}
                </option>
                {modelValue && !models.some(({ key }) => key === modelValue) ? (
                  <option value={modelValue} disabled>
                    已保存 · {draft.model_selection?.model_id}（不在当前可选列表）
                  </option>
                ) : null}
                {models.map((model) => (
                  <option key={model.key} value={model.key}>
                    {model.label}
                  </option>
                ))}
              </select>
              {catalog.state === 'loading' ? (
                <p role="status" className="text-sm text-muted-foreground">
                  正在读取可选模型…
                </p>
              ) : null}
              {catalog.error ? (
                <ErrorNotice message={catalog.error}>
                  <Button
                    type="button"
                    variant="glass"
                    color="default"
                    onClick={() => void catalog.refresh()}
                  >
                    重新读取模型
                  </Button>
                </ErrorNotice>
              ) : null}
            </div>
            <details>
              <summary className="min-h-11 cursor-pointer content-center font-medium">
                工具与资料范围
              </summary>
              <p className="mb-4 text-sm text-muted-foreground">
                未选择的工具和资料不会授予此 Bot。空范围表示不授权，而非全部授权。
              </p>
              <ScopeChoices
                title="允许使用的工具"
                options={[
                  ...Object.entries(tools).map(([id, label]) => ({
                    id,
                    label: `${label} · ${id}`,
                  })),
                  ...unknownTools.map((id) => ({ id, label: `${id}（不在当前可选列表）` })),
                ]}
                selected={draft.tool_ids}
                onChange={(values) => setValue('tool_ids', values)}
              />
              <ScopeChoices
                title="允许使用的已登记资料"
                options={[
                  ...workspaceOptions,
                  ...missingWorkspaces.map((id) => ({ id, label: `${id}（不在当前可选列表）` })),
                ]}
                selected={draft.workspace_ids}
                onChange={(values) => setValue('workspace_ids', values)}
              />
              {workspaces.state.reading ? (
                <p role="status" className="text-sm text-muted-foreground">
                  正在读取资料登记…
                </p>
              ) : null}
              {workspaces.state.error ? (
                <ErrorNotice message={workspaces.state.error}>
                  <Button
                    type="button"
                    variant="glass"
                    color="default"
                    onClick={() => void workspaces.read(true)}
                  >
                    重新读取资料登记
                  </Button>
                </ErrorNotice>
              ) : null}
              {workspaces.state.loaded && !workspaceOptions.length ? (
                <p className="text-sm text-muted-foreground">账户目前没有可选的资料登记。</p>
              ) : null}
            </details>
            <details>
              <summary className="min-h-11 cursor-pointer content-center font-medium">
                技能{assignedSkills.length ? ` · ${assignedSkills.length} 项已分配` : ''}
              </summary>
              <p className="mb-4 text-sm text-muted-foreground">
                分配后，可在对话中为单条消息选用。技能是文本指令，不授予工具或资料权限。
              </p>
              <ScopeChoices
                title="分配给此 Bot 的技能"
                options={[
                  ...skillOptions.map((item) => ({
                    id: item.id,
                    label: `${item.name} · 版本 ${item.revision}${item.disabled_at ? '（已停用，可移除）' : ''} · ${item.description}`,
                  })),
                  ...missingSkills.map((id) => ({
                    id,
                    label: `已分配技能 ${id}（列表中未显示，可移除）`,
                  })),
                ]}
                selected={assignedSkills}
                onChange={(values) => setValue('skill_ids', values)}
              />
              {skills.state.loaded &&
              !skills.state.nextCursor &&
              !skillOptions.length &&
              !missingSkills.length ? (
                <p className="text-sm text-muted-foreground">
                  还没有可分配的技能。请先在「设置 → 技能」创建。
                </p>
              ) : null}
              <ReadControls state={skills.state} read={skills.read} label="技能" compact />
            </details>
          </fieldset>
          {error ? (
            <ErrorNotice message={error}>
              {botId ? (
                <Button type="button" variant="glass" color="default" onClick={reload}>
                  放弃未保存的修改并重新读取
                </Button>
              ) : null}
            </ErrorNotice>
          ) : null}
          <Dialog.Footer>
            <Button
              type="button"
              variant="glass"
              color="default"
              disabled={saving}
              onClick={onClose}
            >
              取消
            </Button>
            <Button
              type="submit"
              color="primary"
              disabled={saving || Boolean(botId && !base) || !draft.name.trim()}
            >
              {saving ? '正在保存…' : bot ? '保存设置' : '创建 Bot'}
            </Button>
          </Dialog.Footer>
        </form>
      </Dialog.Content>
    </Dialog>
  );
}
