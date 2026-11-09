import { describe, expect, test } from 'bun:test';
import { lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  configureWorkspaceRegistry,
  getWorkspaceGrant,
  resolveWorkspaceGrants,
  getWorkspaceOutputIdentity,
  readWorkspaceBytes,
  hashBytes,
  validateWorkspaceGrant,
} from '../src/modules/workspaces/service.js';

describe('workspace physical identity', () => {
  test('registers separate directories and preserves safe legacy grants without accepting unsafe numeric grants', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'along-identity-'));
    try {
      let root = path.join(directory, 'first');
      await mkdir(root);
      if (process.platform === 'win32') {
        for (let index = 0; index < 256; index++) {
          const stat = await lstat(root, { bigint: true });
          if (
            stat.dev > BigInt(Number.MAX_SAFE_INTEGER) ||
            stat.ino > BigInt(Number.MAX_SAFE_INTEGER)
          )
            break;
          root = path.join(directory, `candidate-${index}`);
          await mkdir(root);
        }
      }
      const second = path.join(directory, 'second');
      const output = path.join(root, 'output');
      await mkdir(second);
      await mkdir(output);
      await writeFile(path.join(root, 'note.txt'), 'identity check');
      const registration = {
        workspace_id: 'identity-workspace',
        owner_id: 'identity-owner',
        label: 'Identity',
        root,
        readable_paths: ['note.txt'],
        writable_paths: [],
        output_directories: ['output'],
      };
      const other = {
        ...registration,
        workspace_id: 'other',
        root: second,
        output_directories: [],
      };
      expect((await configureWorkspaceRegistry([registration, other])).state).toBe('loaded');
      const grant = getWorkspaceGrant(registration.owner_id, registration.workspace_id);
      const frozen = resolveWorkspaceGrants(registration.owner_id).grants.find(
        (item) => item.workspace_id === registration.workspace_id,
      )!;
      expect(await getWorkspaceOutputIdentity(registration.owner_id, frozen, 'output')).toBe(
        frozen.output_directories![0]!.identity,
      );
      expect(
        (await readWorkspaceBytes(registration.owner_id, grant, 'note.txt')).bytes.toString(),
      ).toBe('identity check');
      const rootStat = await lstat(root, { bigint: true });
      const outputStat = await lstat(output, { bigint: true });
      const legacyIdentity = (stat: typeof rootStat) => `${Number(stat.dev)}:${Number(stat.ino)}`;
      const root_identity = legacyIdentity(rootStat);
      const output_identities = [{ path: 'output', identity: legacyIdentity(outputStat) }];
      const legacyMaterial = {
        workspace_id: registration.workspace_id,
        label: registration.label,
        owner_id: registration.owner_id,
        root,
        readable_paths: registration.readable_paths,
        writable_paths: registration.writable_paths,
        root_identity,
        output_directories: registration.output_directories,
        output_identities,
      };
      const legacy = {
        ...grant,
        root_identity,
        registration_digest: hashBytes(Buffer.from(JSON.stringify(legacyMaterial))),
      };
      const safe = [rootStat.dev, rootStat.ino, outputStat.dev, outputStat.ino].every(
        (value) => value <= BigInt(Number.MAX_SAFE_INTEGER),
      );
      if (safe) expect(() => validateWorkspaceGrant(registration.owner_id, legacy)).not.toThrow();
      else expect(() => validateWorkspaceGrant(registration.owner_id, legacy)).toThrow();
    } finally {
      await configureWorkspaceRegistry([]);
      await rm(directory, { recursive: true, force: true });
    }
  });
});
