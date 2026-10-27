import { afterEach, describe, expect, it } from 'bun:test';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  createConfig,
  loadConfig,
  saveConfig,
  updateConfig,
  validateConfig,
} from '../local/config.mjs';
import type { LocalConfig } from '../local/config.mjs';
import { withInstallationLock } from '../local/lock.mjs';

const execute = promisify(execFile);
const directories: string[] = [];
const fixture = () => createConfig({ mode: 'new', tzdbVersion: '2025b' });
async function location() {
  const directory = await mkdtemp(join(tmpdir(), 'along-config-test-'));
  directories.push(directory);
  return { directory, file: join(directory, 'local.json') };
}
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function privateAccess(path: string, directory: boolean) {
  if (process.platform !== 'win32') {
    expect((await stat(path)).mode & 0o777).toBe(directory ? 0o700 : 0o600);
    return;
  }
  const encoded = Buffer.from(path, 'utf16le').toString('base64');
  const script = `$ErrorActionPreference = 'Stop'; $p = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encoded}')); $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $acl = Get-Acl -LiteralPath $p; @{ owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value; current = $sid; protected = $acl.AreAccessRulesProtected; allowed = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | Where-Object { $_.AccessControlType -eq 'Allow' } | ForEach-Object { $_.IdentityReference.Value }) } | ConvertTo-Json -Compress`;
  const { stdout } = await execute(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    { windowsHide: true },
  );
  const acl = JSON.parse(stdout);
  expect(acl.owner).toBe(acl.current);
  expect(acl.protected).toBe(true);
  expect(acl.allowed.length).toBeGreaterThan(0);
  expect(acl.allowed.every((identity: string) => identity === acl.current)).toBe(true);
}

describe('strict local configuration', () => {
  it('new installations fix independent identities and credentials once, then round-trip unchanged', async () => {
    const { directory, file } = await location();
    const config = fixture();
    const other = fixture();
    expect(config.installationId).not.toBe(other.installationId);
    expect(config.authSecret).not.toBe(other.authSecret);
    expect(config.database.password).not.toBe(other.database.password);
    expect(config.postgresVolume).not.toBe(other.postgresVolume);
    expect(config.workspaceVolume).not.toBe(config.postgresVolume);
    expect(config.model).toBeNull();
    expect(config.registryFile).toBeNull();
    await saveConfig(file, config, { exclusive: true });
    expect(await loadConfig(file)).toEqual(config);
    await privateAccess(directory, true);
    await privateAccess(file, false);
    expect(await readdir(directory)).toEqual(['local.json']);
  }, 60_000);

  it('preserves an explicitly unauthenticated original model without introducing a key', async () => {
    const { file } = await location();
    const original = {
      ...fixture(),
      mode: 'adopt' as const,
      model: {
        baseUrl: 'http://127.0.0.1:8080/v1',
        name: 'original-model',
        apiKey: '',
        maxIterations: 7,
        maxTokens: 1234,
      },
    };
    await saveConfig(file, createConfig(original));
    expect((await loadConfig(file)).model).toEqual(original.model);
  }, 60_000);

  it('adoption preserves every original value and never fills a missing field', () => {
    const original = {
      ...fixture(),
      mode: 'adopt' as const,
      origin: 'http://localhost:3100',
      database: { user: 'original-user', name: 'original-database', password: 'original-password' },
      authSecret: 'original-auth-secret',
      model: {
        baseUrl: 'https://provider.invalid/custom',
        name: 'original-model',
        apiKey: 'original-model-key',
        maxIterations: 7,
        maxTokens: 1234,
      },
      registryFile: join(tmpdir(), 'original-registry.json'),
    };
    expect(createConfig(original)).toEqual(original);
    expect(createConfig(original).origin).toBe('http://localhost:3100');
    for (const key of Object.keys(original)) {
      const incomplete = { ...original };
      delete incomplete[key as keyof typeof incomplete];
      expect(() => createConfig(incomplete)).toThrow();
    }
    for (const key of ['user', 'name', 'password']) {
      const database = { ...original.database };
      delete database[key as keyof typeof database];
      expect(() => createConfig({ ...original, database })).toThrow();
    }
    expect(() => createConfig({ mode: 'adopt' })).toThrow();
    expect(() => createConfig({ tzdbVersion: '2025b' })).toThrow();
  });

  it('rejects unknown fields and invalid or ambiguous values at every persisted boundary', () => {
    const config = fixture();
    const invalid = [
      { ...config, secretTypo: 'do-not-print' },
      { ...config, ports: { ...config.ports, unknown: 1 } },
      { ...config, database: { ...config.database, unknown: 'do-not-print' } },
      {
        ...config,
        model: {
          baseUrl: 'https://provider.invalid',
          name: 'm',
          apiKey: 'k',
          maxIterations: 1,
          maxTokens: 1,
          unknown: true,
        },
      },
      { ...config, ports: { ...config.ports, web: config.ports.api } },
      { ...config, ports: { ...config.ports, postgres: 0 } },
      { ...config, ports: { ...config.ports, postgres: '55432' } },
      { ...config, postgresVolume: config.workspaceVolume },
      { ...config, workspaceMount: '/var/../data' },
      { ...config, registryFile: 'relative/registry.json' },
      { ...config, installationId: 'not-a-uuid' },
      { ...config, authSecret: '' },
      { ...config, origin: `https://localhost:${config.ports.web}` },
      { ...config, origin: `http://public.invalid:${config.ports.web}` },
      { ...config, origin: `http://localhost:${config.ports.web}/path` },
      { ...config, origin: `http://localhost:${config.ports.web}?query=1` },
      { ...config, origin: `http://localhost:${config.ports.web}#fragment` },
      { ...config, origin: `http://user:password@localhost:${config.ports.web}` },
      { ...config, origin: `http://localhost:${config.ports.web + 1}` },
    ];
    for (const value of invalid) expect(() => validateConfig(value)).toThrow();
    expect(() => createConfig({ mode: 'new', tzdbVersion: '2025b', unknown: true })).toThrow();
  });

  it('rejects replacement and exclusive publication failures without changing original bytes', async () => {
    const { directory, file } = await location();
    const original = fixture();
    await saveConfig(file, original);
    const bytes = await readFile(file);
    await expect(
      saveConfig(file, { ...original, unknownSecret: 'fixture-secret' }),
    ).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    expect(await readFile(file)).toEqual(bytes);
    await expect(saveConfig(file, fixture(), { exclusive: true })).rejects.toMatchObject({
      code: 'CONFIG_EXISTS',
    });
    expect(await readFile(file)).toEqual(bytes);
    expect(await readdir(directory)).toEqual(['local.json']);
    const next = {
      ...original,
      model: {
        baseUrl: 'https://provider.invalid',
        name: 'm',
        apiKey: 'fixture-key',
        maxIterations: 1,
        maxTokens: 32,
      },
    };
    await saveConfig(file, next);
    expect(await loadConfig(file)).toEqual(next);
    await privateAccess(file, false);
  }, 60_000);

  it('two exclusive creators publish exactly one complete private configuration', async () => {
    const { directory, file } = await location();
    const candidates = [fixture(), fixture()];
    const results = await Promise.allSettled(
      candidates.map((config) => saveConfig(file, config, { exclusive: true })),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const winner = results.findIndex((result) => result.status === 'fulfilled');
    expect(await loadConfig(file)).toEqual(candidates[winner]);
    const loser = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
    expect(loser.reason.code).toBe('CONFIG_EXISTS');
    expect(await readdir(directory)).toEqual(['local.json']);
    await privateAccess(file, false);
  }, 60_000);

  it('sanitizes missing, malformed and unknown-field load failures without manufacturing a config', async () => {
    const { file } = await location();
    await expect(loadConfig(file)).rejects.toMatchObject({ code: 'CONFIG_MISSING' });
    await expect(updateConfig(file, () => fixture())).rejects.toMatchObject({
      code: 'CONFIG_MISSING',
    });
    await saveConfig(file, fixture());
    for (const bytes of [
      '{"fixture-secret":',
      JSON.stringify({ ...fixture(), privateEndpoint: 'fixture-secret' }),
    ]) {
      await writeFile(file, bytes);
      const error = await loadConfig(file).catch((reason: Error & { code: string }) => reason);
      expect(error).toMatchObject({ code: 'CONFIG_INVALID' });
      expect(String(error)).not.toContain('fixture-secret');
      expect(String(error)).not.toContain(file);
      expect(await readFile(file, 'utf8')).toBe(bytes);
    }
  }, 60_000);

  it('refuses a publicly readable POSIX file instead of quietly consuming its secrets', async () => {
    if (process.platform === 'win32') return;
    const { file } = await location();
    await saveConfig(file, fixture());
    await chmod(file, 0o644);
    await expect(loadConfig(file)).rejects.toMatchObject({ code: 'CONFIG_PERMISSIONS' });
  });

  it('updates registry/model/origin through the installation lease while preserving identity and credentials', async () => {
    const { file } = await location();
    const original = fixture();
    await saveConfig(file, original);
    const registryFile = join(tmpdir(), 'authorized-registry.json');
    const model = {
      baseUrl: 'https://authorized.invalid',
      name: 'explicit-model',
      apiKey: 'fixture-key',
      maxIterations: 2,
      maxTokens: 2048,
    };
    const origin = `http://localhost:${original.ports.web}`;
    const next = await updateConfig(file, (current: LocalConfig) => ({
      ...current,
      registryFile,
      model,
      origin,
    }));
    expect(next).toEqual({ ...original, registryFile, model, origin });
    expect(await loadConfig(file)).toEqual(next);
    const bytes = await readFile(file);
    await expect(
      updateConfig(file, (current: LocalConfig) => ({
        ...current,
        ports: { ...current.ports, web: current.ports.web + 1 },
      })),
    ).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    expect(await readFile(file)).toEqual(bytes);
    const replacements = {
      installationId: fixture().installationId,
      mode: 'adopt',
      project: 'another-project',
      postgresVolume: 'another_postgres',
      workspaceVolume: 'another_workspace',
      workspaceMount: '/another/mount',
      database: { ...original.database, password: 'replacement-password' },
      authSecret: 'replacement-secret',
    };
    for (const [key, value] of Object.entries(replacements)) {
      await expect(
        updateConfig(file, (current: LocalConfig) => {
          (current as unknown as Record<string, unknown>)[key] = value;
          return current;
        }),
      ).rejects.toMatchObject({ code: 'CONFIG_IDENTITY_IMMUTABLE' });
      expect(await readFile(file)).toEqual(bytes);
    }
    await expect(
      updateConfig(file, () => {
        throw new Error('fixture-secret');
      }),
    ).rejects.toMatchObject({ code: 'CONFIG_UPDATE_FAILED', message: 'CONFIG_UPDATE_FAILED' });
    expect(await readFile(file)).toEqual(bytes);
    await withInstallationLock(file, async () => {
      await expect(updateConfig(file, (current: LocalConfig) => current)).rejects.toMatchObject({
        code: 'LOCK_BUSY',
      });
    });
    expect(await readFile(file)).toEqual(bytes);
  }, 120_000);
});
