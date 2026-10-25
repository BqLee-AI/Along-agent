import { z } from 'zod';

// Wire types for the v0 API. The Web layer reads these frozen fields only.
export interface BriefCard {
  card_id: string;
  kind: string;
  schema_version: number;
  title: string;
  status?: string;
  fire_at_local?: string;
  ref?: { task_id?: string; approval_id?: string };
}

export interface Brief {
  date: string;
  timezone_id: string;
  summary: { pending_count: number; fired_count: number };
  cards: BriefCard[];
  meta: {
    brief_state: 'empty' | 'day-in-progress' | 'stale';
    stale_reason?: string | null;
    timezone_note: string | null;
  };
}

export interface ApprovalListItem {
  approval_id: string;
  title: string;
  status: string;
  expires_at: string;
  created_at: string;
}

export const ApprovalDetailSchema = z.object({
  approval_id: z.string().uuid(),
  kind: z.enum(['create_task', 'cancel_task']),
  status: z.string(),
  echo_text: z.string(),
  original_text: z.string().nullable(),
  fire_at_local: z.string(),
  expires_in_seconds: z.number(),
  snapshot: z.object({
    fire_at_utc: z.string(),
    timezone_id: z.string(),
    fold: z.number(),
    offset_seconds: z.number(),
  }),
  presentation_hash: z.string(),
  presentation_version: z.string(),
  expires_at: z.string(),
  recreated_from: z.string().nullable(),
});
export type ApprovalDetail = z.infer<typeof ApprovalDetailSchema>;

export interface TaskListItem {
  task_id: string;
  state: string;
  fire_at_utc: string;
  fire_at_local: string;
  timezone_id: string;
  source_approval_id: string | null;
  schedule_receipt: string | null;
}

export interface TaskNotification {
  id: string;
  title: string;
  body: string;
  status: 'pending' | 'sent' | 'failed';
  sent_at: string | null;
}

export interface TaskDetail extends TaskListItem {
  kind: string;
  state_version: number;
  recreated_from: string | null;
  created_at: string;
  notifications: TaskNotification[];
}

export interface TaskEventItem {
  event_id: string;
  type: string;
  recorded_at_utc: string;
  state_version: number;
  evidence_ref: string;
}

export const MeSchema = z.object({
  user: z.object({ id: z.string().uuid(), display_name: z.string() }),
  csrf_token: z.string().nullable(),
  confirmed_timezone: z.string().nullable(),
});
export type Me = z.infer<typeof MeSchema>;
