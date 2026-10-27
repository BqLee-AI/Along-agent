import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, writeFile, mkdir, rm, link, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { PoolClient } from 'pg';
import {
  canonicalRelativePath,
  configureWorkspaceRegistry,
  loadWorkspaceRegistry,
  getWorkspaceGrant,
  listWorkspaces,
  readWorkspaceFile,
  listWorkspaceFiles,
  searchWorkspaceFiles,
  validateWorkspaceGrant,
  hashBytes,
  strictUtf8,
  utf8Bytes,
  WorkspaceDeniedError,
} from '../src/modules/workspaces/service.js';
import { applyWorkspaceReplace } from '../src/modules/workspaces/replace.js';

let root: string;
const owner = 'workspace-test-owner';
function registration(directory = root, id = 'workspace-test') {
  return {
    workspace_id: id,
    label: 'Test',
    owner_id: owner,
    root: directory,
    readable_paths: ['target.txt', 'sources/a.txt', 'missing.txt'],
    writable_paths: ['target.txt'],
  };
}
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'along-workspaces-'));
  await mkdir(path.join(root, 'sources'));
  await writeFile(path.join(root, 'target.txt'), '\uFEFFbefore\r\nold 中文\r\nafter  \r\n');
  await writeFile(path.join(root, 'sources/a.txt'), 'Date 2026\nDate 2027\n');
  await configureWorkspaceRegistry([registration()]);
});
afterEach(async () => {
  await configureWorkspaceRegistry([]);
  await rm(root, { recursive: true, force: true });
});

describe('deployment registry diagnostics', () => {
  test('missing configuration and an unreadable configured file are different and both revoke grants', async () => {
    expect(await loadWorkspaceRegistry('')).toEqual({
      state: 'unconfigured',
      accepted: 0,
      rejected: 0,
    });
    expect(listWorkspaces(owner)).toEqual([]);
    await configureWorkspaceRegistry([registration()]);
    expect(await loadWorkspaceRegistry(path.join(root, 'absent.json'))).toEqual({
      state: 'unreadable',
      accepted: 0,
      rejected: 0,
    });
    expect(listWorkspaces(owner)).toEqual([]);
  });
  test('invalid JSON is diagnosed without retaining an old grant or leaking file contents', async () => {
    const file = path.join(root, 'registry.json');
    await writeFile(file, 'private-invalid-registry');
    expect(await loadWorkspaceRegistry(file)).toEqual({
      state: 'invalid',
      accepted: 0,
      rejected: 0,
    });
    expect(listWorkspaces(owner)).toEqual([]);
  });
  test('a mixed registration reports rejected entries and keeps only the valid original owner', async () => {
    const file = path.join(root, 'registry.json');
    await writeFile(
      file,
      JSON.stringify([
        registration(),
        { ...registration(), workspace_id: 'bad', root: path.join(root, 'absent') },
      ]),
    );
    expect(await loadWorkspaceRegistry(file)).toEqual({
      state: 'invalid',
      accepted: 1,
      rejected: 1,
    });
    expect(listWorkspaces(owner).map((item) => item.workspace_id)).toEqual(['workspace-test']);
    expect(listWorkspaces('another-owner')).toEqual([]);
  });
});

describe('trusted finite workspace boundary', () => {
  test('rejects traversal, aliases, devices and noncanonical separators', () => {
    for (const value of [
      '/etc/passwd',
      'C:/a',
      '../a',
      'a/../b',
      'a//b',
      'a\\b',
      'a/',
      'NUL',
      'target.txt.',
      'a\0b',
    ])
      expect(() => canonicalRelativePath(value)).toThrow(WorkspaceDeniedError);
    expect(canonicalRelativePath('', true)).toBe('');
  });
  test('never lists another owner or discloses root', () => {
    expect(listWorkspaces('other')).toEqual([]);
    expect(JSON.stringify(listWorkspaces(owner))).not.toContain(root);
    expect(() => getWorkspaceGrant('other', 'workspace-test')).toThrow();
  });
  test('overlapping roots and duplicate physical identity disable both registrations', async () => {
    await configureWorkspaceRegistry([
      registration(),
      registration(path.join(root, 'sources'), 'child'),
    ]);
    expect(listWorkspaces(owner)).toEqual([]);
    await configureWorkspaceRegistry([registration(), registration(root, 'alias')]);
    expect(listWorkspaces(owner)).toEqual([]);
  });
  test('invalid registry clears old grant and writable paths must be readable', async () => {
    const grant = getWorkspaceGrant(owner, 'workspace-test');
    await configureWorkspaceRegistry([{ ...registration(), writable_paths: ['secret.txt'] }]);
    expect(() => validateWorkspaceGrant(owner, grant)).toThrow();
    expect(listWorkspaces(owner)).toEqual([]);
  });
  test('stable digest ignores path ordering but binds registration changes', async () => {
    const old = getWorkspaceGrant(owner, 'workspace-test');
    await configureWorkspaceRegistry([
      { ...registration(), readable_paths: [...registration().readable_paths].reverse() },
    ]);
    expect(getWorkspaceGrant(owner, 'workspace-test')).toEqual(old);
    await configureWorkspaceRegistry([{ ...registration(), label: 'Changed' }]);
    expect(() => validateWorkspaceGrant(owner, old)).toThrow();
  });
  test('read preserves exact BOM CRLF bytes and changes actual version', async () => {
    const grant = getWorkspaceGrant(owner, 'workspace-test');
    const first = await readWorkspaceFile(owner, grant, 'target.txt');
    expect(first.kind).toBe('read');
    if (first.kind !== 'read') throw Error('read required');
    expect(first.content).toBe('\uFEFFbefore\r\nold 中文\r\nafter  \r\n');
    expect(first.byte_length).toBe(Buffer.byteLength(first.content));
    await writeFile(path.join(root, 'target.txt'), 'changed');
    const next = await readWorkspaceFile(owner, grant, 'target.txt');
    expect(next.kind === 'read' && next.version).not.toBe(first.version);
  });
  test('strict utf8 rejects invalid bytes and isolated surrogates', () => {
    expect(() => strictUtf8(Buffer.from([0xc3, 0x28]))).toThrow();
    expect(() => utf8Bytes('\ud800')).toThrow();
    expect(strictUtf8(Buffer.from([0xef, 0xbb, 0xbf, 0x61]))).toBe('\uFEFFa');
  });
  test('list observes only actual authorized children and explicit misses', async () => {
    await writeFile(path.join(root, 'secret.txt'), 'never disclosed');
    const result = await listWorkspaceFiles(owner, getWorkspaceGrant(owner, 'workspace-test'), '');
    expect(result.entries.map((v) => v.path).sort()).toEqual(['sources', 'target.txt']);
    expect(result.failures).toContainEqual({
      kind: 'operation_error',
      path: 'missing.txt',
      reason: 'not_found',
    });
  });
  test('literal search carries versions, real lines and partial failures', async () => {
    const result = await searchWorkspaceFiles(
      owner,
      getWorkspaceGrant(owner, 'workspace-test'),
      '',
      'Date',
    );
    expect(result.matches.map((v) => v.line)).toEqual([1, 2]);
    expect(result.matches.every((v) => v.version.length === 64)).toBe(true);
    expect(result.failures[0]?.reason).toBe('not_found');
    expect(
      (await searchWorkspaceFiles(owner, getWorkspaceGrant(owner, 'workspace-test'), '', 'date'))
        .matches,
    ).toEqual([]);
  });
  test('hard links cannot expose aliased bytes', async () => {
    await rm(path.join(root, 'target.txt'));
    await link(path.join(root, 'sources/a.txt'), path.join(root, 'target.txt'));
    await expect(
      readWorkspaceFile(owner, getWorkspaceGrant(owner, 'workspace-test'), 'target.txt'),
    ).rejects.toBeInstanceOf(WorkspaceDeniedError);
  });
  test.skipIf(process.platform === 'win32')('symlink targets are denied', async () => {
    await rm(path.join(root, 'target.txt'));
    await symlink(path.join(root, 'sources/a.txt'), path.join(root, 'target.txt'));
    await expect(
      readWorkspaceFile(owner, getWorkspaceGrant(owner, 'workspace-test'), 'target.txt'),
    ).rejects.toBeInstanceOf(WorkspaceDeniedError);
  });
  test('unregistered path denies without returning bytes', async () => {
    await writeFile(path.join(root, 'secret.txt'), 'sensitive');
    await expect(
      readWorkspaceFile(owner, getWorkspaceGrant(owner, 'workspace-test'), 'secret.txt'),
    ).rejects.toBeInstanceOf(WorkspaceDeniedError);
  });
  test('version conflict proves zero write with invocation binding', async () => {
    const grant = getWorkspaceGrant(owner, 'workspace-test');
    const calls: string[] = [];
    const client = {
      query: async (sql: string) => {
        calls.push(sql);
        return { rows: [] };
      },
    } as unknown as PoolClient;
    const content = 'approved';
    const result = await applyWorkspaceReplace(
      client,
      owner,
      grant,
      {
        approval_id: '00000000-0000-4000-8000-000000000001',
        path: 'target.txt',
        base_version: '0'.repeat(64),
        exact_new_content: content,
        new_version: hashBytes(Buffer.from(content)),
      },
      { invocation_id: '00000000-0000-4000-8000-000000000002', args_hash: 'bound' },
    );
    expect(result.kind).toBe('conflict');
    expect(result.kind === 'conflict' && result.zero_write).toBe(true);
    expect(result.args_hash).toBe('bound');
    expect(calls[0]).toContain('pg_advisory_lock');
    expect(calls[1]).toContain('pg_advisory_unlock');
    expect((await readWorkspaceFile(owner, grant, 'target.txt')).kind).toBe('read');
  });
  test.skipIf(process.platform === 'win32')(
    'approved replacement preserves all unrelated bytes and readback',
    async () => {
      const grant = getWorkspaceGrant(owner, 'workspace-test');
      const base = await readWorkspaceFile(owner, grant, 'target.txt');
      if (base.kind !== 'read') throw Error('read required');
      const content = base.content.replace('old 中文', 'new 中文');
      const client = { query: async () => ({ rows: [] }) } as unknown as PoolClient;
      const result = await applyWorkspaceReplace(
        client,
        owner,
        grant,
        {
          approval_id: '00000000-0000-4000-8000-000000000001',
          path: 'target.txt',
          base_version: base.version,
          exact_new_content: content,
          new_version: hashBytes(Buffer.from(content)),
        },
        { invocation_id: '00000000-0000-4000-8000-000000000002', args_hash: 'bound' },
      );
      expect(result.kind).toBe('applied');
      expect(await readWorkspaceFile(owner, grant, 'target.txt')).toMatchObject({
        kind: 'read',
        content,
        version: hashBytes(Buffer.from(content)),
      });
    },
  );
});
