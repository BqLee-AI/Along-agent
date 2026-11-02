import { ALIAS_TABLE_V1 } from './entry.js';

// Provenance only. Parsing, timezone conversion and date arithmetic stay in
// classifyEntry/normalize. Multiple date statements require a full restatement.
export function reminderDateExpression(text: string): string | null {
  const dates = [
    ...text.matchAll(/\d{4}-\d{2}-\d{2}|\d{4}年\d{1,2}月\d{1,2}[日号]|今天|明天|后天|昨天/g),
  ];
  return dates.length === 1 ? dates[0][0] : null;
}

export function reminderTimezoneReply(text: string): string | null {
  const value = text.trim();
  if (Object.hasOwn(ALIAS_TABLE_V1.aliases, value)) return ALIAS_TABLE_V1.aliases[value];
  return Object.values(ALIAS_TABLE_V1.aliases).includes(value) ? value : null;
}
