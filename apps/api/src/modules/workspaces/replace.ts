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

export interface WorkspaceReplaceTarget {
  path: string;
  base_version: string;
  exact_new_content: string;
  new_version: string;
}
export interface ApprovedWorkspaceTarget extends WorkspaceReplaceTarget {
  approval_id: string;
}
export type WorkspaceEditChange =
  | { kind: 'literal'; old_text: string; new_text: string }
  | { kind: 'full'; new_content: string };

export function compileWorkspaceEdit(
  content: string,
  change: WorkspaceEditChange,
):
  | { ok: true; exact_new_content: string; new_version: string }
  | { ok: false; reason: 'literal_not_found' | 'literal_not_unique' | 'unchanged' } {
  utf8Bytes(content);
  let exact_new_content: string;
  if (change.kind === 'literal') {
    utf8Bytes(change.old_text);
    utf8Bytes(change.new_text);
    if (!change.old_text) return { ok: false, reason: 'literal_not_found' };
    if (change.old_text === change.new_text) return { ok: false, reason: 'unchanged' };
    const start = content.indexOf(change.old_text);
    if (start < 0) return { ok: false, reason: 'literal_not_found' };
    if (content.indexOf(change.old_text, start + 1) >= 0)
      return { ok: false, reason: 'literal_not_unique' };
    exact_new_content =
      content.slice(0, start) + change.new_text + content.slice(start + change.old_text.length);
  } else {
    exact_new_content = change.new_content;
  }
  const bytes = utf8Bytes(exact_new_content);
  if (exact_new_content === content) return { ok: false, reason: 'unchanged' };
  return { ok: true, exact_new_content, new_version: hashBytes(bytes) };
}

export type WorkspacePublicationResult =
  | { kind: 'applied'; version: string; byte_length: number }
  | {
      kind: 'conflict';
      actual_version: string | null;
      reason: WorkspaceConflictResult['reason'];
      zero_write: true;
    };
export interface WorkspaceInvocationBinding {
  invocation_id: string;
  args_hash: string;
}
/** The caller supplies a dedicated checked-out client, outside its qualification transaction. */
export async function publishWorkspaceReplace(
  client: PoolClient,
  ownerId: string,
  grant: WorkspaceGrant,
  target: WorkspaceReplaceTarget,
): Promise<WorkspacePublicationResult> {
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
    ): WorkspacePublicationResult => ({
      kind: 'conflict',
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
    const mode = Number(base.stat.mode & 0o777n);
    const handle = await open(temporary, 'wx', mode);
    try {
      await handle.chmod(mode);
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
    return { kind: 'applied', version: target.new_version, byte_length: observed.bytes.length };
  } finally {
    try {
      if (temporary) await unlink(temporary);
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [lock]);
    }
  }
}

export async function applyWorkspaceReplace(
  client: PoolClient,
  ownerId: string,
  grant: WorkspaceGrant,
  target: ApprovedWorkspaceTarget,
  binding: WorkspaceInvocationBinding,
): Promise<WorkspaceAppliedResult | WorkspaceConflictResult> {
  const result = await publishWorkspaceReplace(client, ownerId, grant, target);
  const common = {
    workspace_id: grant.workspace_id,
    path: target.path,
    approval_id: target.approval_id,
    ...binding,
    base_version: target.base_version,
  };
  if (result.kind === 'conflict') return { ...common, ...result };
  return {
    ...common,
    ...result,
    evidence_ref: `workspace-apply:${binding.invocation_id}:${target.new_version}`,
  };
}
