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

export interface ApprovalDetail {
  approval_id: string;
  kind: 'create_task' | 'cancel_task';
  status: string;
  echo_text: string;
  original_text: string | null;
  fire_at_local: string;
  expires_in_seconds: number;
  snapshot: {
    fire_at_utc: string;
    timezone_id: string;
    fold: number;
    offset_seconds: number;
  };
  presentation_hash: string;
  presentation_version: string;
  expires_at: string;
  recreated_from: string | null;
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

export interface TaskDetail extends TaskListItem {
  kind: string;
  state_version: number;
  recreated_from: string | null;
  created_at: string;
}

export interface TaskEventItem {
  event_id: string;
  type: string;
  recorded_at_utc: string;
  state_version: number;
  evidence_ref: string;
}

export interface Me {
  user: { id: string; display_name: string };
  csrf_token: string | null;
  confirmed_timezone: string | null;
}
