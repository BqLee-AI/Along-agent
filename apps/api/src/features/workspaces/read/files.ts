import { constants, type BigIntStats } from 'node:fs';
import { lstat, realpath, open } from 'node:fs/promises';
import path from 'node:path';
import type {
  WorkspaceGrant,
  WorkspaceReadResult,
  WorkspaceOperationError,
} from '@along/contracts';
import {
  isWorkspaceOutputDirectory,
  isWorkspaceReadableDirectory,
  isWorkspaceReadablePath,
  selected,
  withinOutput,
  type AuthorizedCreatedPath,
} from '../registry/service.js';
import {
  canonicalRelativePath,
  checkedDirectory,
  hashBytes,
  inside,
  strictUtf8,
  utf8Bytes,
  workspaceIdentity,
  WorkspaceDeniedError,
} from '../registry/path-policy.js';

export async function getWorkspaceOutputIdentity(
  ownerId: string,
  grant: WorkspaceGrant,
  outputDirectory: string,
): Promise<string> {
  canonicalRelativePath(outputDirectory, true);
  const item = selected(ownerId, grant);
  const entry = grant.output_directories?.find(
    (v) => v.path === outputDirectory || withinOutput(outputDirectory, v.path),
  );
  if (!entry) throw new WorkspaceDeniedError();
  let directoryIdentity: string;
  try {
    await checkedDirectory(item.root);
    if (
      workspaceIdentity(await lstat(item.root, { bigint: true })) !== item.root_identity ||
      (await realpath(item.root)) !== item.root
    )
      throw new WorkspaceDeniedError();
    const registered = path.join(item.root, ...entry.path.split('/').filter(Boolean));
    await checkedDirectory(registered);
    if (
      (await realpath(registered)) !== registered ||
      workspaceIdentity(await lstat(registered, { bigint: true })) !== entry.identity
    )
      throw new WorkspaceDeniedError();
    const absolute = path.join(item.root, ...outputDirectory.split('/').filter(Boolean));
    await checkedDirectory(absolute);
    if ((await realpath(absolute)) !== absolute) throw new WorkspaceDeniedError();
    directoryIdentity = workspaceIdentity(await lstat(absolute, { bigint: true }));
  } catch {
    throw new WorkspaceDeniedError();
  }
  return directoryIdentity;
}

export async function checkedWorkspaceOutputDirectory(
  ownerId: string,
  grant: WorkspaceGrant,
  outputDirectory: string,
): Promise<{ absolute: string; identity: string }> {
  const directoryIdentity = await getWorkspaceOutputIdentity(ownerId, grant, outputDirectory);
  const item = selected(ownerId, grant);
  return {
    absolute: path.join(item.root, ...outputDirectory.split('/').filter(Boolean)),
    identity: directoryIdentity,
  };
}

async function checkedOutputForPath(
  ownerId: string,
  grant: WorkspaceGrant,
  relative: string,
): Promise<void> {
  const matches = (grant.output_directories ?? []).filter((entry) =>
    withinOutput(relative, entry.path),
  );
  if (!matches.length) throw new WorkspaceDeniedError();
  await getWorkspaceOutputIdentity(ownerId, grant, matches[0]!.path);
}

export interface CheckedWorkspaceTarget {
  absolute: string;
  stat: BigIntStats;
  parent_identity: string;
}
export interface WorkspaceFileBytes extends CheckedWorkspaceTarget {
  bytes: Buffer;
}
export async function checkedTarget(
  ownerId: string,
  grant: WorkspaceGrant,
  relative: string,
  write = false,
  authorizedCreatedPaths: AuthorizedCreatedPath[] = [],
): Promise<CheckedWorkspaceTarget> {
  canonicalRelativePath(relative);
  const item = selected(ownerId, grant);
  if (
    write
      ? !item.writable_paths.includes(relative)
      : !isWorkspaceReadablePath(ownerId, grant, relative, authorizedCreatedPaths)
  )
    throw new WorkspaceDeniedError();
  if (!write && !item.readable_paths.includes(relative))
    await checkedOutputForPath(ownerId, grant, relative);
  await checkedDirectory(item.root);
  if (
    workspaceIdentity(await lstat(item.root, { bigint: true })) !== item.root_identity ||
    (await realpath(item.root)) !== item.root
  )
    throw new WorkspaceDeniedError();
  const absolute = path.join(item.root, ...relative.split('/'));
  await checkedDirectory(path.dirname(absolute));
  const parent_identity = workspaceIdentity(await lstat(path.dirname(absolute), { bigint: true }));
  if (
    !write &&
    !item.readable_paths.includes(relative) &&
    !authorizedCreatedPaths.some(
      (entry) => entry.path === relative && entry.directory_identity === parent_identity,
    )
  )
    throw new WorkspaceDeniedError();
  const stat = await lstat(absolute, { bigint: true });
  if (
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    stat.nlink !== 1n ||
    !inside(item.root, await realpath(absolute))
  )
    throw new WorkspaceDeniedError();
  if (
    !write &&
    !item.readable_paths.includes(relative) &&
    !authorizedCreatedPaths.some(
      (entry) =>
        entry.path === relative &&
        entry.directory_identity === parent_identity &&
        entry.file_identity === workspaceIdentity(stat),
    )
  )
    throw new WorkspaceDeniedError();
  return { absolute, stat, parent_identity };
}
export async function readWorkspaceBytes(
  ownerId: string,
  grant: WorkspaceGrant,
  relative: string,
  write = false,
  authorizedCreatedPaths: AuthorizedCreatedPath[] = [],
): Promise<WorkspaceFileBytes> {
  const target = await checkedTarget(ownerId, grant, relative, write, authorizedCreatedPaths);
  const handle = await open(
    target.absolute,
    constants.O_RDONLY | (process.platform === 'linux' ? constants.O_NOFOLLOW : 0),
  );
  try {
    const stat = await handle.stat({ bigint: true });
    if (
      !stat.isFile() ||
      stat.nlink !== 1n ||
      workspaceIdentity(stat) !== workspaceIdentity(target.stat)
    )
      throw new WorkspaceDeniedError();
    if (
      !write &&
      !selected(ownerId, grant).readable_paths.includes(relative) &&
      !authorizedCreatedPaths.some(
        (entry) =>
          entry.path === relative &&
          entry.directory_identity === target.parent_identity &&
          entry.file_identity === workspaceIdentity(stat),
      )
    )
      throw new WorkspaceDeniedError();
    const bytes = await handle.readFile();
    if (
      !write &&
      !selected(ownerId, grant).readable_paths.includes(relative) &&
      !authorizedCreatedPaths.some(
        (entry) =>
          entry.path === relative &&
          entry.directory_identity === target.parent_identity &&
          entry.file_identity === workspaceIdentity(stat) &&
          entry.version === hashBytes(bytes),
      )
    )
      throw new WorkspaceDeniedError();
    return { ...target, stat, bytes };
  } finally {
    await handle.close();
  }
}
export function operationFailure(relative: string, error: unknown): WorkspaceOperationError {
  if (error instanceof WorkspaceDeniedError) throw error;
  return {
    kind: 'operation_error',
    path: relative,
    reason:
      error instanceof TypeError
        ? 'invalid_utf8'
        : (error as NodeJS.ErrnoException)?.code === 'ENOENT'
          ? 'not_found'
          : 'unreadable',
  };
}
export async function readWorkspaceFile(
  ownerId: string,
  grant: WorkspaceGrant,
  relative: string,
  authorizedCreatedPaths: AuthorizedCreatedPath[] = [],
): Promise<WorkspaceReadResult | WorkspaceOperationError> {
  try {
    const { bytes } = await readWorkspaceBytes(
      ownerId,
      grant,
      relative,
      false,
      authorizedCreatedPaths,
    );
    return {
      kind: 'read',
      path: relative,
      version: hashBytes(bytes),
      byte_length: bytes.length,
      content: strictUtf8(bytes),
    };
  } catch (error) {
    return operationFailure(relative, error);
  }
}
export async function listWorkspaceFiles(
  ownerId: string,
  grant: WorkspaceGrant,
  directory: string,
  authorizedCreatedPaths: AuthorizedCreatedPath[] = [],
) {
  canonicalRelativePath(directory, true);
  const item = selected(ownerId, grant);
  const prefix = directory ? `${directory}/` : '';
  const paths = [
    ...new Set([...item.readable_paths, ...authorizedCreatedPaths.map((entry) => entry.path)]),
  ].filter(
    (v) =>
      v.startsWith(prefix) && isWorkspaceReadablePath(ownerId, grant, v, authorizedCreatedPaths),
  );
  if (!isWorkspaceReadableDirectory(ownerId, grant, directory, authorizedCreatedPaths)) {
    if (!isWorkspaceOutputDirectory(grant, directory)) throw new WorkspaceDeniedError();
    await getWorkspaceOutputIdentity(ownerId, grant, directory);
  }
  const entries = new Map<string, { path: string; kind: 'file' | 'directory' }>();
  const failures: WorkspaceOperationError[] = [];
  for (const relative of paths) {
    try {
      if (item.readable_paths.includes(relative)) await checkedTarget(ownerId, grant, relative);
      else await readWorkspaceBytes(ownerId, grant, relative, false, authorizedCreatedPaths);
      const rest = relative.slice(prefix.length);
      const first = rest.split('/')[0]!;
      entries.set(prefix + first, {
        path: prefix + first,
        kind: rest.includes('/') ? 'directory' : 'file',
      });
    } catch (error) {
      failures.push(operationFailure(relative, error));
    }
  }
  return {
    kind: 'list' as const,
    path: directory,
    ...(grant.output_directories ? { visibility: 'authorized_paths_only' as const } : {}),
    entries: [...entries.values()],
    failures,
  };
}
export async function searchWorkspaceFiles(
  ownerId: string,
  grant: WorkspaceGrant,
  directory: string,
  literal: string,
  authorizedCreatedPaths: AuthorizedCreatedPath[] = [],
) {
  canonicalRelativePath(directory, true);
  utf8Bytes(literal);
  if (!literal) throw new WorkspaceDeniedError();
  const item = selected(ownerId, grant);
  if (!isWorkspaceReadableDirectory(ownerId, grant, directory, authorizedCreatedPaths))
    throw new WorkspaceDeniedError();
  const paths = [
    ...new Set([...item.readable_paths, ...authorizedCreatedPaths.map((entry) => entry.path)]),
  ].filter(
    (v) =>
      (!directory || v === directory || v.startsWith(`${directory}/`)) &&
      isWorkspaceReadablePath(ownerId, grant, v, authorizedCreatedPaths),
  );
  const matches: { path: string; line: number; text: string; version: string }[] = [];
  const failures: WorkspaceOperationError[] = [];
  for (const relative of paths) {
    const read = await readWorkspaceFile(ownerId, grant, relative, authorizedCreatedPaths);
    if (read.kind === 'operation_error') {
      failures.push(read);
      continue;
    }
    for (const [index, text] of read.content.split(/\r\n|\n|\r/u).entries())
      if (text.includes(literal))
        matches.push({ path: relative, line: index + 1, text, version: read.version });
  }
  return { kind: 'search' as const, path: directory, matches, failures };
}
