import type {
  RoutingEmbedding,
  RoutingFacts,
  RoutingIntent,
  RoutingPolicy,
} from '@along/contracts';

export const ROUTING_INTENTS = [
  'task_list_bounded',
  'prefs_timezone_read',
  'brief_cards_read',
] as const;
export const REVISIONS = Object.freeze({
  guard_revision: 'r2b-guard/9',
  parser_revision: 'r2b-parser/1',
  handler_revision: 'r2b-handler/1',
  renderer_revision: 'r2b-renderer/1',
  scorer_revision: 'r2b-number-top2/1',
});
export type EnabledRoutingPolicy = Exclude<RoutingPolicy, { mode: 'off' }>;
export interface RoutingInput {
  messageId: string;
  text: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  hasPendingApproval: boolean;
  workspaceSelected: boolean;
}
export type RoutingFetch = (url: string, init: RequestInit) => Promise<Response>;
export interface RoutingRuntimeSettings {
  mode?: 'off' | 'shadow' | 'enforce';
  bundlePath?: string;
  encoderUrl?: string;
  intents?: readonly RoutingIntent[];
  fetch?: RoutingFetch;
  onUnavailable?: (reason: string) => void;
}
export interface RoutingRuntime {
  policy(): RoutingPolicy;
  facts(input: RoutingInput, policy: RoutingPolicy): RoutingFacts;
  embedding(
    text: string,
    facts: RoutingFacts,
    policy: RoutingPolicy,
    signal: AbortSignal,
  ): Promise<RoutingEmbedding>;
  choose(
    facts: RoutingFacts,
    embedding: RoutingEmbedding | null,
    policy: RoutingPolicy,
  ): RoutingIntent | null;
  render(intent: RoutingIntent, accepted: unknown): string;
}
