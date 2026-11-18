import { createServer, type Server } from 'node:http';
import { createRequestHandler } from './transport/handler.js';
import type { AppDeps } from './contracts.js';
export interface ServeOptions {
  port?: number;
  deps: AppDeps;
}
export function serve({ port = 3000, deps }: ServeOptions): Server {
  const handler = createRequestHandler(deps);
  const server = createServer((req, res) => {
    void handler(req, res);
  });
  server.listen(port);
  return server;
}
