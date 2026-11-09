import { randomUUID } from 'node:crypto';
import { link, lstat, open, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { PoolClient } from 'pg';
import type { WorkspaceGrant } from '@along/contracts';
import {
  canonicalWorkspaceFilename,
  checkedWorkspaceOutputDirectory,
  hashBytes,
  readWorkspaceBytes,
  utf8Bytes,
  workspaceIdentity,
  WorkspaceDeniedError,
} from './service.js';

export interface WorkspaceCreateTarget {
  output_directory: string;
  directory_identity: string;
  path: string;
  exact_new_content: string;
  new_version: string;
}

export type WorkspaceCreatePublicationResult =
  | { kind: 'applied'; version: string; byte_length: number; file_identity: string }
  | { kind: 'conflict'; reason: 'already_exists'; zero_write: true }
  | { kind: 'failed'; reason: 'unavailable'; zero_write: true };

/** Called only by the execution stack that received the committed once-permit. */
export async function publishWorkspaceCreate(
  client: PoolClient,
  ownerId: string,
  grant: WorkspaceGrant,
  target: WorkspaceCreateTarget,
): Promise<WorkspaceCreatePublicationResult> {
  const prefix = target.output_directory ? `${target.output_directory}/` : '';
  if (!target.path.startsWith(prefix)) throw new WorkspaceDeniedError();
  const filename = canonicalWorkspaceFilename(target.path.slice(prefix.length));
  const bytes = utf8Bytes(target.exact_new_content);
  if (hashBytes(bytes) !== target.new_version) throw new Error('Invalid frozen document target');
  const lock = `along:workspace:${grant.workspace_id}`;
  let temporaryIdentity: { dev: bigint; ino: bigint } | undefined;
  await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [lock]);
  let temporary: string | undefined;
  let linkStarted = false;
  let published = false;
  try {
    const directory = await checkedWorkspaceOutputDirectory(
      ownerId,
      grant,
      target.output_directory,
    );
    if (directory.identity !== target.directory_identity) throw new WorkspaceDeniedError();
    const destination = path.join(directory.absolute, filename);
    temporary = path.join(directory.absolute, `.along-${randomUUID()}.tmp`);
    const handle = await open(temporary, 'wx', 0o600);
    let dev: bigint;
    let ino: bigint;
    try {
      const initial = await handle.stat({ bigint: true });
      temporaryIdentity = { dev: initial.dev, ino: initial.ino };
      await handle.writeFile(bytes);
      await handle.sync();
      const stat = await handle.stat({ bigint: true });
      if (!stat.isFile() || stat.nlink !== 1n) throw new WorkspaceDeniedError();
      dev = stat.dev;
      ino = stat.ino;
    } finally {
      await handle.close();
    }
    const again = await checkedWorkspaceOutputDirectory(ownerId, grant, target.output_directory);
    if (again.identity !== directory.identity || again.absolute !== directory.absolute)
      throw new WorkspaceDeniedError();
    const tempStat = await lstat(temporary, { bigint: true });
    if (!tempStat.isFile() || tempStat.nlink !== 1n || tempStat.dev !== dev || tempStat.ino !== ino)
      throw new WorkspaceDeniedError();
    linkStarted = true;
    try {
      await link(temporary, destination);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EEXIST')
        return { kind: 'conflict', reason: 'already_exists', zero_write: true };
      if (
        code &&
        ['ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'EPERM', 'EACCES', 'EROFS'].includes(code)
      )
        return { kind: 'failed', reason: 'unavailable', zero_write: true };
      throw error;
    }
    published = true;
    await unlink(temporary);
    temporary = undefined;
    const parent = await open(directory.absolute, 'r');
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
    const fileIdentity = workspaceIdentity({ dev, ino });
    const observed = await readWorkspaceBytes(ownerId, grant, target.path, false, [
      {
        path: target.path,
        directory_identity: target.directory_identity,
        file_identity: fileIdentity,
        version: target.new_version,
      },
    ]);
    if (observed.stat.dev !== dev || observed.stat.ino !== ino || !observed.bytes.equals(bytes))
      throw new Error('Workspace creation readback uncertain');
    return {
      kind: 'applied',
      version: target.new_version,
      byte_length: observed.bytes.length,
      file_identity: fileIdentity,
    };
  } catch (error) {
    if (error instanceof WorkspaceDeniedError || linkStarted || published) throw error;
    return { kind: 'failed', reason: 'unavailable', zero_write: true };
  } finally {
    try {
      if (temporary && temporaryIdentity && !published) {
        const current = await lstat(temporary, { bigint: true }).catch(() => undefined);
        if (
          current?.isFile() &&
          current.dev === temporaryIdentity.dev &&
          current.ino === temporaryIdentity.ino
        )
          await unlink(temporary).catch(() => {});
      }
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [lock]);
    }
  }
}
