// Closed event vocabulary: docs/design/07 §1 (S0 frozen, seven words).
export const EVENT_TYPES = [
  'created',
  'scheduled',
  'fired',
  'missed',
  'cancel_requested',
  'cancelled',
  'reconciliation_run',
] as const;
export { THREAD_EVENT_TYPES, THREAD_PROTOCOL_VERSION, ThreadEventSchema } from './thread-events.js';
export { AmbiguousTimeDetailsSchema } from './thread-events.js';
export {
  DELEGATION_THREAD_PROTOCOL_VERSION,
  LegacyThreadEventSchema,
  DelegationThreadEventSchema,
} from './thread-events.js';
export type {
  ApprovalRequiredEvent,
  CardProposedEvent,
  MessageDeltaEvent,
  ThreadCancelledEvent,
  ThreadCompletedEvent,
  ThreadEvent,
  ThreadEventType,
  ThreadFailedEvent,
  ThreadStartedEvent,
} from './thread-events.js';

export type EventType = (typeof EVENT_TYPES)[number];
