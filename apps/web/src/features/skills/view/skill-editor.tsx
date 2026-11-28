'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import {
  SkillInputSchema,
  type SkillDetail,
  type SkillImportPreview,
  type SkillInput,
} from '@along/contracts';
import { Button } from '@lorelum/lumen-ui/components/button';
import { Dialog } from '@lorelum/lumen-ui/components/dialog';
import { Input } from '@lorelum/lumen-ui/components/input';
import { ApiReadError } from '@/shared/http/client';
import { ErrorNotice } from '@/shared/ui/page';
import {
  createSkill,
  disableSkill,
  previewSkillImport,
  readSkill,
  skillFieldErrors,
  updateSkill,
} from '../model/skill';

export type SkillEditorTarget = { kind: 'create' | 'import' } | { kind: 'existing'; id: string };
type Operation = 'reading' | 'previewing' | 'saving' | 'disabling';
const blank = { name: '', description: '', body: '' } as const satisfies SkillInput;
const fieldCopy = {
  name: { label: '名称', hint: '1–64 个小写字母、数字或单个连字符，连字符不能位于首尾。' },
  description: { label: '用途', hint: '说明什么时候应使用这个技能，最多 1,024 字符。' },
  body: {
    label: '正文',
    hint: 'Markdown 文本，最多 16 KiB（UTF-8）。路径、链接和代码仅作为文本。',
  },
};

function draftOf({ name, description, body }: SkillInput): SkillInput {
  return { name, description, body };
}

export function SkillEditor({
  target,
  onClose,
  onSaved,
}: {
  target: SkillEditorTarget;
  onClose: () => void;
  onSaved: (skill: SkillDetail) => void;
}) {
  const formId = useId();
  const id = target.kind === 'existing' ? target.id : null;
  const importing = target.kind === 'import';
  const [base, setBase] = useState<SkillDetail | null>(null);
  const [draft, setDraft] = useState<SkillInput>(blank);
  const [imported, setImported] = useState<{ filename: string; value: SkillImportPreview } | null>(
    null,
  );
  const [operation, setOperation] = useState<Operation | null>(id ? 'reading' : null);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [conflict, setConflict] = useState(false);
  const [reloaded, setReloaded] = useState(false);
  const [confirmDisable, setConfirmDisable] = useState(false);
  const request = useRef<AbortController | null>(null);
  const createAttempt = useRef<{ snapshot: string; key: string } | null>(null);

  const run = useCallback(
    async (action: Operation, work: (signal: AbortSignal) => Promise<void>) => {
      if (request.current) return;
      const controller = new AbortController();
      request.current = controller;
      setOperation(action);
      setError(null);
      setFields({});
      try {
        await work(controller.signal);
      } catch (failure) {
        if (controller.signal.aborted) return;
        setFields(skillFieldErrors(failure));
        setError(failure instanceof Error ? failure.message : '请求失败。');
        if (
          id &&
          (action === 'saving' || action === 'disabling') &&
          failure instanceof ApiReadError &&
          failure.status === 409
        )
          setConflict(true);
      } finally {
        if (request.current === controller) {
          request.current = null;
          setOperation(null);
        }
      }
    },
    [id],
  );

  const load = useCallback(
    (preserveDraft: boolean) =>
      run('reading', async (signal) => {
        if (!id) return;
        const latest = await readSkill(id, signal);
        if (signal.aborted) return;
        setBase(latest);
        setConflict(false);
        setReloaded(preserveDraft);
        if (!preserveDraft) setDraft(draftOf(latest));
      }),
    [id, run],
  );

  useEffect(() => {
    if (id) void load(false);
    return () => {
      request.current?.abort();
      request.current = null;
    };
  }, [id, load]);

  function preview(file: File) {
    void run('previewing', async (signal) => {
      const value = await previewSkillImport(file, signal);
      if (signal.aborted) return;
      setImported({ filename: file.name, value });
      setDraft(draftOf(value));
    });
  }

  const visible = id ? Boolean(base) : !importing || Boolean(imported);
  const canSave = visible && !base?.disabled_at && !operation && !conflict && !confirmDisable;

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSave || request.current) return;
    const parsed = SkillInputSchema.safeParse(draft);
    if (!parsed.success) {
      const errors = Object.fromEntries(
        parsed.error.issues.map((issue) => [issue.path.join('.'), issue.message]),
      );
      setFields(errors);
      setError('请检查下方标出的字段。');
      document.getElementById(`${formId}-${Object.keys(errors)[0]}`)?.focus();
      return;
    }
    void run('saving', async (signal) => {
      let saved;
      if (base) {
        saved = await updateSkill(base.id, base.revision, parsed.data, signal);
      } else {
        const snapshot = JSON.stringify(parsed.data);
        if (createAttempt.current?.snapshot !== snapshot)
          createAttempt.current = { snapshot, key: crypto.randomUUID() };
        saved = await createSkill(parsed.data, createAttempt.current.key, signal);
      }
      if (!signal.aborted) onSaved(saved);
    });
  }

  function disable() {
    if (!base || base.disabled_at || conflict) return;
    setConfirmDisable(false);
    void run('disabling', async (signal) => {
      const saved = await disableSkill(base.id, base.revision, signal);
      if (!signal.aborted) onSaved(saved);
    });
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !request.current) onClose();
      }}
    >
      <Dialog.Content className="flex max-h-[85dvh] max-w-xl flex-col">
        <Dialog.Header>
          <Dialog.Title>
            {base?.name ?? (id ? '技能详情' : importing ? '导入 SKILL.md' : '新建技能')}
          </Dialog.Title>
          <Dialog.Description>
            {base
              ? `版本 ${base.revision}${base.disabled_at ? ' · 已停用，仅可查看。' : ' · 保存正文或元数据会创建新版本。'}`
              : importing
                ? '选择一个 UTF-8 Markdown 文件，预览后再保存。最多 64 KiB。'
                : '技能只保存文本步骤，不会安装脚本、附件或扩大授权。'}
          </Dialog.Description>
        </Dialog.Header>
        <form
          className="min-h-0 space-y-4 overflow-y-auto overscroll-contain px-1 py-2"
          onSubmit={save}
          noValidate
        >
          {operation ? (
            <p role="status" className="text-sm text-muted-foreground">
              {
                {
                  reading: '正在读取技能…',
                  previewing: '正在解析文件…',
                  saving: '正在保存…',
                  disabling: '正在停用…',
                }[operation]
              }
            </p>
          ) : null}
          {error ? <ErrorNotice message={error} /> : null}
          {id && (!base || conflict) && !operation ? (
            <div className="space-y-2">
              {conflict ? (
                <p className="text-sm">
                  当前版本已变化，未保存的内容仍保留。请读取最新版本后比较，再决定是否保存。
                </p>
              ) : null}
              <Button
                type="button"
                variant="glass"
                color="default"
                onClick={() => void load(Boolean(base))}
              >
                {conflict ? '读取最新版本并保留草稿' : '重新读取技能'}
              </Button>
            </div>
          ) : null}
          {importing ? (
            <div className="space-y-2">
              <label htmlFor={`${formId}-file`} className="block text-sm font-medium">
                选择本地 SKILL.md
              </label>
              <input
                className="max-w-full text-sm file:mr-2 file:min-h-11 file:rounded-control file:border file:border-separator file:bg-background file:px-3 focus-visible:outline-2 focus-visible:outline-ring"
                id={`${formId}-file`}
                type="file"
                accept=".md,text/markdown"
                disabled={Boolean(operation)}
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  event.currentTarget.value = '';
                  if (file) preview(file);
                }}
              />
              {fields.name || fields.description || fields.body ? (
                !imported ? (
                  <ul className="space-y-1 text-sm">
                    {Object.entries(fields).map(([field, message]) => (
                      <li key={field}>
                        {field}: {message}
                      </li>
                    ))}
                  </ul>
                ) : null
              ) : null}
              {imported ? (
                <div className="space-y-1 text-sm text-secondary-foreground [overflow-wrap:anywhere]">
                  <p>预览来源：{imported.filename}。核对下方将保存的名称、用途和正文。</p>
                  <p>
                    附加信息仅供预览；<code>allowed-tools</code> 不会改变授权。
                  </p>
                  {Object.entries(imported.value.extras).map(([key, value]) => (
                    <p key={key}>
                      <code>{key}</code>：
                      {typeof value === 'string' ? value : JSON.stringify(value)}
                    </p>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
          {reloaded && base ? (
            <details className="rounded-control border border-separator px-3 py-2 text-sm [overflow-wrap:anywhere]">
              <summary className="cursor-pointer font-medium">
                查看已保存的版本 {base.revision}，与下方保留的草稿比较
              </summary>
              <p className="mt-2 font-medium">{base.name}</p>
              <p className="whitespace-pre-wrap">{base.description}</p>
              <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap text-xs">
                {base.body}
              </pre>
            </details>
          ) : null}
          {visible ? (
            <fieldset disabled={Boolean(operation) || confirmDisable} className="space-y-3">
              {(Object.keys(fieldCopy) as (keyof SkillInput)[]).map((field) => {
                const { label, hint } = fieldCopy[field];
                const fieldId = `${formId}-${field}`;
                const props = {
                  id: fieldId,
                  value: draft[field],
                  readOnly: Boolean(base?.disabled_at),
                  required: true,
                  'aria-invalid': Boolean(fields[field]),
                  'aria-describedby': `${fieldId}-hint${fields[field] ? ` ${fieldId}-error` : ''}`,
                  onChange: (event: { currentTarget: { value: string } }) => {
                    const value = event.currentTarget.value;
                    setDraft((previous) => ({ ...previous, [field]: value }));
                    setFields((previous) => ({ ...previous, [field]: '' }));
                  },
                };
                return (
                  <div key={field} className="space-y-1">
                    <label htmlFor={fieldId} className="block text-sm font-medium">
                      {label}
                    </label>
                    {field === 'name' ? (
                      <Input {...props} />
                    ) : (
                      <textarea
                        {...props}
                        rows={field === 'body' ? 8 : 3}
                        className="w-full rounded-control border border-separator bg-background px-3 py-2 text-base focus-visible:outline-2 focus-visible:outline-ring"
                      />
                    )}
                    <p id={`${fieldId}-hint`} className="text-xs leading-5 text-muted-foreground">
                      {hint}
                    </p>
                    {fields[field] ? (
                      <p id={`${fieldId}-error`} className="text-sm font-medium">
                        {fields[field]}
                      </p>
                    ) : null}
                  </div>
                );
              })}
            </fieldset>
          ) : null}
          {confirmDisable ? (
            <section
              aria-label="确认停用"
              className="space-y-2 rounded-control border border-separator p-3 text-sm"
            >
              <p role="status">
                停用后不可恢复，也不能在新消息中使用。已发送消息仍会显示原技能版本。
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="glass"
                  color="default"
                  onClick={() => setConfirmDisable(false)}
                >
                  保留技能
                </Button>
                <Button type="button" color="danger" onClick={disable}>
                  确认停用
                </Button>
              </div>
            </section>
          ) : null}
          <Dialog.Footer>
            {base && !base.disabled_at && !confirmDisable ? (
              <Button
                type="button"
                variant="glass"
                color="danger"
                disabled={Boolean(operation) || conflict}
                onClick={() => setConfirmDisable(true)}
              >
                停用技能
              </Button>
            ) : null}
            <Button
              type="button"
              variant="glass"
              color="default"
              disabled={Boolean(operation)}
              onClick={onClose}
            >
              {base?.disabled_at ? '关闭' : '取消'}
            </Button>
            {visible && !base?.disabled_at && !confirmDisable ? (
              <Button type="submit" color="primary" disabled={!canSave}>
                保存技能
              </Button>
            ) : null}
          </Dialog.Footer>
        </form>
      </Dialog.Content>
    </Dialog>
  );
}
