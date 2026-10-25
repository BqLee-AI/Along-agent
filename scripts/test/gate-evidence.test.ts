import { afterEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const targets: string[] = [];
const cases = ['D8.required.local', 'D8.required.http'];

afterEach(() => {
  for (const target of targets.splice(0)) rmSync(target, { recursive: true, force: true });
});

function fixture({ fullManifest = false, consumerCases = cases as unknown } = {}) {
  const target = mkdtempSync(join(tmpdir(), 'along-gate-evidence-'));
  targets.push(target);
  mkdirSync(join(target, 'ci'));
  mkdirSync(join(target, '.github', 'workflows'), { recursive: true });
  const manifest = fullManifest
    ? JSON.parse(readFileSync(join(root, 'ci/gates.json'), 'utf8'))
    : { version: 1, gates: {} };
  manifest.gates.D8 = {
    status: 'enforced',
    owner: '#47',
    scope: 'Current native local/HTTP consumers, bounded approval and unknown-core contracts.',
    remaining: { status: 'partial', scope: 'Other tool seams and product unknown recovery.' },
    enforced_by: {
      job: 'contracts-dual',
      evidence: ['consumer.test.ts'],
      consumer_cases: consumerCases,
    },
  };
  writeFileSync(join(target, 'ci/gates.json'), JSON.stringify(manifest));
  writeFileSync(join(target, '.github/workflows/ci.yml'), 'jobs:\n  contracts-dual:\n');
  writeFileSync(join(target, 'consumer.test.ts'), '// Declaration fixture, not native evidence.\n');
  return { target, manifest };
}

function run(script: string, target: string, report?: string) {
  const args = [join(root, 'scripts', script), target];
  if (report !== undefined) args.push(report);
  const result = spawnSync(process.execPath, args, { encoding: 'utf8' });
  return { code: result.status, output: `${result.stdout}${result.stderr}` };
}

// Synthetic XML tests only the report consumer. Real native evidence comes from test:contracts.
function report(target: string, entries: string[], tail = '</testsuite></testsuites>') {
  const path = join(target, 'report.xml');
  writeFileSync(
    path,
    `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites tests="${entries.length}"><testsuite>${entries.join('')}${tail}`,
  );
  return path;
}

const passed = (id: string) => `<testcase name="${id}" classname="" />`;

describe('D8 bounded enforcement declarations', () => {
  it('accepts an evidenced limited enforced declaration rather than pinning partial forever', () => {
    const { target } = fixture({ fullManifest: true });
    expect(run('check-gate-manifest.mjs', target).code).toBe(0);
  });

  it('rejects the old healthz-only partial declaration after promotion', () => {
    const { target, manifest } = fixture({ fullManifest: true });
    manifest.gates.D8 = { status: 'partial', scope: 'healthz only' };
    writeFileSync(join(target, 'ci/gates.json'), JSON.stringify(manifest));
    const result = run('check-gate-manifest.mjs', target);
    expect(result.code).toBe(1);
    expect(result.output).toContain('D8');
  });

  for (const [name, invalid] of [
    ['absent', undefined],
    ['empty', []],
    ['not an array', 'D8.required.local'],
    ['invalid ID', ['healthz']],
    ['duplicate', [cases[0], cases[0]]],
  ] as const) {
    it(`rejects ${name} required consumer identities`, () => {
      const { target, manifest } = fixture({ fullManifest: true, consumerCases: invalid });
      if (invalid === undefined) {
        delete manifest.gates.D8.enforced_by.consumer_cases;
        writeFileSync(join(target, 'ci/gates.json'), JSON.stringify(manifest));
      }
      const result = run('check-gate-manifest.mjs', target);
      expect(result.code).toBe(1);
      expect(result.output).toContain('D8');
    });
  }
});

describe('D8 actual execution report consumer', () => {
  it('accepts both uniquely passed required consumers', () => {
    const { target } = fixture();
    expect(run('check-gates-executable.mjs', target, report(target, cases.map(passed))).code).toBe(
      0,
    );
  });

  it('rejects a missing current report even if evidence files exist', () => {
    const { target } = fixture();
    const result = run('check-gates-executable.mjs', target, join(target, 'not-produced.xml'));
    expect(result.code).toBe(1);
    expect(result.output).toContain('D8');
  });

  it('rejects a report that only ran the local consumer', () => {
    const { target } = fixture();
    const result = run('check-gates-executable.mjs', target, report(target, [passed(cases[0]!)]));
    expect(result.code).toBe(1);
    expect(result.output).toContain(cases[1]!);
  });

  for (const state of ['skipped', 'failure', 'error']) {
    it(`rejects a ${state} required consumer even when the other passed`, () => {
      const { target } = fixture();
      const path = report(target, [
        passed(cases[0]!),
        `<testcase name="${cases[1]}"><${state} /></testcase>`,
      ]);
      const result = run('check-gates-executable.mjs', target, path);
      expect(result.code).toBe(1);
      expect(result.output).toContain(cases[1]!);
    });
  }

  it('rejects duplicate required consumer identities instead of counting two passes', () => {
    const { target } = fixture();
    const path = report(target, [passed(cases[0]!), passed(cases[0]!), passed(cases[1]!)]);
    const result = run('check-gates-executable.mjs', target, path);
    expect(result.code).toBe(1);
    expect(result.output).toContain(cases[0]!);
  });

  it('rejects a truncated report with apparently passed cases', () => {
    const { target } = fixture();
    const result = run('check-gates-executable.mjs', target, report(target, cases.map(passed), ''));
    expect(result.code).toBe(1);
    expect(result.output).toContain('D8');
  });

  it('rejects malformed nesting rather than extracting passing testcase substrings', () => {
    const { target } = fixture();
    const path = report(target, cases.map(passed), '</wrong></testsuites>');
    const result = run('check-gates-executable.mjs', target, path);
    expect(result.code).toBe(1);
    expect(result.output).toContain('D8');
  });
});
