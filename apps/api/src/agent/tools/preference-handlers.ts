import type { PoolClient } from 'pg';
import { readToolBriefCards } from '../../features/brief/public.js';
import {
  readUserPreferences,
  setUserTimezoneWithinTransaction,
} from '../../features/identity/public.js';
import { ApplicationError } from '../../platform/errors.js';
import { TOOL_INPUT_SCHEMAS } from './schemas.js';
import type { ToolContext, ToolResult } from './contracts.js';
import type { ToolExecution } from './handler-common.js';

export async function runReadBriefCards(
  client: PoolClient,
  ctx: ToolContext,
  args: unknown,
): Promise<ToolExecution> {
  const parsed = TOOL_INPUT_SCHEMAS.read_brief_cards.safeParse(args);
  if (!parsed.success) {
    return {
      payload: {
        kind: 'clarify',
        reason: 'INVALID_ARGS',
        phrase_key: 'INVALID_ARGS',
        text: '日期格式不合法；请给 YYYY-MM-DD。',
      },
      errorCode: null,
    };
  }
  const projection = await readToolBriefCards(client, ctx.ownerId, parsed.data, ctx.timeContext);
  return {
    payload: { kind: 'brief', ...projection },
    errorCode: null,
  };
}

export async function runGetUserPrefs(
  client: PoolClient,
  ctx: ToolContext,
  args: unknown,
): Promise<ToolExecution> {
  if (!TOOL_INPUT_SCHEMAS.get_user_prefs.safeParse(args).success) {
    return {
      payload: {
        kind: 'clarify',
        reason: 'INVALID_ARGS',
        phrase_key: 'INVALID_ARGS',
        text: '工具参数不合法，已拒绝。',
      },
      errorCode: 'TOOL_FORBIDDEN',
    };
  }
  const preferences = await readUserPreferences(client, ctx.ownerId);
  return {
    payload: {
      kind: 'prefs',
      timezone_id: preferences.timezone_id,
      alias_version: ctx.timeContext.available ? ctx.timeContext.aliases.version : 'unavailable',
      quiet_hours: null,
      locale: null,
    },
    errorCode: null,
  };
}

export async function runSetUserTimezone(
  client: PoolClient,
  ctx: ToolContext,
  args: unknown,
): Promise<ToolResult> {
  const parsed = TOOL_INPUT_SCHEMAS.set_user_timezone.safeParse(args);
  if (!parsed.success || ctx.authorizationRevision !== 'delegation/1')
    return {
      status: 'denied',
      error: { code: 'TOOL_FORBIDDEN', message: '时区设置参数或运行授权不合法。' },
    };
  try {
    const setting = await setUserTimezoneWithinTransaction(
      client,
      ctx.ownerId,
      parsed.data.timezone_id,
      ctx.timeContext,
    );
    return { status: 'ok', result: { kind: 'timezone_setting', ...setting } };
  } catch (error) {
    if (!(error instanceof ApplicationError)) throw error;
    return { status: 'denied', error: { code: error.errorCode, message: error.message } };
  }
}
