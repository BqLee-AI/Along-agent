import type { RoutingIntent } from '@along/contracts';
import { ROUTING_INTENTS } from '../../apps/api/src/agent/routing/types.js';
import type { EnabledRoutingPolicy } from '../../apps/api/src/agent/routing/types.js';
import { candidateCorrect, rowDecision } from './evaluation.js';
import type { ScoredRecord } from './evaluation.js';

export interface ThresholdCandidate {
  tau_intent: number;
  tau_gap: number;
  all_reject: boolean;
  correct_accept: number;
  false_accept: number;
  false_reject: number;
  accepted_ids: string[];
  false_accept_ids: string[];
}
export interface CalibrationResult {
  thresholds: EnabledRoutingPolicy['thresholds'];
  candidate_intents: RoutingIntent[];
  intents: Record<
    RoutingIntent,
    { supported: number; selected: ThresholdCandidate; candidates: ThresholdCandidate[] }
  >;
  method: 'zero_false_accept_max_correct_high_tau_intent_high_tau_gap/1';
}

// Smallest representable larger Number: candidate boundaries cannot be rounded
// to decimal grids without silently changing which exact JS scores are accepted.
export function nextNumber(value: number): number {
  if (!Number.isFinite(value) || value === Infinity) return value;
  if (value === 0) return Number.MIN_VALUE;
  const bytes = new DataView(new ArrayBuffer(8));
  bytes.setFloat64(0, value, false);
  let bits = bytes.getBigUint64(0, false);
  bits += value > 0 ? 1n : -1n;
  bytes.setBigUint64(0, bits, false);
  return bytes.getFloat64(0, false);
}
export function calibrateThresholds(
  rows: ScoredRecord[],
  base: EnabledRoutingPolicy,
): CalibrationResult {
  const thresholds = { ...base.thresholds };
  const candidateIntents: RoutingIntent[] = [];
  const results = {} as CalibrationResult['intents'];
  for (const intent of ROUTING_INTENTS) {
    const absoluteCuts = new Set([-1, 1]);
    const gapCuts = new Set([0, 2]);
    for (const row of rows) {
      if (!row.eligible || row.rule_intent || row.encoding_reason) continue;
      const sorted = [...row.scores].sort((a, b) => b.score - a.score);
      if (sorted[0]?.intent !== intent || !sorted[1]) continue;
      const absolute = sorted[0].score;
      const gap = absolute - sorted[1].score;
      absoluteCuts.add(absolute);
      if (nextNumber(absolute) <= 1) absoluteCuts.add(nextNumber(absolute));
      gapCuts.add(gap);
      if (nextNumber(gap) <= 2) gapCuts.add(nextNumber(gap));
    }
    const supported = rows.filter(
      (row) => row.expected_takeover && row.expected_intent === intent,
    ).length;
    const candidates: ThresholdCandidate[] = [];
    for (const tauIntent of [...absoluteCuts].sort((a, b) => a - b))
      for (const tauGap of [...gapCuts].sort((a, b) => a - b)) {
        const policy: EnabledRoutingPolicy = {
          ...base,
          thresholds: { ...thresholds, [intent]: { tau_intent: tauIntent, tau_gap: tauGap } },
        };
        const accepted = rows.flatMap((row) => {
          const candidate = rowDecision(row, policy);
          return candidate?.intent === intent ? [{ row, candidate }] : [];
        });
        const correct = accepted.filter(({ row, candidate }) => candidateCorrect(row, candidate));
        const falseAccepts = accepted.filter(
          ({ row, candidate }) => !candidateCorrect(row, candidate),
        );
        candidates.push({
          tau_intent: tauIntent,
          tau_gap: tauGap,
          all_reject: false,
          correct_accept: correct.length,
          false_accept: falseAccepts.length,
          false_reject: supported - correct.length,
          accepted_ids: accepted.map(({ row }) => row.id),
          false_accept_ids: falseAccepts.map(({ row }) => row.id),
        });
      }
    // Explicit disabled intent is the only unconditional all-reject policy;
    // (1,2) thresholds alone do not mathematically guarantee rejection.
    candidates.push({
      tau_intent: 1,
      tau_gap: 2,
      all_reject: true,
      correct_accept: 0,
      false_accept: 0,
      false_reject: supported,
      accepted_ids: [],
      false_accept_ids: [],
    });
    const valid = candidates.filter((candidate) => candidate.false_accept === 0);
    valid.sort(
      (a, b) =>
        b.correct_accept - a.correct_accept ||
        b.tau_intent - a.tau_intent ||
        b.tau_gap - a.tau_gap ||
        Number(b.all_reject) - Number(a.all_reject),
    );
    const selected = valid[0]!;
    thresholds[intent] = { tau_intent: selected.tau_intent, tau_gap: selected.tau_gap };
    if (!selected.all_reject) candidateIntents.push(intent);
    results[intent] = { supported, selected, candidates };
  }
  return {
    thresholds,
    candidate_intents: candidateIntents,
    intents: results,
    method: 'zero_false_accept_max_correct_high_tau_intent_high_tau_gap/1',
  };
}
