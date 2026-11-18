import { describe, expect, it, spyOn } from 'bun:test';
import type { PoolClient } from 'pg';
import type { LockedRun } from '../src/features/conversations/run/repository.js';
import { viewOf } from '../src/agent/operations/run-view.js';
import * as query from '../src/agent/tools/query.js';

const client = { query: async () => ({ rows: [] }) } as unknown as PoolClient;
const run = {
  id: 'run',
  owner_id: 'owner',
  conversation_id: 'conversation',
  execution: 'harness',
  status: 'done',
  tools_allowlist: ['workspace_read'],
  frozen_context: {
    authorization_revision: 'delegation/1',
    execution_lifecycle: 'request-bound',
    workspaceGrants: [
      {
        workspace_id: 'workspace',
        owner_id: 'owner',
        registration_digest: 'secret',
        root_identity: 'private',
      },
    ],
    trustedExecutionContext: {
      workspaces: [
        {
          workspace_id: 'workspace',
          label: 'Documents',
          readable_paths: ['.'],
          writable_paths: ['.'],
        },
      ],
    },
  },
  goal_result: null,
  waiting_checkpoint_id: null,
  waiting_invocation_id: null,
  waiting_approval_id: null,
} as unknown as LockedRun['run'];
const locked = { run, attempt: { id: 'attempt', attempt_no: 1, status: 'done' } };

describe('document RunView projection', () => {
  it('projects only safe document facts and reads by the same owner and Run', async () => {
    const projection = spyOn(query, 'readRunGoalDocumentEvidence').mockResolvedValue({
      effects: [
        {
          status: 'verified',
          workspace_id: 'workspace',
          path: 'a.md',
          invocation_id: 'write',
          read_invocation_id: 'read',
          version: 'version',
          superseded: true,
        },
      ],
      hasPendingApproval: false,
      resolvedApprovalInvocationIds: [],
    });
    const reminders = spyOn(query, 'readRunCreatedReminders').mockResolvedValue([]);
    const timeErrors = spyOn(query, 'readRunReminderTimeErrors').mockResolvedValue([]);
    try {
      const view = await viewOf(client, locked, false);
      expect(view.document_effects).toEqual([
        {
          status: 'verified',
          workspace_id: 'workspace',
          path: 'a.md',
          invocation_id: 'write',
          read_invocation_id: 'read',
          version: 'version',
        },
      ]);
      expect(view.workspaces).toEqual([
        {
          workspace_id: 'workspace',
          label: 'Documents',
          readable_paths: ['.'],
          writable_paths: ['.'],
        },
      ]);
      expect(projection).toHaveBeenCalledWith(client, {
        ownerId: 'owner',
        conversationId: 'conversation',
        runId: 'run',
      });
      expect(JSON.stringify(view)).not.toContain('secret');
      expect(JSON.stringify(view)).not.toContain('private');
      expect(JSON.stringify(view)).not.toContain('superseded');
    } finally {
      projection.mockRestore();
      reminders.mockRestore();
      timeErrors.mockRestore();
    }
  });

  it('exposes creation and zero-write failure without private projection data', async () => {
    const projection = spyOn(query, 'readRunGoalDocumentEvidence').mockResolvedValue({
      effects: [
        {
          status: 'failed',
          operation: 'create',
          workspace_id: 'workspace',
          path: 'output/a.md',
          invocation_id: 'write',
          read_invocation_id: null,
          version: null,
          superseded: false,
        },
      ],
      hasPendingApproval: false,
      resolvedApprovalInvocationIds: [],
    });
    const reminders = spyOn(query, 'readRunCreatedReminders').mockResolvedValue([]);
    const timeErrors = spyOn(query, 'readRunReminderTimeErrors').mockResolvedValue([]);
    try {
      expect((await viewOf(client, locked, false)).document_effects).toEqual([
        {
          status: 'failed',
          operation: 'create',
          workspace_id: 'workspace',
          path: 'output/a.md',
          invocation_id: 'write',
          read_invocation_id: null,
          version: null,
        },
      ]);
    } finally {
      projection.mockRestore();
      reminders.mockRestore();
      timeErrors.mockRestore();
    }
  });

  it('does not add document effects or query document facts for old Runs', async () => {
    const projection = spyOn(query, 'readRunGoalDocumentEvidence');
    try {
      const view = await viewOf(
        client,
        { ...locked, run: { ...run, frozen_context: null } },
        false,
      );
      expect(view.document_effects).toBeUndefined();
      expect(projection).not.toHaveBeenCalled();
    } finally {
      projection.mockRestore();
    }
  });

  it('does not grant historical delegation Runs a document projection', async () => {
    const projection = spyOn(query, 'readRunGoalDocumentEvidence');
    const reminders = spyOn(query, 'readRunCreatedReminders').mockResolvedValue([]);
    const timeErrors = spyOn(query, 'readRunReminderTimeErrors').mockResolvedValue([]);
    try {
      const frozen = { ...run.frozen_context! };
      delete frozen.workspaceGrants;
      const view = await viewOf(
        client,
        { ...locked, run: { ...run, frozen_context: frozen } },
        false,
      );
      expect(view.document_effects).toBeUndefined();
      expect(view.workspaces).toBeUndefined();
      expect(projection).not.toHaveBeenCalled();
    } finally {
      projection.mockRestore();
      reminders.mockRestore();
      timeErrors.mockRestore();
    }
  });
});
