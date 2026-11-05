#!/usr/bin/env node
// Gate-manifest check: D9 enforced (#8 owner), D3-D6 enforced, never silently skipped.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { d8ConsumerCases } from './d8-contracts.mjs';

const root = process.argv[2] ?? process.cwd();
const manifest = JSON.parse(readFileSync(join(root, 'ci/gates.json'), 'utf8'));

const failures = [];
for (const gate of ['D3', 'D4', 'D5', 'D6', 'D9']) {
  const entry = manifest.gates?.[gate];
  const owner = gate === 'D9' ? '#8' : '#7';
  if (
    entry?.status !== 'enforced' ||
    entry?.owner !== owner ||
    typeof entry?.scope !== 'string' ||
    entry.scope.length === 0
  ) {
    failures.push(
      `${gate}: expected {status: enforced, owner: ${owner}, scope: non-empty}, got ${JSON.stringify(entry)}`,
    );
  }
}
const d1 = manifest.gates?.D1;
if (d1?.status !== 'enforced') failures.push(`D1: expected enforced, got ${JSON.stringify(d1)}`);
const d2 = manifest.gates?.D2;
if (
  d2?.status !== 'enforced' ||
  d2?.owner !== '#10' ||
  typeof d2?.scope !== 'string' ||
  d2.scope.length === 0
) {
  failures.push(
    `D2: expected {status: enforced, owner: #10, scope: non-empty}, got ${JSON.stringify(d2)}`,
  );
}
const d7 = manifest.gates?.D7;
if (d7?.status !== 'enforced') failures.push(`D7: expected enforced, got ${JSON.stringify(d7)}`);
const d8 = manifest.gates?.D8;
if (
  d8?.status !== 'enforced' ||
  d8?.enforced_by?.job !== 'integration' ||
  typeof d8?.scope !== 'string' ||
  d8.scope.trim().length === 0 ||
  d8?.remaining?.status !== 'partial' ||
  typeof d8?.remaining?.scope !== 'string' ||
  d8.remaining.scope.trim().length === 0
) {
  failures.push(`D8: expected bounded enforced declaration with partial remaining scope`);
}
try {
  d8ConsumerCases(d8);
} catch (error) {
  failures.push(error.message);
}
const d10 = manifest.gates?.D10;
if (d10?.status !== 'enforced') failures.push(`D10: expected enforced, got ${JSON.stringify(d10)}`);
for (const [gate, entry] of Object.entries(manifest.gates ?? {})) {
  if (entry?.status !== 'enforced') continue;
  if (typeof entry?.enforced_by?.job !== 'string' || entry.enforced_by.job.length === 0) {
    failures.push(
      `${gate}: expected enforced_by.job non-empty, got ${JSON.stringify(entry?.enforced_by)}`,
    );
  }
  if (!Array.isArray(entry?.enforced_by?.evidence) || entry.enforced_by.evidence.length === 0) {
    failures.push(
      `${gate}: expected enforced_by.evidence non-empty array, got ${JSON.stringify(entry?.enforced_by)}`,
    );
  }
}

if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log('gate manifest ok');
