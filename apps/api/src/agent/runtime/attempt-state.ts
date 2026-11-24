import type { Pool, PoolClient } from 'pg';
import type {
  HarnessApprovalDecision,
  HarnessContextMeasurement,
  HarnessModelStep,
  HarnessStart,
  RoutingEmbedding,
  RoutingFacts,
} from '@along/contracts';
import type { ConversationDeps, RunContext } from './contracts.js';
import type { LockedRun } from '../../features/conversations/public.js';
import type { LoadedAttempt } from './attempt-load.js';
export type AttemptGuard = <T>(
  action: (client: PoolClient, locked: LockedRun) => Promise<T>,
) => Promise<T>;

/** Exactly one mutable state object is shared by the synchronous attempt handlers. */
export interface AttemptState {
  stopped: boolean;
  correctingGoal: boolean;
  lastSnapshot: LoadedAttempt['snapshot'];
  delivered: Set<string>;
  cumulative: { iterations: number; tokens: number | null };
  facts: RoutingFacts | null;
  embedding: RoutingEmbedding | null;
  encodingCount: number;
  encodingPending: boolean;
  routingDecision: LoadedAttempt['decision'];
  modelStarted: boolean;
  latestModelMessage:
    | Extract<
        NonNullable<LoadedAttempt['snapshot']>,
        { version: 3 | 4 }
      >['native_state']['pending_model']
    | null;
  modelToolCount: number;
  nextPermit: boolean;
  lastModelInputTokens: number | null;
  lastMeasurement: {
    measurement: HarnessContextMeasurement;
    remaining: number | null;
    output: number;
  } | null;
  modelStream: {
    ref: string;
    iterator: AsyncGenerator<HarnessModelStep, void, unknown>;
    pendingDelta: string | null;
    pulling: boolean;
  } | null;
}

export interface AttemptEnvironment {
  pool: Pool;
  deps: ConversationDeps;
  context: RunContext;
  initial: LoadedAttempt;
  state: AttemptState;
  tools: HarnessStart['tools'];
  guarded: AttemptGuard;
  assertActionAuthority(client: PoolClient): Promise<void>;
  sessionSignal: AbortSignal;
  modelSignal: AbortSignal;
  modelController: AbortController;
}

export function approvalAuthorizesActions(decision: HarnessApprovalDecision | null): boolean {
  return (
    decision === null ||
    (decision.kind === 'task' ? decision.status === 'consumed' : decision.status === 'approved')
  );
}
