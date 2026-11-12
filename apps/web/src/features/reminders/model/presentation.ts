// D2: the display layer never computes time. It renders frozen server fields
// (fire_at_local, local wall text, echo_text) exactly as received. This module
// intentionally does not read snapshot.fire_at_utc.
import type { ApprovalDetail } from '@along/contracts';
import type { BriefCard } from '@/features/brief/model/types';
import type { ElapsedTimeBasis } from './types';

const TASK_STATUS_LABELS: Record<string, string> = {
  saved: '已保存',
  pending_schedule: '待排期',
  scheduled: '已排期',
  fired: '已触发',
  missed: '已错过',
  cancel_pending: '取消中',
  cancelled: '已取消',
};

const APPROVAL_STATUS_LABELS: Record<string, string> = {
  pending: '待确认',
  consumed: '已确认',
  rejected: '已拒绝',
  expired: '已过期',
  superseded: '已被替代',
};

export interface CardView {
  title: string;
  time: string | null;
  href: string | null;
  status: string | null;
  warning: string | null;
  frozenTimezone: string | null;
  timeBasis: ElapsedTimeBasis | null;
}

export function describeCard(card: BriefCard): CardView {
  if (card.schema_version !== 1 || !['task', 'approval', 'text'].includes(card.kind)) {
    return {
      title: card.title,
      time: null,
      href: null,
      status: null,
      warning: '卡片版本过新或类型未知，请升级应用后查看。',
      frozenTimezone: null,
      timeBasis: null,
    };
  }
  const ref = card.ref;
  const href =
    card.kind === 'task' && ref?.task_id
      ? `/tasks/${ref.task_id}`
      : card.kind === 'approval' && ref?.approval_id
        ? `/approvals/${ref.approval_id}`
        : null;
  const labels = card.kind === 'approval' ? APPROVAL_STATUS_LABELS : TASK_STATUS_LABELS;
  const isTask = card.kind === 'task';
  return {
    title: card.title,
    time: card.fire_at_local ?? null,
    href,
    status: card.status ? (labels[card.status] ?? card.status) : null,
    warning: card.kind === 'text' ? '这条内容暂时无法结构化展示。' : null,
    frozenTimezone: isTask ? (card.timezone_id ?? null) : null,
    timeBasis: isTask ? (card.time_basis ?? null) : null,
  };
}

export interface ApprovalView {
  originalText: string;
  localTime: string;
  timezone: string;
  echo: string;
  remainingLabel: string;
}

export function describeApproval(detail: ApprovalDetail): ApprovalView {
  const hours = Math.floor(detail.expires_in_seconds / 3600);
  const minutes = Math.floor((detail.expires_in_seconds % 3600) / 60);
  return {
    originalText: detail.original_text ?? '(空内容)',
    localTime: detail.fire_at_local,
    timezone: detail.snapshot.timezone_id,
    echo: detail.echo_text,
    remainingLabel: hours > 0 ? `${hours} 小时 ${minutes} 分` : `${minutes} 分`,
  };
}
