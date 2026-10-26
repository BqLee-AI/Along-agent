import { randomUUID } from 'node:crypto';
import { open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { PoolClient } from 'pg';
import type {
  WorkspaceGrant,
  WorkspaceAppliedResult,
  WorkspaceConflictResult,
} from '@along/contracts';
import {
  readWorkspaceBytes,
  hashBytes,
  utf8Bytes,
  strictUtf8,
  validateWorkspaceGrant,
  type WorkspaceFileBytes,
} from './service.js';

export interface ApprovedWorkspaceTarget {
  approval_id: string;
  path: string;
  base_version: string;
  exact_new_content: string;
  new_version: string;
}
export interface WorkspaceInvocationBinding {
  invocation_id: string;
  args_hash: string;
}
/** The caller supplies a dedicated checked-out client, outside its qualification transaction. */
export async function applyWorkspaceReplace(
  client: PoolClient,
  ownerId: string,
  grant: WorkspaceGrant,
  target: ApprovedWorkspaceTarget,
  binding: WorkspaceInvocationBinding,
): Promise<WorkspaceAppliedResult | WorkspaceConflictResult> {
  validateWorkspaceGrant(ownerId, grant);
  const bytes = utf8Bytes(target.exact_new_content);
  strictUtf8(bytes);
  if (hashBytes(bytes) !== target.new_version) throw new Error('Invalid frozen document target');
  const lock = `along:workspace:${grant.workspace_id}`;
  await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [lock]);
  let temporary: string | undefined;
  try {
    validateWorkspaceGrant(ownerId, grant);
    const conflict = (
      reason: WorkspaceConflictResult['reason'],
      actual_version: string | null,
    ): WorkspaceConflictResult => ({
      kind: 'conflict',
      workspace_id: grant.workspace_id,
      path: target.path,
      approval_id: target.approval_id,
      ...binding,
      base_version: target.base_version,
      actual_version,
      reason,
      zero_write: true,
    });
    let base: WorkspaceFileBytes;
    try {
      base = await readWorkspaceBytes(ownerId, grant, target.path, true);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === 'ENOENT') return conflict('not_found', null);
      if (code === 'EACCES' || code === 'EPERM') return conflict('unreadable', null);
      throw error;
    }
    const actual = hashBytes(base.bytes);
    if (actual !== target.base_version) return conflict('version_changed', actual);
    temporary = path.join(path.dirname(base.absolute), `.along-${randomUUID()}.tmp`);
    const handle = await open(temporary, 'wx', base.stat.mode & 0o777);
    try {
      await handle.chmod(base.stat.mode & 0o777);
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    const current = await readWorkspaceBytes(ownerId, grant, target.path, true);
    if (
      current.stat.dev !== base.stat.dev ||
      current.stat.ino !== base.stat.ino ||
      current.parent_identity !== base.parent_identity
    )
      return conflict('identity_changed', hashBytes(current.bytes));
    if (hashBytes(current.bytes) !== target.base_version)
      return conflict('version_changed', hashBytes(current.bytes));
    await rename(temporary, base.absolute);
    temporary = undefined;
    const parent = await open(path.dirname(base.absolute), 'r');
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
    const observed = await readWorkspaceBytes(ownerId, grant, target.path, true);
    if (!observed.bytes.equals(bytes) || hashBytes(observed.bytes) !== target.new_version)
      throw new Error('Workspace replacement readback uncertain');
    return {
      kind: 'applied',
      workspace_id: grant.workspace_id,
      path: target.path,
      approval_id: target.approval_id,
      ...binding,
      base_version: target.base_version,
      version: target.new_version,
      byte_length: observed.bytes.length,
      evidence_ref: `workspace-apply:${binding.invocation_id}:${target.new_version}`,
    };
  } finally {
    try {
      if (temporary) await unlink(temporary);
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [lock]);
    }
  }
}
