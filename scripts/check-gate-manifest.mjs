#!/usr/bin/env node
// Gate-manifest check: D9 enforced (#8 owner), D3-D6 enforced, never silently skipped.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2] ?? process.cwd();
const manifest = JSON.parse(readFileSync(join(root, "ci/gates.json"), "utf8"));

const failures = [];
for (const gate of ["D3", "D4", "D5", "D6", "D9"]) {
  const entry = manifest.gates?.[gate];
  const owner = gate === "D9" ? "#8" : "#7";
  if (entry?.status !== "enforced" || entry?.owner !== owner || typeof entry?.scope !== "string" || entry.scope.length === 0) {
    failures.push(`${gate}: expected {status: enforced, owner: ${owner}, scope: non-empty}, got ${JSON.stringify(entry)}`);
  }
}
const d1 = manifest.gates?.D1;
if (d1?.status !== "enforced") failures.push(`D1: expected enforced, got ${JSON.stringify(d1)}`);
const d2 = manifest.gates?.D2;
if (d2?.status !== "enforced" || d2?.owner !== "#10" || typeof d2?.scope !== "string" || d2.scope.length === 0) {
  failures.push(`D2: expected {status: enforced, owner: #10, scope: non-empty}, got ${JSON.stringify(d2)}`);
}
const d7 = manifest.gates?.D7;
if (d7?.status !== "enforced") failures.push(`D7: expected enforced, got ${JSON.stringify(d7)}`);
const d8 = manifest.gates?.D8;
if (d8?.status !== "partial") failures.push(`D8: expected partial, got ${JSON.stringify(d8)}`);
const d10 = manifest.gates?.D10;
if (d10?.status !== "enforced") failures.push(`D10: expected enforced, got ${JSON.stringify(d10)}`);

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log("gate manifest ok");
