import { afterAll, describe, expect, it } from 'bun:test';
import { rmSync } from 'node:fs';
import { bundlePolicy } from '../src/agent/routing/bundle.js';
import { calibrateThresholds, nextNumber } from '../../../scripts/routing/calibration.js';
import {
  candidateCorrect,
  recordInput,
  evaluationReport,
} from '../../../scripts/routing/evaluation.js';
import type { DatasetInput, ScoredRecord } from '../../../scripts/routing/evaluation.js';
import { createRoutingFixture } from './routing-fixtures.js';

const fixture = createRoutingFixture();
afterAll(() => rmSync(fixture.directory, { recursive: true, force: true }));
const policy = bundlePolicy(fixture.bundle, 'shadow', []);
function row(id: string, score: number, runnerUp: number, gold: boolean): ScoredRecord {
  return {
    id,
    text: '列出提醒',
    expected_intent: gold ? 'task_list_bounded' : 'task_query_other',
    expected_takeover: gold,
    expected_args: gold ? { limit: 20, state: null } : null,
    expected_sources: gold
      ? [
          { field: 'limit', source: 'contract_default' },
          { field: 'state', source: 'contract_default' },
        ]
      : [],
    split: 'calibration',
    family_id: id,
    leakage_group_id: id,
    risk_group: 'test',
    context_kind: 'independent',
    eligible: true,
    reason: null,
    rule_intent: null,
    candidates: [
      {
        intent: 'task_list_bounded',
        tool_id: 'list_tasks',
        args: { limit: 20, state: null },
        sources: [
          { field: 'limit', source: 'contract_default', parser_revision: policy.parser_revision },
          { field: 'state', source: 'contract_default', parser_revision: policy.parser_revision },
        ],
      },
    ],
    scores: policy.competition.map((intent) => ({
      intent,
      score: intent === 'task_list_bounded' ? score : intent === 'ordinary_chat' ? runnerUp : 0,
      exclusion_score: intent === 'task_list_bounded' ? -1 : null,
    })),
    encoding_reason: null,
    encoded: true,
    encoding_succeeded: true,
    token_count: 5,
    elapsed_ms: 1,
    encoding_elapsed_ms: 1,
    input_sha256: '0'.repeat(64),
  };
}

describe('same Number scorer calibration and complete candidate retention', () => {
  it('selects per-intent data-derived cuts with zero false accepts and retains every candidate', () => {
    const rows = [row('good', 0.7, 0.4, true), row('bad', 0.8, 0.7, false)];
    const result = calibrateThresholds(rows, policy);
    expect(result.intents.task_list_bounded.selected.correct_accept).toBe(1);
    expect(result.intents.task_list_bounded.selected.false_accept).toBe(0);
    expect(result.thresholds.task_list_bounded).toEqual({ tau_intent: 0.7, tau_gap: 0.7 - 0.4 });
    expect(
      result.intents.task_list_bounded.candidates.some((candidate) =>
        candidate.false_accept_ids.includes('bad'),
      ),
    ).toBe(true);
    expect(
      result.intents.task_list_bounded.candidates.some((candidate) => candidate.all_reject),
    ).toBe(true);
    expect(
      result.intents.task_list_bounded.candidates.some(
        (candidate) => candidate.tau_intent === nextNumber(0.7),
      ),
    ).toBe(true);
    const report = evaluationReport(rows, {
      ...policy,
      thresholds: result.thresholds,
      candidate_intents: result.candidate_intents,
    });
    expect(report.summary.correct_accept).toBe(1);
    expect(report.summary.false_accept).toBe(0);
  });
  it('chooses explicit disabled intent when positives and unsafe goals are inseparable', () => {
    const result = calibrateThresholds(
      [row('positive', 0.9, 0.2, true), row('unsafe', 0.9, 0.2, false)],
      policy,
    );
    expect(result.intents.task_list_bounded.selected.all_reject).toBe(true);
    expect(result.candidate_intents).not.toContain('task_list_bounded');
  });
  it('counts wrong args or provenance as false accepts even with the right top class', () => {
    const sample = row('wrong-argument', 0.9, 0.1, true);
    sample.expected_args = { limit: 5, state: null };
    expect(candidateCorrect(sample, sample.candidates[0]!)).toBe(false);
    sample.expected_args = { limit: 20, state: null };
    sample.expected_sources = [{ field: 'limit', source: 'message', raw: '20', start: 0, end: 2 }];
    expect(candidateCorrect(sample, sample.candidates[0]!)).toBe(false);
  });
  it('preserves context originals without inventing pending approval from a done Run', () => {
    const sample: DatasetInput = {
      text: '我的时区是什么',
      messages: [{ role: 'assistant', content: '旧回复' }],
      context: {
        prior_messages: [{ role: 'assistant', text: '原context保真' }],
        system_state: { run_status: 'done' },
      },
    };
    expect(recordInput(sample)).toMatchObject({
      hasPendingApproval: false,
      messages: [{ role: 'assistant', content: '旧回复' }],
    });
    sample.context!.system_state = { approval: { status: 'pending' } };
    expect(recordInput(sample).hasPendingApproval).toBe(true);
  });
});
