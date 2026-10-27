import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { failure, hostEnvironment, readJson, run, waitFor, writeJson } from './commands.mjs';
import { assertPortFree } from './compose.mjs';

async function processIdentity(pid, nonce) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw failure('INSTALLATION_STATE_INVALID');
  let material;
  try {
    if (process.platform === 'win32') {
      const command = `$p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; if ($p) { $p | Select-Object CreationDate,ExecutablePath,CommandLine | ConvertTo-Json -Compress }`;
      const text = (
        await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command])
      ).trim();
      if (!text) return null;
      const info = JSON.parse(text);
      if (!info.CommandLine?.includes(nonce) || !info.CommandLine.includes('web-host.mjs'))
        throw failure('UNKNOWN_PROCESS');
      material = JSON.stringify(info);
    } else {
      const [stat, cmdline] = await Promise.all([
        readFile(`/proc/${pid}/stat`, 'utf8'),
        readFile(`/proc/${pid}/cmdline`, 'utf8'),
      ]);
      if (stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z ')) return null;
      if (!cmdline.includes(nonce) || !cmdline.includes('web-host.mjs'))
        throw failure('UNKNOWN_PROCESS');
      // stat field 22 is the kernel start tick, not a reusable PID or wall clock.
      material = `${stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]}\0${cmdline}`;
    }
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ESRCH') return null;
    throw error;
  }
  return createHash('sha256').update(material).digest('hex');
}

export async function webIsRunning(directory) {
  const record = await readJson(path.join(directory, 'web.json'));
  if (!record) return false;
  const identity = await processIdentity(record.pid, record.nonce);
  if (!identity) return false;
  if (record.identity !== identity) throw failure('UNKNOWN_PROCESS');
  return true;
}

export async function startWeb(configFile, config, directory, artifact) {
  if (await webIsRunning(directory)) {
    const record = await readJson(path.join(directory, 'web.json'));
    if (record.digest !== artifact.digest) throw failure('UPGRADE_REQUIRED');
    return;
  }
  await assertPortFree(config.ports.web);
  const nonce = randomUUID();
  const stateFile = path.join(directory, 'web-input.json');
  await rm(`${stateFile}.ready`, { force: true });
  await rm(`${stateFile}.error`, { force: true });
  await writeJson(stateFile, {
    nonce,
    configFile: path.resolve(configFile),
    source: artifact.source,
  });
  const child = spawn(
    process.execPath,
    ['--no-env-file', path.join(artifact.source, 'scripts/local/web-host.mjs'), stateFile, nonce],
    {
      cwd: artifact.source,
      env: hostEnvironment({
        NODE_ENV: 'production',
        API_BASE: `http://127.0.0.1:${config.ports.api}`,
        APP_ORIGIN: config.origin,
      }),
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
    },
  );
  const spawned = Promise.withResolvers();
  child.once('error', () => spawned.reject(failure('WEB_START_FAILED')));
  child.once('spawn', spawned.resolve);
  await spawned.promise;
  child.unref();
  const identity = await processIdentity(child.pid, nonce);
  if (!identity) throw failure('WEB_START_FAILED');
  await writeJson(path.join(directory, 'web.json'), {
    pid: child.pid,
    identity,
    nonce,
    digest: artifact.digest,
  });
  await waitFor(async () => {
    if (!(await webIsRunning(directory))) throw failure('WEB_START_FAILED');
    return (await readJson(`${stateFile}.ready`))?.nonce === nonce;
  }, 'WEB_START_FAILED');
  await waitFor(async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${config.ports.web}/`, {
        signal: AbortSignal.timeout(2000),
      });
      await response.body?.cancel();
      return response.status < 500;
    } catch {
      return false;
    }
  }, 'WEB_START_FAILED');
}

export async function stopWeb(directory) {
  const file = path.join(directory, 'web.json');
  const record = await readJson(file);
  if (!record) return;
  if (await webIsRunning(directory)) {
    try {
      process.kill(record.pid, 'SIGTERM');
    } catch (error) {
      if (error.code !== 'ESRCH') throw failure('WEB_STOP_FAILED');
    }
    await waitFor(async () => !(await webIsRunning(directory)), 'WEB_STOP_FAILED', 15000);
  }
  await rm(file, { force: true });
  await rm(path.join(directory, 'web-input.json.ready'), { force: true });
}
