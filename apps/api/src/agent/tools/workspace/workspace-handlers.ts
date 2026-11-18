import type { Pool, PoolClient } from 'pg';
import { workspaceGrantSchema } from '@along/contracts';
import { ApplicationError } from '../../../platform/errors.js';
import {
  createDocumentApproval,
  validateDocumentApprovalApply,
  DocumentProposalOperationError,
} from '../../../features/approvals/public.js';
import {
  applyWorkspaceReplace,
  publishWorkspaceReplace,
  type ApprovedWorkspaceTarget,
  publishWorkspaceCreate,
  isWorkspaceOutputDirectory,
  strictUtf8,
  utf8Bytes,
  WorkspaceDeniedError,
} from '../../../features/workspaces/public.js';
import {
  TOOL_INPUT_SCHEMAS,
  DELEGATED_WORKSPACE_READ_SCHEMAS,
  DelegatedWorkspaceProposeInputSchema,
} from '../schemas.js';
import type { ToolContext, ToolOutcome, ToolResult } from '../contracts.js';
import {
  executeNonTransactionalInvocation,
  executeReadOnlyInvocation,
} from '../invocations/invocations.js';
import { readAcceptedInvocationResult } from '../invocations/accepted-result.js';
import { callWorkspaceMcp, type WorkspaceReadTool } from './mcp-workspace.js';
import { readRunDocumentEvidence } from '../query.js';
import { workspaceDenied } from '../handler-common.js';

export async function runWorkspaceProposal(
  client: PoolClient,
  ctx: ToolContext,
  args: unknown,
): Promise<ToolResult> {
  const parsed =
    ctx.authorizationRevision === 'delegation/1'
      ? DelegatedWorkspaceProposeInputSchema.safeParse(args)
      : TOOL_INPUT_SCHEMAS.workspace_propose_replace.safeParse(args);
  if (!parsed.success || !ctx.workspaceGrant) return workspaceDenied();
  let path = '';
  try {
    if ('old_text' in parsed.data) {
      utf8Bytes(parsed.data.old_text);
      utf8Bytes(parsed.data.new_text);
    }
    const evidence = await readRunDocumentEvidence(client, ctx);
    const baseRead = evidence.reads.find(
      (read) => read.invocation_id === parsed.data.read_invocation_id,
    );
    if (!baseRead) return workspaceDenied();
    path = baseRead.relative_path;
    if ('old_text' in parsed.data && parsed.data.old_text === parsed.data.new_text)
      return { status: 'ok', result: { kind: 'operation_error', path, reason: 'unchanged' } };
    const approval = await createDocumentApproval(client, {
      ownerId: ctx.ownerId,
      conversationId: ctx.conversationId,
      runId: ctx.runId,
      workspaceGrant: ctx.workspaceGrant,
      relativePath: path,
      baseRead,
      ...('change' in parsed.data
        ? { change: parsed.data.change }
        : { oldText: parsed.data.old_text, newText: parsed.data.new_text }),
      evidence,
    });
    return { status: 'ok', result: { kind: 'document_approval', approval } };
  } catch (error) {
    if (error instanceof WorkspaceDeniedError) return workspaceDenied();
    if (error instanceof DocumentProposalOperationError)
      return { status: 'ok', result: { kind: 'operation_error', path, reason: error.reason } };
    if (error instanceof ApplicationError) return workspaceDenied();
    throw error;
  }
}

export function invokeWorkspaceApply(
  pool: Pool,
  ctx: ToolContext,
  input: { invocationId: string; toolId: string; args: unknown },
): Promise<ToolOutcome> {
  let target: ApprovedWorkspaceTarget | undefined;
  let frozen: ToolContext | undefined;
  return executeNonTransactionalInvocation(pool, ctx, input, {
    validateDispatch: async (client, context, binding) => {
      const args = TOOL_INPUT_SCHEMAS.workspace_apply_replace.parse(input.args);
      if (!context.workspaceGrant) throw new WorkspaceDeniedError();
      const receipt = await validateDocumentApprovalApply(client, {
        ownerId: context.ownerId,
        conversationId: context.conversationId,
        runId: context.runId,
        workspaceGrant: context.workspaceGrant,
        approvalId: args.approval_id,
        invocationId: binding.invocationId,
      });
      frozen = context;
      target = {
        approval_id: receipt.approval_id,
        path: receipt.relative_path,
        base_version: receipt.base_version,
        exact_new_content: receipt.exact_new_content,
        new_version: receipt.new_version,
      };
    },
    execute: async (binding) => {
      if (!target || !frozen?.workspaceGrant) throw new Error('missing authorized frozen target');
      frozen.signal?.throwIfAborted();
      const client = await pool.connect();
      try {
        const result = await applyWorkspaceReplace(
          client,
          frozen.ownerId,
          frozen.workspaceGrant,
          target,
          { invocation_id: binding.invocationId, args_hash: binding.argsHash },
        );
        return {
          ...binding,
          evidenceRef:
            result.kind === 'applied'
              ? result.evidence_ref
              : `workspace-conflict:${binding.invocationId}`,
          result: { status: 'ok', result },
        };
      } finally {
        client.release();
      }
    },
  });
}

export function invokeWorkspaceReplace(
  pool: Pool,
  ctx: ToolContext,
  input: { invocationId: string; toolId: string; args: unknown },
): Promise<ToolOutcome> {
  let frozen: ToolContext | undefined;
  return executeNonTransactionalInvocation(pool, ctx, input, {
    validateDispatch: async (_client, context) => {
      if (!context.workspaceGrant || !context.documentEdit) throw new WorkspaceDeniedError();
      frozen = context;
    },
    execute: async (binding) => {
      const grant = frozen?.workspaceGrant;
      const edit = frozen?.documentEdit;
      if (!frozen || !grant || !edit) throw new Error('missing frozen document edit');
      if (edit.operation_error)
        return {
          ...binding,
          evidenceRef: `workspace-operation:${binding.invocationId}`,
          result: {
            status: 'ok',
            result: {
              kind: 'operation_error',
              path: edit.relative_path,
              reason: edit.operation_error,
            },
          },
        };
      if (edit.exact_new_content === undefined || !edit.new_version)
        throw new Error('missing exact document bytes');
      frozen.signal?.throwIfAborted();
      const client = await pool.connect();
      try {
        const result = await publishWorkspaceReplace(client, frozen.ownerId, grant, {
          path: edit.relative_path,
          base_version: edit.base_version,
          exact_new_content: edit.exact_new_content,
          new_version: edit.new_version,
        });
        const common = {
          workspace_id: grant.workspace_id,
          path: edit.relative_path,
          invocation_id: binding.invocationId,
          args_hash: binding.argsHash,
          base_version: edit.base_version,
        };
        const evidenceRef = `workspace-edit:${binding.invocationId}`;
        return {
          ...binding,
          evidenceRef,
          result: {
            status: 'ok',
            result:
              result.kind === 'applied'
                ? {
                    kind: 'edit_applied',
                    ...common,
                    version: result.version,
                    byte_length: result.byte_length,
                    evidence_ref: evidenceRef,
                  }
                : {
                    kind: 'edit_conflict',
                    ...common,
                    actual_version: result.actual_version,
                    reason: result.reason,
                    zero_write: true,
                  },
          },
        };
      } finally {
        client.release();
      }
    },
  });
}
export function invokeWorkspaceCreate(
  pool: Pool,
  ctx: ToolContext,
  input: { invocationId: string; toolId: string; args: unknown },
): Promise<ToolOutcome> {
  let frozen: ToolContext | undefined;
  return executeNonTransactionalInvocation(pool, ctx, input, {
    validateDispatch: async (_client, context) => {
      if (
        context.authorizationRevision !== 'delegation/1' ||
        !context.workspaceGrant ||
        !context.documentCreate
      )
        throw new WorkspaceDeniedError();
      frozen = context;
    },
    execute: async (binding) => {
      const grant = frozen?.workspaceGrant;
      const target = frozen?.documentCreate;
      if (!frozen || !grant || !target) throw new Error('missing frozen create target');
      frozen.signal?.throwIfAborted();
      const client = await pool.connect();
      try {
        const result = await publishWorkspaceCreate(client, frozen.ownerId, grant, {
          output_directory: target.output_directory,
          directory_identity: target.directory_identity,
          path: target.relative_path,
          exact_new_content: strictUtf8(Buffer.from(target.content_base64, 'base64')),
          new_version: target.new_version,
        });
        const common = {
          workspace_id: grant.workspace_id,
          path: target.relative_path,
          invocation_id: binding.invocationId,
          args_hash: binding.argsHash,
        };
        const evidenceRef = `workspace-create:${binding.invocationId}:${target.new_version}`;
        return {
          ...binding,
          evidenceRef,
          ...(result.kind === 'applied' ? { fileIdentity: result.file_identity } : {}),
          result: {
            status: 'ok',
            result:
              result.kind === 'applied'
                ? {
                    kind: 'create_applied',
                    ...common,
                    version: result.version,
                    byte_length: result.byte_length,
                    evidence_ref: evidenceRef,
                  }
                : result.kind === 'conflict'
                  ? { kind: 'create_conflict', ...common, reason: result.reason, zero_write: true }
                  : { kind: 'create_failed', ...common, reason: result.reason, zero_write: true },
          },
        };
      } finally {
        client.release();
      }
    },
  });
}

export function invokeWorkspaceRead(
  pool: Pool,
  ctx: ToolContext,
  input: { invocationId: string; toolId: string; args: unknown },
): Promise<ToolOutcome> {
  const toolId = input.toolId as WorkspaceReadTool;
  return executeReadOnlyInvocation(pool, ctx, input, async (frozen) => {
    const parsed =
      frozen.authorizationRevision === 'delegation/1'
        ? DELEGATED_WORKSPACE_READ_SCHEMAS[toolId].safeParse(input.args)
        : TOOL_INPUT_SCHEMAS[toolId].safeParse(input.args);
    if (!parsed.success) return workspaceDenied();
    try {
      const { path } = parsed.data;
      const mcpArgs =
        'literal' in parsed.data && typeof parsed.data.literal === 'string'
          ? { path, literal: parsed.data.literal }
          : { path };
      const authorizedCreatedPaths: Array<{
        path: string;
        directory_identity: string;
        file_identity: string;
        version: string;
      }> = [];
      if (frozen.authorizationRevision === 'delegation/1' && frozen.workspaceGrant) {
        const client = await pool.connect();
        try {
          const { rows } = await client.query<{
            invocation_id: string;
            args_hash: string;
            frozen_context: {
              workspaceGrant?: unknown;
              documentCreate?: {
                output_directory: string;
                relative_path: string;
                directory_identity: string;
              };
            };
            result_version: number | null;
            tool_id: string;
            approval_id: string | null;
            accepted_result: unknown;
            outcome_kind: string | null;
          }>(
            `SELECT i.invocation_id,i.args_hash,i.frozen_context,i.result_version,i.tool_id,i.approval_id,i.accepted_result,i.outcome_kind
               FROM tool_invocations i
               JOIN agent_runs current_run ON current_run.id=$3 AND current_run.owner_id=$1
                 AND current_run.conversation_id=$2
               WHERE i.owner_id=$1 AND i.tool_id='workspace_create' AND i.state='completed'
                 AND i.accepted_result->'result'->>'kind'='create_applied'
                 AND (
                   (i.conversation_id=$2 AND i.run_id=$3 AND i.frozen_context->'workspaceGrant'=$4::jsonb)
                   OR (
                     current_run.frozen_context->>'createdArtifactReadRevision'='owner-created/1'
                     AND i.run_id<>$3 AND i.accepted_at < current_run.created_at
                     AND i.frozen_context->'workspaceGrant'->>'workspace_id'=$5
                     AND i.frozen_context->'workspaceGrant'->>'owner_id'=$1::text
                     AND i.frozen_context->'workspaceGrant'->>'root_identity'=$6
                   )
                 )
               ORDER BY i.accepted_at DESC,i.invocation_id DESC`,
            [
              frozen.ownerId,
              frozen.conversationId,
              frozen.runId,
              JSON.stringify(frozen.workspaceGrant),
              frozen.workspaceGrant.workspace_id,
              frozen.workspaceGrant.root_identity,
            ],
          );
          for (const row of rows) {
            const accepted = await readAcceptedInvocationResult(client, frozen, row);
            const target = row.frozen_context.documentCreate;
            const privateResult = row.accepted_result as { file_identity?: unknown };
            const historicalGrant = workspaceGrantSchema.safeParse(
              row.frozen_context.workspaceGrant,
            );
            const slash = target?.relative_path.lastIndexOf('/') ?? -1;
            const directory = slash < 0 ? '' : target!.relative_path.slice(0, slash);
            if (
              accepted.status === 'ok' &&
              accepted.result.kind === 'create_applied' &&
              target &&
              historicalGrant.success &&
              historicalGrant.data.owner_id === frozen.ownerId &&
              historicalGrant.data.workspace_id === frozen.workspaceGrant.workspace_id &&
              historicalGrant.data.root_identity === frozen.workspaceGrant.root_identity &&
              typeof target.directory_identity === 'string' &&
              target.directory_identity.length > 0 &&
              typeof target.output_directory === 'string' &&
              target.output_directory === directory &&
              isWorkspaceOutputDirectory(historicalGrant.data, directory) &&
              isWorkspaceOutputDirectory(frozen.workspaceGrant, directory) &&
              !authorizedCreatedPaths.some((entry) => entry.path === target.relative_path) &&
              typeof privateResult.file_identity === 'string' &&
              privateResult.file_identity.length > 0
            )
              authorizedCreatedPaths.push({
                path: target.relative_path,
                directory_identity: target.directory_identity,
                file_identity: privateResult.file_identity,
                version: accepted.result.version,
              });
          }
        } finally {
          client.release();
        }
      }
      const result = await callWorkspaceMcp(frozen, toolId, mcpArgs, authorizedCreatedPaths);
      return {
        status: 'ok',
        result:
          frozen.authorizationRevision === 'delegation/1'
            ? { ...result, workspace_id: frozen.workspaceGrant!.workspace_id }
            : result,
      };
    } catch (error) {
      if (error instanceof WorkspaceDeniedError) return workspaceDenied();
      throw error;
    }
  });
}
