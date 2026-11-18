import { Elysia } from 'elysia';
import type { ActorResolver } from '../../http/auth.js';
export { drive } from '../../agent/runtime/driver.js';

export const route = new Elysia();
export type RouteActor = ActorResolver;
