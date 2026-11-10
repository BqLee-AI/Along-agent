import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import {
  DEFAULT_INHERITED_ENV_VARS,
  StdioClientTransport,
} from '@modelcontextprotocol/client/stdio';
import { z } from 'zod';
import { workspaceResultSchema, type WorkspaceResult } from '@along/contracts';
import {
  canonicalRelativePath,
  getWorkspaceMcpConfiguration,
  hashBytes,
  isWorkspaceOutputDirectory,
  isWorkspaceReadableDirectory,
  isWorkspaceReadablePath,
  utf8Bytes,
  validateWorkspaceGrant,
  WorkspaceDeniedError,
} from '../workspaces/service.js';
import type { ToolContext } from './contracts.js';
import { ToolExecutionError } from './invocations.js';

const BUN_EXECUTABLE = process.execPath;
const SERVER_ENTRY = fileURLToPath(
  new URL('../../../dist/modules/workspaces/mcp-server.js', import.meta.url),
);
const MCP_TOOLS = ['list_files', 'read_file', 'search_files'];
const names = {
  workspace_list: 'list_files',
  workspace_grep: 'search_files',
  workspace_read: 'read_file',
} as const;
export type WorkspaceReadTool = keyof typeof names;
const envelopeSchema = z
  .object({
    content: z.tuple([z.object({ type: z.literal('text'), text: z.string() }).strict()]),
    structuredContent: z.unknown(),
    isError: z.literal(false).optional(),
  })
  .strict();

// The SDK otherwise adds a platform-specific default inherited environment.
// Explicitly clear every default, then allow only OS loader prerequisites.
function childEnvironment(configuration: string): Record<string, string> {
  const env: Record<string, string> = Object.fromEntries(
    DEFAULT_INHERITED_ENV_VARS.map((key) => [key, '']),
  );
  for (const key of ['SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT']) {
    if (process.env[key]) env[key] = process.env[key]!;
  }
  env.WORKSPACE_MCP_CONFIG = configuration;
  return env;
}

export async function callWorkspaceMcp(
  ctx: ToolContext,
  toolId: WorkspaceReadTool,
  args: { path: string; literal?: string },
  authorizedCreatedPaths: Array<{
    path: string;
    directory_identity: string;
    file_identity: string;
    version: string;
  }> = [],
): Promise<WorkspaceResult> {
  if (!ctx.workspaceGrant) throw new WorkspaceDeniedError();
  validateWorkspaceGrant(ctx.ownerId, ctx.workspaceGrant);
  const grant = ctx.workspaceGrant;
  canonicalRelativePath(args.path, toolId !== 'workspace_read');
  const inSubtree = (path: string) =>
    args.path === '' || path === args.path || path.startsWith(`${args.path}/`);
  if (
    toolId === 'workspace_read'
      ? !isWorkspaceReadablePath(ctx.ownerId, grant, args.path, authorizedCreatedPaths)
      : !isWorkspaceReadableDirectory(ctx.ownerId, grant, args.path, authorizedCreatedPaths) &&
        !(toolId === 'workspace_list' && isWorkspaceOutputDirectory(grant, args.path))
  )
    throw new WorkspaceDeniedError();
  const configuration = getWorkspaceMcpConfiguration(ctx.ownerId, grant, authorizedCreatedPaths);
  const transport = new StdioClientTransport({
    command: BUN_EXECUTABLE,
    args: [SERVER_ENTRY],
    env: childEnvironment(configuration),
    stderr: 'ignore',
  });
  const client = new Client({ name: 'along-workspace-gateway', version: '1.0.0' });
  const closeOnAbort = () => {
    void client.close().catch(() => undefined);
  };
  ctx.signal?.addEventListener('abort', closeOnAbort, { once: true });
  let deniedByServer = false;
  try {
    ctx.signal?.throwIfAborted();
    await client.connect(transport, { signal: ctx.signal });
    const listed = await client.listTools(undefined, { signal: ctx.signal });
    if (
      listed.tools.length !== 3 ||
      listed.tools
        .map((tool) => tool.name)
        .sort()
        .join(',') !== MCP_TOOLS.join(',')
    )
      throw new ToolExecutionError();
    const called = await client.callTool(
      { name: names[toolId], arguments: args },
      { signal: ctx.signal },
    );
    const deniedResponse = z
      .object({
        isError: z.literal(true),
        content: z.tuple([
          z.object({ type: z.literal('text'), text: z.literal('WORKSPACE_DENIED') }).strict(),
        ]),
      })
      .strict()
      .safeParse(called);
    if (deniedResponse.success) {
      deniedByServer = true;
      throw new WorkspaceDeniedError();
    }
    const response = envelopeSchema.parse(called);
    if (JSON.stringify(response.structuredContent) !== response.content[0].text)
      throw new ToolExecutionError();
    const result = workspaceResultSchema.parse(response.structuredContent);
    const allowedFile = (path: string) => {
      canonicalRelativePath(path);
      if (
        !isWorkspaceReadablePath(ctx.ownerId, grant, path, authorizedCreatedPaths) ||
        !inSubtree(path)
      )
        throw new ToolExecutionError();
    };
    if (result.kind === 'operation_error') {
      if (result.path !== args.path) allowedFile(result.path);
    } else if (result.kind === 'read') {
      if (toolId !== 'workspace_read' || result.path !== args.path) throw new ToolExecutionError();
      allowedFile(result.path);
      const bytes = utf8Bytes(result.content);
      if (bytes.length !== result.byte_length || hashBytes(bytes) !== result.version)
        throw new ToolExecutionError();
      const created = authorizedCreatedPaths.find((entry) => entry.path === result.path);
      if (
        !isWorkspaceReadablePath(ctx.ownerId, grant, result.path) &&
        (!created || created.version !== result.version)
      )
        throw new ToolExecutionError();
    } else if (result.kind === 'list') {
      if (toolId !== 'workspace_list' || result.path !== args.path) throw new ToolExecutionError();
      if (grant.output_directories && result.visibility !== 'authorized_paths_only')
        throw new ToolExecutionError();
      const prefix = args.path ? `${args.path}/` : '';
      for (const entry of result.entries) {
        canonicalRelativePath(entry.path);
        if (!entry.path.startsWith(prefix) || entry.path.slice(prefix.length).includes('/'))
          throw new ToolExecutionError();
        if (entry.kind === 'file') allowedFile(entry.path);
        else if (
          !isWorkspaceReadableDirectory(ctx.ownerId, grant, entry.path, authorizedCreatedPaths)
        )
          throw new ToolExecutionError();
      }
      for (const failure of result.failures) allowedFile(failure.path);
    } else if (result.kind === 'search') {
      if (toolId !== 'workspace_grep' || result.path !== args.path) throw new ToolExecutionError();
      for (const match of result.matches) {
        allowedFile(match.path);
        const created = authorizedCreatedPaths.find((entry) => entry.path === match.path);
        if (
          !isWorkspaceReadablePath(ctx.ownerId, grant, match.path) &&
          (!created || created.version !== match.version)
        )
          throw new ToolExecutionError();
        if (
          !/^[a-f0-9]{64}$/.test(match.version) ||
          !args.literal ||
          !match.text.includes(args.literal)
        )
          throw new ToolExecutionError();
      }
      for (const failure of result.failures) allowedFile(failure.path);
    } else throw new ToolExecutionError();
    if (Buffer.byteLength(JSON.stringify({ status: 'ok', result }), 'utf8') > 240000)
      return { kind: 'operation_error', path: args.path, reason: 'range_too_large' };
    return result;
  } catch (error) {
    if (deniedByServer && error instanceof WorkspaceDeniedError) throw error;
    throw new ToolExecutionError();
  } finally {
    ctx.signal?.removeEventListener('abort', closeOnAbort);
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
  }
}
