import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { hostEnvironment } from '../local/commands.mjs';
import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { maintainAccount } from '../local/account.mjs';
import {
  configureWorkspaceRegistry,
  getWorkspaceGrant,
} from '../../apps/api/src/modules/workspaces/service.js';

const file = path.join(tmpdir(), 'along-account-fixture', 'local.json');
const registryFile = path.join(path.dirname(file), 'workspace-registry.json');
const admin = { userId: '00000000-0000-4000-8000-000000000068', displayName: 'original user' };
const registration = (owner = admin.userId) => ({
  workspace_id: 'original-workspace',
  owner_id: owner,
  label: 'Original',
  root: '/var/lib/along/workspaces/documents',
  readable_paths: ['notes.txt'],
  writable_paths: [],
});

function fixture({
  bound = admin as typeof admin | null,
  registry = [registration()] as unknown,
  configured = true,
  answers = [] as string[],
  eligible = true,
  hasPassword = false,
} = {}) {
  let config = {
    installationId: 'fixture-installation',
    project: 'fixture',
    workspaceMount: '/var/lib/along/workspaces',
    registryFile: configured ? registryFile : null,
  };
  const files = new Map<string, string>();
  if (registry !== undefined && registry !== null)
    files.set(registryFile, JSON.stringify(registry, null, 3));
  const events: string[] = [],
    messages: string[] = [],
    prompts: Array<{ label: string; secret: boolean }> = [];
  let locked = false,
    connections = 0,
    bindCalls = 0,
    publishes = 0,
    updates = 0,
    admitCalls = 0,
    reloads = 0;
  const binding = {
    get value() {
      return bound;
    },
    set value(value) {
      bound = value;
    },
  };
  const service = {
    async getBoundAdministrator() {
      return bound;
    },
    async listMaintenanceCandidates() {
      return [
        {
          selection: 'opaque-candidate-handle',
          displayName: 'legacy\nname',
          status: eligible ? 'active' : 'disabled',
          eligible,
          hasPassword,
        },
      ];
    },
    async bindLocal(input: {
      selection: string;
      confirmed: boolean;
      loginName: string;
      password: string;
    }) {
      bindCalls++;
      expect(input.selection).toBe('opaque-candidate-handle');
      expect(input.confirmed).toBe(true);
      if (input.password === 'wrong-password')
        throw Object.assign(new Error('UNAUTHENTICATED'), { code: 'UNAUTHENTICATED' });
      bound = admin;
    },
    async admitLocal(input: {
      selection: string;
      confirmed: boolean;
      loginName: string;
      password: string;
    }) {
      admitCalls++;
      expect(input.selection).toBe('opaque-candidate-handle');
      expect(input.confirmed).toBe(true);
      if (input.password === 'wrong-password')
        throw Object.assign(new Error('UNAUTHENTICATED'), { code: 'UNAUTHENTICATED' });
      return { admitted: true, userId: 'ordinary-owner' };
    },
    async listAdmittedLocalCandidates() {
      return [
        {
          selection: 'ordinary-handle',
          displayName: 'ordinary',
          status: 'active',
          installationAdmin: false,
        },
      ];
    },
    async resolveAdmittedLocalCandidate(selection: string) {
      expect(selection).toBe('ordinary-handle');
      return { userId: 'ordinary-owner', displayName: 'ordinary' };
    },
    async getAdmittedLocalOwner(userId: string) {
      expect(userId).toBe('ordinary-owner');
      return { userId, displayName: 'ordinary' };
    },
  };
  const dependencies = {
    async lock(_file: string, callback: () => Promise<unknown>) {
      expect(locked).toBe(false);
      locked = true;
      try {
        return await callback();
      } finally {
        locked = false;
      }
    },
    async loadConfig() {
      return structuredClone(config);
    },
    async fileVersion(target: string, expected: unknown) {
      const bytes = target === file ? JSON.stringify(config) : files.get(target);
      if (bytes === undefined || JSON.stringify(JSON.parse(bytes)) !== JSON.stringify(expected))
        throw Object.assign(new Error('changed'), { code: 'ACCOUNT_INSTALLATION_CHANGED' });
      return bytes;
    },
    async prepare() {
      events.push('prepare');
      return {};
    },
    async openIdentity() {
      connections++;
      events.push('db-open');
      return {
        service,
        async close() {
          connections--;
          events.push('db-close');
        },
      };
    },
    async loadRegistry(target: string) {
      const value = files.get(target);
      if (value === undefined) throw Object.assign(new Error('absent'), { code: 'ENOENT' });
      return JSON.parse(value);
    },
    async publishRegistry(target: string, input: unknown, options: { exclusive: boolean }) {
      expect(options.exclusive).toBe(true);
      expect(files.has(target)).toBe(false);
      publishes++;
      files.set(target, JSON.stringify(input));
      events.push('publish');
    },
    async verifyRegistry(_config: unknown, _context: unknown, input: unknown) {
      if (!Array.isArray(input))
        return { state: 'invalid', accepted: 0, rejected: 1, ownerIds: [], grants: [] };
      return {
        state: 'loaded',
        accepted: input.length,
        rejected: 0,
        ownerIds: [...new Set(input.map((item) => item.owner_id))],
        grants: input.map((item) => ({
          workspace_id: item.workspace_id,
          owner_id: item.owner_id,
          registration_digest: JSON.stringify(item),
          root_identity: 'original-device:original-inode',
        })),
      };
    },
    async updateConfig(
      _file: string,
      callback: (value: typeof config) => typeof config | Promise<typeof config>,
    ) {
      expect(locked).toBe(false);
      expect(connections).toBe(0);
      updates++;
      events.push('config-save');
      config = await callback(structuredClone(config));
      return config;
    },
    async reload(_file: string, options: { expectedConfig: typeof config }) {
      expect(locked).toBe(false);
      expect(connections).toBe(0);
      expect(options.expectedConfig).toEqual(config);
      reloads++;
      events.push('reload');
      return { workspace: { state: 'loaded' } };
    },
  };
  const io = {
    write(message: string) {
      messages.push(message);
    },
    async ask(label: string, options?: { secret?: boolean }) {
      prompts.push({ label, secret: options?.secret === true });
      const value = answers.shift();
      if (value === undefined) throw new Error('unexpected prompt');
      return value;
    },
  };
  return {
    dependencies,
    io,
    files,
    events,
    messages,
    prompts,
    binding,
    service,
    get counts() {
      return { bindCalls, publishes, updates, reloads, connections };
    },
    get admitCalls() {
      return admitCalls;
    },
    get config() {
      return config;
    },
  };
}

const configureAnswers = [
  'CONFIGURE',
  '/var/lib/along/workspaces/documents',
  'My documents',
  '["notes.txt"]',
  '[]',
  'REGISTER',
];

describe('local:account explicit maintenance and non-atomic recovery', () => {
  it('provides command help without loading configuration, database or interactive IO', () => {
    const output = execFileSync(
      process.execPath,
      ['--no-env-file', path.resolve(import.meta.dirname, '../local/cli.mjs'), 'account', '--help'],
      { encoding: 'utf8', env: hostEnvironment() },
    );
    expect(output).toContain('bun --no-env-file run local:account');
    expect(output).toContain('--config');
  });

  it('derives a Web-created administrator owner and releases all DB/locks before save/reload', async () => {
    const f = fixture({ configured: false, registry: null, answers: [...configureAnswers] });
    expect(await maintainAccount(file, f.io, f.dependencies)).toEqual({
      account: 'committed',
      workspace: 'loaded',
    });
    const rows = JSON.parse(f.files.get(registryFile)!);
    expect(rows[0].owner_id).toBe(admin.userId);
    expect(rows[0].root).toBe('/var/lib/along/workspaces/documents');
    expect(rows[0].readable_paths).toEqual(['notes.txt']);
    expect(rows[0].writable_paths).toEqual([]);
    expect(f.counts).toEqual({
      bindCalls: 0,
      publishes: 1,
      updates: 1,
      reloads: 1,
      connections: 0,
    });
    expect(f.events.indexOf('db-close')).toBeLessThan(f.events.indexOf('config-save'));
    expect(f.messages).toContain('[registry_loaded]');
  });

  it('preserves exact original registry bytes, workspace identity and permissions without config rewrite', async () => {
    const f = fixture();
    const original = f.files.get(registryFile);
    await maintainAccount(file, f.io, f.dependencies);
    expect(f.files.get(registryFile)).toBe(original);
    expect(f.counts.publishes).toBe(0);
    expect(f.counts.updates).toBe(0);
    expect(f.counts.bindCalls).toBe(0);
    expect(f.counts.reloads).toBe(1);
  });

  it('requires explicit finite selection and confirmation before claiming the original user', async () => {
    const secret = 'untouched secret password';
    const f = fixture({ bound: null, answers: ['1', 'CONFIRM 1', 'legacy-login', secret, secret] });
    await maintainAccount(file, f.io, f.dependencies);
    expect(f.counts.bindCalls).toBe(1);
    expect(f.binding.value?.userId).toBe(admin.userId);
    expect(f.messages.join('\n')).not.toContain(secret);
    expect(f.messages.join('\n')).not.toContain('opaque-candidate-handle');
    expect(f.messages.join('\n')).not.toContain('legacy\nname');
    expect(f.prompts.filter((item) => item.secret)).toHaveLength(2);
  });

  it('never defaults to a candidate or accepts an owner ID or disabled selection', async () => {
    for (const answers of [[''], [admin.userId], ['1', 'yes']]) {
      const f = fixture({ bound: null, answers: [...answers] });
      if (!answers[0])
        expect(await maintainAccount(file, f.io, f.dependencies)).toMatchObject({
          account: 'unconfigured',
        });
      else await expect(maintainAccount(file, f.io, f.dependencies)).rejects.toBeDefined();
      expect(f.counts.bindCalls).toBe(0);
      expect(f.counts.connections).toBe(0);
    }
    const disabled = fixture({ bound: null, eligible: false, answers: ['1'] });
    await expect(maintainAccount(file, disabled.io, disabled.dependencies)).rejects.toMatchObject({
      code: 'ACCOUNT_SELECTION_INVALID',
    });
    expect(disabled.counts.bindCalls).toBe(0);
  });

  it('passes an existing password to public verification and does not overwrite it on failure', async () => {
    const f = fixture({
      bound: null,
      hasPassword: true,
      answers: ['1', 'CONFIRM 1', 'existing-login', 'wrong-password'],
    });
    await expect(maintainAccount(file, f.io, f.dependencies)).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
    expect(f.binding.value).toBeNull();
    expect(f.counts.connections).toBe(0);
    expect(f.counts.publishes).toBe(0);
    expect(f.counts.reloads).toBe(0);
    expect(f.prompts.filter((item) => item.secret)).toHaveLength(1);
    expect(f.messages.join('\n')).not.toContain('wrong-password');
  });

  it.each(['absent', 'invalid', 'unreadable'])(
    'reports committed account separately from %s registry and does not overwrite it',
    async (state) => {
      const f = fixture({
        registry:
          state === 'absent' ? null : state === 'invalid' ? { not: 'an array' } : [registration()],
      });
      const original = f.files.get(registryFile);
      if (state === 'unreadable')
        f.dependencies.loadRegistry = async () => {
          throw Object.assign(new Error('denied'), { code: 'EACCES' });
        };
      await expect(maintainAccount(file, f.io, f.dependencies)).rejects.toBeDefined();
      expect(f.messages).toContain(`[registry_${state}]`);
      expect(f.messages).toContain('[account_committed_workspace_pending]');
      expect(f.files.get(registryFile)).toBe(original);
      expect(f.counts.publishes).toBe(0);
      expect(f.counts.reloads).toBe(0);
    },
  );

  it('never transfers or rewrites another owner registration', async () => {
    const f = fixture({ registry: [registration('different-owner')] });
    const original = f.files.get(registryFile);
    await expect(maintainAccount(file, f.io, f.dependencies)).rejects.toMatchObject({
      code: 'WORKSPACE_OWNER_MISSING',
    });
    expect(f.files.get(registryFile)).toBe(original);
    expect(f.counts.publishes).toBe(0);
  });

  it('recovers a published registry after config failure without creating a second account or file', async () => {
    const f = fixture({ configured: false, registry: null, answers: [...configureAnswers] });
    const update = f.dependencies.updateConfig;
    f.dependencies.updateConfig = async () => {
      throw Object.assign(new Error('save'), { code: 'CONFIG_SAVE_FAILED' });
    };
    await expect(maintainAccount(file, f.io, f.dependencies)).rejects.toMatchObject({
      code: 'CONFIG_SAVE_FAILED',
    });
    const original = f.files.get(registryFile);
    expect(f.counts.publishes).toBe(1);
    expect(f.messages).toContain('[registry_published]');
    f.dependencies.updateConfig = update;
    await maintainAccount(file, f.io, f.dependencies);
    expect(f.files.get(registryFile)).toBe(original);
    expect(f.counts.publishes).toBe(1);
    expect(f.counts.bindCalls).toBe(0);
    expect(f.counts.reloads).toBe(1);
  });

  it('reports saved config/reload failure and retries only remaining workspace activation', async () => {
    const f = fixture();
    const reload = f.dependencies.reload;
    f.dependencies.reload = async () => {
      throw Object.assign(new Error('reload'), { code: 'RELOAD_FAILED' });
    };
    await expect(maintainAccount(file, f.io, f.dependencies)).rejects.toMatchObject({
      code: 'RELOAD_FAILED',
    });
    expect(f.messages).toContain('[config_saved_reload_failed]');
    f.dependencies.reload = reload;
    await maintainAccount(file, f.io, f.dependencies);
    expect(f.counts.bindCalls).toBe(0);
    expect(f.counts.publishes).toBe(0);
    expect(f.messages).toContain('[registry_loaded]');
  });

  it('requires a managed subdirectory and explicit finite readable paths', async () => {
    for (const root of ['/var/lib/along/workspaces', '/outside/documents']) {
      const f = fixture({ configured: false, registry: null, answers: ['CONFIGURE', root] });
      await expect(maintainAccount(file, f.io, f.dependencies)).rejects.toMatchObject({
        code: 'WORKSPACE_ROOT_INVALID',
      });
      expect(f.counts.publishes).toBe(0);
    }
    const f = fixture({
      configured: false,
      registry: null,
      answers: ['CONFIGURE', '/var/lib/along/workspaces/documents', 'docs', '[]', '[]'],
    });
    await expect(maintainAccount(file, f.io, f.dependencies)).rejects.toMatchObject({
      code: 'WORKSPACE_REGISTRY_INVALID',
    });
    expect(f.counts.publishes).toBe(0);
  });

  it('admits an explicitly selected ordinary legacy owner without administrator binding or workspace side effects', async () => {
    const f = fixture({
      hasPassword: true,
      answers: ['1', 'CONFIRM 1', 'ordinary-login', 'original-password'],
    });
    expect(await maintainAccount(file, f.io, f.dependencies, { operation: 'admit' })).toEqual({
      account: 'committed',
      workspace: 'unconfigured',
    });
    expect(f.admitCalls).toBe(1);
    expect(f.binding.value).toEqual(admin);
    expect(f.counts.bindCalls).toBe(0);
    expect(f.counts.publishes).toBe(0);
    expect(f.counts.reloads).toBe(0);
    expect(f.prompts.filter((prompt) => prompt.secret)).toHaveLength(1);
  });

  it('adds a finite workspace for an explicitly selected admitted owner, preserving every original registration and source byte', async () => {
    const answers = [
      '1',
      'CONFIRM 1',
      'ADD',
      '/var/lib/along/workspaces/ordinary',
      'Ordinary',
      '["notes.txt"]',
      '[]',
      'REGISTER',
    ];
    const f = fixture({ answers });
    const before = f.files.get(registryFile);
    await maintainAccount(file, f.io, f.dependencies, { operation: 'workspace' });
    expect(f.files.get(registryFile)).toBe(before);
    expect(f.config.registryFile).not.toBe(registryFile);
    const rows = JSON.parse(f.files.get(f.config.registryFile!)!);
    expect(rows[0]).toEqual(registration());
    expect(rows[1].owner_id).toBe('ordinary-owner');
    expect(rows[1].readable_paths).toEqual(['notes.txt']);
    expect(rows[1].writable_paths).toEqual([]);
    expect(f.counts.bindCalls).toBe(0);
    expect(f.counts.connections).toBe(0);
    expect(f.counts.reloads).toBe(1);
    const published = f.config.registryFile;
    const bytes = f.files.get(published!);
    answers.push('1', 'CONFIRM 1', 'LOAD');
    await maintainAccount(file, f.io, f.dependencies, { operation: 'workspace' });
    expect(f.config.registryFile).toBe(published);
    expect(f.files.get(published!)).toBe(bytes);
    expect(f.counts.publishes).toBe(1);
    expect(f.counts.reloads).toBe(2);
  });

  it('refuses registry byte-version changes before publishing and never overwrites the concurrent source', async () => {
    const f = fixture({
      answers: [
        '1',
        'CONFIRM 1',
        'ADD',
        '/var/lib/along/workspaces/ordinary',
        'Ordinary',
        '["notes.txt"]',
        '[]',
        'REGISTER',
      ],
    });
    const original = f.files.get(registryFile)!;
    const verify = f.dependencies.verifyRegistry;
    f.dependencies.verifyRegistry = async (...args) => {
      if (Array.isArray(args[2]) && args[2].length === 2)
        f.files.set(registryFile, original + '\n');
      return verify(...args);
    };
    await expect(
      maintainAccount(file, f.io, f.dependencies, { operation: 'workspace' }),
    ).rejects.toMatchObject({ code: 'WORKSPACE_IDENTITY_CHANGED' });
    expect(f.files.get(registryFile)).toBe(original + '\n');
    expect(f.counts.publishes).toBe(0);
    expect(f.counts.updates).toBe(0);
    expect(f.counts.reloads).toBe(0);
  });

  it('refuses changed physical roots during finite add and retains all existing registry bytes', async () => {
    const f = fixture({
      answers: [
        '1',
        'CONFIRM 1',
        'ADD',
        '/var/lib/along/workspaces/ordinary',
        'Ordinary',
        '["notes.txt"]',
        '[]',
        'REGISTER',
      ],
    });
    const before = f.files.get(registryFile);
    const verify = f.dependencies.verifyRegistry;
    f.dependencies.verifyRegistry = async (...args) => {
      const report = await verify(...args);
      if (Array.isArray(args[2]) && args[2].length === 2)
        report.grants[0]!.root_identity = 'replaced-device:replaced-inode';
      return report;
    };
    await expect(
      maintainAccount(file, f.io, f.dependencies, { operation: 'workspace' }),
    ).rejects.toMatchObject({ code: 'WORKSPACE_IDENTITY_CHANGED' });
    expect(f.files.get(registryFile)).toBe(before);
    expect(f.counts.publishes).toBe(0);
  });

  it('uses the real registry validator to reject duplicate/nested roots and observe replaced physical identity', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'along-invited-registry-'));
    try {
      const originalRoot = path.join(directory, 'administrator');
      const ordinaryRoot = path.join(directory, 'ordinary');
      await mkdir(originalRoot);
      await mkdir(ordinaryRoot);
      const original = { ...registration(), root: originalRoot };
      const ordinary = {
        ...registration('ordinary-owner'),
        workspace_id: 'ordinary-workspace',
        root: ordinaryRoot,
      };
      expect((await configureWorkspaceRegistry([original])).state).toBe('loaded');
      const before = getWorkspaceGrant(admin.userId, original.workspace_id);
      expect((await configureWorkspaceRegistry([original, ordinary])).state).toBe('loaded');
      expect(getWorkspaceGrant(admin.userId, original.workspace_id)).toEqual(before);
      expect(
        (await configureWorkspaceRegistry([original, { ...ordinary, root: originalRoot }])).state,
      ).toBe('invalid');
      const nested = path.join(originalRoot, 'nested');
      await mkdir(nested);
      expect(
        (await configureWorkspaceRegistry([original, { ...ordinary, root: nested }])).state,
      ).toBe('invalid');
      await rename(originalRoot, path.join(directory, 'preserved-original'));
      await mkdir(originalRoot);
      expect((await configureWorkspaceRegistry([original, ordinary])).state).toBe('loaded');
      expect(getWorkspaceGrant(admin.userId, original.workspace_id).root_identity).not.toBe(
        before.root_identity,
      );
    } finally {
      await configureWorkspaceRegistry([]);
      await rm(directory, { recursive: true, force: true });
    }
  });
});
