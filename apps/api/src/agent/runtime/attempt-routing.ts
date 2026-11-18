import { RoutingFactsSchema, type RoutingFacts, type RoutingPolicy } from '@along/contracts';
import { forbidden, stateConflict } from '../../platform/errors.js';
import type { RunContext } from './contracts.js';
import { routingHash } from '../routing/routing-checkpoints.js';
export function validateRoutingFacts(
  value: RoutingFacts,
  context: RunContext,
  policy: RoutingPolicy | null,
): RoutingFacts {
  const result = RoutingFactsSchema.parse(value);
  if (
    !policy ||
    policy.mode === 'off' ||
    result.input_sha256 !== routingHash(context.inputText) ||
    result.bundle_sha256 !== policy.bundle_sha256
  )
    throw stateConflict('routing facts input or bundle binding conflict');
  const scalars = Array.from(context.inputText);
  for (const candidate of result.candidates) {
    if (!policy.candidate_intents.includes(candidate.intent))
      throw forbidden('routing candidate outside frozen policy');
    const keys = Object.keys(candidate.args);
    if (candidate.intent === 'task_list_bounded') {
      if (
        candidate.tool_id !== 'list_tasks' ||
        !keys.includes('limit') ||
        keys.some((key) => key !== 'limit' && key !== 'state') ||
        ('state' in candidate.args && candidate.args.state !== null) ||
        !Number.isInteger(candidate.args.limit) ||
        Number(candidate.args.limit) < 1 ||
        Number(candidate.args.limit) > 50
      )
        throw stateConflict('routing task arguments outside bounded contract');
    } else if (candidate.intent === 'prefs_timezone_read') {
      if (candidate.tool_id !== 'get_user_prefs' || keys.length || candidate.sources.length)
        throw stateConflict('routing prefs must use server owner and empty arguments');
    } else {
      const date = candidate.args.date;
      if (
        candidate.tool_id !== 'read_brief_cards' ||
        keys.length !== 1 ||
        keys[0] !== 'date' ||
        typeof date !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}$/.test(date)
      )
        throw stateConflict('routing brief requires one Gregorian date');
      const year = Number(date.slice(0, 4)),
        month = Number(date.slice(5, 7)),
        day = Number(date.slice(8));
      const days = [
        31,
        year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28,
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
      ];
      if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1]!)
        throw stateConflict('routing brief requires valid Gregorian date');
    }
    if (candidate.sources.length !== keys.length)
      throw stateConflict('routing requires one source for every parameter');
    const seen = new Set<string>();
    for (const source of candidate.sources) {
      if (
        !keys.includes(source.field) ||
        seen.has(source.field) ||
        source.parser_revision !== policy.parser_revision
      )
        throw stateConflict('routing parameter source binding conflict');
      seen.add(source.field);
      if (source.source === 'contract_default') {
        if (
          candidate.intent !== 'task_list_bounded' ||
          !(
            (source.field === 'limit' && candidate.args.limit === 20) ||
            (source.field === 'state' && candidate.args.state === null)
          )
        )
          throw stateConflict('routing parameter has no contract default');
      } else if (
        (source.field !== 'limit' && source.field !== 'date') ||
        source.message_id !== context.userMessageId ||
        source.end > scalars.length ||
        scalars.slice(source.start, source.end).join('') !== source.raw ||
        (source.field === 'date'
          ? candidate.args.date !== source.raw
          : !/^\d+$/.test(source.raw) || Number(source.raw) !== candidate.args.limit)
      )
        throw stateConflict('routing message source does not match frozen input');
    }
  }
  // Keep the runtime-owned evidence identity; its private input binding is not serializable.
  return value;
}
