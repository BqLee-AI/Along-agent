#!/usr/bin/env node
// Gates-executable check: every enforced gate must bind to a CI job and existing evidence files.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertD8Report } from './d8-contracts.mjs';

const root = process.argv[2] ?? process.cwd();
const manifest = JSON.parse(readFileSync(join(root, 'ci/gates.json'), 'utf8'));
const ci = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');

const failures = [];
let enforced = 0;
for (const [gate, entry] of Object.entries(manifest.gates ?? {})) {
  if (entry?.status !== 'enforced') continue;
  enforced++;
  const job = entry?.enforced_by?.job;
  if (typeof job !== 'string' || job.length === 0 || !ci.match(new RegExp(`^  ${job}:`, 'm'))) {
    failures.push(`${gate}: 缺 job ${job ?? '(empty)'}`);
  }
  const evidence = entry?.enforced_by?.evidence;
  if (!Array.isArray(evidence)) {
    failures.push(`${gate}: 缺 evidence 数组`);
    continue;
  }
  for (const file of evidence) {
    if (typeof file !== 'string' || !existsSync(join(root, file))) {
      failures.push(`${gate}: 缺文件 ${file}`);
    }
  }
}

// Optional runtime evidence is consumed by the same root contracts entrypoint.
// static calls this without a report and only checks declaration locations.
if (process.argv[3] !== undefined) {
  try {
    const ids = assertD8Report(readFileSync(process.argv[3], 'utf8'), manifest.gates?.D8);
    console.log(`D8 current report verified: ${ids.join(', ')}`);
  } catch (error) {
    failures.push(`D8: ${error.message}`);
  }
}

if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log(`gates executable ok (${enforced} gates)`);
