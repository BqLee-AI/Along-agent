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
  if (process.env.GITHUB_EVENT_NAME !== 'pull_request') {
    return ['full', 'not a pull request'];
  }

  try {
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
    const base = event?.pull_request?.base?.sha;
    if (typeof base !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(base)) {
      return ['full', 'missing or invalid pull request base SHA'];
    }

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
      '--find-renames',
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
    for (let i = 0; i < fields.length; i += 2) {
      const [status, path] = [fields[i], fields[i + 1]];
      if ((status !== 'A' && status !== 'M') || !path)
        return ['full', 'deletion, rename, or unsupported diff status'];
      const docs =
        /^(?:docs|openspec)\/[\s\S]+\.(?:md|mdx)(?![\s\S])/.test(path) ||
        path === 'README.md' ||
        path === 'CONTRIBUTING.md';
      const web = /^apps\/web\/(?:src|test)\/[\s\S]+/.test(path);
      if (!docs && !web) return ['full', `outside scoped paths: ${JSON.stringify(path)}`];
      if (web) hasWeb = true;
    }
    return [hasWeb ? 'web' : 'docs', `${fields.length / 2} changed file(s)`];
  } catch (error) {
    return ['full', `unable to determine changes: ${error.message}`];
  }
}

const [scope, reason] = selectScope();
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `scope=${scope}\n`);
console.log(`CI scope: ${scope} (${reason})`);
