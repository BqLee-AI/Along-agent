import type { ConversationDeps } from '../execution/contracts.js';
import { createRoutingRuntime, type RoutingRuntime } from './index.js';

const routingByDeps = new WeakMap<ConversationDeps, RoutingRuntime>();

/** Freeze optional routing configuration once for each server dependency set. */
export function routingRuntimeOf(deps: ConversationDeps): RoutingRuntime {
  if (deps.routing) return deps.routing;
  let runtime = routingByDeps.get(deps);
  if (!runtime) {
    runtime = createRoutingRuntime({ mode: 'off' });
    routingByDeps.set(deps, runtime);
  }
  return runtime;
}
