'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Pencil, Plus, RefreshCw, X } from 'lucide-react';
import type { MessageHistoryItem } from '@along/contracts';
import { Button } from '@lorelum/lumen-ui/components/button';
import Link from '@/shell/view/workspace-link';
import { useHistoryPage } from '@/shared/http/use-page';
import { ErrorNotice, PageHeading } from '@/shared/ui/page';
import { ReadControls } from '@/shared/ui/read-controls';
import {
  correctManualMemory,
  correctMemory,
  createMemory,
  readMemories,
  readMemory,
  readSourceMessages,
  stopMemory,
} from '../model/memory';
import type { ConversationMemory, ManualMemory, ManualMemoryInput, Memory } from '../model/memory';

const categoryLabels: Record<ManualMemoryInput['category'], string> = {
  project: '项目',
  preference: '偏好',
  goal: '目标',
};

function ManualMemoryForm({
  initial,
  busy,
  saveDisabled = false,
  onSave,
}: {
  initial?: ManualMemory;
  busy: boolean;
  saveDisabled?: boolean;
  onSave: (input: ManualMemoryInput) => Promise<void>;
}) {
  const [category, setCategory] = useState<ManualMemoryInput['category'] | ''>(
    initial?.category ?? '',
  );
  const [content, setContent] = useState(initial?.content ?? '');
  const canSave =
    !busy &&
    !saveDisabled &&
    category !== '' &&
    content.trim() !== '' &&
    (category !== initial?.category || content !== initial?.content);
  return (
    <form
      aria-label={initial ? '更正手动记忆' : '添加记忆'}
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (canSave) void onSave({ category, content });
      }}
    >
      <label className="block space-y-1">
        <span className="block font-medium">分类</span>
        <select
          className="min-h-11 w-full rounded-lg border border-border bg-background px-3"
          value={category}
          onChange={(event) => {
            const value = event.currentTarget.value;
            if (value === 'project' || value === 'preference' || value === 'goal')
              setCategory(value);
          }}
          required
          disabled={busy}
        >
          <option value="" disabled>
            选择分类
          </option>
          {Object.entries(categoryLabels).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label className="block space-y-1">
        <span className="block font-medium">记忆内容</span>
        <textarea
          className="block w-full rounded-lg border border-border bg-background px-3 py-2"
          value={content}
          onChange={(event) => setContent(event.currentTarget.value)}
          rows={4}
          maxLength={12000}
          required
          disabled={busy}
        />
      </label>
      <Button type="submit" disabled={!canSave}>
        {busy ? '正在保存…' : initial ? '保存更正' : '保存记忆'}
      </Button>
    </form>
  );
}

function Correction({
  memory,
  busy,
  onCorrect,
}: {
  memory: ConversationMemory;
  busy: boolean;
  onCorrect: (source: MessageHistoryItem & { role: 'user' }) => Promise<void>;
}) {
  const [chosen, setChosen] = useState<string | null>(null);
  const loader = useCallback(
    async (cursor: string | null, signal: AbortSignal) => {
      const page = await readSourceMessages(memory.conversationId, cursor, signal);
      return { items: page.items, nextCursor: page.next_cursor };
    },
    [memory.conversationId],
  );
  const { state, read } = useHistoryPage<MessageHistoryItem>(
    `memory-source:${memory.conversationId}`,
    loader,
  );
  const selected = state.items.find((message) => message.message_id === chosen);
  return (
    <section className="space-y-3 border-t border-separator pt-4" aria-label="选择更正来源">
      <p>在来源会话写下完整更正，再选择该条消息。所选内容会原样保存。</p>
      <Link
        className="inline-flex min-h-11 items-center text-primary underline"
        href={`/conversations?${new URLSearchParams({ conversation_id: memory.conversationId })}`}
      >
        打开来源会话
      </Link>
      <fieldset disabled={busy || state.reading} className="space-y-3">
        <legend className="font-medium">选择更正消息</legend>
        {state.items
          .filter((message) => message.role === 'user')
          .map((message) => (
            <label
              key={message.message_id}
              className="flex cursor-pointer gap-3 rounded-lg border border-border p-3"
            >
              <input
                type="radio"
                name={`correction-${memory.id}`}
                value={message.message_id}
                checked={chosen === message.message_id}
                onChange={() => setChosen(message.message_id)}
              />
              <span className="min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]">
                {message.content}
                <span className="block text-xs text-muted-foreground">{message.created_at}</span>
              </span>
            </label>
          ))}
      </fieldset>
      {state.loaded && !state.error && !state.items.some((item) => item.role === 'user') ? (
        <p className="text-muted-foreground">当前消息列表中没有本人消息；请先在会话中写下更正。</p>
      ) : null}
      <ReadControls state={state} read={read} label="来源消息" />
      <Button
        disabled={
          busy ||
          state.reading ||
          Boolean(state.error) ||
          !selected ||
          selected.role !== 'user' ||
          !selected.content.trim() ||
          selected.content.length > 12000
        }
        onClick={() => {
          if (
            selected?.role === 'user' &&
            selected.content.trim() &&
            selected.content.length <= 12000
          )
            void onCorrect({ ...selected, role: 'user' });
        }}
      >
        {busy ? '正在提交…' : '使用所选本人消息更正'}
      </Button>
      {selected && selected.content.length > 12000 ? (
        <p role="alert">所选消息超过更正长度限制，请先在会话中写一条较短的完整更正。</p>
      ) : null}
    </section>
  );
}

function MemoryCard({
  item,
  changed,
}: {
  item: Memory;
  changed: (stoppedId?: string) => Promise<void>;
}) {
  const [readback, setReadback] = useState<Memory | null>(null);
  const memory = readback && readback.revision >= item.revision ? readback : item;
  const [detail, setDetail] = useState(false);
  const [editingRevision, setEditingRevision] = useState<number | null>(null);
  const correcting = editingRevision !== null;
  const manual = memory.sourceKind === 'manual';
  const staleManualDraft = manual && correcting && editingRevision !== memory.revision;
  const [confirmStop, setConfirmStop] = useState(false);
  const [busy, setBusy] = useState(false);
  const [needsRead, setNeedsRead] = useState(false);
  const [stopped, setStopped] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);

  async function perform(
    action:
      | { kind: 'detail' | 'stop' }
      | { kind: 'correct'; source: MessageHistoryItem & { role: 'user' } }
      | { kind: 'correct-manual'; input: ManualMemoryInput },
  ) {
    if (
      request.current ||
      (action.kind !== 'detail' && (needsRead || stopped)) ||
      (action.kind === 'correct-manual' && editingRevision !== memory.revision)
    )
      return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (action.kind === 'detail') {
        const current = await readMemory(memory.id, controller.signal);
        if (!controller.signal.aborted) {
          setReadback(current);
          setDetail(true);
          setNeedsRead(false);
        }
      } else if (action.kind === 'stop') {
        await stopMemory(memory, controller.signal);
        if (!controller.signal.aborted) {
          setStopped(true);
          setConfirmStop(false);
          setNotice(
            manual
              ? '已停止召回；正在读取最新列表。'
              : '已停止召回；正在读取最新列表。原始会话不会被删除。',
          );
          await changed(memory.id);
        }
      } else {
        const current =
          action.kind === 'correct-manual' && memory.sourceKind === 'manual'
            ? await correctManualMemory(memory, action.input, controller.signal)
            : action.kind === 'correct' && memory.sourceKind !== 'manual'
              ? await correctMemory(memory, action.source, controller.signal)
              : null;
        if (!current) return;
        if (!controller.signal.aborted) {
          setReadback(current);
          setEditingRevision(null);
          setNotice(manual ? '更正已保存为新修订。' : '更正已保存为新修订。原始消息不变。');
          if (!manual) await changed();
        }
      }
    } catch (failure) {
      if (!controller.signal.aborted) {
        if (action.kind !== 'detail') setNeedsRead(true);
        setError(
          `${failure instanceof Error ? failure.message : '操作失败。'} 请先重新读取最新记忆；结果未知时不要重复提交。`,
        );
      }
    } finally {
      if (request.current === controller) request.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  return (
    <li>
      <article
        className="min-w-0 space-y-4 rounded-xl bg-foreground/5 p-4 text-sm leading-6 [overflow-wrap:anywhere]"
        aria-busy={busy}
      >
        <p className="whitespace-pre-wrap">{memory.content}</p>
        {memory.sourceKind === 'manual' ? (
          <p className="text-xs text-secondary-foreground">
            {categoryLabels[memory.category]} · 本人手动添加
          </p>
        ) : null}
        <details className="text-xs text-secondary-foreground">
          <summary className="inline-flex min-h-8 cursor-pointer list-none items-center underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-ring max-lg:min-h-11 [&::-webkit-details-marker]:hidden">
            来源与版本
          </summary>
          <dl className="space-y-1 pt-1">
            <div>
              <dt className="inline">来源：</dt>
              <dd className="inline">
                {memory.sourceKind === 'manual' ? (
                  '本人手动添加'
                ) : (
                  <>
                    {memory.sourceKind === 'explicit' ? '对话中明确记住' : '从对话摘要提取'} ·{' '}
                    <Link
                      className="text-primary underline"
                      href={`/conversations?${new URLSearchParams({ conversation_id: memory.conversationId })}`}
                    >
                      查看来源会话
                    </Link>
                  </>
                )}
              </dd>
            </div>
            {memory.sourceKind !== 'manual' ? (
              <div>
                <dt className="inline">来源消息：</dt>
                <dd className="inline">{memory.messageIds.join('、')}</dd>
              </div>
            ) : null}
            <div>
              <dt className="inline">创建：</dt>
              <dd className="inline">
                <time dateTime={memory.createdAt}>{memory.createdAt}</time>
              </dd>
            </div>
            <div>
              <dt className="inline">修订：</dt>
              <dd className="inline">
                第 {memory.revision} 版 ·{' '}
                <time dateTime={memory.updatedAt}>{memory.updatedAt}</time>
              </dd>
            </div>
            {memory.expiresAt ? (
              <div>
                <dt className="inline">到期：</dt>
                <dd className="inline">
                  <time dateTime={memory.expiresAt}>{memory.expiresAt}</time>
                </dd>
              </div>
            ) : null}
            {detail ? (
              <div>
                <dt className="inline">记忆 ID：</dt>
                <dd className="inline">{memory.id}</dd>
              </div>
            ) : null}
          </dl>
        </details>
        {error && !(manual && correcting) ? <ErrorNotice message={error} /> : null}
        {notice ? <p role="status">{notice}</p> : null}
        <div className="flex flex-wrap gap-2">
          <Button
            variant="glass"
            color="default"
            size="icon"
            aria-label="刷新这条记忆"
            title="刷新这条记忆"
            disabled={busy}
            onClick={() => void perform({ kind: 'detail' })}
          >
            <RefreshCw className="size-4" aria-hidden="true" />
          </Button>
          <Button
            variant="glass"
            color="default"
            size="icon"
            aria-label={correcting ? '收起更正' : '更正记忆'}
            title={correcting ? '收起更正' : '更正记忆'}
            aria-expanded={correcting}
            disabled={busy || (!correcting && (needsRead || stopped))}
            onClick={() => {
              setEditingRevision(correcting ? null : memory.revision);
              setConfirmStop(false);
            }}
          >
            {correcting ? (
              <X className="size-4" aria-hidden="true" />
            ) : (
              <Pencil className="size-4" aria-hidden="true" />
            )}
          </Button>
          <Button
            variant="glass"
            color="default"
            disabled={busy || needsRead || stopped}
            onClick={() => {
              setConfirmStop(!confirmStop);
              setEditingRevision(null);
            }}
          >
            {confirmStop ? '取消停止' : '停止召回'}
          </Button>
        </div>
        {confirmStop ? (
          <div className="space-y-2">
            <p>
              {manual
                ? '停止后此记忆不再参与召回。确定停止？'
                : '停止后此记忆不再参与召回；不会删除来源消息。确定停止？'}
            </p>
            <Button
              disabled={busy || needsRead || stopped}
              onClick={() => void perform({ kind: 'stop' })}
            >
              {busy ? '正在停止…' : '确认停止召回'}
            </Button>
          </div>
        ) : null}
        {correcting &&
          (memory.sourceKind === 'manual' ? (
            <div className="space-y-3 border-t border-separator pt-4">
              {staleManualDraft ? (
                <div className="space-y-2">
                  <p role="status">
                    记忆已有新修订。请比较上方内容和保留的草稿，再决定是否继续更正。
                  </p>
                  <Button
                    type="button"
                    variant="glass"
                    color="default"
                    disabled={busy || needsRead || stopped}
                    onClick={() => setEditingRevision(memory.revision)}
                  >
                    基于最新修订继续编辑
                  </Button>
                </div>
              ) : null}
              <ManualMemoryForm
                initial={memory}
                busy={busy}
                saveDisabled={needsRead || stopped || staleManualDraft}
                onSave={(input) => perform({ kind: 'correct-manual', input })}
              />
              {error ? <ErrorNotice message={error} /> : null}
            </div>
          ) : (
            <Correction
              key={`${memory.id}:${memory.revision}`}
              memory={memory}
              busy={busy || needsRead || stopped}
              onCorrect={(source) => perform({ kind: 'correct', source })}
            />
          ))}
      </article>
    </li>
  );
}

export default function MemoriesScreen() {
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [created, setCreated] = useState<ManualMemory[]>([]);
  const pendingCreate = useRef<(ManualMemoryInput & { idempotencyKey: string }) | null>(null);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);

  const loader = useCallback(async (cursor: string | null, signal: AbortSignal) => {
    const page = await readMemories(cursor, signal);
    // A successful read replaces receipts only inside the UUID range it covered.
    if (!signal.aborted) {
      setCreated((current) =>
        current.filter(
          ({ id }) =>
            (cursor !== null && id <= cursor) || (page.nextCursor !== null && id > page.nextCursor),
        ),
      );
    }
    return { items: page.items, nextCursor: page.nextCursor };
  }, []);
  const { state, read } = useHistoryPage<Memory>('memories', loader);
  const items = [
    ...created.filter((entry) => !state.items.some((item) => item.id === entry.id)),
    ...state.items,
  ];

  async function addMemory(input: ManualMemoryInput) {
    if (request.current) return;
    const controller = new AbortController();
    const previous = pendingCreate.current;
    const submission =
      previous?.category === input.category && previous.content === input.content
        ? previous
        : { ...input, idempotencyKey: crypto.randomUUID() };
    pendingCreate.current = submission;
    request.current = controller;
    setSaving(true);
    setError(null);
    try {
      const memory = await createMemory(submission, controller.signal);
      if (!controller.signal.aborted) {
        pendingCreate.current = null;
        setCreated((current) => [memory, ...current.filter((item) => item.id !== memory.id)]);
        setSaved(true);
        setAdding(false);
        void read(true);
      }
    } catch (failure) {
      if (!controller.signal.aborted) {
        setError(
          `${failure instanceof Error ? failure.message : '未能确认保存结果。'} 草稿已保留，可按原内容重试。`,
        );
      }
    } finally {
      request.current = null;
      if (!controller.signal.aborted) setSaving(false);
    }
  }

  return (
    <section className="min-w-0 space-y-6 text-sm leading-6">
      <PageHeading
        title="记忆"
        actions={
          <Button
            type="button"
            variant={adding ? 'glass' : undefined}
            aria-expanded={adding}
            disabled={saving}
            onClick={() => {
              setAdding(!adding);
              setError(null);
              setSaved(false);
            }}
          >
            {adding ? <X aria-hidden="true" /> : <Plus aria-hidden="true" />}
            {adding ? '取消添加' : '添加记忆'}
          </Button>
        }
      />
      {adding ? (
        <div className="space-y-3 rounded-xl bg-foreground/5 p-4" aria-busy={saving}>
          <ManualMemoryForm busy={saving} onSave={addMemory} />
          {error ? <ErrorNotice message={error} /> : null}
        </div>
      ) : null}
      {saved ? <p role="status">记忆已保存。</p> : null}
      {state.loaded && !state.error && items.length === 0 ? (
        <p className="rounded-xl bg-muted px-4 py-6 text-secondary-foreground">
          暂无可召回记忆。可以直接添加一条项目、偏好或目标记忆。
        </p>
      ) : null}
      <ul className="space-y-3" aria-label="可召回记忆">
        {items.map((item) => (
          <MemoryCard
            key={item.id}
            item={item}
            changed={(stoppedId) => {
              if (stoppedId) setCreated((current) => current.filter(({ id }) => id !== stoppedId));
              return read(true);
            }}
          />
        ))}
      </ul>
      <ReadControls state={state} read={read} label="记忆" compact />
    </section>
  );
}
