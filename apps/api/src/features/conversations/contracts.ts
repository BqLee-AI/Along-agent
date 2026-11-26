import type { Pool, PoolClient } from 'pg';
import type {
  ContextPolicy,
  ExecutionKind,
  HarnessR3Context,
  HarnessStart,
  WorkspaceGrant,
  TrustedExecutionContext,
} from '@along/contracts';
import type { TimeContext } from '../time/public.js';
import type { AutoCompactPolicy } from './compact/auto-compact-policy.js';

export interface ConversationDeps {
  pool: Pool | null;
  timeContext: TimeContext;
}

/** Execution authority is supplied by the caller; facts never acquire it. */
export interface RunAuthority {
  assert(client: PoolClient, runId: string, attemptId?: string): Promise<void>;
  transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T>;
}

export interface RunContext {
  ownerId: string;
  conversationId: string;
  runId: string;
  attemptId: string;
  requestId: string;
  ownership?: RunAuthority;
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
  personalBot?: { id: string; revision: number; role: string; instructions: string };
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
