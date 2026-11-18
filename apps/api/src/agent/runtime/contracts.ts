import type { Pool } from 'pg';
import type { ThreadEvent } from '@along/stream-protocol';
import type {
  RunContext as RunFacts,
  AutoCompactPolicy,
} from '../../features/conversations/public.js';
import type { TimeContext } from '../../features/time/public.js';
import type {
  ModelTransportFactory,
  ModelContextMeasurement,
  ModelStepTransport,
} from '../../features/model-providers/public.js';
import type { ContextPolicy } from '@along/contracts';
import type { HarnessProcessServices } from '../harness/harness-process.js';
import type { RoutingRuntime } from '../routing/index.js';
import type { RunOwnership } from './run-ownership.js';

export interface HarnessServices extends HarnessProcessServices {
  maxIterations: number;
  maxTokens: number;
  autoCompactPlanningTokens?: number;
  compactCompletionCap?: number;
  contextPolicy: ContextPolicy;
  measure?: ModelContextMeasurement;
  model: ModelStepTransport;
}

/** Process execution augments frozen conversation facts, never the reverse. */
export interface RunContext extends Omit<RunFacts, 'ownership'> {
  ownership?: RunOwnership;
}

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
  modelTransport?: ModelTransportFactory;
  runDriver?: {
    acquire(runId: string, waitForLock?: boolean): Promise<RunOwnership>;
    release(owner: RunOwnership): Promise<void>;
    start(deps: ConversationDeps, context: RunContext): void;
  };
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
