import type { Pool } from 'pg';
import type {
  ContextPolicy,
  ExecutionKind,
  HarnessR3Context,
  HarnessStart,
  WorkspaceGrant,
} from '@along/contracts';
import type { ThreadEvent } from '@along/stream-protocol';
import type { TrustedExecutionContext } from '@along/contracts';
import type { TimeContext } from '../time/context.js';
import type { HarnessServices } from './harness-process.js';
import type { RoutingRuntime } from './routing/index.js';
import type { RunOwnership } from './run-ownership.js';
import type { AutoCompactPolicy } from './auto-compact-policy.js';

export interface ConversationDeps {
  pool: Pool | null;
  timeContext: TimeContext;
  harness?:
    | (Omit<HarnessServices, 'model' | 'measure'> & {
        autoCompactPolicy?: AutoCompactPolicy;
        autoCompactPlanningTokens?: number;
      })
    | null;
  routing?: RoutingRuntime;
  // A real adapter must enforce the common outbound policy and make measurement
  // describe the exact bytes its model transport sends. No deployment fallback.
  modelTransport?: (
    config: {
      base_url: string;
      api_key: string | null;
      model_id: string;
    },
    diagnostic?: { runId: string; attemptId: string; operation: 'compact' | 'model' },
  ) => Promise<{
    model: HarnessServices['model'];
    measure: NonNullable<HarnessServices['measure']>;
  }>;
  runDriver?: {
    acquire(runId: string, waitForLock?: boolean): Promise<RunOwnership>;
    release(owner: RunOwnership): Promise<void>;
    start(deps: ConversationDeps, context: RunContext): void;
  };
}

export interface RunContext {
  ownerId: string;
  conversationId: string;
  runId: string;
  attemptId: string;
  requestId: string;
  ownership?: RunOwnership;
  inputText: string;
  reminderInputText?: string;
  reminderNeedsRestatement?: boolean;
  confirmedTimezone: string | null;
  anchorReceivedAtUtc: string;
  receivedAtUtc: string;
  foldChoice: 'first' | 'second' | 'none';
  maxIterations: number;
  maxTokens: number;
  timeContext: TimeContext;
  execution: ExecutionKind;
  /** Null only for a persisted compact control Run; never a message source. */
  userMessageId: string | null;
  compactControl?: true;
  allowlist: readonly string[];
  autoCompactPolicy?: AutoCompactPolicy;
  workspaceGrant?: WorkspaceGrant | null;
  workspaceGrants?: WorkspaceGrant[];
  resumeCheckpointId?: string;
  messageRefs?: readonly string[];
  messages?: HarnessStart['messages'];
  contextPolicy?: ContextPolicy;
  compactCompletionCap?: number;
  authorizationRevision?: 'delegation/1';
  executionProfile?: 'pause/1' | 'pause-memory/1' | 'compact-memory/1';
  r3Context?: HarnessR3Context;
  trustedExecutionContext?: TrustedExecutionContext;
}

export interface StartResult {
  conversationId: string;
  runId: string;
  replay: ThreadEvent[] | null;
  context: RunContext | null;
  serverOwned?: true;
  afterSeq?: number | null;
}

export type EventWriter = (event: ThreadEvent) => Promise<boolean>;
