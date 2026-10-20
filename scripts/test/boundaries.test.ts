import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const modules = [
  'identity',
  'brief',
  'notifications',
  'conversations',
  'tasks',
  'tools',
  'approvals',
  'future-module',
];
const packages = [
  ['time-core', 'time-core-zero-egress'],
  ['contracts', 'contracts-zod-only'],
  ['scheduler-core', 'scheduler-core-dependencies'],
  ['notifier-core', 'notifier-core-dependencies'],
  ['stream-protocol', 'stream-protocol-zod-only'],
];
let target: string;

beforeAll(() => {
  target = mkdtempSync(join(tmpdir(), 'along-boundaries-'));
  cpSync(join(root, 'scripts', 'fixtures', 'boundaries'), target, { recursive: true });
  mkdirSync(join(target, 'node_modules'));
  // Resolve installed dependencies, not fake modules: the fixture runs outside the workspace.
  const contractsRequire = createRequire(join(root, 'packages', 'contracts', 'package.json'));
  const rootRequire = createRequire(join(root, 'package.json'));
  for (const [name, require] of [
    ['zod', contractsRequire],
    ['typescript', rootRequire],
  ] as const) {
    symlinkSync(
      dirname(require.resolve(`${name}/package.json`)),
      join(target, 'node_modules', name),
      'junction',
    );
  }
});

afterAll(() => {
  if (target) rmSync(target, { recursive: true, force: true });
});

function cruise(entry: string, reporter = 'err'): { code: number; output: string } {
  const args = [
    join(root, 'node_modules', 'dependency-cruiser', 'bin', 'dependency-cruiser.mjs'),
    '--config',
    join(root, '.dependency-cruiser.cjs'),
    '--output-type',
    reporter,
    entry,
  ];
  try {
    return {
      code: 0,
      output: execFileSync(process.execPath, args, {
        cwd: target,
        encoding: 'utf8',
        env: { ...process.env, NO_COLOR: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    };
  } catch (error) {
    const err = error as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? -1, output: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

function expectRed(entry: string, rule: string) {
  const result = cruise(entry);
  expect(result.code, result.output).toBe(1);
  expect(result.output).toContain(`error ${rule}: ${entry} → `);
  // Local fixture imports use .js specifiers: a resolved .ts target proves real resolution.
  // The remaining cases resolve to the installed TypeScript package or a Node builtin.
  expect(result.output).toMatch(
    /→ (?:[^\s]+\.ts|fs|[^\s]*node_modules\/typescript\/[^\s]+\.js)(?:\s|$)/,
  );
  console.info(`[red] exit=${result.code}${result.output}`);
}

describe('D1 dependency boundaries (real depcruise)', () => {
  it('allows own storage, public calls, confirm→cancel, HTTP and declared package dependencies', () => {
    const result = cruise('green.ts');
    expect(result.code, result.output).toBe(0);
    const report = JSON.parse(cruise('green.ts', 'json').output);
    expect(report.summary.violations).toEqual([]);
    expect(
      report.modules.flatMap((module: { dependencies: { couldNotResolve?: boolean }[] }) =>
        module.dependencies.filter((dependency) => dependency.couldNotResolve),
      ),
    ).toEqual([]);
  });

  it.each(modules)(
    'rejects %s crossing into another module’s storage, including type imports',
    (module) => {
      expectRed(`apps/api/src/modules/${module}/bad.ts`, `no-${module}-cross-module-storage`);
    },
  );

  it.each(Array.from({ length: 12 }, (_, index) => index))(
    'rejects storage file/directory/suffix and nested type-import shape %i',
    (index) => {
      expectRed(
        `apps/api/src/modules/identity/shapes/bad-${index}.ts`,
        'no-identity-cross-module-storage',
      );
    },
  );

  it.each(['bad.ts', 'bad-type.ts'])('rejects Web→API %s', (entry) => {
    expectRed(`apps/web/${entry}`, 'no-web-to-api');
  });

  it.each(
    packages.flatMap(([name, rule]) =>
      ['workspace', 'app', 'builtin', 'external'].map((kind) => ({ name, rule, kind })),
    ),
  )('rejects $name → undeclared $kind dependency', ({ name, rule, kind }) => {
    expectRed(`packages/${name}/src/bad-${kind}.ts`, rule);
  });
});
