import type { Pool } from 'pg';
import type { ActorResolver } from './auth.js';
import type { TimeContext } from '../features/time/public.js';
import type { RoutingRuntime } from '../agent/routing/index.js';
import type { RunDriver } from '../agent/runtime/run-driver.js';
import type { ConversationDeps } from '../agent/runtime/contracts.js';
import type { MemoryService } from '../features/memory/public.js';
import type { AccountService, InvitedAccountService } from '../features/identity/public.js';

export interface AppDeps {
  pool: Pool | null;
  resolveActor?: ActorResolver;
  tzdbVersion?: string;
  timeContext?: TimeContext;
  harness?: ConversationDeps['harness'];
  routing?: RoutingRuntime;
  runDriver?: RunDriver;
  modelTransport?: ConversationDeps['modelTransport'];
  accountService?: AccountService;
  invitedAccountService?: InvitedAccountService;
  memoryService?: MemoryService;
}
