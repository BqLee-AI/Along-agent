#!/usr/bin/env bun
// 一键 verify：按固定顺序串行跑完全部门禁，任一失败即停并报步名。
// 用法：bun scripts/verify.mjs [--skip <step...>]；也兼容 node 调用。
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();

// ---- 参数：--skip <step...>（只消费 --skip 之后、下一个 --flag 之前的词） ----
const skip = new Set();
{
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--skip');
  if (i !== -1) {
    for (const token of argv.slice(i + 1)) {
      if (token.startsWith('--')) break;
      skip.add(token);
    }
  }
}

const STEPS = [
  { name: 'lint', run: 'bun run lint' },
  { name: 'typecheck', run: 'bun run typecheck' },
  { name: 'depcruise', run: 'bun run depcruise' },
  { name: 'gate-manifest', run: 'bun scripts/check-gate-manifest.mjs' },
  { name: 'gates-executable', run: 'bun scripts/check-gates-executable.mjs' },
  { name: 'frozen-names', run: 'bun scripts/check-frozen-names.mjs' },
  { name: 'copy-claims', run: 'bun scripts/scan-copy-claims.mjs' },
  { name: 'unit', run: 'bun run test:unit' },
  { name: 'openspec', run: 'bunx --bun --no-install openspec validate --all --strict' },
  { name: 'format:check', run: 'bun run format:check' },
];

function hasActiveChanges() {
  let entries;
  try {
    entries = readdirSync(join(ROOT, 'openspec', 'changes'));
  } catch {
    return false;
  }
  return entries.some((e) => e !== 'archive' && e !== '.gitkeep' && !e.startsWith('.'));
}

let ran = 0;
let failed = null;
for (const step of STEPS) {
  if (skip.has(step.name)) {
    console.log(`\n[verify] 跳过：${step.name}（--skip 指定）`);
    continue;
  }
  if (step.name === 'openspec' && !hasActiveChanges()) {
    console.log(
      '\n[verify] 跳过：openspec（openspec/changes 下无 active change；有 change 时再跑 `bunx --bun --no-install openspec validate --all --strict`）',
    );
    continue;
  }
  console.log(`\n[verify] 开始：${step.name}：${step.run}`);
  const res = spawnSync(step.run, { cwd: ROOT, stdio: 'inherit', shell: true });
  if (res.status !== 0) {
    failed = { name: step.name, code: res.status ?? 1 };
    break;
  }
  ran++;
}

if (failed) {
  console.error(`\n[verify] 失败：${failed.name}（exit ${failed.code}），已中止后续步骤`);
  process.exit(failed.code);
}
const skipped = [...skip].join(', ');
console.log(`\n[verify] 全部通过（跑了 ${ran} 步${skipped ? `，跳过 ${skipped}` : ''}）`);
