import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { ApplicationError } from '../../../platform/errors.js';

export class WorkspaceDeniedError extends ApplicationError {
  constructor() {
    super(403, 'PERMISSION_DENIED', 'Workspace authorization denied');
    this.name = 'WorkspaceDeniedError';
  }
}
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
  utf8Bytes(value);
  return value;
}
const internalTemporaryName =
  /^\.along-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/u;
export function canonicalWorkspaceFilename(value: string): string {
  canonicalRelativePath(value);
  if (value.includes('/') || internalTemporaryName.test(value)) throw new WorkspaceDeniedError();
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
// A legacy numeric identity is ambiguous outside the safe integer range, even
// when its rounded value happens to equal the actual inode.
export function workspaceIdentity(stat: { dev: bigint; ino: bigint }): string {
  const limit = BigInt(Number.MAX_SAFE_INTEGER);
  const legacySafe =
    stat.dev >= -limit && stat.dev <= limit && stat.ino >= -limit && stat.ino <= limit;
  return `${legacySafe ? '' : 'exact:'}${stat.dev}:${stat.ino}`;
}
export function inside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}
export async function checkedDirectory(directory: string): Promise<void> {
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
