import type { ActorResolver } from '../auth.js';

export interface ConnectionMetadata {
  remoteAddress: string | null;
  localAddress: string | null;
  encrypted: boolean;
  resolveActor?: ActorResolver;
}
const connections = new WeakMap<Request, ConnectionMetadata>();
export function attachConnection(request: Request, metadata: ConnectionMetadata): void {
  connections.set(request, metadata);
}
export function connectionOf(request: Request): ConnectionMetadata {
  return connections.get(request) ?? { remoteAddress: null, localAddress: null, encrypted: false };
}
