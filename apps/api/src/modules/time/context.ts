import { readFileSync } from 'node:fs';
import {
  ALIAS_TABLE_V1,
  freezeValue,
  isSupportedRuleset,
  sameValue,
  type AliasTable,
  type TimeRuleset,
} from '@along/time-core';
import { HttpError } from '../../http/errors.js';

interface ContextIdentity {
  readonly ruleset_id: string;
  readonly tzdb_version: string;
  readonly missing: readonly string[];
}
export type TimeContext = ContextIdentity &
  (
    | { readonly available: true; readonly ruleset: TimeRuleset; readonly aliases: AliasTable }
    | { readonly available: false }
  );

// These are actual, removable production inputs, outside compiled JS. Both
// src/modules/time and dist/modules/time resolve the same apps/api/resources.
export const TIME_RESOURCE_URLS = Object.freeze({
  rules: new URL('../../../resources/time/fixture-v1.json', import.meta.url),
  aliases: new URL('../../../resources/time/aliases-v1.json', import.meta.url),
});

export function createTimeContext(
  version: string | undefined,
  rules: unknown,
  aliases: unknown,
): TimeContext {
  const validRules = isSupportedRuleset(rules);
  const validAliases = sameValue(aliases, ALIAS_TABLE_V1);
  const identity = {
    ruleset_id: validRules ? rules.ruleset_id : 'unavailable',
    tzdb_version: validRules ? rules.tzdb_version : 'unavailable',
    missing: version ? [] : ['TZDB_VERSION'],
  };
  if (!validRules || !validAliases || version !== rules.tzdb_version) {
    return freezeValue({ ...identity, available: false });
  }
  // Own the input values; callers cannot mutate an admitted run's context.
  return freezeValue({
    ...identity,
    available: true,
    ruleset: structuredClone(rules),
    aliases: structuredClone(aliases) as AliasTable,
  });
}

export function loadTimeContext(version: string | undefined): TimeContext {
  let rules: unknown;
  let aliases: unknown;
  try {
    rules = JSON.parse(readFileSync(TIME_RESOURCE_URLS.rules, 'utf8'));
  } catch {
    rules = null;
  }
  try {
    aliases = JSON.parse(readFileSync(TIME_RESOURCE_URLS.aliases, 'utf8'));
  } catch {
    aliases = null;
  }
  return createTimeContext(version, rules, aliases);
}

export function requireTimeContext(
  context: TimeContext,
): asserts context is Extract<TimeContext, { available: true }> {
  if (!context.available) {
    throw new HttpError(
      503,
      400006,
      'TZDB_UNAVAILABLE',
      '时区规则库暂不可用，现在无法排期，请稍后再试。',
    );
  }
}
