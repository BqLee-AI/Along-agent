import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmod, link, lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, posix, resolve } from 'node:path';
import { z } from 'zod';
import { withInstallationLock } from './lock.mjs';

const text = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0 && !value.includes('\0'));
const volume = text.refine((value) => /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(value));
const port = z.number().int().min(1).max(65535);
const databaseSchema = z.object({ user: text, password: text, name: text }).strict();
const modelSchema = z
  .object({
    baseUrl: z
      .string()
      .url()
      .pipe(text)
      .refine((value) => ['http:', 'https:'].includes(new URL(value).protocol)),
    name: text,
    apiKey: z.string().refine((value) => !value.includes('\0')),
    maxIterations: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    maxTokens: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    completionCap: z.number().int().positive().safe(),
    modelWindowTokens: z.number().int().positive().safe().nullable().optional(),
    reserveTokens: z.number().int().nonnegative().safe().optional(),
  })
  .strict();
const configSchema = z
  .object({
    version: z.literal(1),
    installationId: z.string().uuid(),
    mode: z.enum(['new', 'adopt']),
    project: text.refine((value) => /^[a-z0-9][a-z0-9_-]{0,62}$/.test(value)),
    postgresVolume: volume,
    workspaceVolume: volume,
    workspaceMount: text.refine(
      (value) =>
        posix.isAbsolute(value) &&
        value !== '/' &&
        !value.includes('\\') &&
        posix.normalize(value) === value,
    ),
    ports: z.object({ postgres: port, api: port, web: port }).strict(),
    origin: z
      .string()
      .url()
      .refine((value) => /^http:\/\/(?:localhost|127\.0\.0\.1)(?::[0-9]+)?$/i.test(value)),
    database: databaseSchema,
    authSecret: text,
    tzdbVersion: text,
    model: modelSchema.nullable(),
    registryFile: text.refine((value) => isAbsolute(value)).nullable(),
  })
  .strict();

/** @typedef {z.infer<typeof configSchema>} LocalConfig */
const newInputSchema = configSchema
  .partial()
  .extend({
    mode: z.literal('new'),
    database: databaseSchema.partial().optional(),
    ports: z
      .object({ postgres: port.optional(), api: port.optional(), web: port.optional() })
      .strict()
      .optional(),
    tzdbVersion: text,
  })
  .strict();

export class LocalConfigError extends Error {
  constructor(code) {
    super(code);
    this.name = 'LocalConfigError';
    this.code = code;
  }
}

export function defaultConfigPath() {
  if (process.platform === 'win32') {
    if (!process.env.LOCALAPPDATA || !isAbsolute(process.env.LOCALAPPDATA)) {
      throw new LocalConfigError('CONFIG_LOCALAPPDATA_REQUIRED');
    }
    return join(process.env.LOCALAPPDATA, 'Along-agent', 'local.json');
  }
  const base = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
  if (!isAbsolute(base)) throw new LocalConfigError('CONFIG_DATA_HOME_INVALID');
  return join(base, 'Along-agent', 'local.json');
}

/** @returns {LocalConfig} */
export function validateConfig(input) {
  const parsed = configSchema.safeParse(input);
  if (!parsed.success) throw new LocalConfigError('CONFIG_INVALID');
  const config = parsed.data;
  if (
    new Set(Object.values(config.ports)).size !== 3 ||
    config.postgresVolume === config.workspaceVolume
  ) {
    throw new LocalConfigError('CONFIG_INVALID');
  }
  const origin = new URL(config.origin);
  if (Number(origin.port || 80) !== config.ports.web) throw new LocalConfigError('CONFIG_INVALID');
  return config;
}

/** @returns {LocalConfig} */
export function createConfig(input) {
  if (input?.mode === 'adopt') return validateConfig(input);
  const parsed = newInputSchema.safeParse(input);
  if (!parsed.success) throw new LocalConfigError('CONFIG_INVALID');
  const values = parsed.data;
  const installationId = values.installationId ?? randomUUID();
  const project = values.project ?? `along-${installationId.replaceAll('-', '').slice(0, 16)}`;
  const webPort = values.ports?.web ?? 3100;
  return validateConfig({
    version: 1,
    installationId,
    project,
    mode: 'new',
    postgresVolume: values.postgresVolume ?? `${project}_pgdata`,
    workspaceVolume: values.workspaceVolume ?? `${project}_workspace_data`,
    workspaceMount: values.workspaceMount ?? '/var/lib/along/workspaces',
    authSecret: values.authSecret ?? randomBytes(48).toString('base64url'),
    tzdbVersion: values.tzdbVersion,
    model: values.model ?? null,
    registryFile: values.registryFile ?? null,
    origin: values.origin ?? `http://127.0.0.1:${webPort}`,
    ports: {
      postgres: values.ports?.postgres ?? 55432,
      api: values.ports?.api ?? 3000,
      web: webPort,
    },
    database: {
      user: values.database?.user ?? 'along',
      name: values.database?.name ?? 'along',
      password: values.database?.password ?? randomBytes(32).toString('base64url'),
    },
  });
}

async function windowsAcl(file, directory, checkOnly = false) {
  // Only a constant PowerShell command appears in argv. Paths travel on stdin;
  // configuration bytes and secrets never enter a command line or subprocess.
  const target = Buffer.from(resolve(file), 'utf16le').toString('base64');
  const kind = directory ? 'DirectorySecurity' : 'FileSecurity';
  const inheritance = directory ? 'ContainerInherit, ObjectInherit' : 'None';
  // Persist the modified owner/DACL directly. PowerShell's Set-Acl provider can
  // demand SeSecurityPrivilege when rewriting an already protected entry.
  const operation = checkOnly
    ? `$acl = Get-Acl -LiteralPath $target\nif ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'owner' }\nforeach ($rule in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) { if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -ne $sid.Value) { throw 'access' } }`
    : `$acl = New-Object System.Security.AccessControl.${kind}\n$acl.SetOwner($sid)\n$acl.SetAccessRuleProtection($true, $false)\n$rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', '${inheritance}', 'None', 'Allow')\n$acl.AddAccessRule($rule)\n[System.IO.${directory ? 'Directory' : 'File'}]::SetAccessControl($target, $acl)`;
  const script = `$ErrorActionPreference = 'Stop'\ntry {\n$target = [System.Text.Encoding]::Unicode.GetString([System.Convert]::FromBase64String('${target}'))\n$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User\n${operation}\nexit 0\n} catch { exit 1 }\n\n`;
  const { promise, resolve: resolveAcl, reject: rejectAcl } = Promise.withResolvers();
  const child = spawn(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '-'],
    {
      windowsHide: true,
      stdio: ['pipe', 'ignore', 'ignore'],
    },
  );
  child.once('error', () => rejectAcl(new LocalConfigError('CONFIG_PERMISSIONS')));
  child.stdin.on('error', () => rejectAcl(new LocalConfigError('CONFIG_PERMISSIONS')));
  child.once('exit', (code) =>
    code === 0 ? resolveAcl() : rejectAcl(new LocalConfigError('CONFIG_PERMISSIONS')),
  );
  child.stdin.end(script);
  await promise;
}

async function checkRegularFile(file, allowMissing = false) {
  try {
    const status = await lstat(file);
    if (!status.isFile() || status.isSymbolicLink())
      throw new LocalConfigError('CONFIG_NOT_REGULAR');
    return status;
  } catch (error) {
    if (allowMissing && error.code === 'ENOENT') return null;
    throw error;
  }
}

async function privateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const status = await lstat(directory);
  if (!status.isDirectory() || status.isSymbolicLink())
    throw new LocalConfigError('CONFIG_PERMISSIONS');
  if (process.platform === 'win32') await windowsAcl(directory, true);
  else {
    if (status.uid !== process.getuid()) throw new LocalConfigError('CONFIG_PERMISSIONS');
    await chmod(directory, 0o700);
  }
}

async function assertPrivate(file, status) {
  const directory = dirname(file);
  const parent = await lstat(directory);
  if (!parent.isDirectory() || parent.isSymbolicLink())
    throw new LocalConfigError('CONFIG_PERMISSIONS');
  if (process.platform === 'win32') {
    await windowsAcl(directory, true, true);
    await windowsAcl(file, false, true);
  } else if (
    status.uid !== process.getuid() ||
    parent.uid !== process.getuid() ||
    (status.mode & 0o077) !== 0 ||
    (parent.mode & 0o077) !== 0
  ) {
    throw new LocalConfigError('CONFIG_PERMISSIONS');
  }
}

export async function loadConfig(file) {
  try {
    const target = resolve(file);
    const status = await checkRegularFile(target);
    await assertPrivate(target, status);
    const bytes = await readFile(target, 'utf8');
    let input;
    try {
      input = JSON.parse(bytes);
    } catch {
      throw new LocalConfigError('CONFIG_INVALID');
    }
    return validateConfig(input);
  } catch (error) {
    if (error instanceof LocalConfigError) throw error;
    throw new LocalConfigError(error.code === 'ENOENT' ? 'CONFIG_MISSING' : 'CONFIG_READ_FAILED');
  }
}
/** Read without normalization or rewriting; caller may preserve the original file bytes. */
export async function loadPrivateJson(file) {
  const target = resolve(file);
  const status = await checkRegularFile(target);
  await assertPrivate(target, status);
  return JSON.parse(await readFile(target, 'utf8'));
}

export async function saveConfig(file, config, options = {}) {
  return savePrivateJson(file, validateConfig(config), options);
}

/** Private JSON publication shared by configuration and host registry maintenance. */
export async function savePrivateJson(file, value, { exclusive = false } = {}) {
  let temporary;
  let handle;
  try {
    const target = resolve(file);
    const directory = dirname(target);
    await privateDirectory(directory);
    await checkRegularFile(target, true);
    temporary = join(directory, `.along-config-${randomUUID()}.tmp`);
    handle = await open(temporary, 'wx', 0o600);
    if (process.platform === 'win32') await windowsAcl(temporary, false);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    if (exclusive) {
      // Atomic no-clobber publication; access()+rename() would race another init.
      await link(temporary, target);
    } else {
      await rename(temporary, target);
      temporary = null;
    }
  } catch (error) {
    if (error instanceof LocalConfigError) throw error;
    throw new LocalConfigError(error.code === 'EEXIST' ? 'CONFIG_EXISTS' : 'CONFIG_SAVE_FAILED');
  } finally {
    if (handle) await handle.close().catch(() => {});
    if (temporary) await unlink(temporary).catch(() => {});
  }
}

const fixedFields = [
  'installationId',
  'mode',
  'project',
  'postgresVolume',
  'workspaceVolume',
  'workspaceMount',
  'database',
  'authSecret',
];

/**
 * @param {string} file
 * @param {(current: LocalConfig) => LocalConfig | Promise<LocalConfig>} fn
 * @returns {Promise<LocalConfig>}
 */
export async function updateConfig(file, fn) {
  return withInstallationLock(file, async () => {
    const original = await loadConfig(file);
    let next;
    try {
      next = validateConfig(await fn(structuredClone(original)));
    } catch (error) {
      if (error instanceof LocalConfigError) throw error;
      throw new LocalConfigError('CONFIG_UPDATE_FAILED');
    }
    for (const field of fixedFields) {
      if (JSON.stringify(original[field]) !== JSON.stringify(next[field]))
        throw new LocalConfigError('CONFIG_IDENTITY_IMMUTABLE');
    }
    await saveConfig(file, next);
    return next;
  });
}
