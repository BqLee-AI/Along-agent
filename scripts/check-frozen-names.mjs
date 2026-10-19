#!/usr/bin/env node
// Frozen-name check: banned S0 aliases must not appear in shipped code (S0 #14 frozen).
// Scans src + tests only: fixtures under scripts/fixtures intentionally contain
// banned strings so their negative tests can assert the scanner catches them.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2] ?? process.cwd();
const banned = ["outbox_events", "schedule_confirmed", "SERVICE_NOT_READY", "C-XXXX"];
const scanRoots = ["apps", "packages", "infra"];
const failures = [];

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const rel = full.slice(root.length + 1);
    if (name === "node_modules" || name === "dist" || name === "coverage" || name === ".turbo") continue;
    // Rejection tests legitimately name banned words to assert they are refused.
    if (name === "test" || name === "__tests__" || /\.test\.[jt]sx?$/.test(name)) continue;
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(full);
    } else if (/\.(ts|js|mjs|cjs|json|sql|yaml|yml)$/.test(name)) {
      const text = readFileSync(full, "utf8");
      for (const word of banned) {
        if (text.includes(word)) failures.push(`${rel}: banned name ${word}`);
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
for (const scanRoot of existing.length > 0 ? existing : ["."]) {
  walk(scanRoot === "." ? root : join(root, scanRoot));
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log("frozen names ok");
