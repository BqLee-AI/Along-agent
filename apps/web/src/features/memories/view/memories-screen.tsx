'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { MessageHistoryItem } from '@along/contracts';
import { Button } from '@lorelum/lumen-ui/components/button';
import Link from '@/shell/view/workspace-link';
import { useHistoryPage } from '@/shared/http/use-page';
import { EmptyState, ErrorNotice, PageHeading } from '@/shared/ui/page';
import { ReadControls } from '@/shared/ui/read-controls';
import {
  correctMemory,
  readMemories,
  readMemory,
  readSourceMessages,
  stopMemory,
} from '../model/memory';
import type { Memory } from '../model/memory';

function Correction({
  memory,
  busy,
  onCorrect,
}: {
  memory: Memory;
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
      <p>
        请先在原会话写下完整的更正，再回到此处选择那条本人消息。更正内容将原样使用所选消息，不会自动选取旧消息。
      </p>
      <Link
        className="inline-flex min-h-11 items-center text-primary underline"
        href={`/conversations?${new URLSearchParams({ conversation_id: memory.conversationId })}`}
      >
        前往来源会话写下更正
      </Link>
      <fieldset disabled={busy || state.reading} className="space-y-3">
        <legend className="font-medium">选择明确表达此次更正的本人消息</legend>
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
      <p className="text-xs text-muted-foreground">
        来源可追溯不代表内容已核实；请核对消息确实是此次更正。
      </p>
      {selected && selected.content.length > 12000 ? (
        <p role="alert">所选消息超过更正长度限制，请先在会话中写一条较短的完整更正。</p>
      ) : null}
    </section>
  );
}

function MemoryCard({ item, changed }: { item: Memory; changed: () => Promise<void> }) {
  const [memory, setMemory] = useState(item);
  const [detail, setDetail] = useState(false);
  const [correcting, setCorrecting] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const [busy, setBusy] = useState(false);
  const [needsRead, setNeedsRead] = useState(false);
  const [stopped, setStopped] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  useEffect(() => {
    setMemory(item);
  }, [item]);
  useEffect(() => () => request.current?.abort(), []);

  async function perform(
    action: 'detail' | 'stop' | 'correct',
    source?: MessageHistoryItem & { role: 'user' },
  ) {
    if (request.current || (action !== 'detail' && (needsRead || stopped))) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (action === 'detail') {
        const current = await readMemory(memory.id, controller.signal);
        if (!controller.signal.aborted) {
          setMemory(current);
          setDetail(true);
          setNeedsRead(false);
        }
      } else if (action === 'stop') {
        await stopMemory(memory, controller.signal);
        if (!controller.signal.aborted) {
          setStopped(true);
          setConfirmStop(false);
          setNotice('已停止召回；正在读取最新列表。原始会话不会被删除。');
          await changed();
        }
      } else if (source) {
        const current = await correctMemory(memory, source, controller.signal);
        if (!controller.signal.aborted) {
          setMemory(current);
          setCorrecting(false);
          setNotice('更正已保存为新修订。来源仅用于追溯，原始消息不变。');
          await changed();
        }
      }
    } catch (failure) {
      if (!controller.signal.aborted) {
        if (action !== 'detail') setNeedsRead(true);
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
        <dl className="space-y-1 text-xs text-muted-foreground">
          <div>
            <dt className="inline">来源：</dt>
            <dd className="inline">
              {memory.sourceKind === 'explicit' ? '明确记住' : '其他来源'} ·{' '}
              <Link
                className="text-primary underline"
                href={`/conversations?${new URLSearchParams({ conversation_id: memory.conversationId })}`}
              >
                查看来源会话
              </Link>
            </dd>
          </div>
          <div>
            <dt className="inline">来源消息：</dt>
            <dd className="inline">{memory.messageIds.join('、')}</dd>
          </div>
          <div>
            <dt className="inline">创建：</dt>
            <dd className="inline">
              <time dateTime={memory.createdAt}>{memory.createdAt}</time>
            </dd>
          </div>
          <div>
            <dt className="inline">修订：</dt>
            <dd className="inline">
              第 {memory.revision} 版 · <time dateTime={memory.updatedAt}>{memory.updatedAt}</time>
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
        {error ? <ErrorNotice message={error} /> : null}
        {notice ? <p role="status">{notice}</p> : null}
        <div className="flex flex-wrap gap-2">
          <Button
            variant="glass"
            color="default"
            disabled={busy}
            onClick={() => void perform('detail')}
          >
            {busy ? '处理中…' : '读取最新记忆'}
          </Button>
          <Button
            variant="glass"
            color="default"
            disabled={busy || needsRead || stopped}
            onClick={() => {
              setCorrecting(!correcting);
              setConfirmStop(false);
            }}
          >
            {correcting ? '收起更正' : '更正记忆'}
          </Button>
          <Button
            variant="glass"
            color="default"
            disabled={busy || needsRead || stopped}
            onClick={() => {
              setConfirmStop(!confirmStop);
              setCorrecting(false);
            }}
          >
            {confirmStop ? '取消停止' : '停止召回'}
          </Button>
        </div>
        {confirmStop ? (
          <div className="space-y-2">
            <p>停止后此记忆不再参与召回；不会删除来源消息。确定停止？</p>
            <Button disabled={busy || needsRead || stopped} onClick={() => void perform('stop')}>
              {busy ? '正在停止…' : '确认停止召回'}
            </Button>
          </div>
        ) : null}
        {correcting ? (
          <Correction
            key={`${memory.id}:${memory.revision}`}
            memory={memory}
            busy={busy || needsRead || stopped}
            onCorrect={(source) => perform('correct', source)}
          />
        ) : null}
      </article>
    </li>
  );
}

export default function MemoriesScreen() {
  const loader = useCallback(async (cursor: string | null, signal: AbortSignal) => {
    const page = await readMemories(cursor, signal);
    return { items: page.items, nextCursor: page.nextCursor };
  }, []);
  const { state, read } = useHistoryPage<Memory>('memories', loader);
  return (
    <section className="min-w-0 space-y-6 text-sm leading-6">
      <PageHeading
        eyebrow="个人记忆"
        title="记忆"
        description="查看当前可召回的记忆及其来源；记忆是历史材料，不是授权或提醒。"
      />
      {state.loaded && !state.error && state.items.length === 0 ? (
        <EmptyState
          title="暂无可召回记忆"
          description="此处只显示当前可读取且尚未停止或过期的记忆。"
        />
      ) : null}
      <ul className="space-y-3" aria-label="可召回记忆">
        {state.items.map((item) => (
          <MemoryCard key={item.id} item={item} changed={() => read(true)} />
        ))}
      </ul>
      <ReadControls state={state} read={read} label="记忆" />
      <p className="border-t border-border pt-5 text-muted-foreground">
        读取、翻页或打开来源不会修改记忆。更正和停止召回均需明确操作。
      </p>
    </section>
  );
}
