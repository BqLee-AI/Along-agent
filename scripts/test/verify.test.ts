import { afterEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const scripts = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts as Record<
  string,
  string
>;
const typescript = createRequire(import.meta.url).resolve('typescript/bin/tsc');
const targets: string[] = [];
const consumers = [
  {
    path: 'apps/consumer.test.ts',
    import: '../packages/prepared/dist/index.js',
    name: 'apps',
    value: 21,
  },
  {
    path: 'packages/prepared/test/consumer.test.ts',
    import: '../dist/index.js',
    name: 'packages',
    value: 22,
  },
  {
    path: 'scripts/test/consumer.test.ts',
    import: '../../packages/prepared/dist/index.js',
    name: 'scripts',
    value: 23,
  },
];
const otherSteps = [
  'lint',
  'depcruise',
  'gate-manifest',
  'gates-executable',
  'frozen-names',
  'copy-claims',
  'openspec',
  'format:check',
];

afterEach(() => {
  for (const target of targets.splice(0)) {
    rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

function fixture({ buildFails = false, typecheckFails = false } = {}) {
  const target = mkdtempSync(join(tmpdir(), 'along-verify-'));
  targets.push(target);
  function put(path: string, content: string) {
    const file = join(target, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  put(
    'package.json',
    JSON.stringify({
      private: true,
      type: 'module',
      workspaces: ['packages/*'],
      scripts: {
        'build:packages': scripts['build:packages'],
        typecheck: scripts.typecheck,
        'test:unit': scripts['test:unit'],
      },
    }),
  );
  mkdirSync(join(target, 'scripts'), { recursive: true });
  for (const file of ['verify.mjs', 'test-unit.mjs']) {
    cpSync(join(root, 'scripts', file), join(target, 'scripts', file));
  }
  put(
    'packages/prepared/package.json',
    JSON.stringify({
      name: '@verify-fixture/prepared',
      private: true,
      type: 'module',
      scripts: {
        build: 'bun measure-build.mjs && bun build src/index.ts --outdir dist --target bun',
        typecheck: `bun "${typescript}" --noEmit --strict --target es2022 --module esnext --moduleResolution bundler src/check.ts`,
      },
    }),
  );
  // Count real build attempts, not a substitute for building or consuming the resulting module.
  put(
    'packages/prepared/measure-build.mjs',
    `import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const file = new URL('./build-attempts.json', import.meta.url);
const count = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : 0;
writeFileSync(file, JSON.stringify(count + 1));
`,
  );
  put(
    'packages/prepared/src/index.ts',
    buildFails
      ? 'export const double = (value: number) => ;'
      : 'export const double = (value: number): number => value * 2;',
  );
  put(
    'packages/prepared/src/check.ts',
    `import { double } from './index';
const result: ${typecheckFails ? 'string' : 'number'} = double(21);
export { result };
`,
  );
  for (const consumer of consumers) {
    put(
      consumer.path,
      `import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { double } from '${consumer.import}';
test('consumes the built package from ${consumer.name}', () => {
  const result = double(${consumer.value});
  expect(result).toBe(${consumer.value * 2});
  writeFileSync('consumed-${consumer.name}.json', JSON.stringify(result));
});
`,
    );
  }
  put(
    'apps/test/integration/excluded.test.ts',
    "throw new Error('The integration suite is not part of unit execution');",
  );
  return target;
}

function run(target: string, args: string[]) {
  const result = spawnSync(process.execPath, args, {
    cwd: target,
    encoding: 'utf8',
    timeout: 20_000,
    env: { ...process.env, NO_COLOR: '1' },
  });
  if (result.error) throw result.error;
  return { code: result.status, output: `${result.stdout}${result.stderr}` };
}

function verify(target: string, skipTypecheck = false) {
  return run(target, [
    'scripts/verify.mjs',
    '--skip',
    ...otherSteps,
    ...(skipTypecheck ? ['typecheck'] : []),
  ]);
}

function attempts(target: string) {
  return JSON.parse(readFileSync(join(target, 'packages/prepared/build-attempts.json'), 'utf8'));
}

function expectConsumed(target: string) {
  for (const consumer of consumers) {
    expect(JSON.parse(readFileSync(join(target, `consumed-${consumer.name}.json`), 'utf8'))).toBe(
      consumer.value * 2,
    );
  }
}

function expectNotConsumed(target: string) {
  for (const consumer of consumers) {
    expect(existsSync(join(target, `consumed-${consumer.name}.json`))).toBe(false);
  }
}

describe('package preparation through real Bun builds and unit consumers', () => {
  it('builds missing packages before standalone unit consumes all three discovery roots', () => {
    const target = fixture();
    expect(existsSync(join(target, 'packages/prepared/dist'))).toBe(false);
    const result = run(target, ['run', 'test:unit']);
    expect(result.code, result.output).toBe(0);
    expect(attempts(target)).toBe(1);
    expectConsumed(target);
  }, 30_000);

  it('reuses the successful typecheck preparation in the same verify invocation', () => {
    const target = fixture();
    const result = verify(target);
    expect(result.code, result.output).toBe(0);
    expect(attempts(target)).toBe(1);
    expectConsumed(target);
  }, 30_000);

  it('builds missing packages when verify skips typecheck', () => {
    const target = fixture();
    const result = verify(target, true);
    expect(result.code, result.output).toBe(0);
    expect(attempts(target)).toBe(1);
    expectConsumed(target);
  }, 30_000);

  it('does not carry preparation into another verify invocation or standalone unit', () => {
    const target = fixture();
    const first = verify(target);
    expect(first.code, first.output).toBe(0);
    expectConsumed(target);
    for (const [index, args] of [
      ['scripts/verify.mjs', '--skip', ...otherSteps, 'typecheck'],
      ['run', 'test:unit'],
    ].entries()) {
      // Existing, incorrect dist must be replaced rather than treated as preparation evidence.
      writeFileSync(
        join(target, 'packages/prepared/dist/index.js'),
        'export const double = () => -1;',
      );
      for (const consumer of consumers) {
        rmSync(join(target, `consumed-${consumer.name}.json`));
      }
      const result = run(target, args);
      expect(result.code, result.output).toBe(0);
      expect(attempts(target)).toBe(index + 2);
      expectConsumed(target);
    }
  }, 30_000);

  it.each(['standalone', 'verify', 'verify-skip-typecheck'])(
    'stops %s before unit consumers when real package preparation fails',
    (entry) => {
      const target = fixture({ buildFails: true });
      const result =
        entry === 'standalone'
          ? run(target, ['run', 'test:unit'])
          : verify(target, entry === 'verify-skip-typecheck');
      expect(result.code, result.output).not.toBe(0);
      expect(attempts(target)).toBe(1);
      expectNotConsumed(target);
      expect(existsSync(join(target, 'packages/prepared/dist/index.js'))).toBe(false);
    },
    30_000,
  );

  it('stops before unit consumers when typecheck fails after a successful package build', () => {
    const target = fixture({ typecheckFails: true });
    const result = verify(target);
    expect(result.code, result.output).not.toBe(0);
    expect(attempts(target)).toBe(1);
    expect(existsSync(join(target, 'packages/prepared/dist/index.js'))).toBe(true);
    expectNotConsumed(target);
  }, 30_000);
});
