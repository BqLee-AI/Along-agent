import type { Pool } from 'pg';
import { notReady } from '../../../platform/errors.js';
import type { ConversationDeps } from '../contracts.js';

export const CANCEL_INTENT = /取消|删掉|别再提醒/;

export function requirePool(deps: ConversationDeps): Pool {
  if (!deps.pool) throw notReady();
  return deps.pool;
}
