'use client';

import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { Bot as BotIcon, PanelLeftOpen, Plus, Settings } from 'lucide-react';
import { Button } from '@lorelum/lumen-ui/components/button';
import { Dialog } from '@lorelum/lumen-ui/components/dialog';
import Link from '@/shell/view/workspace-link';
import type { ConversationLocation } from '@/shell/model/navigation';
import { useHistoryPage } from '@/shared/http/use-page';
import { Brand } from '@/shared/ui/brand';
import { ErrorNotice } from '@/shared/ui/page';
import { ReadControls } from '@/shared/ui/read-controls';
import {
  botHref,
  createBotConversation,
  readBots,
  readSelectedBot,
  type PersonalBot,
} from '../model/personal-bot';
import type { TaskIntent } from '../model/task';
import { useConversationHistory } from '../viewmodel/use-conversation-history';
import { ConversationHistory } from './conversation-history';
import ConversationPane from './conversation-pane';
import { ConversationSidebar } from './conversation-sidebar';
import { PersonalBotSettings } from './personal-bot-settings';

const actionClass =
  'inline-flex min-h-8 min-w-8 items-center justify-center gap-1.5 rounded-control px-2 text-[13px] text-secondary-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50 max-lg:min-h-11 max-lg:min-w-11';

type Selection = { key: string; bot: PersonalBot | null; error: string | null };

export default function PersonalBotPane({
  botId,
  conversationId,
  runId,
  initialIntent,
  headerActions,
  sidebar,
}: ConversationLocation & {
  headerActions?: ReactNode;
  sidebar: boolean;
}) {
  const router = useRouter();
  const bots = useHistoryPage('personal-bots', readBots);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [retry, setRetry] = useState(0);
  const selectionKey = conversationId ? `conversation:${conversationId}` : `bot:${botId ?? ''}`;
  const [lastKey, setLastKey] = useState(selectionKey);
  const current = selection?.key === selectionKey ? selection : null;
  const resolvedBot = current?.bot ?? null;
  const wrongParent = Boolean(resolvedBot && botId && resolvedBot.id !== botId);
  const bot = wrongParent ? null : resolvedBot;
  const error = wrongParent ? '此会话不属于所选的 Bot。' : current?.error;
  const loading = Boolean(botId || conversationId) && !current;
  const [chooser, setChooser] = useState(false);
  const [editor, setEditor] = useState<'create' | string | null>(null);
  const [newIntent, setNewIntent] = useState<{ id: string; intent: TaskIntent | null } | null>(
    null,
  );
  if (lastKey !== selectionKey) {
    setLastKey(selectionKey);
    setSelection(null);
    setChooser(false);
    setEditor(null);
  }

  useEffect(() => {
    if ((!botId && !conversationId) || resolvedBot) return;
    const request = new AbortController();
    void readSelectedBot(botId, conversationId, request.signal).then(
      (result) => {
        if (!request.signal.aborted) setSelection({ key: selectionKey, bot: result, error: null });
      },
      (failure: unknown) => {
        if (!request.signal.aborted)
          setSelection({
            key: selectionKey,
            bot: null,
            error: failure instanceof Error ? failure.message : 'Bot 读取失败。',
          });
      },
    );
    return () => request.abort();
  }, [botId, conversationId, resolvedBot, retry, selectionKey]);

  function saved(result: PersonalBot) {
    setEditor(null);
    void bots.read(true);
    if (bot?.id === result.id) setSelection({ key: selectionKey, bot: result, error: null });
    else router.push(botHref(result.id, null, initialIntent), { scroll: false });
  }

  const botControls = (
    <>
      <Dialog open={chooser} onOpenChange={setChooser}>
        <Dialog.Trigger className={actionClass} aria-label="选择 Bot" data-testid="bot-picker">
          <BotIcon className="size-4 shrink-0" aria-hidden="true" />
          <span className="hidden max-w-40 truncate sm:inline" title={bot?.config.name}>
            {bot?.config.name ?? '选择 Bot'}
          </span>
        </Dialog.Trigger>
        <Dialog.Content className="flex max-h-[85dvh] max-w-md flex-col">
          <Dialog.Header>
            <Dialog.Title>我的 Bot</Dialog.Title>
            <Dialog.Description>选择一个 Bot，查看或创建它的对话。</Dialog.Description>
          </Dialog.Header>
          <div className="min-h-0 overflow-y-auto overscroll-contain">
            <ul className="space-y-1">
              {bots.state.items.map((item) => (
                <li key={item.id}>
                  <Link
                    href={botHref(item.id, null, initialIntent)}
                    className="block min-h-11 rounded-control px-2 py-2 text-sm hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring [overflow-wrap:anywhere]"
                    aria-current={item.id === bot?.id ? 'page' : undefined}
                    onClick={() => {
                      setChooser(false);
                      setEditor(null);
                    }}
                  >
                    <span className="block font-medium">{item.config.name}</span>
                    {item.config.introduction ? (
                      <span className="block text-muted-foreground">
                        {item.config.introduction}
                      </span>
                    ) : null}
                  </Link>
                </li>
              ))}
            </ul>
            {bots.state.loaded && !bots.state.items.length ? (
              <p className="p-2 text-sm text-muted-foreground">还没有 Bot。</p>
            ) : null}
            <ReadControls state={bots.state} read={bots.read} label="Bot 列表" />
          </div>
          <Dialog.Footer className="flex flex-wrap gap-2">
            {bot ? (
              <Button
                type="button"
                variant="glass"
                color="default"
                onClick={() => {
                  setChooser(false);
                  setEditor(bot.id);
                }}
              >
                <Settings className="size-4" aria-hidden="true" /> 当前 Bot 设置
              </Button>
            ) : null}
            <Button
              type="button"
              color="primary"
              onClick={() => {
                setChooser(false);
                setEditor('create');
              }}
            >
              创建 Bot
            </Button>
          </Dialog.Footer>
        </Dialog.Content>
      </Dialog>
    </>
  );

  return (
    <>
      {bot ? (
        <BotConversations
          key={bot.id}
          bot={bot}
          conversationId={conversationId}
          runId={runId}
          initialIntent={newIntent?.id === conversationId ? newIntent.intent : initialIntent}
          headerActions={headerActions}
          botControls={botControls}
          sidebar={sidebar}
          onCreated={(id) => {
            setNewIntent({ id, intent: initialIntent });
            router.push(botHref(bot.id, id), { scroll: false });
          }}
        />
      ) : (
        <section className="flex min-h-0 w-full min-w-0 flex-1 flex-col" aria-label="Bot 与对话">
          <BotHeader actions={headerActions}>{botControls}</BotHeader>
          <div className="mx-auto flex min-h-0 w-full max-w-xl flex-1 flex-col justify-center gap-4 overflow-y-auto px-5 py-8">
            {loading ? (
              <p role="status" className="text-sm text-muted-foreground">
                正在读取 Bot…
              </p>
            ) : null}
            {error ? (
              <ErrorNotice message={error}>
                {!wrongParent ? (
                  <Button
                    type="button"
                    variant="glass"
                    color="default"
                    onClick={() => {
                      setSelection(null);
                      setRetry((value) => value + 1);
                    }}
                  >
                    重新读取
                  </Button>
                ) : null}
                <Link
                  href="/conversations"
                  className="inline-flex min-h-11 items-center px-2 text-brand-ink underline"
                >
                  返回 Bot 列表
                </Link>
              </ErrorNotice>
            ) : null}
            {!loading && !error ? (
              <>
                <h1 className="text-2xl font-semibold">选择 Bot 开始对话</h1>
                {bots.state.items.length ? (
                  <ul className="space-y-1">
                    {bots.state.items.map((item) => (
                      <li key={item.id}>
                        <Link
                          className="block min-h-11 rounded-control px-2 py-2 font-medium text-brand-ink hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring [overflow-wrap:anywhere]"
                          href={botHref(item.id, null, initialIntent)}
                        >
                          {item.config.name}
                        </Link>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    每个 Bot 保存自己的设置和对话。打开 Bot 不会开始运行。
                  </p>
                )}
                {bots.state.reading ? (
                  <p role="status" className="text-sm text-muted-foreground">
                    正在读取 Bot 列表…
                  </p>
                ) : null}
                {bots.state.error ? (
                  <ErrorNotice message={bots.state.error}>
                    <Button
                      type="button"
                      variant="glass"
                      color="default"
                      onClick={() => void bots.read(true)}
                    >
                      重新读取 Bot 列表
                    </Button>
                  </ErrorNotice>
                ) : null}
                <div>
                  <Button type="button" color="primary" onClick={() => setEditor('create')}>
                    创建 Bot
                  </Button>
                </div>
              </>
            ) : null}
          </div>
        </section>
      )}
      {editor === 'create' || (bot && editor === bot.id) ? (
        <PersonalBotSettings
          key={editor}
          bot={editor === 'create' ? null : bot}
          onClose={() => setEditor(null)}
          onSaved={saved}
        />
      ) : null}
    </>
  );
}

function BotHeader({
  children,
  actions,
  label,
}: {
  children: ReactNode;
  actions?: ReactNode;
  label?: string;
}) {
  return (
    <header className="flex shrink-0 items-center justify-between gap-1 px-2 py-2 sm:gap-2 sm:px-4">
      {label ? (
        <h1 className="min-w-0 truncate text-sm font-semibold sm:sr-only" title={label}>
          {label}
        </h1>
      ) : (
        <Brand height={20} />
      )}
      <nav
        className="chat-dock ml-auto flex shrink-0 items-center rounded-full p-1"
        aria-label="Bot 与会话操作"
      >
        {children}
        {actions}
      </nav>
    </header>
  );
}

function BotConversations({
  bot,
  conversationId,
  runId,
  initialIntent,
  headerActions,
  botControls,
  sidebar,
  onCreated,
}: {
  bot: PersonalBot;
  conversationId: string | null;
  runId: string | null;
  initialIntent: TaskIntent | null;
  headerActions?: ReactNode;
  botControls: ReactNode;
  sidebar: boolean;
  onCreated: (id: string) => void;
}) {
  const history = useConversationHistory(bot.id);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const sidebarShown = sidebar && sidebarOpen;
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  // Retain the key for an explicit retry; reads, reloads and re-login never replay POST.
  const key = useRef<string | null>(null);
  useEffect(() => () => request.current?.abort(), []);

  async function create() {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setCreating(true);
    setError(null);
    try {
      key.current ??= crypto.randomUUID();
      const id = await createBotConversation(bot.id, key.current, controller.signal);
      if (!controller.signal.aborted) {
        key.current = null;
        onCreated(id);
      }
    } catch (failure) {
      if (!controller.signal.aborted)
        setError(failure instanceof Error ? failure.message : '创建对话失败。');
    } finally {
      if (!controller.signal.aborted) {
        request.current = null;
        setCreating(false);
      }
    }
  }

  function header(blockNewConversation: boolean) {
    return (
      <>
        <BotHeader actions={headerActions} label={bot.config.name}>
          {sidebar && !sidebarOpen ? (
            <button
              type="button"
              className={`hidden lg:inline-flex ${actionClass}`}
              aria-label="展开会话栏"
              onClick={() => setSidebarOpen(true)}
            >
              <PanelLeftOpen className="size-4" aria-hidden="true" />
            </button>
          ) : null}
          {botControls}
          <div className={sidebarShown ? 'contents lg:hidden' : 'contents'}>
            <ConversationHistory history={history} />
          </div>
          <button
            type="button"
            className={actionClass}
            aria-label={creating ? '正在创建对话' : '新对话'}
            title={blockNewConversation ? '请先处理当前会话' : '新对话'}
            disabled={creating || blockNewConversation}
            onClick={() => void create()}
          >
            <Plus className="size-4" aria-hidden="true" />
            <span className="hidden sm:inline">{creating ? '正在创建…' : '新对话'}</span>
          </button>
        </BotHeader>
        {error ? (
          <div className="px-3">
            <ErrorNotice message={`创建对话失败，可明确重试同一请求。${error}`} />
          </div>
        ) : null}
        <span role="status" className="sr-only">
          {creating ? '正在创建空对话…' : ''}
        </span>
      </>
    );
  }

  return (
    <div className="flex h-full min-h-0 w-full min-w-0">
      {sidebarShown ? (
        <div className="hidden shrink-0 lg:block">
          <ConversationSidebar
            history={history}
            activeId={conversationId}
            onCollapse={() => setSidebarOpen(false)}
          />
        </div>
      ) : null}
      {conversationId ? (
        <ConversationPane
          key={conversationId}
          bot={bot}
          conversationId={conversationId}
          runId={runId}
          initialIntent={initialIntent}
          creatingConversation={creating}
          header={header}
        />
      ) : (
        <section className="flex min-h-0 min-w-0 flex-1 flex-col" aria-label="当前 Bot">
          {header(false)}
          <div className="mx-auto flex min-h-0 w-full max-w-xl flex-1 flex-col justify-center gap-3 overflow-y-auto px-5 py-8">
            <h2 className="text-2xl font-semibold [overflow-wrap:anywhere]">{bot.config.name}</h2>
            {bot.config.introduction ? (
              <p className="whitespace-pre-wrap text-sm text-muted-foreground [overflow-wrap:anywhere]">
                {bot.config.introduction}
              </p>
            ) : null}
            <p className="text-sm text-muted-foreground">
              打开历史会话，或新建此 Bot 的空对话。只有发送消息才会开始运行。
            </p>
          </div>
        </section>
      )}
    </div>
  );
}
