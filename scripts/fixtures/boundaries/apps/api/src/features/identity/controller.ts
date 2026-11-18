import { Elysia } from 'elysia';
import type { ActorResolver } from '../../http/auth.js';

export const route = new Elysia();
export type RouteActor = ActorResolver;
