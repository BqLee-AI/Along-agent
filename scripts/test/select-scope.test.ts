import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyChanges, applyReuse } from '../ci/select-scope.mjs';

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
      [databaseTest]: 'database baseline\n',
      [otherDatabaseTest]: 'other database baseline\n',
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
    expect(select([apiSource])).toEqual(plan(['web', 'api'], 'api', true));
  });

  it('selects package consumers without automatically including every app', () => {
    for (const name of ['contracts', 'stream-protocol']) {
      expect(select([`packages/${name}/src/index.ts`])).toEqual(
        plan(['web', 'api', 'packages'], 'full', true),
      );
    }
    for (const name of ['time-core', 'scheduler-core', 'notifier-core']) {
      expect(select([`packages/${name}/src/index.ts`])).toEqual(
        plan(['web', 'api', 'packages'], 'full', true),
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
    expect(select(['apps/api/test/integration/setup.ts'])).toEqual(plan(['api'], 'full', true));
    for (const path of [
      'apps/api/src/db/schema.ts',
      'apps/api/src/features/identity/account/account-service.ts',
      'apps/api/src/features/conversations/run/context-policy.ts',
      'apps/api/src/features/conversations/run-event-response.ts',
      'apps/web/src/shared/http/eden.ts',
      'apps/web/src/app/api/[...path]/route.ts',
    ]) {
      expect(select([path])).toEqual(plan(['web', 'api'], 'full', true));
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
    const cases = [
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
      [
        'apps/api/src/features/workspaces/registry/service.ts',
        plan(['web', 'api', 'tooling'], 'api', true),
      ],
      ['apps/api/src/http/errors.ts', plan(['web', 'api', 'tooling'], 'api', true)],
      ['ci/native-tests.txt', plan(['api', 'tooling'], 'full', true)],
      ['ci/gates.json', plan(['tooling'], 'none', true)],
    ] as const;
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
function merge(repo: string, base: string, head: string) {
  const tree = git(repo, 'merge-tree', '--write-tree', base, head).split('\n')[0];
  return git(repo, 'commit-tree', tree, '-p', base, '-p', head, '-m', 'PR merge fixture');
}

// Native Response body readers can stall Bun's parallel test workers.
function response<T>(body: T, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function context(repo: string, base: string, head: string, prior: string) {
  const steps = {
    plan: [`Select affected checks (${merge(repo, base, prior)})`],
    checks: allChecks.map(
      (lane) => `Check ${lane === 'web' ? 'Web' : lane === 'api' ? 'API' : lane}`,
    ),
    database: ['Verify PostgreSQL'],
    integration: ['Verify production runtime'],
  };
  return {
    cwd: repo,
    base,
    head,
    checkout: merge(repo, base, head),
    prNumber: 7,
    repository: 'example/repo',
    token: 'fixture-token',
    fetch: async () =>
      response({
        jobs: Object.entries(steps).map(([name, names]) => ({
          name,
          conclusion: 'success',
          steps: names.map((name) => ({ name, conclusion: 'success' })),
        })),
      }),
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
      const original = structuredClone(all);
      const result = await applyReuse(
        all,
        [successfulRun(prior, base)],
        context(repo, base, head, prior),
      );
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
      expect(all).toEqual(original);
    });
  });

  it.each([
    [apiSource, plan(['web', 'api'], 'api', true)],
    ['packages/contracts/src/index.ts', plan(['web', 'api', 'packages'], 'full', true)],
    ['packages/time-core/src/index.ts', plan(['web', 'api', 'packages'], 'full', true)],
    ['scripts/test/fixtures/0024_tasks_elapsed_basis.sql', plan([], 'full')],
    ['apps/api/src/features/workspaces/registry/service.ts', plan(['tooling'])],
    ['apps/api/src/http/errors.ts', plan(['tooling'])],
    ['scripts/ci/select-scope.mjs', all],
  ] as const)('invalidates %s for its consumers', async (path, requested) => {
    await fixture(async (repo, base) => {
      const prior = commit(repo, {
        'packages/contracts/src/index.ts': 'validated dependency\n',
        [path]: 'validated input\n',
      });
      const head = commit(repo, { [path]: 'changed input\n' });
      const result = await applyReuse(
        requested,
        [successfulRun(prior, base)],
        context(repo, base, head, prior),
      );
      expect(result.checks).toEqual(requested.checks);
      expect(result.database).toEqual(requested.database);
      expect(result.runtime).toBe(requested.runtime);
      expect(Object.keys(result.reused)).toEqual([]);
    });
  });

  it('does not reuse a database subset even with identical current test inputs', async () => {
    await fixture(async (repo, base) => {
      const prior = commit(repo, { [databaseTest]: 'validated test\n' });
      const head = commit(repo, { 'README.md': 'new docs\n' });
      const requested = plan([], 'api-tests', false, [databaseTest, otherDatabaseTest].sort());
      expect(
        await applyReuse(requested, [successfulRun(prior, base)], context(repo, base, head, prior)),
      ).toEqual({ ...requested, reused: {} });
    });
  });

  it('accepts a successful owning job even when another job failed the overall run', async () => {
    await fixture(async (repo, base) => {
      const prior = commit(repo, { [webSource]: 'validated Web\n' });
      const head = commit(repo, { 'README.md': 'new docs\n' });
      const result = await applyReuse(
        plan(['web']),
        [{ ...successfulRun(prior, base), conclusion: 'failure' }],
        context(repo, base, head, prior),
      );
      expect(result.checks).toEqual([]);
      expect(result.reused.web).toEqual({ runId: 42, url: successfulRun(prior, base).html_url });
    });
  });

  it('rejects incompatible provenance and unfinished runs', async () => {
    await fixture(async (repo, base) => {
      const prior = commit(repo, { [webSource]: 'validated Web\n' });
      const head = commit(repo, { 'README.md': 'new docs\n' });
      const ctx = context(repo, base, head, prior);
      const valid = successfulRun(prior, base);
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
      for (const candidate of invalid)
        expect(await applyReuse(all, [candidate], ctx)).toEqual({ ...all, reused: {} });
    });
  });

  it('requires a successful owning job and actual execution, not skipped or failed steps', async () => {
    await fixture(async (repo, base) => {
      const prior = commit(repo, { [webSource]: 'validated Web\n' });
      const head = commit(repo, { 'README.md': 'new docs\n' });
      const ctx = context(repo, base, head, prior);
      const { jobs } = await (await ctx.fetch()).json();
      const cases = [
        [],
        [
          {
            name: 'checks',
            conclusion: 'failure',
            steps: [{ name: 'Check Web', conclusion: 'success' }],
          },
        ],
        [{ name: 'checks', conclusion: 'success', steps: [] }],
        ...['skipped', 'failure', null].map((conclusion) => [
          {
            name: 'checks',
            conclusion: 'success',
            steps: [{ name: 'Check Web', conclusion }],
          },
        ]),
      ];
      for (const checks of cases) {
        expect(
          await applyReuse(plan(['web']), [successfulRun(prior, base)], {
            ...ctx,
            fetch: async () => response({ jobs: [jobs[0], ...checks] }),
          }),
        ).toEqual({ ...plan(['web']), reused: {} });
      }
    });
  });

  it('does not trust missing checkout evidence or a commit with the wrong merge parents', async () => {
    await fixture(async (repo, base) => {
      const prior = commit(repo, { [webSource]: 'validated Web\n' });
      const head = commit(repo, { 'README.md': 'new docs\n' });
      const ctx = context(repo, base, head, prior);
      const { jobs } = await (await ctx.fetch()).json();
      for (const name of ['Select affected checks', `Select affected checks (${prior})`]) {
        jobs[0].steps[0].name = name;
        expect(
          await applyReuse(plan(['web']), [successfulRun(prior, base)], {
            ...ctx,
            fetch: async () => response({ jobs }),
          }),
        ).toEqual({ ...plan(['web']), reused: {} });
      }
    });
  });

  it('hashes the tested merge tree when base adds a native test absent from the PR manifest', async () => {
    await fixture(async (repo, originalBase) => {
      const prior = commit(repo, { [databaseTest]: 'previous test\n' });
      const head = commit(repo, { [databaseTest]: 'changed native test\n' });
      git(repo, 'checkout', '-qb', 'target', originalBase);
      const base = commit(repo, { 'ci/native-tests.txt': `${nativeTest}\n${databaseTest}\n` });
      const requested = plan(['api'], 'none', true);
      expect(
        await applyReuse(requested, [successfulRun(prior, base)], context(repo, base, head, prior)),
      ).toEqual({ ...requested, reused: {} });
    });
  });

  it('runs normally without evidence and stops querying when the shared deadline expires', async () => {
    await fixture(async (repo, base) => {
      const prior = commit(repo, { [apiSource]: 'validated API\n' });
      const head = commit(repo, { 'README.md': 'new docs\n' });
      const ctx = context(repo, base, head, prior);
      expect(
        await applyReuse(all, [successfulRun(prior, base)], {
          ...ctx,
          fetch: async () => response(null, 503),
        }),
      ).toEqual({ ...all, reused: {} });
      const controller = new AbortController();
      let calls = 0;
      expect(
        await applyReuse(all, [successfulRun(prior, base), successfulRun(prior, base)], {
          ...ctx,
          signal: controller.signal,
          fetch: async () => {
            calls++;
            controller.abort();
            throw controller.signal.reason;
          },
        }),
      ).toEqual({ ...all, reused: {} });
      expect(calls).toBe(1);
    });
  });
});
