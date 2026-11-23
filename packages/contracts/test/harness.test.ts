import { describe, expect, it } from 'bun:test';
import {
  HarnessApprovalDecisionSchema,
  HarnessCancelSchema,
  HarnessReplySchema,
  HarnessModelStepSchema,
  HarnessRequestSchema,
  HarnessSnapshotSchema,
  HarnessPauseSnapshotSchema,
  HarnessR3ContextStartSchema,
  HarnessStartSchema,
  HarnessObservationSchema,
  OfficeAnalyzeTasksInputSchema,
  OfficeAnalyzeTasksResultSchema,
  OfficeCreateArtifactsInputSchema,
  OfficeCreateArtifactsResultSchema,
  OfficeReadNotesInputSchema,
  OfficeReadNotesResultSchema,
  HarnessToolPayloadSchema,
  RunViewSchema,
} from '../src/harness.js';

const approvalId = '00000000-0000-4000-8000-000000000001';
const taskId = '00000000-0000-4000-8000-000000000002';
const invocationId = '00000000-0000-4000-8000-000000000003';
const messageId = '00000000-0000-4000-8000-000000000004';
const snapshot = {
  version: 2,
  message_refs: [messageId],
  tool_refs: [invocationId],
  next_call_no: 2,
  usage: { iterations: 1, tokens: null },
  waiting: { invocation_id: invocationId, approval_id: approvalId },
};
const start = {
  protocol: 'harness/v6',
  type: 'start',
  trusted_context: null,
  routing_policy: { revision: 'r2b/1', mode: 'off' },
  eligible_phase: 'disabled',
  messages: [{ message_id: messageId, role: 'user', content: 'Read the registered workspace.' }],
  tools: [],
  budget: { max_iterations: 8, max_tokens: 8000 },
  context_policy: {
    revision: 'r2a/1',
    completion_cap: 256,
    model_window_tokens: null,
    input_meter: 'unavailable',
    meter_revision: 'unavailable/1',
    reserve_tokens: 0,
    model_binding: { model: 'fixture', adapter_revision: 'openai-chat/v1' },
  },
  snapshot: null,
  observations: [],
  approval: null,
};
const workspace = {
  workspace_id: 'documents',
  label: 'My documents',
  readable_paths: ['sources', 'brief.md'],
  writable_paths: ['brief.md'],
};

function acceptsDecision(decision: unknown) {
  expect<unknown>(HarnessApprovalDecisionSchema.parse(decision)).toEqual(decision);
  expect<unknown>(HarnessStartSchema.parse({ ...start, approval: decision }).approval).toEqual(
    decision,
  );
}

function rejectsDecision(decision: unknown) {
  expect(HarnessApprovalDecisionSchema.safeParse(decision).success).toBe(false);
  expect(HarnessStartSchema.safeParse({ ...start, approval: decision }).success).toBe(false);
}

describe('harness/v6 executable contract', () => {
  it('retains all five typed task decision states and their real references', () => {
    for (const status of ['pending', 'consumed', 'rejected', 'expired', 'superseded'] as const) {
      acceptsDecision({
        kind: 'task',
        approval_id: approvalId,
        status,
        task_id: status === 'consumed' ? taskId : null,
        successor_id: status === 'superseded' ? taskId : null,
      });
    }
  });

  it('requires a real task_id for consumed task decisions', () => {
    const consumed = {
      kind: 'task',
      approval_id: approvalId,
      status: 'consumed',
      successor_id: null,
    };
    for (const task_id of [undefined, null, '', 'not-a-uuid'])
      rejectsDecision({ ...consumed, task_id });
    acceptsDecision({ ...consumed, task_id: taskId });
  });

  it('types document authorization separately with a nullable apply invocation', () => {
    for (const status of ['pending', 'approved', 'rejected'] as const) {
      for (const apply_invocation_id of [null, invocationId]) {
        acceptsDecision({
          kind: 'document',
          approval_id: approvalId,
          status,
          apply_invocation_id,
        });
      }
    }
  });

  it('rejects fake task results and cross-kind states or fields on document decisions', () => {
    const document = {
      kind: 'document',
      approval_id: approvalId,
      status: 'approved',
      apply_invocation_id: null,
    };
    rejectsDecision({ ...document, task_id: taskId });
    rejectsDecision({ ...document, task_id: null });
    rejectsDecision({ ...document, successor_id: null });
    for (const status of ['consumed', 'expired', 'superseded'])
      rejectsDecision({ ...document, status });
    rejectsDecision({ ...document, apply_invocation_id: 'not-a-uuid' });
    rejectsDecision({ kind: 'document', approval_id: approvalId, status: 'approved' });
    rejectsDecision({
      kind: 'task',
      approval_id: approvalId,
      status: 'approved',
      task_id: taskId,
      successor_id: null,
    });
    rejectsDecision({
      approval_id: approvalId,
      status: 'consumed',
      task_id: taskId,
      successor_id: null,
    });
  });

  it('accepts omitted, null or strict safe workspace summaries without exposing a root', () => {
    expect<unknown>(HarnessStartSchema.parse(start)).toEqual(start);
    expect(HarnessStartSchema.parse({ ...start, workspace: null }).workspace).toBeNull();
    expect(HarnessStartSchema.parse({ ...start, workspace }).workspace).toEqual(workspace);
    for (const extra of [
      { root: '/private/documents' },
      { owner_id: approvalId },
      { allowlist: ['workspace_apply_replace'] },
      { unexpected: true },
    ]) {
      expect(
        HarnessStartSchema.safeParse({ ...start, workspace: { ...workspace, ...extra } }).success,
      ).toBe(false);
    }
    for (const malformed of [
      { ...workspace, workspace_id: 1 },
      { ...workspace, label: null },
      { ...workspace, readable_paths: 'sources' },
      { ...workspace, writable_paths: [1] },
      { workspace_id: workspace.workspace_id, label: workspace.label },
    ])
      expect(HarnessStartSchema.safeParse({ ...start, workspace: malformed }).success).toBe(false);
  });

  it('accepts snapshot2 references and rejects native-supplied approval kinds', () => {
    expect<unknown>(HarnessSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect<unknown>(HarnessStartSchema.parse({ ...start, snapshot }).snapshot).toEqual(snapshot);
    expect(
      HarnessRequestSchema.parse({
        protocol: 'harness/v6',
        type: 'snapshot',
        request_ref: 'snapshot-1',
        context: snapshot,
      }),
    ).toMatchObject({ context: snapshot });
    expect(
      HarnessSnapshotSchema.safeParse({
        ...snapshot,
        waiting: { ...snapshot.waiting, kind: 'document' },
      }).success,
    ).toBe(false);
    expect(
      HarnessRequestSchema.safeParse({
        protocol: 'harness/v6',
        type: 'suspend',
        request_ref: 'suspend-1',
        checkpoint_ref: messageId,
        invocation_id: invocationId,
        approval_id: approvalId,
        kind: 'document',
      }).success,
    ).toBe(false);
  });

  it('accepts correlated model pulls and bounded delta-or-complete-or-failed replies only', () => {
    expect(
      HarnessRequestSchema.parse({
        protocol: 'harness/v6',
        type: 'model_next',
        request_ref: 'next-1',
        model_ref: 'model-1',
      }),
    ).toMatchObject({ model_ref: 'model-1' });
    expect(
      HarnessRequestSchema.safeParse({
        protocol: 'harness/v6',
        type: 'model_next',
        request_ref: 'next-1',
      }).success,
    ).toBe(false);
    expect(HarnessModelStepSchema.parse({ type: 'delta', delta: '中文😀' })).toEqual({
      type: 'delta',
      delta: '中文😀',
    });
    for (const delta of ['', 'x'.repeat(4001)]) {
      expect(HarnessModelStepSchema.safeParse({ type: 'delta', delta }).success).toBe(false);
      expect(
        HarnessRequestSchema.safeParse({
          protocol: 'harness/v6',
          type: 'answer',
          request_ref: 'answer-1',
          delta,
        }).success,
      ).toBe(false);
    }
    expect(
      HarnessModelStepSchema.parse({
        type: 'complete',
        reply: { message: { content: '中文😀', tool_calls: [] }, usage: null },
      }),
    ).toMatchObject({ type: 'complete' });
    expect(
      HarnessModelStepSchema.parse({
        type: 'failed',
        error: { code: 'HARNESS_CONTEXT_LIMIT', message: 'capacity exhausted' },
        usage: null,
      }),
    ).toMatchObject({ type: 'failed', usage: null });
    expect(
      HarnessModelStepSchema.safeParse({
        message: { content: 'old complete reply', tool_calls: [] },
        usage: null,
      }).success,
    ).toBe(false);
    for (const protocol of ['harness/v2', 'harness/v3', 'harness/v4', 'harness/v5']) {
      expect(HarnessStartSchema.safeParse({ ...start, protocol }).success).toBe(false);
    }
  });

  it('rejects v1 executable frames and v1 snapshots rather than running a fallback protocol', () => {
    expect(HarnessStartSchema.safeParse({ ...start, protocol: 'harness/v1' }).success).toBe(false);
    const legacy = { ...snapshot, version: 1 };
    expect(HarnessSnapshotSchema.safeParse(legacy).success).toBe(false);
    expect(HarnessStartSchema.safeParse({ ...start, snapshot: legacy }).success).toBe(false);
    expect(
      HarnessRequestSchema.safeParse({
        protocol: 'harness/v6',
        type: 'snapshot',
        request_ref: 'snapshot-1',
        context: legacy,
      }).success,
    ).toBe(false);
    expect(
      HarnessRequestSchema.safeParse({
        protocol: 'harness/v1',
        type: 'answer',
        request_ref: 'answer-1',
        delta: 'legacy answer',
      }).success,
    ).toBe(false);
    expect(
      HarnessReplySchema.safeParse({
        protocol: 'harness/v1',
        type: 'reply',
        reply_to: 'answer-1',
        value: null,
      }).success,
    ).toBe(false);
    expect(
      HarnessCancelSchema.safeParse({
        protocol: 'harness/v1',
        type: 'cancel',
        reason: 'legacy cancel',
      }).success,
    ).toBe(false);
  });
});

describe('harness/v7 user pause contract', () => {
  const pauseSnapshot = {
    ...snapshot,
    version: 3,
    waiting: null,
    native_state: {
      protected_messages: [{ role: 'user', content: 'Continue this task.' }],
      units: [],
      hard_denied: '',
      closing_goal: false,
      pending_model: null,
    },
  };
  const frame = { protocol: 'harness/v7', request_ref: 'pause-1' };

  it('accepts pause frames and version 3 restores only on v7', () => {
    expect(HarnessPauseSnapshotSchema.safeParse(pauseSnapshot).success).toBe(true);
    expect(HarnessRequestSchema.safeParse({ ...frame, type: 'pause_probe' }).success).toBe(true);
    expect(
      HarnessRequestSchema.safeParse({ ...frame, type: 'pause_point', context: pauseSnapshot })
        .success,
    ).toBe(true);
    for (const type of ['pause_probe', 'pause_point']) {
      expect(
        HarnessRequestSchema.safeParse({
          ...frame,
          protocol: 'harness/v6',
          type,
          ...(type === 'pause_point' ? { context: pauseSnapshot } : {}),
        }).success,
      ).toBe(false);
    }
    expect(HarnessStartSchema.safeParse({ ...start, snapshot: pauseSnapshot }).success).toBe(false);
    expect(
      HarnessStartSchema.safeParse({ ...start, protocol: 'harness/v7', snapshot: pauseSnapshot })
        .success,
    ).toBe(true);
    for (const protocol of ['harness/v6', 'harness/v7']) {
      expect(HarnessStartSchema.safeParse({ ...start, protocol, snapshot }).success).toBe(true);
    }
  });

  it('requires a strict safe-point snapshot without approval waiting or v8 fields', () => {
    expect(
      HarnessPauseSnapshotSchema.safeParse({ ...pauseSnapshot, waiting: snapshot.waiting }).success,
    ).toBe(false);
    expect(
      HarnessPauseSnapshotSchema.safeParse({
        ...pauseSnapshot,
        native_state: { ...pauseSnapshot.native_state, history_index: 0 },
      }).success,
    ).toBe(false);
    expect(
      HarnessRequestSchema.safeParse({ ...frame, type: 'pause_point', context: snapshot }).success,
    ).toBe(false);
    expect(
      HarnessRequestSchema.safeParse({ ...frame, type: 'pause_probe', after_measurement: true })
        .success,
    ).toBe(false);
    expect(HarnessStartSchema.safeParse({ ...start, protocol: 'harness/v8' }).success).toBe(false);
  });

  it('supports v7 replies and cancellation without breaking v6', () => {
    for (const protocol of ['harness/v6', 'harness/v7']) {
      expect(
        HarnessReplySchema.safeParse({ protocol, type: 'reply', reply_to: 'pause-1', value: null })
          .success,
      ).toBe(true);
      expect(
        HarnessCancelSchema.safeParse({ protocol, type: 'cancel', reason: 'stop' }).success,
      ).toBe(true);
    }
  });

  it('exposes only user pause state while retaining old run views', () => {
    const view = {
      run_id: messageId,
      conversation_id: messageId,
      execution: 'harness',
      model_selection: { state: 'legacy_unavailable' },
      status: 'paused',
      attempt_id: invocationId,
      attempt_no: 1,
      waiting: null,
      can_resume: false,
    };
    const pause = {
      pause_id: approvalId,
      reason: 'user',
      purpose: 'none',
      status: 'paused',
    } as const;
    expect(RunViewSchema.safeParse(view).success).toBe(true);
    expect(RunViewSchema.parse({ ...view, pause, can_pause: false }).pause).toEqual(pause);
    expect(RunViewSchema.safeParse({ ...view, pause: null }).success).toBe(true);
    expect(
      RunViewSchema.safeParse({ ...view, pause: { ...pause, reason: 'runtime' } }).success,
    ).toBe(true);
    expect(
      RunViewSchema.safeParse({ ...view, pause: { ...pause, unexpected: true } }).success,
    ).toBe(false);
  });
});

describe('literal memory harness contract', () => {
  const item = {
    memory_id: taskId,
    content: 'historical fact',
    conversation_id: approvalId,
    message_ids: [messageId],
    created_at: '2026-11-01T00:00:00Z',
    updated_at: '2026-11-01T00:00:00Z',
  };
  const payload = { kind: 'memory_recall', items: [item], completeness: 'degraded' };
  const observation = {
    view: 'full',
    invocation_id: invocationId,
    tool_id: 'recall_memories',
    result: { status: 'ok', result: payload },
  };
  const tool = { name: 'recall_memories', description: 'recall', parameters: {}, risk: 'low' };

  it('accepts v7 memory results and rejects them on v6', () => {
    expect(HarnessToolPayloadSchema.safeParse(payload).success).toBe(true);
    expect(
      HarnessToolPayloadSchema.safeParse({
        kind: 'memory_saved',
        memory_id: taskId,
        content: 'fact',
      }).success,
    ).toBe(true);
    expect(
      HarnessStartSchema.safeParse({
        ...start,
        protocol: 'harness/v7',
        tools: [tool],
        observations: [observation],
      }).success,
    ).toBe(true);
    expect(HarnessStartSchema.safeParse({ ...start, tools: [tool] }).success).toBe(false);
    expect(HarnessStartSchema.safeParse({ ...start, observations: [observation] }).success).toBe(
      false,
    );
    expect(
      HarnessStartSchema.safeParse({
        ...start,
        protocol: 'harness/v7',
        tools: [{ ...tool, name: 'read_memory_source' }],
      }).success,
    ).toBe(false);
  });

  it('bounds and validates memory sources and match kinds', () => {
    for (const message_ids of [
      [],
      [messageId, messageId],
      ['invalid'],
      Array(129).fill(messageId),
    ]) {
      expect(
        HarnessToolPayloadSchema.safeParse({ ...payload, items: [{ ...item, message_ids }] })
          .success,
      ).toBe(false);
    }
    expect(
      HarnessToolPayloadSchema.safeParse({ ...payload, items: [{ ...item, match: 'semantic' }] })
        .success,
    ).toBe(true);
    expect(
      HarnessToolPayloadSchema.safeParse({ ...payload, items: [{ ...item, match: 'invalid' }] })
        .success,
    ).toBe(false);
    expect(
      HarnessToolPayloadSchema.safeParse({ ...payload, items: [{ ...item, extra: true }] }).success,
    ).toBe(false);
    expect(HarnessToolPayloadSchema.safeParse({ kind: 'memory_source' }).success).toBe(false);
  });
});

describe('v8 memory source compatibility', () => {
  const source = {
    kind: 'memory_source',
    recall_invocation_id: invocationId,
    memory_id: taskId,
    conversation_id: approvalId,
    message_id: messageId,
    role: 'user',
    content: 'fact',
    offset: 0,
    end: 4,
    total: 4,
    has_more: false,
  };
  const observation = {
    view: 'full',
    invocation_id: invocationId,
    tool_id: 'read_memory_source',
    result: { status: 'ok', result: source },
  };
  const tool = { name: 'read_memory_source', description: 'read', parameters: {}, risk: 'low' };

  it('permits source tools and observations only on the v8 start shape', () => {
    const { messages, ...common } = start;
    const v8 = {
      ...common,
      protocol: 'harness/v8',
      r3_context: {
        manifest: { message_ids: [] },
        summary: null,
        messages: [],
        input: { type: 'user', message_id: messageId, content: messages[0].content },
      },
      tools: [tool],
      observations: [observation],
    };
    expect(HarnessR3ContextStartSchema.safeParse(v8).success).toBe(true);
    for (const protocol of ['harness/v6', 'harness/v7']) {
      expect(HarnessStartSchema.safeParse({ ...start, protocol, tools: [tool] }).success).toBe(
        false,
      );
      expect(
        HarnessStartSchema.safeParse({ ...start, protocol, observations: [observation] }).success,
      ).toBe(false);
    }
  });
});

describe('native office tool wire', () => {
  const source = { display_name: '纪要.txt', version: 'a'.repeat(64) };
  const notes = {
    kind: 'office_read_notes',
    source,
    offset: 0,
    start_line: 1,
    end_line: 1,
    total_lines: 2,
    content: '甲',
    next_offset: 3,
  };
  const notesArgs = { offset: 3 };
  const artifact = {
    artifact_id: approvalId,
    format: 'markdown',
    filename: 'report.md',
    size_bytes: 42,
  };
  const result = { kind: 'office_create_artifacts', artifacts: [artifact] };
  const totals = {
    total: 1,
    todo: 1,
    in_progress: 0,
    done: 0,
    canceled: 0,
    overdue: 1,
    anomaly_rows: 0,
    missing_owner: 0,
    missing_due_date: 0,
    invalid_due_date: 0,
    invalid_status: 0,
  };
  const analysis = {
    kind: 'office_analyze_tasks',
    action: 'analyze',
    source,
    as_of: '2028-02-29',
    after_record: 0,
    total_records: 1,
    total_groups: 1,
    totals,
    groups: [{ owner: '甲', owner_truncated: false, totals }],
    records: [
      {
        record_number: 1,
        task_id: '001',
        title: 'review',
        owner: '甲',
        due_date: '2028-02-28',
        status: 'todo',
        overdue: true,
        anomalies: [],
        truncated_fields: [],
      },
    ],
    next_after_record: null,
  };

  it('admits only bounded inputs for the selected action and source roles', () => {
    expect(OfficeReadNotesInputSchema.safeParse({}).success).toBe(true);
    expect(OfficeReadNotesInputSchema.safeParse(notesArgs).success).toBe(true);
    for (const args of [
      { ...notesArgs, attachment_id: taskId },
      { offset: -1 },
      { offset: 1_048_577 },
    ]) {
      expect(OfficeReadNotesInputSchema.safeParse(args).success).toBe(false);
    }
    const page = { action: 'page', analysis_invocation_id: invocationId, after_record: 1 };
    expect(OfficeAnalyzeTasksInputSchema.safeParse(page).success).toBe(true);
    for (const args of [
      { ...page, as_of: '2028-02-29' },
      { ...page, after_record: 0 },
      { action: 'page' },
    ]) {
      expect(OfficeAnalyzeTasksInputSchema.safeParse(args).success).toBe(false);
    }
    const delivery = {
      formats: ['markdown', 'csv'],
      notes_invocation_ids: [approvalId],
      analysis_invocation_id: invocationId,
    };
    expect(
      OfficeCreateArtifactsInputSchema.safeParse({ ...delivery, interpretation: '观察' }).success,
    ).toBe(true);
    for (const args of [
      { formats: ['csv'], notes_invocation_ids: [taskId] },
      { ...delivery, formats: ['markdown', 'markdown'] },
      { ...delivery, notes_invocation_ids: [taskId, taskId] },
      { ...delivery, notes_invocation_ids: [], interpretation: 'text' },
      { ...delivery, interpretation: '甲'.repeat(3000) },
      { ...delivery, content: 'raw artifact' },
    ]) {
      expect(OfficeCreateArtifactsInputSchema.safeParse(args).success).toBe(false);
    }
  });

  it('validates byte bounds, coverage, sources and artifact metadata without accepting raw bytes', () => {
    for (const payload of [notes, result, analysis]) {
      expect(HarnessToolPayloadSchema.safeParse(payload).success).toBe(true);
    }
    for (const payload of [
      { ...notes, next_offset: 1 },
      { ...notes, next_offset: null },
      { ...notes, source: { ...source, path: '/host/secret.txt' } },
      { ...notes, content: '甲'.repeat(1500), next_offset: 4500 },
      { ...notes, content: '\ud800', next_offset: 3 },
    ]) {
      expect(OfficeReadNotesResultSchema.safeParse(payload).success).toBe(false);
    }
    const preview = {
      kind: 'office_analyze_tasks',
      action: 'preview',
      source,
      result: {
        valid: false,
        issue: { code: 'missing_columns', record_number: 0, missing_columns: ['due_date'] },
        template: 'task_id,title,owner,due_date,status\r\n',
      },
    };
    expect(OfficeAnalyzeTasksResultSchema.safeParse(preview).success).toBe(true);
    const page = {
      ...analysis,
      action: 'page',
      after_record: 1,
      total_records: 2,
      totals: { ...totals, total: 2, todo: 2 },
      groups: [],
      records: [{ ...analysis.records[0], record_number: 2 }],
    };
    expect(OfficeAnalyzeTasksResultSchema.safeParse(page).success).toBe(true);
    for (const payload of [
      { ...analysis, as_of: '2026-02-29' },
      { ...analysis, total_records: 2 },
      { ...analysis, totals: { ...totals, invalid_status: 1 } },
      { ...analysis, records: [{ ...analysis.records[0], record_number: 2 }] },
      { ...analysis, records: [{ ...analysis.records[0], status: '甲'.repeat(65) }] },
      { ...analysis, next_after_record: 1 },
      { ...preview, result: { ...preview.result, raw: 'source bytes' } },
    ]) {
      expect(OfficeAnalyzeTasksResultSchema.safeParse(payload).success).toBe(false);
    }
    for (const artifacts of [
      [{ ...artifact, bytes: 'YWJj' }],
      [{ ...artifact, url: 'https://invalid.example/report' }],
      [artifact, { ...artifact, format: 'csv' }],
      [artifact, { ...artifact, artifact_id: taskId }],
    ]) {
      expect(OfficeCreateArtifactsResultSchema.safeParse({ ...result, artifacts }).success).toBe(
        false,
      );
    }
    expect(
      HarnessObservationSchema.safeParse({
        view: 'full',
        invocation_id: invocationId,
        tool_id: 'get_user_prefs',
        result: { status: 'ok', result: notes },
      }).success,
    ).toBe(false);
  });

  it('does not add office authority to old wire versions or arbitrary reserve frames', () => {
    const tool_id = 'office_read_notes';
    const tools = [{ name: tool_id, description: 'read', parameters: {}, risk: 'low' }];
    for (const protocol of ['harness/v6', 'harness/v7']) {
      expect(HarnessStartSchema.safeParse({ ...start, protocol, tools }).success).toBe(false);
    }
    const request = {
      protocol: 'harness/v8',
      type: 'reserve',
      request_ref: 'r1',
      call_key: 'harness/1',
      tool_id,
      args: notesArgs,
    };
    expect(HarnessRequestSchema.safeParse(request).success).toBe(true);
    expect(HarnessRequestSchema.safeParse({ ...request, protocol: 'harness/v7' }).success).toBe(
      false,
    );
    expect(
      HarnessRequestSchema.safeParse({ ...request, args: { url: 'file:///tmp/private' } }).success,
    ).toBe(false);
  });
});
