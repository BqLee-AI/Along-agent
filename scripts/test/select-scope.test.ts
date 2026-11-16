import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyChanges, fingerprint, applyReuse } from '../ci/select-scope.mjs';

const nativeTest = 'apps/api/test/integration/harness-native.test.ts';
const databaseTest = 'apps/api/test/integration/tasks-read.test.ts';
const otherDatabaseTest = 'apps/api/test/integration/tasks-cancel.test.ts';
const apiSource = 'apps/api/src/http/router.ts';
const webSource = 'apps/web/src/App.tsx';
const allChecks = ['web', 'api', 'packages', 'tooling', 'harness'];
const all = { checks: allChecks, database: { mode: 'full', tests: [] }, runtime: true };

function select(paths: string[], status = 'M') {
  return classifyChanges(
    paths.map((path) => ({ status, path })),
    new Set([nativeTest]),
  );
}

function plan(checks: string[], mode = 'none', runtime = false, tests: string[] = []) {
  return { checks, database: { mode, tests }, runtime };
}

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function commit(repo: string, files: Record<string, string>): string {
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), contents);
  }
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'fixture change');
  return git(repo, 'rev-parse', 'HEAD');
}

async function fixture(run: (repo: string, base: string) => void | Promise<void>): Promise<void> {
  const repo = mkdtempSync(join(tmpdir(), 'along-ci-scope-'));
  try {
    git(repo, 'init', '-q');
    git(repo, 'config', 'user.name', 'CI fixture');
    git(repo, 'config', 'user.email', 'ci@example.invalid');
    const base = commit(repo, {
      [webSource]: 'web baseline\n',
      [apiSource]: 'api baseline\n',
      'packages/contracts/src/index.ts': 'contracts baseline\n',
      'packages/time-core/src/index.ts': 'time baseline\n',
      'README.md': 'documentation baseline\n',
      '.github/workflows/ci.yml': 'workflow baseline\n',
      'scripts/ci/select-scope.mjs': 'planner baseline\n',
      'ci/native-tests.txt': `${nativeTest}\n`,
      'bun.lock': 'lock baseline\n',
      'package.json': '{}\n',
      'tsconfig.base.json': '{}\n',
    });
    await run(repo, base);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

describe('affected CI selection', () => {
  it('keeps Web-only changes out of backend gates, including known deletes', () => {
    expect(select([webSource])).toEqual(plan(['web']));
    expect(select([webSource], 'D')).toEqual(plan(['web']));
    expect(
      classifyChanges(
        [
          { status: 'D', path: 'apps/web/src/Old.tsx' },
          { status: 'A', path: 'apps/web/src/New.tsx' },
        ],
        [],
      ),
    ).toEqual(plan(['web']));
  });

  it('includes runtime for Web frozen-install inputs but not styles or tests', () => {
    for (const path of ['apps/web/package.json', 'apps/web/vendor/library/index.js']) {
      expect(select([path])).toEqual(plan(['web'], 'none', true));
    }
    for (const path of [
      'apps/web/src/styles.css',
      'apps/web/test/component.test.ts',
      'apps/web/vite.config.ts',
    ]) {
      expect(select([path])).toEqual(plan(['web']));
    }
  });

  it('unions Web and API impact without enabling unrelated checks', () => {
    expect(select([webSource, apiSource])).toEqual(plan(['web', 'api'], 'api', true));
    expect(select([apiSource])).toEqual(plan(['api'], 'api', true));
  });

  it('selects package consumers without automatically including every app', () => {
    for (const name of ['contracts', 'stream-protocol']) {
      expect(select([`packages/${name}/src/index.ts`])).toEqual(
        plan(['web', 'api', 'packages'], 'full', true),
      );
    }
    for (const name of ['time-core', 'scheduler-core', 'notifier-core']) {
      expect(select([`packages/${name}/src/index.ts`])).toEqual(
        plan(['api', 'packages'], 'full', true),
      );
    }
  });

  it('distinguishes native, database-only, and unit tests', () => {
    expect(select([nativeTest])).toEqual(plan(['api'], 'none', true));
    expect(select([otherDatabaseTest, databaseTest])).toEqual(
      plan(['api'], 'api-tests', false, [otherDatabaseTest, databaseTest].sort()),
    );
    expect(select([databaseTest], 'D')).toEqual(plan(['api'], 'api'));
    expect(select(['apps/api/test/unit.test.ts'])).toEqual(plan(['api']));
    expect(select([nativeTest, databaseTest])).toEqual(
      plan(['api'], 'api-tests', true, [databaseTest]),
    );
  });

  it('widens shared integration setup and backend shared state', () => {
    for (const path of [
      'apps/api/test/integration/setup.ts',
      'apps/api/src/db/schema.ts',
      'apps/api/src/modules/identity/service.ts',
    ]) {
      expect(select([path])).toEqual(plan(['api'], 'full', true));
    }
  });

  it('does not schedule heavy work for documentation or documentation renames', () => {
    const docs = [
      'docs/guide.md',
      'openspec/change/design.mdx',
      'README.md',
      'CONTRIBUTING.md',
      'SECURITY.md',
      'CODE_OF_CONDUCT.md',
      '.github/ISSUE_TEMPLATE/bug.md',
      '.github/PULL_REQUEST_TEMPLATE.md',
    ];
    expect(select(docs)).toEqual(plan([]));
    expect(
      classifyChanges(
        [
          { status: 'D', path: 'docs/old.md' },
          { status: 'A', path: 'docs/new.md' },
        ],
        [],
      ),
    ).toEqual(plan([]));
    expect(select(['docs/guide.md', webSource])).toEqual(plan(['web']));
  });

  it('maps infrastructure, harness, and script changes to their actual consumers', () => {
    const cases: [
      string,
      { checks: string[]; database: { mode: string; tests: string[] }; runtime: boolean },
    ][] = [
      ['infra/migrations/001.sql', plan([], 'full', true)],
      ['infra/docker/compose.yml', plan([], 'none', true)],
      ['.dockerignore', plan([], 'none', true)],
      ['apps/harness/src/main.ts', plan(['harness'], 'none', true)],
      ['apps/embedding/src/main.ts', all],
      ['scripts/local/start.mjs', plan(['tooling'], 'full')],
      ['scripts/test/local.test.ts', plan(['tooling'], 'full')],
      ['scripts/db/migrate.mjs', plan([], 'full')],
      ['scripts/test/other.test.ts', plan(['tooling'])],
      ['scripts/check-gates-executable.mjs', plan(['tooling'], 'none', true)],
      ['scripts/d8-contracts.mjs', plan(['tooling'], 'none', true)],
      ['scripts/check.mjs', all],
      ['scripts/check-migrations.mjs', plan(['tooling'], 'full')],
      ['scripts/check-gate-manifest.mjs', plan(['tooling'])],
      ['scripts/check-frozen-names.mjs', plan(['tooling'])],
      ['scripts/scan-copy-claims.mjs', plan(['tooling'])],
      ['scripts/verify.mjs', plan(['tooling'])],
      ['scripts/test-unit.mjs', plan(['tooling'])],
      ['scripts/lint-rules.mjs', plan(['web', 'tooling'])],
      ['scripts/fixtures/frozen-bad.ts', plan(['tooling'])],
      ['scripts/test/fixtures/0024_tasks_elapsed_basis.sql', plan(['tooling'], 'full')],
      ['apps/api/src/modules/workspaces/service.ts', plan(['api', 'tooling'], 'api', true)],
      ['apps/api/src/http/errors.ts', plan(['api', 'tooling'], 'api', true)],
      ['ci/native-tests.txt', plan(['api', 'tooling'], 'full', true)],
      ['ci/gates.json', plan(['tooling'], 'none', true)],
    ];
    for (const [path, expected] of cases) expect(select([path])).toEqual(expected);
  });

  it('fails closed for unknown impact or status and shared CI configuration', () => {
    for (const path of [
      'unmapped/file.ts',
      '.github/workflows/ci.yml',
      '.github/actions/setup/action.yml',
      'scripts/ci/select-scope.mjs',
      'package.json',
      'bun.lock',
      'tsconfig.base.json',
    ]) {
      expect(select([path])).toEqual(all);
    }
    expect(select([])).toEqual(all);
    expect(select([webSource], '?')).toEqual(all);
  });
});

describe('CI event entry point', () => {
  it('uses the same Web impact for push and PR and fails closed without a base', async () => {
    await fixture((repo, base) => {
      const head = commit(repo, { [webSource]: 'updated Web\n' });
      const script = fileURLToPath(new URL('../ci/select-scope.mjs', import.meta.url));
      const eventPath = join(repo, 'event.json');
      const outputPath = join(repo, 'output.txt');
      const cases = [
        { name: 'push', event: { before: base }, expected: plan(['web']) },
        {
          name: 'pull_request',
          event: { number: 7, pull_request: { base: { sha: base }, head: { sha: head } } },
          expected: plan(['web']),
        },
        { name: 'push', event: {}, expected: all },
        { name: 'pull_request', event: { pull_request: { head: { sha: head } } }, expected: all },
      ];
      for (const item of cases) {
        writeFileSync(eventPath, JSON.stringify(item.event));
        writeFileSync(outputPath, '');
        execFileSync(process.execPath, [script], {
          cwd: repo,
          env: {
            ...process.env,
            GH_TOKEN: '',
            GITHUB_EVENT_NAME: item.name,
            GITHUB_EVENT_PATH: eventPath,
            GITHUB_OUTPUT: outputPath,
            GITHUB_STEP_SUMMARY: '',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        const output = readFileSync(outputPath, 'utf8').trim();
        expect(output.startsWith('plan=')).toBe(true);
        expect(JSON.parse(output.slice('plan='.length))).toEqual(item.expected);
      }
    });
  });
});

describe('tracked-tree fingerprints', () => {
  it('ignores documentation but includes base and relevant source trees', async () => {
    await fixture((repo, base) => {
      const gates = ['web', 'api', 'packages', 'tooling', 'harness', 'database', 'runtime'];
      const original = Object.fromEntries(
        gates.map((gate) => [gate, fingerprint(base, gate, base, repo)]),
      );
      const docs = commit(repo, { 'README.md': 'updated documentation\n' });
      for (const gate of gates) expect(fingerprint(docs, gate, base, repo)).toBe(original[gate]);
      const web = commit(repo, { [webSource]: 'updated web\n' });
      expect(fingerprint(web, 'web', base, repo)).not.toBe(original.web);
      for (const gate of ['api', 'database', 'runtime'])
        expect(fingerprint(web, gate, base, repo)).toBe(original[gate]);
      const api = commit(repo, { [apiSource]: 'updated API\n' });
      for (const gate of ['api', 'database', 'runtime'])
        expect(fingerprint(api, gate, base, repo)).not.toBe(original[gate]);
      expect(fingerprint(api, 'web', base, repo)).toBe(fingerprint(web, 'web', base, repo));
      expect(fingerprint(api, 'api', docs, repo)).not.toBe(fingerprint(api, 'api', base, repo));
    });
  });

  it('includes shared dependencies only for their consumers and common CI for every gate', async () => {
    await fixture((repo, base) => {
      const time = commit(repo, { 'packages/time-core/src/index.ts': 'updated time\n' });
      for (const gate of ['packages', 'api', 'database', 'runtime']) {
        expect(fingerprint(time, gate, base, repo)).not.toBe(fingerprint(base, gate, base, repo));
      }
      expect(fingerprint(time, 'web', base, repo)).toBe(fingerprint(base, 'web', base, repo));
      const contracts = commit(repo, { 'packages/contracts/src/index.ts': 'updated contracts\n' });
      expect(fingerprint(contracts, 'web', base, repo)).not.toBe(
        fingerprint(time, 'web', base, repo),
      );
      const ci = commit(repo, { '.github/workflows/ci.yml': 'updated workflow\n' });
      for (const gate of ['web', 'api', 'packages', 'tooling', 'harness', 'database', 'runtime']) {
        expect(fingerprint(ci, gate, base, repo)).not.toBe(
          fingerprint(contracts, gate, base, repo),
        );
      }
    });
  });
});

const stepNames = [
  'Check Web',
  'Check API',
  'Check packages',
  'Check tooling',
  'Check harness',
  'Verify PostgreSQL',
  'Verify production runtime',
];
function successfulRun(head: string, base: string) {
  return {
    id: 42,
    head_sha: head,
    status: 'completed',
    conclusion: 'success',
    event: 'pull_request',
    path: '.github/workflows/ci.yml',
    pull_requests: [{ number: 7, base: { sha: base } }],
    html_url: 'https://github.com/example/repo/actions/runs/42',
  };
}
function context(
  repo: string,
  base: string,
  head: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    cwd: repo,
    base,
    head,
    prNumber: 7,
    repository: 'example/repo',
    token: 'fixture-token',
    fetch: async () =>
      new Response(
        JSON.stringify({
          jobs: [
            {
              id: 9,
              name: 'checks',
              status: 'completed',
              conclusion: 'success',
              steps: stepNames.slice(0, 5).map((name, index) => ({
                name,
                number: index + 1,
                status: 'completed',
                conclusion: 'success',
              })),
            },
            {
              id: 10,
              name: 'database',
              status: 'completed',
              conclusion: 'success',
              steps: [{ name: 'Verify PostgreSQL', status: 'completed', conclusion: 'success' }],
            },
            {
              id: 11,
              name: 'integration',
              status: 'completed',
              conclusion: 'success',
              steps: [
                { name: 'Verify production runtime', status: 'completed', conclusion: 'success' },
              ],
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    ...overrides,
  };
}

describe('prior successful gate reuse', () => {
  it('reuses unchanged expensive lanes after docs and Web updates but reruns Web', async () => {
    await fixture(async (repo, base) => {
      const prior = commit(repo, {
        [apiSource]: 'validated API\n',
        'packages/contracts/src/index.ts': 'validated contracts\n',
      });
      const head = commit(repo, { [webSource]: 'new Web\n', 'README.md': 'new docs\n' });
      const result = await applyReuse(all, [successfulRun(prior, base)], context(repo, base, head));
      expect(result.checks).toEqual(['web']);
      expect(result.database.mode).toBe('none');
      expect(result.runtime).toBe(false);
      expect(Object.keys(result.reused).sort()).toEqual([
        'api',
        'database',
        'harness',
        'packages',
        'runtime',
        'tooling',
      ]);
      expect(result.reused.api).toEqual({ runId: 42, url: successfulRun(prior, base).html_url });
      expect(all.database.mode).toBe('full');
      expect(all.checks).toEqual(allChecks);
    });
  });

  it('invalidates API, database, and runtime on API edits', async () => {
    await fixture(async (repo, base) => {
      const head = commit(repo, { [apiSource]: 'new API\n' });
      const result = await applyReuse(
        plan(['api'], 'api', true),
        [successfulRun(base, base)],
        context(repo, base, head),
      );
      expect(result.checks).toEqual(['api']);
      expect(result.database.mode).toBe('api');
      expect(result.runtime).toBe(true);
      expect(result.reused).toEqual({});
    });
  });

  it('invalidates cross-directory consumer evidence for SQL fixtures and local-account inputs', async () => {
    const cases = [
      {
        path: 'scripts/test/fixtures/0024_tasks_elapsed_basis.sql',
        gate: 'database',
        requested: plan([], 'full'),
      },
      {
        path: 'apps/api/src/modules/workspaces/service.ts',
        gate: 'tooling',
        requested: plan(['tooling']),
      },
      { path: 'apps/api/src/http/errors.ts', gate: 'tooling', requested: plan(['tooling']) },
    ];
    for (const item of cases) {
      await fixture(async (repo, base) => {
        const prior = commit(repo, {
          'packages/contracts/src/index.ts': 'validated shared dependency\n',
          [item.path]: 'validated input\n',
        });
        const head = commit(repo, { [item.path]: 'changed consumer input\n' });
        expect(fingerprint(head, item.gate, base, repo)).not.toBe(
          fingerprint(prior, item.gate, base, repo),
        );
        const result = await applyReuse(
          item.requested,
          [successfulRun(prior, base)],
          context(repo, base, head),
        );
        expect(result).toEqual({ ...item.requested, reused: {} });
      });
    }
  });

  it('does not reuse a database test subset that omits requested tests', async () => {
    await fixture(async (repo, base) => {
      const prior = commit(repo, { [databaseTest]: 'validated test\n' });
      const head = commit(repo, { [otherDatabaseTest]: 'additional test\n' });
      const requested = plan([], 'api-tests', false, [databaseTest, otherDatabaseTest].sort());
      const result = await applyReuse(
        requested,
        [successfulRun(prior, base)],
        context(repo, base, head),
      );
      expect(result).toEqual({ ...requested, reused: {} });
    });
  });

  it('accepts a successful owning job even when another job failed the overall run', async () => {
    await fixture(async (repo, base) => {
      const head = commit(repo, { 'README.md': 'new docs\n' });
      const result = await applyReuse(
        plan(['web']),
        [{ ...successfulRun(base, base), conclusion: 'failure' }],
        context(repo, base, head),
      );
      expect(result.checks).toEqual([]);
      expect(result.reused.web).toEqual({ runId: 42, url: successfulRun(base, base).html_url });
    });
  });

  it('never reuses runs with incompatible provenance or unfinished status', async () => {
    await fixture(async (repo, base) => {
      const head = commit(repo, { 'README.md': 'new docs\n' });
      const valid = successfulRun(base, base);
      const invalid = [
        { ...valid, status: 'in_progress', conclusion: null },
        { ...valid, path: '.github/workflows/other.yml' },
        { ...valid, pull_requests: [{ number: 8, base: { sha: base } }] },
        { ...valid, pull_requests: [{ number: 7, base: { sha: head } }] },
        { ...valid, pull_requests: [] },
      ];
      git(repo, 'checkout', '-q', '--orphan', 'unrelated');
      const unrelated = commit(repo, { 'README.md': 'unrelated history\n' });
      invalid.push({ ...valid, head_sha: unrelated });
      for (const candidate of invalid) {
        const result = await applyReuse(all, [candidate], context(repo, base, head));
        expect(result).toEqual({ ...all, reused: {} });
      }
    });
  });

  it('requires successful job and actual named step evidence, not just run success', async () => {
    await fixture(async (repo, base) => {
      const head = commit(repo, { 'README.md': 'new docs\n' });
      const evidence = [
        { jobs: [] },
        {
          jobs: [
            {
              name: 'checks',
              status: 'completed',
              conclusion: 'failure',
              steps: [{ name: 'Check Web', conclusion: 'success', status: 'completed' }],
            },
          ],
        },
        { jobs: [{ name: 'checks', status: 'completed', conclusion: 'success', steps: [] }] },
        ...['skipped', 'failure', null].map((conclusion) => ({
          jobs: [
            {
              name: 'checks',
              conclusion: 'success',
              status: 'completed',
              steps: [{ name: 'Check Web', conclusion, status: 'completed' }],
            },
          ],
        })),
      ];
      for (const body of evidence) {
        const result = await applyReuse(
          plan(['web']),
          [successfulRun(base, base)],
          context(repo, base, head, {
            fetch: async () => new Response(JSON.stringify(body), { status: 200 }),
          }),
        );
        expect(result).toEqual({ ...plan(['web']), reused: {} });
      }
    });
  });

  it('runs normally when evidence cannot be fetched or CI has changed', async () => {
    await fixture(async (repo, base) => {
      const docs = commit(repo, { 'README.md': 'new docs\n' });
      const unavailable = await applyReuse(
        all,
        [successfulRun(base, base)],
        context(repo, base, docs, {
          fetch: async () => new Response('unavailable', { status: 503 }),
        }),
      );
      expect(unavailable).toEqual({ ...all, reused: {} });
      const head = commit(repo, { 'scripts/ci/select-scope.mjs': 'new planner\n' });
      const changed = await applyReuse(all, [successfulRun(base, base)], context(repo, base, head));
      expect(changed).toEqual({ ...all, reused: {} });
    });
  });
});
