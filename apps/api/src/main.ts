import { startApplication } from './bootstrap/application.js';

const application = await startApplication();
let shuttingDown = false;
function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  // Open SSE clients and external IO must not extend the process exit contract.
  setTimeout(() => process.exit(0), 5000).unref();
  void application.stop().finally(() => process.exit(0));
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
