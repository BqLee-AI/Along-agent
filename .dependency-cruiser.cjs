const { readdirSync } = module.require('node:fs');
const { resolve } = module.require('node:path');

// Discover feature owners in both the application and isolated boundary fixtures.
const modules = readdirSync('apps/api/src/features', { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

const escapeRegex = (path) => path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const exactPaths = (paths) => `^(?:${paths.map(escapeRegex).join('|')})$`;

const featureEntrypoints = exactPaths([
  ...modules.map((owner) => `apps/api/src/features/${owner}/public.ts`),
  // The larger public barrels depend on the consumers of these leaf ports.
  'apps/api/src/features/conversations/run/ownership.ts',
  'apps/api/src/features/tasks/notification-source.ts',
]);

const approvalController = 'apps/api/src/features/approvals/controller.ts';
const conversationAdapters = [
  'apps/api/src/features/conversations/controller.ts',
  'apps/api/src/features/conversations/run-event-response.ts',
];
const featureAdapters = exactPaths([
  approvalController,
  ...conversationAdapters,
  'apps/api/src/features/brief/controller.ts',
  'apps/api/src/features/identity/account/controller.ts',
  'apps/api/src/features/memory/controller.ts',
  'apps/api/src/features/model-providers/http/controller.ts',
  'apps/api/src/features/office-connectors/controller.ts',
  'apps/api/src/features/tasks/controller.ts',
  'apps/api/src/features/workspaces/http/controller.ts',
]);
const agentOperations = 'apps/api/src/agent/operations/public.ts';
const agentRuntimeContracts = 'apps/api/src/agent/runtime/contracts.ts';

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
    ...modules.map((owner) => {
      const ownerPath = escapeRegex(owner);
      return {
        name: `no-${owner}-private-feature-imports`,
        comment: 'Cross-owner feature imports, including types, must target declared entrypoints.',
        severity: 'error',
        from: { path: `^apps/api/src/features/${ownerPath}/` },
        to: {
          path: `^apps/api/src/features/(?!${ownerPath}/)[^/]+/`,
          pathNot: featureEntrypoints,
        },
      };
    }),
    {
      name: 'api-business-no-http-implementation',
      comment: 'Business code must not depend on HTTP adapters, controllers or Elysia.',
      severity: 'error',
      from: {
        path: '^apps/api/src/(features|agent|platform|worker)/',
        pathNot: featureAdapters,
      },
      to: {
        path: '(^apps/api/src/http/|^apps/api/src/features/(?:[^/]+/http/|.+/(controller|routes|native-routes|document-routes|run-event-response)\\.)|node_modules/(elysia|@elysia)/)',
      },
    },
    {
      name: 'api-no-reverse-bootstrap',
      comment: 'Bootstrap assembles API layers; those layers must not import it.',
      severity: 'error',
      from: { path: '^apps/api/src/(features|agent|platform|worker|db|http)/' },
      to: { path: '^apps/api/src/bootstrap/' },
    },
    {
      name: 'no-web-to-api',
      comment: 'Web must not load API runtime code; only the declared client type is supported.',
      severity: 'error',
      from: { path: '^apps/web/' },
      to: { path: '^apps/api/', dependencyTypesNot: ['type-only'] },
    },
    {
      name: 'no-web-private-api-types',
      severity: 'error',
      from: { path: '^apps/web/' },
      to: {
        path: '^apps/api/',
        pathNot: '^apps/api/dist/client-type\\.d\\.ts$',
        dependencyTypes: ['type-only'],
      },
    },
    {
      name: 'feature-no-agent-implementation',
      comment: 'Persistent facts and domain rules do not depend on process execution.',
      severity: 'error',
      from: {
        path: '^apps/api/src/features/',
        pathNot: exactPaths([approvalController, ...conversationAdapters]),
      },
      to: { path: '^apps/api/src/agent/' },
    },
    {
      name: 'conversation-adapter-agent-entrypoints',
      severity: 'error',
      from: { path: exactPaths(conversationAdapters) },
      to: {
        path: '^apps/api/src/agent/',
        pathNot: exactPaths([agentOperations, agentRuntimeContracts]),
      },
    },
    {
      name: 'conversation-adapter-agent-contract-types-only',
      severity: 'error',
      from: { path: exactPaths(conversationAdapters) },
      to: { path: exactPaths([agentRuntimeContracts]), dependencyTypesNot: ['type-only'] },
    },
    {
      name: 'approval-adapter-agent-entrypoints',
      severity: 'error',
      from: { path: exactPaths([approvalController]) },
      to: {
        path: '^apps/api/src/agent/',
        // Existing document evidence read. This exception is specific to this adapter and file.
        pathNot: exactPaths([agentOperations, 'apps/api/src/agent/tools/query.ts']),
      },
    },
    {
      name: 'agent-no-private-feature-imports',
      comment: 'Agent operations must use declared feature entrypoints, including for types.',
      severity: 'error',
      from: { path: '^apps/api/src/agent/' },
      to: {
        path: '^apps/api/src/features/[^/]+/',
        pathNot: featureEntrypoints,
      },
    },
    {
      name: 'web-feature-model-no-presentation',
      comment: 'Feature models own data and projections, never presentation or route adapters.',
      severity: 'error',
      from: { path: '^apps/web/src/features/[^/]+/model/' },
      to: {
        path: '^apps/web/src/(features/[^/]+/(viewmodel|view|route)/|shell/view/|shared/ui/)',
      },
    },
    {
      name: 'web-feature-no-app',
      comment: 'App routes assemble features; features MUST NOT import route implementations.',
      severity: 'error',
      from: { path: '^apps/web/src/features/' },
      to: { path: '^apps/web/src/app/' },
    },
    {
      name: 'web-shared-no-feature-or-shell',
      comment: 'Shared infrastructure MUST NOT depend on features or the workspace shell.',
      severity: 'error',
      from: { path: '^apps/web/src/shared/' },
      to: { path: '^apps/web/src/(features|shell)/' },
    },
    {
      name: 'web-no-root-business-lib',
      comment:
        'Business modules live in features, not the obsolete root lib (including deleted aliases).',
      severity: 'error',
      from: { path: '^apps/web/src/' },
      to: { path: '^(apps/web/src/lib|@/lib)(/|$)' },
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
    tsConfig: { fileName: resolve('apps/web/tsconfig.json') },
  },
};
