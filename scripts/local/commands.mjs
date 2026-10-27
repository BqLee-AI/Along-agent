import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { appendFile } from 'node:fs/promises';

const execute = promisify(execFile);

export function failure(code) {
  return Object.assign(new Error(code), { code });
}

// Do not forward an ambient DATABASE_URL, model key, NODE_OPTIONS or Compose override.
export function hostEnvironment(extra = {}) {
  const env = {};
  const allowed = new Set([
    'PATH',
    'PATHEXT',
    'SYSTEMROOT',
    'WINDIR',
    'COMSPEC',
    'TEMP',
    'TMP',
    'TMPDIR',
    'USERPROFILE',
    'LOCALAPPDATA',
    'APPDATA',
    'HOME',
    'PROGRAMFILES',
    'DOCKER_CONFIG',
    'DOCKER_CONTEXT',
    'DOCKER_HOST',
    'DOCKER_TLS_VERIFY',
    'DOCKER_CERT_PATH',
    'SSH_AUTH_SOCK',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
  ]);
  for (const [key, value] of Object.entries(process.env)) {
    if (allowed.has(key.toUpperCase())) env[key] = value;
  }
  return { ...env, COMPOSE_DISABLE_ENV_FILE: '1', NEXT_TELEMETRY_DISABLED: '1', ...extra };
}

export async function run(
  command,
  args,
  { cwd, env = hostEnvironment(), code = 'COMMAND_FAILED', log, input } = {},
) {
  try {
    const child = execute(command, args, {
      cwd,
      env,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    });
    if (input !== undefined) child.child.stdin.end(input);
    const { stdout, stderr } = await child;
    if (log) await appendFile(log, `${stdout}${stderr}`, { mode: 0o600 });
    return stdout;
  } catch (error) {
    if (log) await appendFile(log, `${error.stdout ?? ''}${error.stderr ?? ''}`, { mode: 0o600 });
    throw failure(code);
  }
}

export async function readJson(file) {
  const { readFile } = await import('node:fs/promises');
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw failure('INSTALLATION_STATE_INVALID');
  }
}

export async function writeJson(file, value) {
  const { writeFile, rename, rm } = await import('node:fs/promises');
  const { randomUUID } = await import('node:crypto');
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function waitFor(check, code, milliseconds = 60000) {
  const deadline = Date.now() + milliseconds;
  do {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  } while (Date.now() < deadline);
  throw failure(code);
}
