import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
let target: string;

beforeAll(() => {
  target = mkdtempSync(join(tmpdir(), 'along-lint-'));
  cpSync(join(root, 'scripts/fixtures/lint'), target, { recursive: true });
  for (const group of ['red', 'green', 'policy', 'architecture-red']) {
    const cwd = join(target, group);
    cpSync(join(root, '.oxlintrc.json'), join(cwd, '.oxlintrc.json'));
    mkdirSync(join(cwd, 'scripts'));
    cpSync(join(root, 'scripts/lint-rules.mjs'), join(cwd, 'scripts/lint-rules.mjs'));
  }
  for (const ignored of ['dist', 'node_modules', 'coverage', '.next']) {
    const dir = join(target, 'green/apps/web', ignored);
    mkdirSync(dir, { recursive: true });
    cpSync(join(root, 'scripts/fixtures/lint/red/apps/web/bad.ts'), join(dir, 'ignored.ts'));
  }
});

afterAll(() => {
  if (target) rmSync(target, { recursive: true, force: true });
});

function lint(group: string) {
  const result = spawnSync(
    process.execPath,
    [join(root, 'node_modules/oxlint/bin/oxlint'), '--format', 'json', '.'],
    { cwd: join(target, group), encoding: 'utf8' },
  );
  if (result.error) throw result.error;
  const report = JSON.parse(result.stdout) as {
    diagnostics: { code: string; severity: string; filename: string }[];
  };
  return { code: result.status, errors: report.diagnostics.filter((d) => d.severity === 'error') };
}

describe('lint policy with the real Oxlint CLI', () => {
  it('rejects both frozen clock selectors in TS, TSX, JS, JSX and nested/shadow/optional forms', () => {
    const result = lint('red');
    expect(result.code).toBe(1);
    expect(result.errors).toHaveLength(17);
    expect(result.errors.every((d) => d.code.includes('no-web-time'))).toBe(true);
    expect([...new Set(result.errors.map((d) => d.filename))].sort()).toEqual([
      'apps/web/bad.js',
      'apps/web/bad.jsx',
      'apps/web/bad.ts',
      'apps/web/bad.tsx',
      'apps/web/nested/edges.ts',
    ]);
  });

  it('keeps directive prologues, exact selector exceptions and non-display directories legal', () => {
    const result = lint('green');
    expect(result.code).toBe(0);
    expect(result.errors).toEqual([]);
  });

  it('rejects direct and global fetch calls only inside feature views, including nested files', () => {
    const result = lint('architecture-red');
    expect(result.code).toBe(1);
    expect(result.errors).toHaveLength(19);
    expect(result.errors.every((d) => d.code.includes('no-feature-view-fetch'))).toBe(true);
    expect([...new Set(result.errors.map((d) => d.filename))].sort()).toEqual([
      'apps/web/src/features/tasks/view/bad.js',
      'apps/web/src/features/tasks/view/bad.jsx',
      'apps/web/src/features/tasks/view/bad.ts',
      'apps/web/src/features/tasks/view/bad.tsx',
      'apps/web/src/features/tasks/view/nested/edges.ts',
    ]);
  });

  it('still rejects explicit any, unused underscore/type-only values and unused expressions', () => {
    const result = lint('policy');
    expect(result.code).toBe(1);
    expect(result.errors.filter((d) => d.code.includes('no-unused-vars'))).toHaveLength(3);
    expect(result.errors.some((d) => d.code.includes('no-explicit-any'))).toBe(true);
    expect(result.errors.some((d) => d.code.includes('no-unused-expressions'))).toBe(true);
  });
});
