import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { parseRole } from '../src/bootstrap/role.js';

describe('role', () => {
  it('defaults to all', () => {
    expect(parseRole(undefined)).toBe('all');
  });

  it('accepts api|worker|all', () => {
    expect(parseRole('api')).toBe('api');
    expect(parseRole('worker')).toBe('worker');
    expect(parseRole('all')).toBe('all');
  });

  it('fails fast on unknown role', () => {
    expect(() => parseRole('gateway')).toThrow();
  });

  it('starts and stops worker-only assembly without touching HTTP or workspace configuration', () => {
    const moduleUrl = new URL('../src/bootstrap/application.ts', import.meta.url).href;
    const child = spawnSync(
      process.execPath,
      [
        '--no-env-file',
        '--eval',
        `import { startApplication } from ${JSON.stringify(moduleUrl)};
const application = await startApplication();
console.log(application.role);
await application.stop();
await application.stop();`,
      ],
      {
        env: {
          ...process.env,
          ROLE: 'worker',
          DATABASE_URL: '',
          PORT: 'not-an-http-port',
          WORKSPACE_REGISTRY_FILE: 'not-a-workspace-registry',
        },
        encoding: 'utf8',
        timeout: 8000,
      },
    );
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
    expect(child.stdout.trim()).toBe('worker');
  });

  it('loads maintenance assembly without opening pools, listeners, or timers', () => {
    const identity = new URL('../src/bootstrap/identity.ts', import.meta.url).href;
    const release = new URL('../src/bootstrap/release.ts', import.meta.url).href;
    const child = spawnSync(
      process.execPath,
      [
        '--no-env-file',
        '--eval',
        `import ${JSON.stringify(identity)}; import ${JSON.stringify(release)}; console.log('loaded');`,
      ],
      {
        env: { ...process.env, DATABASE_URL: 'not-a-database-url', PORT: 'not-an-http-port' },
        encoding: 'utf8',
        timeout: 8000,
      },
    );
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
    expect(child.stdout.trim()).toBe('loaded');
  });
});
