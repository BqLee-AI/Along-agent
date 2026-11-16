#!/usr/bin/env bun
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const unit = [
  'test',
  '--parallel=4',
  '--path-ignore-patterns',
  '**/test/{integration,contracts}/**',
];
const workspace = (name, script) => ['run', '--bun', '--filter', `@along/${name}`, script];
const lint = (path) => ['x', '--no-install', 'oxlint', path];
// Keep outgoing boundary edges visible, but never traverse another lane's consumers.
// --include-only would hide illegal Web → API imports instead of validating them.
const boundaries = (paths, owned) => [
  'node_modules/dependency-cruiser/bin/dependency-cruiser.mjs',
  '--config',
  '.dependency-cruiser.cjs',
  '--do-not-follow',
  `node_modules|^(?!${owned})`,
  ...paths,
];

const lanes = {
  docs: [
    ['scripts/scan-copy-claims.mjs'],
    ['x', '--bun', '--no-install', 'openspec', 'validate', '--all', '--strict'],
    ['run', 'format:check'],
  ],
  web: [
    workspace('contracts', 'build'),
    workspace('stream-protocol', 'build'),
    lint('apps/web'),
    workspace('web', 'typecheck'),
    [...unit, './apps/web'],
    boundaries(['apps/web'], 'apps/web/'),
    workspace('web', 'build'),
  ],
  api: [
    ['run', 'build:packages'],
    lint('apps/api'),
    workspace('api', 'typecheck'),
    [...unit, './apps/api'],
    boundaries(['apps/api', 'packages'], '(?:apps/api/|packages/)'),
  ],
  packages: [
    ['run', 'build:packages'],
    lint('packages'),
    ['run', '--bun', '--sequential', '--filter', './packages/*', 'typecheck'],
    [...unit, './packages'],
    boundaries(['packages'], 'packages/'),
  ],
  tooling: [
    ['run', 'build:packages'],
    lint('scripts'),
    [...unit, './scripts/test'],
    ['scripts/check-gate-manifest.mjs'],
    ['scripts/check-gates-executable.mjs'],
    ['scripts/check-frozen-names.mjs'],
  ],
  // Harness has no TS workspace/typecheck or non-contract unit tests today.
  // Native contracts belong to runtime CI; embedding is an independent Python service.
  harness: [lint('apps/harness'), boundaries(['apps/harness'], 'apps/harness/')],
};

const [lane, ...extra] = process.argv.slice(2);
if (extra.length || !Object.hasOwn(lanes, lane)) {
  console.error(`Usage: bun scripts/ci/checks.mjs <${Object.keys(lanes).join('|')}>`);
  process.exit(1);
}

const env = { ...process.env, OPENSPEC_TELEMETRY: '0' };
// Tooling's database helpers must skip even on a developer host with a database URL.
if (lane === 'tooling') delete env.DATABASE_URL;
for (const args of lanes[lane]) {
  console.log(`\n[checks:${lane}] bun ${args.join(' ')}`);
  const result = spawnSync('bun', ['--no-env-file', ...args], {
    cwd: root,
    env,
    stdio: 'inherit',
  });
  if (result.error) console.error(result.error.message);
  if (result.status !== 0) process.exit(result.status ?? 1);
}
