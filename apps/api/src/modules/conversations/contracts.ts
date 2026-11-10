import type { Pool } from 'pg';
import type { ContextPolicy, ExecutionKind, HarnessStart, WorkspaceGrant } from '@along/contracts';
import type { ThreadEvent } from '@along/stream-protocol';
import type { TrustedExecutionContext } from '@along/contracts';
import type { TimeContext } from '../time/context.js';
import type { HarnessServices } from './harness-process.js';
import type { RoutingRuntime } from './routing/index.js';
import type { RunOwnership } from './run-ownership.js';

export interface ConversationDeps {
  pool: Pool | null;
  timeContext: TimeContext;
  harness?: HarnessServices | null;
  routing?: RoutingRuntime;
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
  userMessageId: string;
  allowlist: readonly string[];
  workspaceGrant?: WorkspaceGrant | null;
  workspaceGrants?: WorkspaceGrant[];
  resumeCheckpointId?: string;
  messageRefs?: readonly string[];
  messages?: HarnessStart['messages'];
  contextPolicy?: ContextPolicy;
  authorizationRevision?: 'delegation/1';
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
