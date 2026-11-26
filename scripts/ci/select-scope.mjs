#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const lanes = ['web', 'api', 'packages', 'tooling', 'harness'];
const workflow = '.github/workflows/ci.yml';
const stepNames = {
  web: 'Check Web',
  api: 'Check API',
  packages: 'Check packages',
  tooling: 'Check tooling',
  harness: 'Check harness',
  database: 'Verify PostgreSQL',
  runtime: 'Verify production runtime',
};

function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10000,
    maxBuffer: 32 * 1024 * 1024,
  });
}

function ensureCommit(ref, cwd) {
  try {
    git(['cat-file', '-e', `${ref}^{commit}`], cwd);
  } catch {
    git(['fetch', '--no-tags', 'origin', ref], cwd);
  }
}

function fullPlan() {
  return { checks: [...lanes], database: { mode: 'full', tests: [] }, runtime: true };
}

function documentation(path) {
  return (
    /^(?:docs|openspec)\/[\s\S]+\.(?:md|mdx)$/.test(path) ||
    /^(?:README|CONTRIBUTING|SECURITY|CODE_OF_CONDUCT)\.md$/.test(path) ||
    /^\.github\/(?:PULL_REQUEST_TEMPLATE\.md|ISSUE_TEMPLATE\/[\s\S]+\.md)$/.test(path)
  );
}

export function classifyChanges(changes, nativeTests = []) {
  if (!changes.length) return fullPlan();
  const checks = new Set();
  const native = new Set(nativeTests);
  const tests = new Set();
  let mode = 'none';
  let runtime = false;
  const database = (next) => {
    const priority = ['none', 'api-tests', 'api', 'full'];
    if (priority.indexOf(next) > priority.indexOf(mode)) mode = next;
  };
  const backend = (history = false) => {
    checks.add('api');
    database(history ? 'full' : 'api');
    runtime = true;
  };
  for (const { status, path } of changes) {
    if (!['A', 'M', 'D'].includes(status) || typeof path !== 'string' || !path) return fullPlan();
    if (documentation(path)) continue;
    if (path.startsWith('apps/web/')) {
      checks.add('web');
      if (/^apps\/web\/src\/(?:shared\/http|app\/api)\//.test(path)) backend(true);
      if (path === 'apps/web/package.json' || path.startsWith('apps/web/vendor/')) runtime = true;
    } else if (path.startsWith('apps/api/src/')) {
      // The Web lane compiles the API and consumes its emitted declarations.
      checks.add('web');
      backend(
        /^apps\/api\/src\/(?:db\/|features\/(?:identity\/|conversations\/(?:run\/|run-event-response\.ts$)))/.test(
          path,
        ),
      );
      if (
        path.startsWith('apps/api/src/features/workspaces/') ||
        path === 'apps/api/src/http/errors.ts'
      ) {
        checks.add('tooling');
      }
    } else if (/^apps\/api\/test\/integration\/[a-z0-9-]+\.test\.ts(?![\s\S])/.test(path)) {
      checks.add('api');
      if (native.has(path)) runtime = true;
      else {
        database(status === 'D' ? 'api' : 'api-tests');
        tests.add(path);
      }
    } else if (
      path.startsWith('apps/api/test/integration/') ||
      path.startsWith('apps/api/test/helpers/')
    ) {
      backend(true);
    } else if (/^apps\/api\/test\/contracts(?:\/|\.test\.ts$)/.test(path)) {
      checks.add('api');
      runtime = true;
    } else if (path.startsWith('apps/api/test/')) checks.add('api');
    else if (path.startsWith('apps/api/')) {
      checks.add('web');
      backend(true);
    } else if (
      /^packages\/(contracts|stream-protocol|time-core|scheduler-core|notifier-core)\//.test(path)
    ) {
      checks.add('packages');
      backend(true);
      checks.add('web');
    } else if (path.startsWith('apps/harness/')) {
      checks.add('harness');
      runtime = true;
    } else if (path.startsWith('apps/host/') || path.startsWith('scripts/ci/host-smoke.')) {
      runtime = true;
    } else if (path.startsWith('infra/migrations/')) {
      database('full');
      runtime = true;
    } else if (/^infra\/(?:docker|compose)\//.test(path) || path === '.dockerignore')
      runtime = true;
    else if (
      path.startsWith('scripts/local/') ||
      path.startsWith('scripts/test/local') ||
      path.startsWith('scripts/test/fixtures/') ||
      path === 'scripts/check-migrations.mjs'
    ) {
      checks.add('tooling');
      database('full');
    } else if (path.startsWith('scripts/db/')) database('full');
    else if (path.startsWith('scripts/test/') || path.startsWith('scripts/fixtures/')) {
      checks.add('tooling');
    } else if (['scripts/check-gates-executable.mjs', 'scripts/d8-contracts.mjs'].includes(path)) {
      checks.add('tooling');
      runtime = true;
    } else if (path === 'scripts/lint-rules.mjs') {
      checks.add('web');
      checks.add('tooling');
    } else if (
      [
        'scripts/check-gate-manifest.mjs',
        'scripts/check-frozen-names.mjs',
        'scripts/scan-copy-claims.mjs',
        'scripts/verify.mjs',
        'scripts/test-unit.mjs',
      ].includes(path)
    ) {
      checks.add('tooling');
    } else if (path === 'ci/native-tests.txt') {
      checks.add('tooling');
      backend(true);
    } else if (path === 'ci/gates.json') {
      checks.add('tooling');
      runtime = true;
    } else if (/^\.ox/.test(path)) {
      for (const lane of lanes) checks.add(lane);
    } else if (path === '.dependency-cruiser.cjs') {
      for (const lane of ['web', 'api', 'packages', 'tooling']) checks.add(lane);
    } else return fullPlan();
  }
  return {
    checks: lanes.filter((lane) => checks.has(lane)),
    database: { mode, tests: mode === 'api-tests' ? [...tests].sort() : [] },
    runtime,
  };
}

function readNative(ref, cwd) {
  return git(['show', `${ref}:ci/native-tests.txt`], cwd)
    .trim()
    .split(/\r?\n/);
}

function changesBetween(base, head, cwd) {
  const data = git(
    [
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--no-renames',
      '--name-status',
      '-z',
      base,
      head,
      '--',
    ],
    cwd,
  );
  if (!data || !data.endsWith('\0')) return [];
  const fields = data.slice(0, -1).split('\0');
  if (fields.length % 2) throw new Error('Invalid Git diff');
  const changes = [];
  for (let i = 0; i < fields.length; i += 2)
    changes.push({ status: fields[i], path: fields[i + 1] });
  return changes;
}

function requested(plan, gate) {
  if (gate === 'database') return plan.database.mode !== 'none';
  if (gate === 'runtime') return plan.runtime;
  return plan.checks.includes(gate);
}

function fingerprint(ref, gate, base, cwd) {
  const native = readNative(ref, cwd);
  const hash = createHash('sha256').update(`${gate}\0${base}\0`);
  for (const entry of git(['ls-tree', '-r', '-z', '--full-tree', ref], cwd).split('\0')) {
    if (!entry) continue;
    const path = entry.slice(entry.indexOf('\t') + 1);
    if (requested(classifyChanges([{ status: 'M', path }], native), gate))
      hash.update(`${entry}\0`);
  }
  return hash.digest('hex');
}

function covers(previous, current) {
  return (
    previous.mode === 'full' ||
    (previous.mode === 'api' && current.mode !== 'full') ||
    (previous.mode === 'api-tests' &&
      current.mode === 'api-tests' &&
      current.tests.every((test) => previous.tests.includes(test)))
  );
}

async function github(path, context) {
  const response = await (context.fetch ?? fetch)(
    `https://api.github.com/repos/${context.repository}/${path}`,
    {
      headers: {
        Authorization: `Bearer ${context.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.any([context.signal, AbortSignal.timeout(10000)]),
    },
  );
  if (!response.ok) throw new Error(`GitHub evidence lookup returned ${response.status}`);
  return response.json();
}

export async function applyReuse(plan, candidates, context) {
  context = { ...context, signal: context.signal ?? AbortSignal.timeout(30000) };
  const result = { ...plan, checks: [...plan.checks], database: { ...plan.database }, reused: {} };
  const pending = [
    ...plan.checks,
    ...(requested(plan, 'database') ? ['database'] : []),
    ...(plan.runtime ? ['runtime'] : []),
  ];
  const currentHashes = new Map();
  for (const run of candidates) {
    if (!pending.length || context.signal.aborted) break;
    if (
      run.status !== 'completed' ||
      run.event !== 'pull_request' ||
      run.path !== workflow ||
      !run.pull_requests?.some(
        (pr) => pr.number === context.prNumber && pr.base?.sha === context.base,
      )
    )
      continue;
    try {
      git(['merge-base', '--is-ancestor', run.head_sha, context.head], context.cwd);
      const jobs = await github(`actions/runs/${run.id}/jobs?per_page=100`, context);
      const recorded = jobs.jobs
        ?.find((job) => job.name === 'plan' && job.conclusion === 'success')
        ?.steps?.find(
          (step) =>
            step.conclusion === 'success' &&
            /^Select affected checks \([a-f0-9]{40}\)$/.test(step.name),
        );
      if (!recorded) continue;
      const previous = recorded.name.slice(-41, -1);
      ensureCommit(previous, context.cwd);
      if (
        git(['show', '-s', '--format=%P', previous], context.cwd).trim() !==
        `${context.base} ${run.head_sha}`
      )
        continue;
      const oldPlan = classifyChanges(
        changesBetween(context.base, previous, context.cwd),
        readNative(previous, context.cwd),
      );
      for (const gate of [...pending]) {
        const jobName =
          gate === 'database' ? 'database' : gate === 'runtime' ? 'integration' : 'checks';
        const executed = jobs.jobs?.some(
          (job) =>
            job.name === jobName &&
            job.conclusion === 'success' &&
            job.steps?.some(
              (step) => step.name === stepNames[gate] && step.conclusion === 'success',
            ),
        );
        if (!executed || (gate === 'database' && !covers(oldPlan.database, plan.database)))
          continue;
        if (!currentHashes.has(gate))
          currentHashes.set(gate, fingerprint(context.checkout, gate, context.base, context.cwd));
        if (currentHashes.get(gate) !== fingerprint(previous, gate, context.base, context.cwd))
          continue;
        result.reused[gate] = { runId: run.id, url: run.html_url };
        if (gate === 'database') result.database = { mode: 'none', tests: [] };
        else if (gate === 'runtime') result.runtime = false;
        else result.checks = result.checks.filter((lane) => lane !== gate);
        pending.splice(pending.indexOf(gate), 1);
      }
    } catch (error) {
      console.log(`Not reusing run ${run.id}: ${error.message}`);
    }
  }
  return result;
}

async function selectPlan() {
  try {
    const eventName = process.env.GITHUB_EVENT_NAME;
    if (!['pull_request', 'push'].includes(eventName)) return fullPlan();
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
    const base = eventName === 'pull_request' ? event.pull_request?.base?.sha : event.before;
    const head = eventName === 'pull_request' ? event.pull_request?.head?.sha : 'HEAD';
    if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(base ?? '') || !head) return fullPlan();
    ensureCommit(base);
    const plan = classifyChanges(changesBetween(base, 'HEAD'), readNative('HEAD'));
    if (eventName !== 'pull_request' || !process.env.GH_TOKEN) return plan;
    const context = {
      base,
      head,
      checkout: git(['rev-parse', 'HEAD']).trim(),
      prNumber: event.number,
      repository: process.env.GITHUB_REPOSITORY,
      token: process.env.GH_TOKEN,
      signal: AbortSignal.timeout(30000),
    };
    try {
      const data = await github(
        'actions/workflows/ci.yml/runs?event=pull_request&per_page=30',
        context,
      );
      return await applyReuse(plan, data.workflow_runs ?? [], context);
    } catch (error) {
      console.log(`Running affected checks without prior evidence: ${error.message}`);
      return plan;
    }
  } catch (error) {
    console.log(`Running all checks: ${error.message}`);
    return fullPlan();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const plan = await selectPlan();
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, `plan=${JSON.stringify(plan)}\n`);
  const summary = `CI plan: ${JSON.stringify(plan)}`;
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
}
