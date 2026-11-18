import { McpServer, fromJsonSchema } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { workspaceGrantSchema } from '@along/contracts';
import { configureWorkspaceRegistry, type AuthorizedCreatedPath } from '../registry/service.js';
import { WorkspaceDeniedError } from '../registry/path-policy.js';
import { listWorkspaceFiles, searchWorkspaceFiles, readWorkspaceFile } from '../read/files.js';

const configuration = JSON.parse(process.env.WORKSPACE_MCP_CONFIG ?? 'null') as {
  registration: { workspace_id: string; owner_id: string };
  grant: unknown;
  authorizedCreatedPaths: AuthorizedCreatedPath[];
};
await configureWorkspaceRegistry(configuration ? [configuration.registration] : []);
const selected = configuration.registration;
const grant = workspaceGrantSchema.parse(configuration.grant);
const server = new McpServer({ name: 'along-readonly-workspace', version: '1.0.0' });
const pathInput = fromJsonSchema<{ path: string }>({
  type: 'object',
  properties: { path: { type: 'string' } },
  required: ['path'],
  additionalProperties: false,
});
const searchInput = fromJsonSchema<{ path: string; literal: string }>({
  type: 'object',
  properties: { path: { type: 'string' }, literal: { type: 'string', minLength: 1 } },
  required: ['path', 'literal'],
  additionalProperties: false,
});
function result(payload: unknown) {
  const text = JSON.stringify(payload);
  const relative =
    payload && typeof payload === 'object' && 'path' in payload && typeof payload.path === 'string'
      ? payload.path
      : '';
  const bounded =
    Buffer.byteLength(text) > 240000
      ? { kind: 'operation_error', path: relative, reason: 'range_too_large' }
      : payload;
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(bounded) }],
    structuredContent: bounded as Record<string, unknown>,
  };
}
async function execute(operation: () => Promise<unknown>) {
  try {
    return result(await operation());
  } catch (error) {
    return {
      isError: true,
      content: [
        {
          type: 'text' as const,
          text: error instanceof WorkspaceDeniedError ? 'WORKSPACE_DENIED' : 'WORKSPACE_FAILED',
        },
      ],
    };
  }
}
server.registerTool(
  'list_files',
  {
    description: 'List actual authorized direct children.',
    inputSchema: pathInput,
  },
  async ({ path }) =>
    execute(() =>
      listWorkspaceFiles(selected.owner_id, grant, path, configuration.authorizedCreatedPaths),
    ),
);
server.registerTool(
  'search_files',
  {
    description: 'Search authorized UTF-8 files for a case-sensitive literal.',
    inputSchema: searchInput,
  },
  async ({ path, literal }) =>
    execute(() =>
      searchWorkspaceFiles(
        selected.owner_id,
        grant,
        path,
        literal,
        configuration.authorizedCreatedPaths,
      ),
    ),
);
server.registerTool(
  'read_file',
  {
    description: 'Read a complete authorized UTF-8 file and its actual byte hash.',
    inputSchema: pathInput,
  },
  async ({ path }) =>
    execute(() =>
      readWorkspaceFile(selected.owner_id, grant, path, configuration.authorizedCreatedPaths),
    ),
);
await server.connect(new StdioServerTransport());
