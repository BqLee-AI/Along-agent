import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { failure, hostEnvironment, writeJson } from './commands.mjs';

async function streamBackup(args, file, env) {
  const child = spawn('docker', args, {
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.resume();
  const exited = new Promise((resolve, reject) => {
    child.once('error', () => reject(failure('BACKUP_FAILED')));
    child.once('exit', (code) => (code === 0 ? resolve() : reject(failure('BACKUP_FAILED'))));
  });
  try {
    await Promise.all([
      pipeline(child.stdout, createWriteStream(file, { flags: 'wx', mode: 0o600 })),
      exited,
    ]);
  } catch {
    throw failure('BACKUP_FAILED');
  }
}

export async function backupInstallation(config, directory, postgresContainer) {
  const backup = path.join(directory, 'backups', randomUUID());
  await mkdir(backup, { recursive: true, mode: 0o700 });
  // PGPASSWORD is inherited by the one-shot client, never placed in argv.
  const env = hostEnvironment({ PGPASSWORD: config.database.password });
  await streamBackup(
    [
      'exec',
      '--env',
      'PGPASSWORD',
      postgresContainer,
      'pg_dump',
      '--username',
      config.database.user,
      '--dbname',
      config.database.name,
      '--format=custom',
    ],
    path.join(backup, 'database.dump'),
    env,
  );
  await streamBackup(
    [
      'run',
      '--rm',
      '--network',
      'none',
      '--mount',
      `type=volume,source=${config.workspaceVolume},target=/source,readonly`,
      'postgres:16-alpine',
      'tar',
      '-C',
      '/source',
      '-czf',
      '-',
      '.',
    ],
    path.join(backup, 'workspaces.tar.gz'),
    hostEnvironment(),
  );
  await writeJson(path.join(backup, 'complete.json'), {
    version: 1,
    database: 'database.dump',
    workspaces: 'workspaces.tar.gz',
  });
  return backup;
}
