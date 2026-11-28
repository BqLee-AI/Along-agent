'use client';

import { useRef, useState } from 'react';
import { FileUp, Plus } from 'lucide-react';
import type { SkillInput } from '@along/contracts';
import { Badge } from '@lorelum/lumen-ui/components/badge';
import { Button } from '@lorelum/lumen-ui/components/button';
import { useHistoryPage } from '@/shared/http/use-page';
import { EmptyState, ErrorNotice, PageHeading } from '@/shared/ui/page';
import { ReadControls } from '@/shared/ui/read-controls';
import { createSkill, readSkills, skillCatalogChanged } from '../model/skill';
import { SkillEditor, type SkillEditorTarget } from './skill-editor';

const presets = [
  {
    title: '周报整理',
    input: {
      name: 'weekly-report',
      description: '把零散的工作记录整理成一份周报。',
      body: '按「本周成果」「支撑事实」「下周安排」组织周报。先写成果及其影响，再列出材料里的数据或例子。区分已完成、进行中和受阻。缺少数据或日期时标为待补充，不自行编造。',
    },
  },
  {
    title: '会议纪要',
    input: {
      name: 'meeting-notes',
      description: '从会议笔记或逐字稿提炼决定、待办和未决问题。',
      body: '先概括会议目的，再按「已定事项」「后续行动」「未决问题」整理。区分提议和正式决定。只记录原文明确给出的负责人和期限，缺失项标为待确认。',
    },
  },
  {
    title: '文档审阅',
    input: {
      name: 'document-review',
      description: '检查文档的表达、结构和论据，给出修改建议。',
      body: '先简述文档目的和读者，再按影响从高到低列出问题。每条给出相关段落或短引文、问题影响和具体修改建议。区分事实矛盾、证据不足和表达偏好。',
    },
  },
  {
    title: '待办提取',
    input: {
      name: 'action-items',
      description: '从文字材料提取可执行的下一步。',
      body: '提取原文有依据的待办，列出事项、负责人、期限和依据。合并重复项，区分已承诺行动与建议。缺失信息标为待确认。只整理清单，不代建任务或发送通知。',
    },
  },
] satisfies { title: string; input: SkillInput }[];

export default function SkillsScreen() {
  const skills = useHistoryPage('personal-skills', readSkills);
  const [editor, setEditor] = useState<SkillEditorTarget | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [addError, setAddError] = useState<string | null>(null);
  const addingRef = useRef(false);
  const pendingKeys = useRef(new Map<string, string>());

  function refreshCatalog() {
    void skills.read(true);
    window.dispatchEvent(new Event(skillCatalogChanged));
  }

  async function addPreset({ title, input }: (typeof presets)[number]) {
    if (addingRef.current) return;
    addingRef.current = true;
    setAdding(input.name);
    setAddError(null);
    setNotice(null);
    const key = pendingKeys.current.get(input.name) ?? crypto.randomUUID();
    pendingKeys.current.set(input.name, key);
    try {
      await createSkill(input, key, new AbortController().signal);
      pendingKeys.current.delete(input.name);
      setNotice(`「${title}」已添加到我的技能。`);
      refreshCatalog();
    } catch {
      setAddError(`未能确认「${title}」已添加，请重试。`);
    } finally {
      addingRef.current = false;
      setAdding(null);
    }
  }

  return (
    <div className="w-full min-w-0" data-testid="skills-page">
      <PageHeading
        title="技能"
        description="保存常用的文本工作步骤，分配给自己的 Bot 后即可为单条消息选用。技能不会授予工具或资料权限。"
      />
      <div className="mb-4 flex flex-wrap gap-2">
        <Button type="button" color="primary" onClick={() => setEditor({ kind: 'create' })}>
          <Plus aria-hidden="true" /> 新建技能
        </Button>
        <Button
          type="button"
          variant="glass"
          color="default"
          onClick={() => setEditor({ kind: 'import' })}
        >
          <FileUp aria-hidden="true" /> 导入 SKILL.md
        </Button>
      </div>
      <section aria-labelledby="preset-skills-title" className="mb-6">
        <h2 id="preset-skills-title" className="mb-1 text-sm font-semibold">
          预置技能
        </h2>
        <p className="mb-3 text-sm text-secondary-foreground">添加后可在「我的技能」编辑副本。</p>
        <ul className="grid gap-2 sm:grid-cols-2">
          {presets.map((preset) => (
            <li
              key={preset.input.name}
              className="flex min-w-0 flex-col items-start gap-2 rounded-lg border border-separator p-3"
            >
              <h3 className="text-sm font-semibold">{preset.title}</h3>
              <p className="flex-1 text-sm text-secondary-foreground">{preset.input.description}</p>
              <Button
                type="button"
                variant="glass"
                color="default"
                aria-label={`添加${preset.title}到我的技能`}
                aria-disabled={adding !== null}
                onClick={() => void addPreset(preset)}
              >
                {adding === preset.input.name ? '正在添加…' : '添加到我的技能'}
              </Button>
            </li>
          ))}
        </ul>
        {addError ? <ErrorNotice message={addError} /> : null}
      </section>
      <h2 id="my-skills-title" className="text-sm font-semibold">
        我的技能
      </h2>
      {notice ? (
        <p role="status" className="mb-3 text-sm text-secondary-foreground">
          {notice}
        </p>
      ) : null}
      {skills.state.items.length ? (
        <ul className="divide-y divide-separator" aria-labelledby="my-skills-title">
          {skills.state.items.map((item) => (
            <li
              key={item.id}
              className="flex min-w-0 flex-wrap items-start justify-between gap-2 py-4"
            >
              <div className="min-w-0 flex-1 basis-52 [overflow-wrap:anywhere]">
                <div className="mb-1 flex flex-wrap items-center gap-2">
                  <h3 className="text-sm font-semibold">{item.name}</h3>
                  <Badge variant="glass">版本 {item.revision}</Badge>
                  {item.disabled_at ? <Badge variant="glass">已停用</Badge> : null}
                </div>
                <p className="whitespace-pre-wrap text-sm text-secondary-foreground">
                  {item.description}
                </p>
              </div>
              <Button
                type="button"
                variant="glass"
                color="default"
                aria-label={`${item.disabled_at ? '查看' : '查看或编辑'}技能 ${item.name}`}
                onClick={() => setEditor({ kind: 'existing', id: item.id })}
              >
                {item.disabled_at ? '查看' : '查看或编辑'}
              </Button>
            </li>
          ))}
        </ul>
      ) : skills.state.loaded && !skills.state.error ? (
        <EmptyState title="还没有技能" description="添加预置技能、新建或导入本地 SKILL.md。" />
      ) : null}
      <ReadControls state={skills.state} read={skills.read} label="技能" compact />
      {editor ? (
        <SkillEditor
          target={editor}
          onClose={() => setEditor(null)}
          onSaved={(skill) => {
            setEditor(null);
            setNotice(
              `${skill.name} · 版本 ${skill.revision}${skill.disabled_at ? ' 已停用。' : ' 已保存。'}`,
            );
            refreshCatalog();
          }}
        />
      ) : null}
    </div>
  );
}
