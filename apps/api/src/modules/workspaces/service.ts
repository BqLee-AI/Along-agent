import { createHash } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, realpath, open, readFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  WorkspaceGrant,
  WorkspaceSummary,
  WorkspaceReadResult,
  WorkspaceOperationError,
} from '@along/contracts';
import { HttpError } from '../../http/errors.js';

export class WorkspaceDeniedError extends HttpError {
  constructor() {
    super(403, 403, 'PERMISSION_DENIED', 'Workspace authorization denied');
    this.name = 'WorkspaceDeniedError';
  }
}
export interface WorkspaceRegistration extends WorkspaceSummary {
  owner_id: string;
  root: string;
}
interface ActiveRegistration extends WorkspaceRegistration {
  registration_digest: string;
  root_identity: string;
}
const registry = new Map<string, ActiveRegistration>();
export const hashBytes = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');
export function canonicalRelativePath(value: string, directory = false): string {
  if (
    typeof value !== 'string' ||
    (!directory && !value) ||
    value.includes('\\') ||
    value.includes('\0') ||
    value.includes(':') ||
    value.startsWith('/') ||
    value
      .split('/')
      .some(
        (part) =>
          part === '.' ||
          part === '..' ||
          (part === '' && value !== '') ||
          /[. ]$/u.test(part) ||
          /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part),
      )
  )
    throw new WorkspaceDeniedError();
  for (let index = 0; index < value.length; index++) {
    if (value.charCodeAt(index) < 32) throw new WorkspaceDeniedError();
  }
  return value;
}
export function strictUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
}
export function utf8Bytes(value: string): Buffer {
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value))
    throw new WorkspaceDeniedError();
  return Buffer.from(value, 'utf8');
}
function identity(stat: { dev: number; ino: number }): string {
  return `${stat.dev}:${stat.ino}`;
}
function inside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}
async function checkedDirectory(directory: string): Promise<void> {
  const parsed = path.parse(directory);
  let current = parsed.root;
  for (const component of directory.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new WorkspaceDeniedError();
    if (process.platform !== 'win32') {
      if ((stat.mode & 0o022) !== 0 && !(current !== directory && (stat.mode & 0o1000) !== 0))
        throw new WorkspaceDeniedError();
      if (stat.uid !== 0 && stat.uid !== process.getuid?.()) throw new WorkspaceDeniedError();
    }
  }
}
export interface RegistryLoadReport {
  state: 'unconfigured' | 'loaded' | 'invalid' | 'unreadable';
  accepted: number;
  rejected: number;
}
let registryReport: RegistryLoadReport = { state: 'unconfigured', accepted: 0, rejected: 0 };
export function getWorkspaceAccountStatus(): RegistryLoadReport & { ownerIds: string[] } {
  return {
    ...registryReport,
    ownerIds: [...new Set([...registry.values()].map((item) => item.owner_id))],
  };
}
export async function configureWorkspaceRegistry(input: unknown): Promise<RegistryLoadReport> {
  registry.clear();
  if (!Array.isArray(input))
    return (registryReport = { state: 'invalid', accepted: 0, rejected: 0 });
  const candidates: ActiveRegistration[] = [];
  for (const value of input) {
    try {
      if (
        !value ||
        typeof value !== 'object' ||
        Object.keys(value).some(
          (key) =>
            ![
              'workspace_id',
              'label',
              'owner_id',
              'root',
              'readable_paths',
              'writable_paths',
            ].includes(key),
        )
      )
        continue;
      const item = value as WorkspaceRegistration;
      if (
        ![item.workspace_id, item.owner_id, item.label, item.root].every(
          (v) => typeof v === 'string' && v.length > 0,
        ) ||
        !Array.isArray(item.readable_paths) ||
        !Array.isArray(item.writable_paths) ||
        !path.isAbsolute(item.root)
      )
        continue;
      const readable = [
        ...new Set(item.readable_paths.map((v) => canonicalRelativePath(v))),
      ].sort();
      const writable = [
        ...new Set(item.writable_paths.map((v) => canonicalRelativePath(v))),
      ].sort();
      if (writable.some((v) => !readable.includes(v))) continue;
      await checkedDirectory(item.root);
      const root = await realpath(item.root);
      if (path.resolve(item.root) !== root) continue;
      const stat = await lstat(root);
      const root_identity = identity(stat);
      const material = {
        workspace_id: item.workspace_id,
        label: item.label,
        owner_id: item.owner_id,
        root,
        readable_paths: readable,
        writable_paths: writable,
        root_identity,
      };
      candidates.push({
        ...material,
        registration_digest: hashBytes(Buffer.from(JSON.stringify(material))),
      });
    } catch {
      /* Invalid deployment entries are inactive, not application-fatal. */
    }
  }
  const conflicts = new Set<ActiveRegistration>();
  for (let a = 0; a < candidates.length; a++)
    for (let b = a + 1; b < candidates.length; b++) {
      const x = candidates[a]!;
      const y = candidates[b]!;
      if (
        x.workspace_id === y.workspace_id ||
        x.root_identity === y.root_identity ||
        inside(x.root, y.root) ||
        inside(y.root, x.root)
      ) {
        conflicts.add(x);
        conflicts.add(y);
      }
    }
  for (const item of candidates) if (!conflicts.has(item)) registry.set(item.workspace_id, item);
  return (registryReport = {
    state: registry.size === input.length ? 'loaded' : 'invalid',
    accepted: registry.size,
    rejected: input.length - registry.size,
  });
}
export async function loadWorkspaceRegistry(
  file = process.env.WORKSPACE_REGISTRY_FILE,
): Promise<RegistryLoadReport> {
  if (!file) {
    registry.clear();
    return (registryReport = { state: 'unconfigured', accepted: 0, rejected: 0 });
  }
  try {
    return await configureWorkspaceRegistry(JSON.parse(await readFile(file, 'utf8')));
  } catch (error) {
    registry.clear();
    return (registryReport = {
      state: error instanceof SyntaxError ? 'invalid' : 'unreadable',
      accepted: 0,
      rejected: 0,
    });
  }
}
function selected(ownerId: string, grant: WorkspaceGrant): ActiveRegistration {
  const item = registry.get(grant.workspace_id);
  if (
    !item ||
    item.owner_id !== ownerId ||
    grant.owner_id !== ownerId ||
    item.registration_digest !== grant.registration_digest ||
    item.root_identity !== grant.root_identity
  )
    throw new WorkspaceDeniedError();
  return item;
}
function summary(item: WorkspaceRegistration): WorkspaceSummary {
  return {
    workspace_id: item.workspace_id,
    label: item.label,
    readable_paths: [...item.readable_paths],
    writable_paths: [...item.writable_paths],
  };
}
export function listWorkspaces(ownerId: string): WorkspaceSummary[] {
  return [...registry.values()].filter((v) => v.owner_id === ownerId).map(summary);
}
export function getWorkspaceGrant(ownerId: string, id: string): WorkspaceGrant {
  const item = registry.get(id);
  if (!item || item.owner_id !== ownerId) throw new WorkspaceDeniedError();
  return {
    workspace_id: id,
    owner_id: ownerId,
    registration_digest: item.registration_digest,
    root_identity: item.root_identity,
  };
}
/** Freeze one owner-scoped registry snapshot; an explicit selection must be exact. */
export function resolveWorkspaceGrants(
  ownerId: string,
  ids?: string[],
): { grants: WorkspaceGrant[]; summaries: WorkspaceSummary[] } {
  if (ids && (ids.length === 0 || new Set(ids).size !== ids.length))
    throw new WorkspaceDeniedError();
  const items = ids
    ? ids.map((id) => {
        const item = registry.get(id);
        if (!item || item.owner_id !== ownerId) throw new WorkspaceDeniedError();
        return item;
      })
    : [...registry.values()].filter((item) => item.owner_id === ownerId);
  items.sort((a, b) =>
    a.workspace_id < b.workspace_id ? -1 : a.workspace_id > b.workspace_id ? 1 : 0,
  );
  return {
    grants: items.map((item) => ({
      workspace_id: item.workspace_id,
      owner_id: item.owner_id,
      registration_digest: item.registration_digest,
      root_identity: item.root_identity,
    })),
    summaries: items.map(summary),
  };
}

/** Select only a member of the frozen Run set and revalidate its registration. */
export function resolveFrozenWorkspaceGrant(
  ownerId: string,
  grants: WorkspaceGrant[],
  workspaceId: string,
): WorkspaceGrant {
  const matches = grants.filter((grant) => grant.workspace_id === workspaceId);
  if (matches.length !== 1) throw new WorkspaceDeniedError();
  selected(ownerId, matches[0]!);
  return matches[0]!;
}

export function validateWorkspaceGrant(ownerId: string, grant: WorkspaceGrant): WorkspaceSummary {
  return summary(selected(ownerId, grant));
}
export function getWorkspaceMcpConfiguration(ownerId: string, grant: WorkspaceGrant): string {
  const item = selected(ownerId, grant);
  return JSON.stringify({ ...summary(item), owner_id: item.owner_id, root: item.root });
}
export interface CheckedWorkspaceTarget {
  absolute: string;
  stat: Stats;
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
): Promise<CheckedWorkspaceTarget> {
  canonicalRelativePath(relative);
  const item = selected(ownerId, grant);
  if (!(write ? item.writable_paths : item.readable_paths).includes(relative))
    throw new WorkspaceDeniedError();
  await checkedDirectory(item.root);
  if (
    identity(await lstat(item.root)) !== item.root_identity ||
    (await realpath(item.root)) !== item.root
  )
    throw new WorkspaceDeniedError();
  const absolute = path.join(item.root, ...relative.split('/'));
  await checkedDirectory(path.dirname(absolute));
  const parent_identity = identity(await lstat(path.dirname(absolute)));
  const stat = await lstat(absolute);
  if (
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    stat.nlink !== 1 ||
    !inside(item.root, await realpath(absolute))
  )
    throw new WorkspaceDeniedError();
  return { absolute, stat, parent_identity };
}
export async function readWorkspaceBytes(
  ownerId: string,
  grant: WorkspaceGrant,
  relative: string,
  write = false,
): Promise<WorkspaceFileBytes> {
  const target = await checkedTarget(ownerId, grant, relative, write);
  const handle = await open(
    target.absolute,
    constants.O_RDONLY | (process.platform === 'linux' ? constants.O_NOFOLLOW : 0),
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || identity(stat) !== identity(target.stat))
      throw new WorkspaceDeniedError();
    const bytes = await handle.readFile();
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
): Promise<WorkspaceReadResult | WorkspaceOperationError> {
  try {
    const { bytes } = await readWorkspaceBytes(ownerId, grant, relative);
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
) {
  canonicalRelativePath(directory, true);
  const item = selected(ownerId, grant);
  const prefix = directory ? `${directory}/` : '';
  const paths = item.readable_paths.filter((v) => v.startsWith(prefix));
  if (directory && !paths.length) throw new WorkspaceDeniedError();
  const entries = new Map<string, { path: string; kind: 'file' | 'directory' }>();
  const failures: WorkspaceOperationError[] = [];
  for (const relative of paths) {
    try {
      await checkedTarget(ownerId, grant, relative);
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
  return { kind: 'list' as const, path: directory, entries: [...entries.values()], failures };
}
export async function searchWorkspaceFiles(
  ownerId: string,
  grant: WorkspaceGrant,
  directory: string,
  literal: string,
) {
  canonicalRelativePath(directory, true);
  utf8Bytes(literal);
  if (!literal) throw new WorkspaceDeniedError();
  const item = selected(ownerId, grant);
  const paths = item.readable_paths.filter(
    (v) => !directory || v === directory || v.startsWith(`${directory}/`),
  );
  if (directory && !paths.length) throw new WorkspaceDeniedError();
  const matches: { path: string; line: number; text: string; version: string }[] = [];
  const failures: WorkspaceOperationError[] = [];
  for (const relative of paths) {
    const read = await readWorkspaceFile(ownerId, grant, relative);
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
