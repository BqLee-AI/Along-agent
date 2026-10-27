import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { appendFile } from 'node:fs/promises';
import { loadConfig } from './config.mjs';
import { readJson, writeJson } from './commands.mjs';

// This is the production Web process itself, not a persistent launcher daemon.
const [stateFile, nonce] = process.argv.slice(2);
try {
  const state = await readJson(stateFile);
  if (!state || state.nonce !== nonce) throw new Error('WEB_STATE_INVALID');
  const config = await loadConfig(state.configFile);
  const webDirectory = path.join(state.source, 'apps/web');
  const require = createRequire(path.join(webDirectory, 'package.json'));
  const next = require('next');
  const app = next({
    dev: false,
    dir: webDirectory,
    hostname: '127.0.0.1',
    port: config.ports.web,
    quiet: true,
  });
  await app.prepare();
  const server = createServer(app.getRequestHandler());
  server.on('upgrade', app.getUpgradeHandler());
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    setTimeout(() => process.exit(0), 5000).unref();
    server.close(() => void app.close().finally(() => process.exit(0)));
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.ports.web, '127.0.0.1', resolve);
  });
  await writeJson(`${stateFile}.ready`, { nonce });
} catch (error) {
  // Private diagnostic only; the public CLI prints a stable non-secret error.
  await appendFile(`${stateFile}.error`, `${error.stack ?? 'WEB_START_FAILED'}\n`, { mode: 0o600 });
  process.exit(1);
}
