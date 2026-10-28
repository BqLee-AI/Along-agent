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

export interface TaskListItem {
  task_id: string;
  state: string;
  fire_at_utc: string;
  fire_at_local: string;
  timezone_id: string;
  source_approval_id: string | null;
  schedule_receipt: string | null;
}

export const TaskDetailSchema = z
  .object({
    task_id: z.string().uuid(),
    state: z.string(),
    fire_at_utc: z.string(),
    fire_at_local: z.string(),
    timezone_id: z.string(),
    source_approval_id: z.string().nullable(),
    schedule_receipt: z.string().nullable(),
    kind: z.string(),
    state_version: z.number(),
    recreated_from: z.string().nullable(),
    created_at: z.string(),
    notifications: z.array(
      z
        .object({
          id: z.string().uuid(),
          title: z.string(),
          body: z.string(),
          status: z.enum(['pending', 'sent', 'failed']),
          sent_at: z.string().nullable(),
        })
        .strict(),
    ),
  })
  .strict();
export type TaskDetail = z.infer<typeof TaskDetailSchema>;

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
