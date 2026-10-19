#!/usr/bin/env node
// Copy-claim scan: user-facing copy must never promise delivery (D10 ceiling).
// Scans shipped dirs only; scripts/fixtures intentionally contain banned claims
// so their negative tests can assert the scanner catches them.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = process.argv[2] ?? process.cwd();
const banned = ['一定响', '必达', '已读', '保证送达'];
const negations = ['不承诺', '不保证', '不意味', '并非', '不声称'];
const scanRoots = ['apps', 'packages', 'infra'];
const scanExts = /\.(ts|tsx|js|jsx|md|json)$/;

const failures = [];

function isNegated(text, index, wordLen) {
  const window = text.slice(Math.max(0, index - 12), index + wordLen + 2);
  return negations.some((neg) => window.includes(neg));
}

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const rel = full.slice(root.length + 1);
    if (
      name === 'node_modules' ||
      name === 'dist' ||
      name === 'coverage' ||
      name === '.turbo' ||
      name === '.next'
    )
      continue;
    // Rejection tests legitimately contain banned claims to assert they are caught.
    if (name === 'test' || name === '__tests__' || /\.test\.[jt]sx?$/.test(name)) continue;
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(full);
    } else if (scanExts.test(name)) {
      const text = readFileSync(full, 'utf8');
      for (const word of banned) {
        let from = 0;
        for (;;) {
          const index = text.indexOf(word, from);
          if (index === -1) break;
          if (!isNegated(text, index, word.length)) {
            failures.push(`${rel}: banned copy claim ${word}`);
            break;
          }
          from = index + word.length;
        }
      }
    }
  }
}

const existing = scanRoots.filter((scanRoot) => {
  try {
    return statSync(join(root, scanRoot)).isDirectory();
  } catch {
    return false;
  }
});
// Fixture-only targets (negative tests) have no shipped dirs: scan the target itself.
for (const scanRoot of existing.length > 0 ? existing : ['.']) {
  walk(scanRoot === '.' ? root : join(root, scanRoot));
}

if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log('copy claims ok');
