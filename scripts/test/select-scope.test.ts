import { describe, expect, it } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'ci', 'select-scope.mjs');

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function fixture(run: (repo: string, base: string) => void): void {
  const repo = mkdtempSync(join(tmpdir(), 'along-ci-scope-'));
  try {
    git(repo, 'init', '-q');
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'user.name', 'CI Test');
    for (const path of ['docs/old.md', 'docs/rename.md', 'apps/web/src/existing.ts']) {
      mkdirSync(dirname(join(repo, path)), { recursive: true });
      writeFileSync(join(repo, path), 'original\n');
    }
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'base');
    run(repo, git(repo, 'rev-parse', 'HEAD'));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

function commitFiles(repo: string, paths: string[]): void {
  for (const path of paths) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), 'changed\n');
  }
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'change');
}

function select(repo: string, base: string | null, event = 'pull_request'): string {
  const eventPath = join(repo, 'event.json');
  const outputPath = join(repo, 'output.txt');
  writeFileSync(
    eventPath,
    JSON.stringify(
      base === null
        ? {}
        : event === 'push'
          ? { before: base }
          : { pull_request: { base: { sha: base } } },
    ),
  );
  writeFileSync(outputPath, '');
  const result = spawnSync('node', [script], {
    cwd: repo,
    encoding: 'utf8',
    env: {
      ...process.env,
      GITHUB_EVENT_NAME: event,
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_OUTPUT: outputPath,
    },
  });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('scope');
  return readFileSync(outputPath, 'utf8').trim();
}

describe('CI scope selector', () => {
  for (const path of [
    'docs/guide.md',
    'docs/nested/guide.mdx',
    'openspec/changes/a.md',
    'README.md',
    'CONTRIBUTING.md',
    ...(process.platform === 'win32' ? [] : ['docs/space and\nnewline.md']),
  ]) {
    it(`classifies documentation ${JSON.stringify(path)}`, () =>
      fixture((repo, base) => {
        commitFiles(repo, [path]);
        expect(select(repo, base)).toBe('scope=docs');
      }));
  }

  it('classifies modified documentation and web files', () =>
    fixture((repo, base) => {
      commitFiles(repo, ['docs/old.md', 'apps/web/src/existing.ts']);
      expect(select(repo, base)).toBe('scope=web');
    }));

  for (const paths of [
    ['apps/web/src/page.tsx'],
    ['apps/web/test/view.test.ts'],
    ['docs/a.md', 'apps/web/src/a.ts'],
  ]) {
    it(`classifies web changes ${JSON.stringify(paths)}`, () =>
      fixture((repo, base) => {
        commitFiles(repo, paths);
        expect(select(repo, base)).toBe('scope=web');
      }));
  }

  it('skips historical upgrades for isolated non-identity API module changes', () =>
    fixture((repo, base) => {
      commitFiles(repo, ['apps/api/src/modules/tasks/service.ts', 'docs/a.md']);
      expect(select(repo, base)).toBe('scope=api');
    }));

  it('selects changed database integration tests without unrelated test files', () =>
    fixture((repo, base) => {
      commitFiles(repo, [
        'apps/api/test/integration/tasks-read.test.ts',
        'apps/api/test/integration/identity-rate-limit.test.ts',
      ]);
      expect(select(repo, base)).toBe(
        'scope=api-tests\napi_tests=apps/api/test/integration/identity-rate-limit.test.ts apps/api/test/integration/tasks-read.test.ts',
      );
    }));

  it('runs all API tests when a module and its tests change together', () =>
    fixture((repo, base) => {
      commitFiles(repo, [
        'apps/api/src/modules/tasks/service.ts',
        'apps/api/test/integration/tasks-read.test.ts',
      ]);
      expect(select(repo, base)).toBe('scope=api');
    }));

  it('falls back to full for mixed web and API changes', () =>
    fixture((repo, base) => {
      commitFiles(repo, ['apps/web/src/page.tsx', 'apps/api/src/modules/tasks/service.ts']);
      expect(select(repo, base)).toBe('scope=full');
    }));

  for (const path of [
    'apps/api/src/modules/identity/better-auth.ts',
    'apps/api/src/db/pool.ts',
    'infra/migrations/0028.sql',
    'scripts/local/database.mjs',
    'apps/api/test/integration/setup.ts',
    'apps/api/test/integration/harness-native.test.ts',
    'apps/api/test/integration/memory-native-wiring.test.ts',
    'apps/api/test/integration/pause-http.test.ts',
    'apps/api/test/integration/r3-compact-http.test.ts',
    'apps/api/test/integration/server-owned-native.test.ts',
    'apps/api/test/integration/server-owned-resume-race.test.ts',
    'apps/api/test/integration/server-owned-driver-effect-race.test.ts',
    'apps/api/src/modules/new-module/service.ts',
    'apps/api/src/modules/tasks/data.json',
    'apps/api/test/integration/fixtures/input.ts',
    ...(process.platform === 'win32'
      ? []
      : ['apps/api/test/integration/unsafe.test.ts\n', 'apps/api/src/modules/tasks/service.ts\n']),
  ]) {
    it(`keeps the full suite for shared or native input ${path}`, () =>
      fixture((repo, base) => {
        commitFiles(repo, [path]);
        expect(select(repo, base)).toBe('scope=full');
      }));
  }

  for (const path of [
    'docs/image.png',
    'openspec/config.yaml',
    'docs-notes.md',
    'apps/web/package.json',
    'apps/web/src-other/a.ts',
    'scripts/check.mjs',
    'SECURITY.md',
  ]) {
    it(`classifies other changes ${path} as full`, () =>
      fixture((repo, base) => {
        commitFiles(repo, [path]);
        expect(select(repo, base)).toBe('scope=full');
      }));
  }

  it('keeps documentation deletions in the documentation scope', () =>
    fixture((repo, base) => {
      git(repo, 'rm', 'docs/old.md');
      git(repo, 'commit', '-qm', 'delete');
      expect(select(repo, base)).toBe('scope=docs');
    }));

  it('checks both sides of documentation renames', () =>
    fixture((repo, base) => {
      git(repo, 'mv', 'docs/rename.md', 'docs/renamed.md');
      git(repo, 'commit', '-qm', 'rename');
      expect(select(repo, base)).toBe('scope=docs');
    }));

  it('does not classify a deleted Web source as documentation', () =>
    fixture((repo, base) => {
      git(repo, 'rm', 'apps/web/src/existing.ts');
      commitFiles(repo, ['docs/new.md']);
      expect(select(repo, base)).toBe('scope=full');
    }));

  it('selects documentation on main but keeps code pushes full', () =>
    fixture((repo, base) => {
      commitFiles(repo, ['docs/new.md']);
      expect(select(repo, base, 'push')).toBe('scope=docs');
      commitFiles(repo, ['apps/web/src/existing.ts']);
      expect(select(repo, base, 'push')).toBe('scope=full');
    }));

  it('does not narrow a push with an unavailable before commit', () =>
    fixture((repo) => {
      expect(select(repo, '0'.repeat(40), 'push')).toBe('scope=full');
    }));

  it('uses full when a web change is mixed with an unrelated file', () =>
    fixture((repo, base) => {
      commitFiles(repo, ['apps/web/src/page.tsx', 'apps/api/src/change.ts']);
      expect(select(repo, base)).toBe('scope=full');
    }));

  it('fetches an absent base from origin before classifying the diff', () =>
    fixture((repo, base) => {
      commitFiles(repo, ['docs/new.md']);
      const parent = mkdtempSync(join(tmpdir(), 'along-ci-clone-'));
      const clone = join(parent, 'clone');
      try {
        git(repo, 'clone', '-q', '--depth=1', pathToFileURL(repo).href, clone);
        expect(
          spawnSync('git', ['cat-file', '-e', `${base}^{commit}`], { cwd: clone }).status,
        ).not.toBe(0);
        expect(select(clone, base)).toBe('scope=docs');
      } finally {
        rmSync(parent, { recursive: true, force: true });
      }
    }));

  it('uses full for empty diffs, missing bases, and unsupported events', () =>
    fixture((repo, base) => {
      expect(select(repo, base)).toBe('scope=full');
      commitFiles(repo, ['docs/new.md']);
      expect(select(repo, null)).toBe('scope=full');
      expect(select(repo, 'a'.repeat(40))).toBe('scope=full');
      expect(select(repo, base, 'workflow_dispatch')).toBe('scope=full');
    }));
});
