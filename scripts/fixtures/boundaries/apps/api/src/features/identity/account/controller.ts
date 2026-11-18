import { Elysia } from 'elysia';
import type { ActorResolver } from '../../../http/auth.js';

export const accountRoute = new Elysia();
export type AccountRouteActor = ActorResolver;
