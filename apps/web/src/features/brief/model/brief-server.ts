import { apiGet } from '@/shared/http/server';
import type { ApiResult } from '@/shared/http/result';
import { pageReturnTo } from '@/shared/session/navigation';
import type { PageQuery } from '@/shared/session/navigation';
import { describeCard } from '@/features/reminders/model/presentation';
import type { CardView } from '@/features/reminders/model/presentation';
import { BriefSchema } from './types';
import type { Brief } from './types';

export interface BriefGroup {
  id: string;
  title: string;
  description: string;
  href: string | null;
  empty: string;
  items: (CardView & { id: string })[];
}

export interface BriefWorkspace {
  brief: Brief;
  groups: BriefGroup[];
}

export interface TodayWorkspace {
  refreshHref: string;
  result: Promise<ApiResult<BriefWorkspace>>;
}

function assembleBrief(brief: Brief): BriefWorkspace {
  const groups = [
    {
      id: 'approvals',
      title: '待你确认',
      description: '审阅完整方案，再决定是否确认。',
      href: '/approvals',
      empty: '本次简报没有待确认事项',
      cards: brief.cards.filter((card) => card.kind === 'approval'),
    },
    {
      id: 'reminders',
      title: '提醒',
      description: '只展示已记录的步骤，不承诺通知必达。',
      href: '/tasks',
      empty: '本次简报没有提醒',
      cards: brief.cards.filter((card) => card.kind === 'task'),
    },
    {
      id: 'other',
      title: '其他简报记录',
      description: '保留原始简报内容与类型提示。',
      href: null,
      empty: '',
      cards: brief.cards.filter((card) => card.kind !== 'approval' && card.kind !== 'task'),
    },
  ]
    .filter((group) => group.id !== 'other' || group.cards.length > 0)
    .map(({ cards, ...group }) => ({
      ...group,
      items: cards.map((card) => ({ id: card.card_id, ...describeCard(card) })),
    }));
  return { brief, groups };
}

async function readBrief(path: string, returnTo: string): Promise<ApiResult<BriefWorkspace>> {
  const response = await apiGet<unknown>(path, returnTo);
  if (!response.ok) return response;
  const parsed = BriefSchema.safeParse(response.data);
  if (!parsed.success) {
    return {
      ok: false,
      status: 200,
      code: 'INVALID_RESPONSE',
      requestId: null,
      message: '简报响应无法核验，请重新读取。此错误不代表没有事项。',
    };
  }
  return { ok: true, data: assembleBrief(parsed.data) };
}

export function loadTodayWorkspace(query: PageQuery): TodayWorkspace {
  const params = new URLSearchParams();
  for (const key of ['date', 'timezone'] as const) {
    const raw = query[key];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (value !== undefined) params.set(key, value);
  }
  const refreshHref = pageReturnTo('/', query);
  return {
    refreshHref,
    result: readBrief(`/api/v1/brief${params.size ? `?${params}` : ''}`, refreshHref),
  };
}
