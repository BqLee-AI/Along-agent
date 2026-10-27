import { createHash, randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { basename, dirname, join, resolve } from 'node:path';

const active = new Set();
const protocol = 'along-local-lifecycle-v1';

export class InstallationLockError extends Error {
  constructor(code) {
    super(
      code === 'LOCK_BUSY'
        ? 'Another lifecycle operation owns this installation. Wait for it to exit, then retry; do not kill a process based on a PID or delete lock files.'
        : 'The local lifecycle lock resource is unavailable. Stop the conflicting listener only after verifying its ownership, then retry.',
    );
    this.name = 'InstallationLockError';
    this.code = code;
  }
}

async function installationKey(configFile) {
  // Resolve existing ancestors even before init creates the configuration directory.
  let directory = dirname(resolve(configFile));
  const suffix = [basename(resolve(configFile))];
  for (;;) {
    try {
      directory = await realpath(directory);
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw new InstallationLockError('LOCK_UNAVAILABLE');
      const parent = dirname(directory);
      if (parent === directory) throw new InstallationLockError('LOCK_UNAVAILABLE');
      suffix.unshift(basename(directory));
      directory = parent;
    }
  }
  let canonical = join(directory, ...suffix);
  if (process.platform === 'win32') canonical = canonical.toLowerCase();
  return createHash('sha256').update(canonical).digest('hex');
}

async function identifyListener(port, key) {
  const { promise, resolve: resolveIdentity } = Promise.withResolvers();
  const socket = createConnection({ host: '127.0.0.1', port });
  let result = '';
  let settled = false;
  const finish = (matches) => {
    if (settled) return;
    settled = true;
    // The client closes first, avoiding server-side TIME_WAIT delaying Windows
    // rebinding when the lifecycle owner subsequently exits.
    socket.destroy();
    resolveIdentity(matches);
  };
  socket.setTimeout(1000, () => finish(false));
  socket.on('error', () => finish(false));
  socket.on('data', (chunk) => {
    result += chunk.toString('utf8');
    if (result.length > 512) return finish(false);
    if (!result.includes('\n')) return;
    try {
      const identity = JSON.parse(result);
      finish(
        identity.protocol === protocol &&
          identity.installation === key &&
          typeof identity.owner === 'string',
      );
    } catch {
      finish(false);
    }
  });
  socket.on('end', () => finish(false));
  return promise;
}

export async function withInstallationLock(configFile, callback) {
  const key = await installationKey(configFile);
  if (active.has(key)) throw new InstallationLockError('LOCK_BUSY');
  active.add(key);
  // A kernel-owned exclusive listener is the lease. It cannot become a stale PID
  // file, and the OS releases it on abnormal exit. Hash collisions fail closed.
  const port = 49152 + (Number.parseInt(key.slice(0, 8), 16) % 16384);
  const identity = JSON.stringify({ protocol, installation: key, owner: randomUUID() });
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => socket.destroy());
    socket.on('close', () => sockets.delete(socket));
    socket.setTimeout(1000, () => socket.destroy());
    socket.write(`${identity}\n`);
  });
  try {
    try {
      const listening = Promise.withResolvers();
      server.once('error', listening.reject);
      server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
        server.removeListener('error', listening.reject);
        listening.resolve();
      });
      await listening.promise;
    } catch (error) {
      if (error.code === 'EADDRINUSE') {
        const sameInstallation = await identifyListener(port, key);
        throw new InstallationLockError(sameInstallation ? 'LOCK_BUSY' : 'LOCK_UNAVAILABLE');
      }
      throw new InstallationLockError('LOCK_UNAVAILABLE');
    }
    return await callback();
  } finally {
    for (const socket of sockets) socket.destroy();
    if (server.listening) {
      const closed = Promise.withResolvers();
      server.close(closed.resolve);
      await closed.promise;
    }
    active.delete(key);
  }
}
