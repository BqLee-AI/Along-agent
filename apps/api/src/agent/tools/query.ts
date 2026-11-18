import type { PoolClient } from 'pg';
import { isDeepStrictEqual } from 'node:util';
import { workspaceGrantSchema, type RunView } from '@along/contracts';
import {
  readDocumentApprovalReceipt,
  type DocumentRunEvidence,
  documentEvidenceLater,
  isDocumentApplied,
  isDocumentConflict,
  matchingDocumentApply,
  verifiedDocumentRead,
  listDocumentApprovals,
} from '../../features/approvals/public.js';
import {
  assertToolRunBinding,
  assertToolRunInterruptionBinding,
} from '../../features/conversations/public.js';
import type {
  ToolContext,
  TimezoneSettingPayload,
  TaskCreatedPayload,
  ReminderCancelledPayload,
} from './contracts.js';
import { parseResult } from './result-schema.js';
import {
  decodeWorkspaceContent,
  hydrateWorkspaceReadResult,
  readAcceptedInvocationResult,
} from './invocations/accepted-result.js';
import { readReminderTimeErrors } from './reminders/reminder-source.js';
import { stateConflict } from '../../platform/errors.js';
import { hashBytes, isWorkspaceOutputDirectory } from '../../features/workspaces/public.js';

export interface RunGoalDocumentEffect {
  workspace_id: string;
  path: string;
  invocation_id: string;
  read_invocation_id: string | null;
  version: string | null;
  status: 'applied' | 'verified' | 'conflict' | 'failed' | 'unknown';
  operation?: 'create' | 'replace';
  superseded: boolean;
}
export interface RunGoalDocumentEvidence {
  effects: RunGoalDocumentEffect[];
  hasPendingApproval: boolean;
  resolvedApprovalInvocationIds: string[];
}

type RunBinding = Pick<ToolContext, 'ownerId' | 'conversationId' | 'runId'>;

// Immutable same-Run setting receipts, not a projection of today's preference.
// A clear is a real accepted null fact; later writes never erase this receipt.
export async function readRunTimezoneSettings(
  client: PoolClient,
  binding: RunBinding,
): Promise<Array<{ invocation_id: string } & Omit<TimezoneSettingPayload, 'kind'>>> {
  await assertToolRunBinding(client, binding);
  return readTimezoneSettings(client, binding);
}

export async function readRunCreatedReminders(client: PoolClient, binding: RunBinding) {
  await assertToolRunBinding(client, binding);
  return readCreatedReminders(client, binding);
}

export async function readRunCancelledReminders(client: PoolClient, binding: RunBinding) {
  await assertToolRunBinding(client, binding);
  return readCancelledReminders(client, binding);
}

export async function readRunReminderTimeErrors(
  client: PoolClient,
  binding: RunBinding,
): Promise<NonNullable<RunView['reminder_time_errors']>> {
  await assertToolRunBinding(client, binding);
  return readReminderTimeErrors(client, binding);
}

async function readCreatedReminders(
  client: PoolClient,
  binding: RunBinding,
): Promise<Array<{ invocation_id: string } & TaskCreatedPayload>> {
  const { rows } = await client.query<{
    invocation_id: string;
    tool_id: string;
    result_version: number | null;
    outcome_kind: string | null;
    approval_id: string | null;
    accepted_result: unknown;
    frozen_context: { authorizationRevision?: unknown };
  }>(
    `SELECT invocation_id,tool_id,result_version,outcome_kind,approval_id,accepted_result,frozen_context
     FROM tool_invocations WHERE owner_id=$1 AND conversation_id=$2 AND run_id=$3
       AND tool_id='create_reminder' AND state='completed' ORDER BY accepted_at,invocation_id`,
    [binding.ownerId, binding.conversationId, binding.runId],
  );
  const receipts: Array<{ invocation_id: string } & TaskCreatedPayload> = [];
  for (const row of rows) {
    const result = await readAcceptedInvocationResult(client, binding, row);
    if (result.status !== 'ok' || result.result.kind !== 'task_created') continue;
    receipts.push({ invocation_id: row.invocation_id, ...result.result });
  }
  return receipts;
}

async function readCancelledReminders(
  client: PoolClient,
  binding: RunBinding,
): Promise<Array<{ invocation_id: string } & ReminderCancelledPayload>> {
  const { rows } = await client.query<{
    invocation_id: string;
    tool_id: string;
    result_version: number | null;
    outcome_kind: string | null;
    approval_id: string | null;
    accepted_result: unknown;
    frozen_context: { authorizationRevision?: unknown } | null;
  }>(
    `SELECT invocation_id,tool_id,result_version,outcome_kind,approval_id,accepted_result,frozen_context
     FROM tool_invocations WHERE owner_id=$1 AND conversation_id=$2 AND run_id=$3
       AND tool_id='cancel_reminder' AND state='completed' ORDER BY accepted_at,invocation_id`,
    [binding.ownerId, binding.conversationId, binding.runId],
  );
  const receipts: Array<{ invocation_id: string } & ReminderCancelledPayload> = [];
  for (const row of rows) {
    const result = await readAcceptedInvocationResult(client, binding, row);
    if (result.status !== 'ok' || result.result.kind !== 'reminder_cancelled') continue;
    if (row.approval_id !== null || row.frozen_context?.authorizationRevision !== 'delegation/1')
      throw stateConflict('invalid accepted reminder cancellation');
    receipts.push({ invocation_id: row.invocation_id, ...result.result });
  }
  return receipts;
}

// Internal terminal projection, never a content/observation read boundary.
// Binding is checked before reading any receipts; hydration retains the same
// accepted-result version, outcome, payload and frozen-profile integrity checks.
export async function readRunInterruptionEvidence(client: PoolClient, binding: RunBinding) {
  await assertToolRunInterruptionBinding(client, binding);
  const { rows } = await client.query<{ has_unknown: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM tool_invocations
       WHERE owner_id=$1 AND conversation_id=$2 AND run_id=$3 AND state='unknown'
     ) AS has_unknown`,
    [binding.ownerId, binding.conversationId, binding.runId],
  );
  const settings = await readTimezoneSettings(client, binding);
  const creations = await readCreatedReminders(client, binding);
  const cancellations = await readCancelledReminders(client, binding);
  const documents = (await readRunGoalDocumentEvidence(client, binding)).effects;
  const savedRows = await client.query<{
    invocation_id: string;
    tool_id: string;
    result_version: number | null;
    outcome_kind: string | null;
    approval_id: string | null;
    accepted_result: unknown;
    frozen_context: unknown;
  }>(
    `SELECT invocation_id,tool_id,result_version,outcome_kind,approval_id,accepted_result,frozen_context
     FROM tool_invocations WHERE owner_id=$1 AND conversation_id=$2 AND run_id=$3
       AND tool_id='remember_memory' AND state='completed' AND outcome_kind='success'
     ORDER BY accepted_at,invocation_id`,
    [binding.ownerId, binding.conversationId, binding.runId],
  );
  const memories: string[] = [];
  for (const row of savedRows.rows) {
    const result = await readAcceptedInvocationResult(client, binding, row);
    if (row.approval_id !== null || result.status !== 'ok' || result.result.kind !== 'memory_saved')
      throw stateConflict('invalid accepted memory save');
    memories.push(row.invocation_id);
  }
  return {
    hasUnknown: rows[0]!.has_unknown,
    settings,
    creations,
    cancellations,
    documents,
    memories,
  };
}

async function readTimezoneSettings(
  client: PoolClient,
  binding: RunBinding,
): Promise<Array<{ invocation_id: string } & Omit<TimezoneSettingPayload, 'kind'>>> {
  const { rows } = await client.query<{
    invocation_id: string;
    tool_id: string;
    result_version: number | null;
    outcome_kind: string | null;
    approval_id: string | null;
    accepted_result: unknown;
    frozen_context: { authorizationRevision?: unknown };
  }>(
    `SELECT invocation_id,tool_id,result_version,outcome_kind,approval_id,accepted_result,frozen_context
     FROM tool_invocations
     WHERE owner_id=$1 AND conversation_id=$2 AND run_id=$3
       AND tool_id='set_user_timezone' AND state='completed'
     ORDER BY accepted_at,invocation_id`,
    [binding.ownerId, binding.conversationId, binding.runId],
  );
  const settings: Array<{ invocation_id: string } & Omit<TimezoneSettingPayload, 'kind'>> = [];
  for (const row of rows) {
    const result = await readAcceptedInvocationResult(client, binding, row);
    if (result.status !== 'ok') continue;
    if (
      result.result.kind !== 'timezone_setting' ||
      row.approval_id !== null ||
      row.frozen_context.authorizationRevision !== 'delegation/1'
    )
      throw stateConflict('invalid accepted timezone setting');
    const { timezone_id, previous_timezone_id, alias_version } = result.result;
    settings.push({
      invocation_id: row.invocation_id,
      timezone_id,
      previous_timezone_id,
      alias_version,
    });
  }
  return settings;
}

// This is the only document-effect projection. Approvals/conversations consume
// explicit accepted facts rather than reaching into the tools result ledger.
export async function readRunDocumentEvidence(
  client: PoolClient,
  binding: RunBinding,
): Promise<DocumentRunEvidence> {
  await assertToolRunBinding(client, binding);
  return readDocumentEvidence(client, binding);
}

async function readDocumentEvidence(
  client: PoolClient,
  binding: RunBinding,
): Promise<
  Omit<DocumentRunEvidence, 'reads'> & {
    reads: Array<
      DocumentRunEvidence['reads'][number] & {
        frozen_grant: unknown;
        authorization_revision: string | undefined;
      }
    >;
  }
> {
  const { rows } = await client.query<{
    invocation_id: string;
    owner_id: string;
    conversation_id: string;
    run_id: string;
    tool_id: string;
    state: 'reserved' | 'unknown' | 'completed';
    approval_id: string | null;
    frozen_context: {
      workspaceGrant?: unknown;
      documentApprovalId?: string;
      authorizationRevision?: string;
    };
    accepted_result: unknown;
    created_at: string;
    accepted_at: string;
  }>(
    `SELECT invocation_id,owner_id,conversation_id,run_id,tool_id,state,approval_id,
      frozen_context,accepted_result,
      to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
      coalesce(to_char(accepted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'') AS accepted_at
     FROM tool_invocations
     WHERE owner_id=$1 AND conversation_id=$2 AND run_id=$3
       AND tool_id IN ('workspace_read','workspace_apply_replace')
     ORDER BY created_at,invocation_id`,
    [binding.ownerId, binding.conversationId, binding.runId],
  );
  const reads: Array<
    DocumentRunEvidence['reads'][number] & {
      frozen_grant: unknown;
      authorization_revision: string | undefined;
    }
  > = [];
  const applies: DocumentRunEvidence['applies'][number][] = [];
  for (const row of rows) {
    const grant = workspaceGrantSchema.parse(row.frozen_context.workspaceGrant);
    const identity = {
      invocation_id: row.invocation_id,
      owner_id: row.owner_id,
      conversation_id: row.conversation_id,
      run_id: row.run_id,
      workspace_id: grant.workspace_id,
      registration_digest: grant.registration_digest,
      created_at: row.created_at,
      accepted_at: row.accepted_at,
    };
    if (row.tool_id === 'workspace_read') {
      if (row.state !== 'completed') continue;
      const accepted = hydrateWorkspaceReadResult(row.accepted_result);
      if (
        accepted.status === 'ok' &&
        accepted.result.kind === 'read' &&
        row.frozen_context.authorizationRevision === 'delegation/1' &&
        accepted.result.workspace_id !== grant.workspace_id
      )
        throw stateConflict('document read workspace differs from frozen grant');
      if (accepted.status === 'ok' && accepted.result.kind === 'read')
        reads.push({
          ...identity,
          frozen_grant: grant,
          authorization_revision: row.frozen_context.authorizationRevision,
          kind: 'read',
          relative_path: accepted.result.path,
          result: accepted.result,
        });
      continue;
    }
    const approvalId = row.frozen_context.documentApprovalId;
    if (!approvalId) continue;
    const receipt = await readDocumentApprovalReceipt(client, binding.ownerId, approvalId);
    const accepted = row.state === 'completed' ? parseResult(row.accepted_result) : null;
    const result =
      accepted?.status === 'ok' &&
      (accepted.result.kind === 'applied' || accepted.result.kind === 'conflict')
        ? accepted.result
        : null;
    applies.push({
      ...identity,
      kind: 'apply',
      relative_path: receipt.relative_path,
      approval_id: approvalId,
      state: row.state,
      result,
    });
  }
  return { reads, applies };
}

// Historical projection only: it does not reacquire a revoked execution grant.
export async function readRunGoalDocumentEvidence(
  client: PoolClient,
  binding: RunBinding,
): Promise<RunGoalDocumentEvidence> {
  await assertToolRunInterruptionBinding(client, binding);
  const { rows } = await client.query<{
    invocation_id: string;
    tool_id: string;
    state: string;
    args_hash: string;
    approval_id: string | null;
    frozen_context: {
      authorizationRevision?: string;
      workspaceGrant?: unknown;
      documentEdit?: NonNullable<ToolContext['documentEdit']>;
      documentCreate?: NonNullable<ToolContext['documentCreate']>;
    };
    accepted_result: unknown;
    accepted_at: string;
  }>(
    `SELECT invocation_id,tool_id,state,args_hash,approval_id,frozen_context,accepted_result,
      coalesce(to_char(accepted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'') accepted_at
      FROM tool_invocations WHERE owner_id=$1 AND conversation_id=$2 AND run_id=$3
      AND tool_id IN ('workspace_replace','workspace_propose_replace','workspace_apply_replace','workspace_create')
      ORDER BY created_at,invocation_id`,
    [binding.ownerId, binding.conversationId, binding.runId],
  );
  const delegated = rows.filter(
    (row) => row.frozen_context.authorizationRevision === 'delegation/1',
  );
  if (!delegated.length)
    return { effects: [], hasPendingApproval: false, resolvedApprovalInvocationIds: [] };
  const evidence = await readDocumentEvidence(client, binding);
  const approvals = await listDocumentApprovals(
    client,
    binding.ownerId,
    binding.conversationId,
    binding.runId,
  );
  const effects: RunGoalDocumentEffect[] = [];
  for (const row of delegated.filter((item) => item.tool_id === 'workspace_create')) {
    const grant = workspaceGrantSchema.parse(row.frozen_context.workspaceGrant);
    const create = row.frozen_context.documentCreate;
    if (!create) throw stateConflict('missing frozen document creation');
    const directory = isWorkspaceOutputDirectory(grant, create.output_directory);
    const { bytes, content } = decodeWorkspaceContent(create.content_base64);
    const prefix = create.output_directory ? `${create.output_directory}/` : '';
    const filename = create.relative_path.slice(prefix.length);
    if (
      !directory ||
      !create.directory_identity ||
      !create.relative_path.startsWith(prefix) ||
      !filename ||
      filename.includes('/') ||
      hashBytes(bytes) !== create.new_version
    )
      throw stateConflict('invalid frozen document creation');
    const common = {
      workspace_id: grant.workspace_id,
      path: create.relative_path,
      invocation_id: row.invocation_id,
      read_invocation_id: null,
      version: null,
      superseded: false,
      operation: 'create' as const,
    };
    if (row.state === 'unknown') {
      effects.push({ ...common, status: 'unknown' });
      continue;
    }
    if (row.state !== 'completed') continue;
    const accepted = hydrateWorkspaceReadResult(row.accepted_result);
    if (accepted.status !== 'ok') continue;
    const result = accepted.result;
    if (
      result.kind !== 'create_applied' &&
      result.kind !== 'create_conflict' &&
      result.kind !== 'create_failed'
    )
      throw stateConflict('invalid document creation result');
    if (
      result.invocation_id !== row.invocation_id ||
      result.args_hash !== row.args_hash ||
      result.workspace_id !== grant.workspace_id ||
      result.path !== create.relative_path
    )
      throw stateConflict('invalid document creation binding');
    if (result.kind !== 'create_applied') {
      effects.push({
        ...common,
        status: result.kind === 'create_conflict' ? 'conflict' : 'failed',
      });
      continue;
    }
    if (
      result.version !== create.new_version ||
      result.byte_length !== bytes.length ||
      result.evidence_ref !== `workspace-create:${row.invocation_id}:${create.new_version}`
    )
      throw stateConflict('invalid document creation bytes or evidence');
    const read = evidence.reads.find(
      (item) =>
        item.workspace_id === grant.workspace_id &&
        item.registration_digest === grant.registration_digest &&
        isDeepStrictEqual(item.frozen_grant, grant) &&
        item.relative_path === create.relative_path &&
        item.result.version === create.new_version &&
        item.result.content === content &&
        item.result.byte_length === result.byte_length &&
        documentEvidenceLater(item.created_at, row.accepted_at) &&
        documentEvidenceLater(item.accepted_at, row.accepted_at),
    );
    effects.push({
      ...common,
      status: read ? 'verified' : 'applied',
      read_invocation_id: read?.invocation_id ?? null,
      version: result.version,
    });
  }
  for (const row of delegated.filter((item) => item.tool_id === 'workspace_replace')) {
    const grant = workspaceGrantSchema.parse(row.frozen_context.workspaceGrant);
    const edit = row.frozen_context.documentEdit;
    if (!edit) continue;
    const common = {
      workspace_id: grant.workspace_id,
      path: edit.relative_path,
      invocation_id: row.invocation_id,
      read_invocation_id: null,
      version: null,
      superseded: false,
    };
    if (row.state === 'unknown') {
      effects.push({ ...common, status: 'unknown' });
      continue;
    }
    if (row.state !== 'completed') continue;
    const accepted = parseResult(row.accepted_result);
    if (accepted.status !== 'ok') continue;
    const result = accepted.result;
    if (result.kind !== 'edit_applied' && result.kind !== 'edit_conflict') continue;
    if (
      result.invocation_id !== row.invocation_id ||
      result.args_hash !== row.args_hash ||
      result.workspace_id !== grant.workspace_id ||
      result.path !== edit.relative_path ||
      result.base_version !== edit.base_version
    )
      throw stateConflict('invalid document effect binding');
    if (result.kind === 'edit_conflict') {
      effects.push({ ...common, status: 'conflict' });
      continue;
    }
    if (
      result.version !== edit.new_version ||
      result.byte_length !== Buffer.byteLength(edit.exact_new_content ?? '', 'utf8')
    )
      throw stateConflict('invalid document edit bytes');
    const read = evidence.reads.find(
      (item) =>
        item.workspace_id === grant.workspace_id &&
        item.registration_digest === grant.registration_digest &&
        item.relative_path === edit.relative_path &&
        item.invocation_id !== edit.base_read_invocation_id &&
        item.result.version === edit.new_version &&
        item.result.content === edit.exact_new_content &&
        item.result.byte_length === result.byte_length &&
        documentEvidenceLater(item.created_at, row.accepted_at) &&
        documentEvidenceLater(item.accepted_at, row.accepted_at),
    );
    effects.push({
      ...common,
      status: read ? 'verified' : 'applied',
      read_invocation_id: read?.invocation_id ?? null,
      version: result.version,
    });
  }
  const resolvedApprovalInvocationIds: string[] = [];
  for (const approval of approvals) {
    const apply = matchingDocumentApply(approval, evidence.applies);
    if (!apply || !delegated.some((row) => row.invocation_id === apply.invocation_id)) continue;
    if (apply.state === 'unknown') {
      effects.push({
        workspace_id: approval.workspace_id,
        path: approval.relative_path,
        invocation_id: apply.invocation_id,
        read_invocation_id: null,
        version: null,
        status: 'unknown',
        superseded: false,
      });
    } else if (isDocumentConflict(approval, apply)) {
      effects.push({
        workspace_id: approval.workspace_id,
        path: approval.relative_path,
        invocation_id: apply.invocation_id,
        read_invocation_id: null,
        version: null,
        status: 'conflict',
        superseded: false,
      });
    } else if (isDocumentApplied(approval, apply)) {
      const read = verifiedDocumentRead(approval, apply, evidence.reads);
      effects.push({
        workspace_id: approval.workspace_id,
        path: approval.relative_path,
        invocation_id: apply.invocation_id,
        read_invocation_id: read?.invocation_id ?? null,
        version: apply.result.version,
        status: read ? 'verified' : 'applied',
        superseded: false,
      });
      if (read) {
        const proposal = delegated.find(
          (row) =>
            row.tool_id === 'workspace_propose_replace' &&
            row.state === 'completed' &&
            row.approval_id === approval.id,
        );
        if (proposal) resolvedApprovalInvocationIds.push(proposal.invocation_id);
      }
    }
  }
  // Only a unique chain ending in an independently verified write resolves a
  // zero-write conflict. A reserved, failed or unverified successor is not proof.
  const successorIds = (id: string): string[] => {
    const direct = delegated.filter(
      (row) => row.frozen_context.documentEdit?.replaces_invocation_id === id,
    );
    const ids = direct.map((row) => {
      if (row.tool_id !== 'workspace_propose_replace') return row.invocation_id;
      return (
        approvals.find((approval) => approval.id === row.approval_id)?.apply_invocation_id ??
        row.invocation_id
      );
    });
    const previousApproval = approvals.find((approval) => approval.apply_invocation_id === id);
    if (previousApproval) {
      for (const approval of approvals.filter(
        (item) => item.replaces_approval_id === previousApproval.id,
      ))
        ids.push(approval.apply_invocation_id ?? approval.id);
    }
    return [...new Set(ids)];
  };
  const reachesVerified = (effect: RunGoalDocumentEffect, visited: Set<string>): boolean => {
    if (effect.status === 'verified') return true;
    if (effect.status !== 'conflict' || visited.has(effect.invocation_id)) return false;
    const row = delegated.find((item) => item.invocation_id === effect.invocation_id);
    if (!row || row.state !== 'completed') return false;
    const result = hydrateWorkspaceReadResult(row.accepted_result);
    if (
      result.status !== 'ok' ||
      !(
        (result.result.kind === 'conflict' && result.result.zero_write) ||
        (result.result.kind === 'edit_conflict' &&
          result.result.zero_write &&
          result.result.reason === 'version_changed') ||
        (result.result.kind === 'create_conflict' && result.result.zero_write)
      )
    )
      return false;
    const successors = successorIds(effect.invocation_id);
    if (successors.length !== 1) return false;
    const next = effects.find((item) => item.invocation_id === successors[0]);
    if (!next || next.workspace_id !== effect.workspace_id) return false;
    // Historical create links were inferred from matching bytes, not from a
    // trusted user decision. They cannot prove that two paths are one goal.
    if (effect.operation === 'create' || next.path !== effect.path || next.operation === 'create')
      return false;
    visited.add(effect.invocation_id);
    return reachesVerified(next, visited);
  };
  for (const effect of effects) {
    if (effect.status === 'conflict') effect.superseded = reachesVerified(effect, new Set());
  }
  for (const approval of approvals) {
    const effect = effects.find((item) => item.invocation_id === approval.apply_invocation_id);
    if (!effect || !(effect.status === 'verified' || effect.superseded)) continue;
    const proposal = delegated.find(
      (row) =>
        row.tool_id === 'workspace_propose_replace' &&
        row.state === 'completed' &&
        row.approval_id === approval.id,
    );
    if (proposal && !resolvedApprovalInvocationIds.includes(proposal.invocation_id))
      resolvedApprovalInvocationIds.push(proposal.invocation_id);
  }
  return {
    effects,
    hasPendingApproval: approvals.some(
      (item) =>
        item.state === 'pending' || (item.state === 'approved' && !item.apply_invocation_id),
    ),
    resolvedApprovalInvocationIds,
  };
}

// Validate explicit model-proposed create links against immutable same-Run facts.
// Matching facts establish provenance, not the user's semantic permission.
export async function validateCreateResolutionEvidence(
  client: PoolClient,
  binding: RunBinding,
  resolution: {
    zero_write_invocation_ids: string[];
    created_invocation_id: string;
    read_invocation_id: string;
  },
  documents: RunGoalDocumentEvidence,
): Promise<void> {
  const ids = [...resolution.zero_write_invocation_ids, resolution.created_invocation_id];
  const { rows } = await client.query<{
    invocation_id: string;
    state: string;
    args_hash: string;
    frozen_context: {
      authorizationRevision?: string;
      workspaceGrant?: unknown;
      documentCreate?: NonNullable<ToolContext['documentCreate']>;
    };
    accepted_result: unknown;
    created_at: string;
    accepted_at: string;
    resolution_revision: string | null;
  }>(
    `SELECT invocation_id,state,args_hash,frozen_context,accepted_result,
      (SELECT frozen_context->>'createResolutionRevision' FROM agent_runs WHERE id=tool_invocations.run_id) AS resolution_revision,
      to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
      coalesce(to_char(accepted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'') AS accepted_at
     FROM tool_invocations WHERE owner_id=$1 AND conversation_id=$2 AND run_id=$3
       AND tool_id='workspace_create' AND invocation_id=ANY($4::uuid[])`,
    [binding.ownerId, binding.conversationId, binding.runId, ids],
  );
  const created = rows.find((row) => row.invocation_id === resolution.created_invocation_id);
  const effect = documents.effects.find(
    (item) => item.invocation_id === resolution.created_invocation_id,
  );
  if (
    !created ||
    created.state !== 'completed' ||
    !created.frozen_context.documentCreate ||
    created.frozen_context.authorizationRevision !== 'delegation/1' ||
    !effect ||
    effect.operation !== 'create' ||
    effect.status !== 'verified'
  )
    throw stateConflict('create resolution requires a verified creation');
  const target = created.frozen_context.documentCreate;
  const grant = workspaceGrantSchema.parse(created.frozen_context.workspaceGrant);
  const applied = hydrateWorkspaceReadResult(created.accepted_result);
  if (applied.status !== 'ok' || applied.result.kind !== 'create_applied')
    throw stateConflict('create resolution requires an accepted creation');
  for (const id of resolution.zero_write_invocation_ids) {
    const prior = rows.find((row) => row.invocation_id === id);
    const priorTarget = prior?.frozen_context.documentCreate;
    const priorEffect = documents.effects.find((item) => item.invocation_id === id);
    if (
      !prior ||
      prior.state !== 'completed' ||
      !priorTarget ||
      prior.frozen_context.authorizationRevision !== 'delegation/1' ||
      !priorEffect ||
      priorEffect.operation !== 'create' ||
      priorEffect.status !== 'conflict' ||
      !isDeepStrictEqual(prior.frozen_context.workspaceGrant, grant) ||
      priorTarget.output_directory !== target.output_directory ||
      priorTarget.directory_identity !== target.directory_identity ||
      priorTarget.relative_path === target.relative_path ||
      (created.resolution_revision === 'create-resolution/1' &&
        (priorTarget.new_version !== target.new_version ||
          priorTarget.content_base64 !== target.content_base64)) ||
      !documentEvidenceLater(created.created_at, prior.accepted_at)
    )
      throw stateConflict('invalid create resolution predecessor');
    const result = hydrateWorkspaceReadResult(prior.accepted_result);
    if (
      result.status !== 'ok' ||
      result.result.kind !== 'create_conflict' ||
      result.result.reason !== 'already_exists' ||
      !result.result.zero_write
    )
      throw stateConflict('create resolution predecessor is not a zero-write collision');
  }
  const evidence = await readDocumentEvidence(client, binding);
  const read = evidence.reads.find((item) => item.invocation_id === resolution.read_invocation_id);
  const { bytes, content } = decodeWorkspaceContent(target.content_base64);
  if (
    !read ||
    read.authorization_revision !== 'delegation/1' ||
    !isDeepStrictEqual(read.frozen_grant, grant) ||
    read.workspace_id !== grant.workspace_id ||
    read.relative_path !== target.relative_path ||
    read.result.version !== target.new_version ||
    read.result.content !== content ||
    read.result.byte_length !== bytes.length ||
    !documentEvidenceLater(read.created_at, created.accepted_at) ||
    !documentEvidenceLater(read.accepted_at, created.accepted_at)
  )
    throw stateConflict('create resolution requires an independent later full read');
}
