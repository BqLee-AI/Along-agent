#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';

function git(...args) {
  return execFileSync('git', args, {
    encoding: 'buffer',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
  });
}

function selectScope() {
  const eventName = process.env.GITHUB_EVENT_NAME;
  if (eventName !== 'pull_request' && eventName !== 'push') {
    return ['full', 'unsupported event'];
  }

  try {
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
    const base = eventName === 'pull_request' ? event?.pull_request?.base?.sha : event?.before;
    if (typeof base !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(base)) {
      return ['full', 'missing or invalid base SHA'];
    }
    const nativeTests = new Set(
      readFileSync(new URL('../../ci/native-tests.txt', import.meta.url), 'utf8')
        .trim()
        .split(/\r?\n/),
    );

    try {
      git('cat-file', '-e', `${base}^{commit}`);
    } catch {
      git('fetch', '--no-tags', '--depth=1', 'origin', base);
      git('cat-file', '-e', `${base}^{commit}`);
    }

    const data = git(
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--no-renames',
      '--name-status',
      '-z',
      base,
      'HEAD',
      '--',
    );
    if (data.length === 0 || data[data.length - 1] !== 0) return ['full', 'empty or invalid diff'];
    const fields = new TextDecoder('utf-8', { fatal: true }).decode(data).slice(0, -1).split('\0');
    if (fields.length % 2 !== 0) return ['full', 'unsupported diff status'];

    let hasWeb = false;
    let hasApi = false;
    const apiTests = [];
    for (let i = 0; i < fields.length; i += 2) {
      const [status, path] = [fields[i], fields[i + 1]];
      if (!['A', 'M', 'D'].includes(status) || !path) return ['full', 'unsupported diff status'];
      const docs =
        /^(?:docs|openspec)\/[\s\S]+\.(?:md|mdx)(?![\s\S])/.test(path) ||
        path === 'README.md' ||
        path === 'CONTRIBUTING.md';
      if (status === 'D' && !docs) return ['full', 'deleted code or configuration'];
      const web = /^apps\/web\/(?:src|test)\/[\s\S]+/.test(path);
      const apiModule =
        /^apps\/api\/src\/modules\/(?:approvals|brief|conversations|notifications|tasks|time|tools|workspaces)\/[\s\S]+\.ts(?![\s\S])/.test(
          path,
        );
      const apiTest =
        /^apps\/api\/test\/integration\/(?!harness-)[a-z0-9-]+\.test\.ts(?![\s\S])/.test(path) &&
        !nativeTests.has(path);
      if (!docs && !web && !apiModule && !apiTest)
        return ['full', `outside scoped paths: ${JSON.stringify(path)}`];
      if (web) hasWeb = true;
      if (apiModule) hasApi = true;
      if (apiTest) apiTests.push(path);
    }
    if (eventName === 'push' && (hasWeb || hasApi || apiTests.length))
      return ['full', 'main code changes'];
    if (hasWeb && (hasApi || apiTests.length)) return ['full', 'mixed Web and API changes'];
    if (hasApi) return ['api', `${fields.length / 2} changed file(s)`];
    if (apiTests.length)
      return ['api-tests', `${apiTests.length} changed API test file(s)`, apiTests];
    return [hasWeb ? 'web' : 'docs', `${fields.length / 2} changed file(s)`];
  } catch (error) {
    return ['full', `unable to determine changes: ${error.message}`];
  }
}

const [scope, reason, apiTests] = selectScope();
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `scope=${scope}\n`);
  if (apiTests) appendFileSync(process.env.GITHUB_OUTPUT, `api_tests=${apiTests.join(' ')}\n`);
}
console.log(`CI scope: ${scope} (${reason})`);
