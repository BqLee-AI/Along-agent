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
    JSON.stringify(base === null ? {} : { pull_request: { base: { sha: base } } }),
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

  it('uses full for a deletion even when all paths are documentation', () =>
    fixture((repo, base) => {
      git(repo, 'rm', 'docs/old.md');
      git(repo, 'commit', '-qm', 'delete');
      expect(select(repo, base)).toBe('scope=full');
    }));

  it('uses full for a rename even when both paths are documentation', () =>
    fixture((repo, base) => {
      git(repo, 'mv', 'docs/rename.md', 'docs/renamed.md');
      git(repo, 'commit', '-qm', 'rename');
      expect(select(repo, base)).toBe('scope=full');
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

  it('uses full for empty diffs, missing or unavailable bases, and non-PR events', () =>
    fixture((repo, base) => {
      expect(select(repo, base)).toBe('scope=full');
      commitFiles(repo, ['docs/new.md']);
      expect(select(repo, null)).toBe('scope=full');
      expect(select(repo, 'a'.repeat(40))).toBe('scope=full');
      expect(select(repo, base, 'push')).toBe('scope=full');
    }));
});
