import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { execFile } from 'node:child_process';
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
// Queue time counts towards Bun's per-test timeout; only this isolated file is concurrent.
setDefaultTimeout(30_000);
const cruises = [Promise.resolve(), Promise.resolve()];
let nextCruise = 0;
let closing = false;

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

afterAll(async () => {
  closing = true;
  // Drain every queued/started CLI before removing the shared, read-only fixture.
  await Promise.all(cruises);
  if (target) rmSync(target, { recursive: true, force: true });
});

function cruise(entry: string, reporter = 'err'): Promise<{ code: number; output: string }> {
  if (closing) return Promise.reject(new Error('Boundary fixture is closing'));
  const args = [
    join(root, 'node_modules', 'dependency-cruiser', 'bin', 'dependency-cruiser.mjs'),
    '--config',
    join(root, '.dependency-cruiser.cjs'),
    '--output-type',
    reporter,
    entry,
  ];
  const slot = nextCruise++ % cruises.length;
  const result = cruises[slot]!.then(
    () =>
      new Promise<{ code: number; output: string }>((resolve, reject) => {
        execFile(
          process.execPath,
          args,
          {
            cwd: target,
            encoding: 'utf8',
            env: { ...process.env, NO_COLOR: '1' },
          },
          (error, stdout, stderr) => {
            // Spawn, signal and buffer errors must fail the test, not look like a rule rejection.
            if (error && (typeof error.code !== 'number' || error.signal)) {
              reject(error);
            } else {
              resolve({ code: error?.code ?? 0, output: `${stdout}${stderr}` });
            }
          },
        );
      }),
  );
  // A failed CLI still releases its slot; retain its rejection for the calling test.
  cruises[slot] = result.then(
    () => {},
    () => {},
  );
  return result;
}

async function expectRed(entry: string, rule: string) {
  const result = await cruise(entry);
  expect(result.code, result.output).toBe(1);
  expect(result.output).toContain(`error ${rule}: ${entry} → `);
  // Local fixture imports use .js specifiers: a resolved .ts target proves real resolution.
  // The remaining cases resolve to the installed TypeScript package or a Node builtin.
  expect(result.output).toMatch(
    /→ (?:[^\s]+\.ts|fs|[^\s]*node_modules\/typescript\/[^\s]+\.js)(?:\s|$)/,
  );
  console.info(`[red] exit=${result.code}${result.output}`);
}

describe.concurrent('D1 dependency boundaries (real depcruise)', () => {
  it('allows own storage, public calls, confirm→cancel, HTTP and declared package dependencies', async () => {
    const result = await cruise('green.ts');
    expect(result.code, result.output).toBe(0);
    const report = JSON.parse((await cruise('green.ts', 'json')).output);
    expect(report.summary.violations).toEqual([]);
    expect(
      report.modules.flatMap((module: { dependencies: { couldNotResolve?: boolean }[] }) =>
        module.dependencies.filter((dependency) => dependency.couldNotResolve),
      ),
    ).toEqual([]);
  });

  it.each(modules)(
    'rejects %s crossing into another module’s storage, including type imports',
    async (module) => {
      await expectRed(`apps/api/src/modules/${module}/bad.ts`, `no-${module}-cross-module-storage`);
    },
  );

  it.each(Array.from({ length: 12 }, (_, index) => index))(
    'rejects storage file/directory/suffix and nested type-import shape %i',
    async (index) => {
      await expectRed(
        `apps/api/src/modules/identity/shapes/bad-${index}.ts`,
        'no-identity-cross-module-storage',
      );
    },
  );

  it.each(['bad.ts', 'bad-type.ts'])('rejects Web→API %s', async (entry) => {
    await expectRed(`apps/web/${entry}`, 'no-web-to-api');
  });

  it.each(
    packages.flatMap(([name, rule]) =>
      ['workspace', 'app', 'builtin', 'external'].map((kind) => ({ name, rule, kind })),
    ),
  )('rejects $name → undeclared $kind dependency', async ({ name, rule, kind }) => {
    await expectRed(`packages/${name}/src/bad-${kind}.ts`, rule);
  });
});
