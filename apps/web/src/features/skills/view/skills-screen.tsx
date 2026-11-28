'use client';

import { useState } from 'react';
import { FileUp, Plus } from 'lucide-react';
import { Badge } from '@lorelum/lumen-ui/components/badge';
import { Button } from '@lorelum/lumen-ui/components/button';
import { useHistoryPage } from '@/shared/http/use-page';
import { EmptyState, PageHeading } from '@/shared/ui/page';
import { ReadControls } from '@/shared/ui/read-controls';
import { readSkills, skillCatalogChanged } from '../model/skill';
import { SkillEditor, type SkillEditorTarget } from './skill-editor';

export default function SkillsScreen() {
  const skills = useHistoryPage('personal-skills', readSkills);
  const [editor, setEditor] = useState<SkillEditorTarget | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

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
      {notice ? (
        <p role="status" className="mb-3 text-sm text-secondary-foreground">
          {notice}
        </p>
      ) : null}
      {skills.state.items.length ? (
        <ul className="divide-y divide-separator" aria-label="我的技能">
          {skills.state.items.map((item) => (
            <li
              key={item.id}
              className="flex min-w-0 flex-wrap items-start justify-between gap-2 py-4"
            >
              <div className="min-w-0 flex-1 basis-52 [overflow-wrap:anywhere]">
                <div className="mb-1 flex flex-wrap items-center gap-2">
                  <h2 className="text-sm font-semibold">{item.name}</h2>
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
        <EmptyState title="还没有技能" description="从一套常用步骤开始，或导入本地 SKILL.md。" />
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
            void skills.read(true);
            window.dispatchEvent(new Event(skillCatalogChanged));
          }}
        />
      ) : null}
    </div>
  );
}
