const { readdirSync } = module.require('node:fs');

// Discover modules in the scanned tree, including new modules and isolated fixture trees.
const modules = readdirSync('apps/api/src/modules', { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'time-core-zero-egress',
      comment: 'D1: packages/time-core/src MUST NOT import anything (zero outgoing deps).',
      severity: 'error',
      from: { path: 'packages/time-core/src' },
      to: { pathNot: 'packages/time-core/src' },
    },
    {
      name: 'contracts-zod-only',
      comment: 'packages/contracts/src MUST depend only on zod.',
      severity: 'error',
      from: { path: 'packages/contracts/src' },
      to: { pathNot: '(packages/contracts/src|node_modules/zod)' },
    },
    ...modules.map((module) => {
      const modulePath = module.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return {
        name: `no-${module}-cross-module-storage`,
        comment: 'D1: storage implementations belong to their module; public calls remain allowed.',
        severity: 'error',
        from: { path: `^apps/api/src/modules/${modulePath}/` },
        to: {
          path: `^apps/api/src/modules/(?!${modulePath}/)[^/]+(?=/).*(?:/|-)(?:repository|schemas?)(?:\\.[^/]+|/|$)`,
        },
      };
    }),
    {
      name: 'no-web-to-api',
      comment: 'D1: Web accesses the API over HTTP, never through source imports.',
      severity: 'error',
      from: { path: '^apps/web/' },
      to: { path: '^apps/api/' },
    },
    {
      name: 'scheduler-core-dependencies',
      comment: 'D1: scheduler-core may depend only on itself, contracts and time-core.',
      severity: 'error',
      from: { path: '^packages/scheduler-core/src/' },
      to: { pathNot: '^packages/(scheduler-core/src|contracts|time-core)/' },
    },
    {
      name: 'notifier-core-dependencies',
      comment: 'D1: notifier-core may depend only on itself and contracts.',
      severity: 'error',
      from: { path: '^packages/notifier-core/src/' },
      to: { pathNot: '^packages/(notifier-core/src|contracts)/' },
    },
    {
      name: 'stream-protocol-zod-only',
      comment: 'D1: stream-protocol may depend only on itself and zod.',
      severity: 'error',
      from: { path: '^packages/stream-protocol/src/' },
      to: { pathNot: '(^packages/stream-protocol/src/|node_modules/zod(?:/|$))' },
    },
    {
      name: 'no-circular',
      comment: 'No circular dependencies in the monorepo.',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
  },
};
