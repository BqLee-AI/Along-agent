#!/usr/bin/env node
// Migration scan (D3/D4/D5): file naming + append-only static rules + S0 frozen names.
// Zero npm dependencies: node stdlib only.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.argv[2] ?? process.cwd();
const dir = join(root, 'infra/migrations');

const failures = [];

// 1. File naming: <seq>_<group>_*.sql; groups own disjoint sequence ranges
// (identity 0001, conversation 0002, commitments 0003+).
// Conversation-owned ledger additions extend through 0014; commitments keep
// their existing [3,9998] range.
const groupRanges = {
  identity: [1, 1],
  conversation: [2, 14],
  commitments: [3, 9998],
  invited: [0, 0],
};
// R1 identity owns exactly this next migration, not the intervening groups' range.
const identityAccountMigration = '0017_identity_account_access.sql';
const invitedAccountMigration = '0024_invited_accounts.sql';
// History owns exactly this addition; intervening conversation ranges stay frozen.
const conversationHistoryMigration = '0018_conversation_history.sql';
// R2-A owns only its immutable per-Run policy migration.
const conversationContextMigration = '0019_conversation_context_policies.sql';
const conversationRoutingMigration = '0020_conversation_readonly_routing.sql';
const files = readdirSync(dir)
  .filter((f) => f.endsWith('.sql'))
  .sort();
if (files.length === 0) failures.push('infra/migrations: no .sql files');
const sequences = new Set();
for (const f of files) {
  const m = /^(\d{4})_([a-z0-9]+)_[a-z0-9_]+\.sql$/.exec(f);
  if (!m) {
    failures.push(`${f}: expected <seq>_<group>_*.sql (e.g. 0003_commitments_tasks.sql)`);
    continue;
  }
  const [, seq, group] = m;
  if (sequences.has(seq)) failures.push(`${f}: duplicate migration sequence ${seq}`);
  sequences.add(seq);
  const range = groupRanges[group];
  if (
    range &&
    (+seq < range[0] || +seq > range[1]) &&
    f !== identityAccountMigration &&
    f !== invitedAccountMigration &&
    f !== conversationHistoryMigration &&
    f !== conversationContextMigration &&
    f !== conversationRoutingMigration
  ) {
    failures.push(`${f}: ${group} sequence ${seq} outside ${String(range[0]).padStart(4, '0')}+`);
  }
}

// 2. Append-only static rule: no migration may run DML against task_events.
// Trigger DDL (BEFORE UPDATE OR DELETE ON task_events) is allowed; only
// UPDATE task_events / DELETE FROM task_events statements are forbidden.
for (const f of files) {
  const text = readFileSync(join(dir, f), 'utf8');
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t.startsWith('--')) continue;
    if (/\bUPDATE\s+task_events\b/i.test(t) || /\bDELETE\s+FROM\s+task_events\b/i.test(t)) {
      failures.push(`${f}: task_events UPDATE/DELETE is forbidden (append-only)`);
    }
  }
}

// 3. S0 frozen aliases must not appear in shipped migrations.
for (const word of ['outbox_events', 'schedule_confirmed', 'SERVICE_NOT_READY', 'C-XXXX']) {
  for (const f of files) {
    const text = readFileSync(join(dir, f), 'utf8');
    if (text.includes(word)) failures.push(`${f}: banned S0 name ${word}`);
  }
}

if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log('migrations scan ok');
