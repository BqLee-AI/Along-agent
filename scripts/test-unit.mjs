#!/usr/bin/env bun
// 独立 CLI 总是先构建；只有 verify 可传入本次成功 typecheck 的内存状态。
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// 双引号兼容 cmd 与 POSIX shell，避免单引号成为 Windows 下的 glob 字节。
const UNIT_COMMAND =
  'bun test --parallel=4 --path-ignore-patterns "**/test/{integration,contracts}/**" ./apps ./packages ./scripts/test';

export function runUnit({ packagesPrepared = false } = {}) {
  const options = { cwd: process.cwd(), stdio: 'inherit', shell: true };
  if (!packagesPrepared) {
    const preparation = spawnSync('bun run build:packages', options);
    if (preparation.status !== 0) return preparation;
  }
  return spawnSync(UNIT_COMMAND, options);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(runUnit().status ?? 1);
}
