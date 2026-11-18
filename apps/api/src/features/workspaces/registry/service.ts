import { lstat, realpath, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { WorkspaceGrant, WorkspaceSummary } from '@along/contracts';
import {
  canonicalRelativePath,
  checkedDirectory,
  hashBytes,
  inside,
  workspaceIdentity,
  WorkspaceDeniedError,
} from './path-policy.js';
export interface WorkspaceRegistration extends WorkspaceSummary {
  owner_id: string;
  root: string;
}
interface ActiveRegistration extends WorkspaceRegistration {
  registration_digest: string;
  root_identity: string;
  output_identities?: { path: string; identity: string }[];
}
const registry = new Map<string, ActiveRegistration>();
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
              'output_directories',
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
        (item.output_directories !== undefined && !Array.isArray(item.output_directories)) ||
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
      const stat = await lstat(root, { bigint: true });
      const root_identity = workspaceIdentity(stat);
      const outputs =
        item.output_directories === undefined
          ? undefined
          : [...new Set(item.output_directories.map((v) => canonicalRelativePath(v, true)))].sort();
      const output_identities =
        outputs === undefined
          ? undefined
          : await Promise.all(
              outputs.map(async (relative) => {
                const directory = path.join(root, ...relative.split('/').filter(Boolean));
                await checkedDirectory(directory);
                if ((await realpath(directory)) !== directory) throw new WorkspaceDeniedError();
                return {
                  path: relative,
                  identity: workspaceIdentity(await lstat(directory, { bigint: true })),
                };
              }),
            );
      const material = {
        workspace_id: item.workspace_id,
        label: item.label,
        owner_id: item.owner_id,
        root,
        readable_paths: readable,
        writable_paths: writable,
        root_identity,
        ...(outputs === undefined ? {} : { output_directories: outputs, output_identities }),
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
export function selected(ownerId: string, grant: WorkspaceGrant): ActiveRegistration {
  const item = registry.get(grant.workspace_id);
  if (
    !item ||
    item.owner_id !== ownerId ||
    grant.owner_id !== ownerId ||
    item.registration_digest !== grant.registration_digest ||
    item.root_identity !== grant.root_identity ||
    (grant.output_directories !== undefined &&
      (new Set(grant.output_directories.map((entry) => entry.path)).size !==
        grant.output_directories.length ||
        grant.output_directories.some(
          (entry) =>
            !item.output_identities?.some(
              (current) => current.path === entry.path && current.identity === entry.identity,
            ),
        )))
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
    ...(item.output_directories === undefined
      ? {}
      : { output_directories: [...item.output_directories] }),
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
      ...(item.output_identities === undefined
        ? {}
        : { output_directories: item.output_identities.map((v) => ({ ...v })) }),
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
  const item = selected(ownerId, grant);
  const result = summary(item);
  if (!grant.output_directories) delete result.output_directories;
  else result.output_directories = grant.output_directories.map((entry) => entry.path);
  return result;
}
export interface AuthorizedCreatedPath {
  path: string;
  directory_identity: string;
  file_identity: string;
  version: string;
}
export function getWorkspaceMcpConfiguration(
  ownerId: string,
  grant: WorkspaceGrant,
  authorizedCreatedPaths: AuthorizedCreatedPath[] = [],
): string {
  const item = selected(ownerId, grant);
  return JSON.stringify({
    registration: { ...summary(item), owner_id: item.owner_id, root: item.root },
    grant,
    authorizedCreatedPaths,
  });
}
export function withinOutput(relative: string, directory: string): boolean {
  return directory === '' ? relative !== '' : relative.startsWith(`${directory}/`);
}

export function isWorkspaceOutputDirectory(grant: WorkspaceGrant, directory: string): boolean {
  canonicalRelativePath(directory, true);
  return (grant.output_directories ?? []).some(
    (entry) => entry.path === directory || withinOutput(directory, entry.path),
  );
}

export function isWorkspaceReadablePath(
  ownerId: string,
  grant: WorkspaceGrant,
  relative: string,
  authorizedCreatedPaths: AuthorizedCreatedPath[] = [],
): boolean {
  canonicalRelativePath(relative);
  const item = selected(ownerId, grant);
  if (item.readable_paths.includes(relative)) return true;
  const slash = relative.lastIndexOf('/');
  const directory = slash < 0 ? '' : relative.slice(0, slash);
  return (
    isWorkspaceOutputDirectory(grant, directory) &&
    authorizedCreatedPaths.some(
      (entry) =>
        entry.path === relative &&
        !!entry.directory_identity &&
        !!entry.file_identity &&
        /^[a-f0-9]{64}$/u.test(entry.version),
    )
  );
}

export function isWorkspaceReadableDirectory(
  ownerId: string,
  grant: WorkspaceGrant,
  directory: string,
  authorizedCreatedPaths: AuthorizedCreatedPath[] = [],
): boolean {
  canonicalRelativePath(directory, true);
  const item = selected(ownerId, grant);
  const paths = [
    ...item.readable_paths,
    ...authorizedCreatedPaths
      .filter((entry) =>
        isWorkspaceReadablePath(ownerId, grant, entry.path, authorizedCreatedPaths),
      )
      .map((entry) => entry.path),
  ];
  return directory === '' || paths.some((v) => v.startsWith(`${directory}/`));
}
