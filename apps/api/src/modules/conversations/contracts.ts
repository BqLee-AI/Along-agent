import type { Pool } from 'pg';
import type { ExecutionKind } from '@along/contracts';
import type { ThreadEvent } from '@along/stream-protocol';
import type { TimeContext } from '../time/context.js';
import type { HarnessServices } from './harness-process.js';

export interface ConversationDeps {
  pool: Pool | null;
  timeContext: TimeContext;
  harness?: HarnessServices | null;
}

export interface RunContext {
  ownerId: string;
  conversationId: string;
  runId: string;
  attemptId: string;
  requestId: string;
  inputText: string;
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
  resumeCheckpointId?: string;
}

export interface StartResult {
  conversationId: string;
  runId: string;
  replay: ThreadEvent[] | null;
  context: RunContext | null;
}

export type EventWriter = (event: ThreadEvent) => Promise<boolean>;
