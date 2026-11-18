import type { RoutingEmbedding, RoutingIntent, RoutingPolicy } from '@along/contracts';
import { ROUTING_INTENTS } from './types.js';

export interface ScoringMatrix {
  competition: readonly string[];
  familyVectors: Float32Array;
  exclusionVectors: Float32Array;
  exclusionClasses: readonly string[];
}
export type RoutingScores = RoutingEmbedding['scores'];

export function scoreVector(query: Float64Array, matrix: ScoringMatrix): RoutingScores {
  if (
    query.length !== 512 ||
    matrix.familyVectors.length !== matrix.competition.length * 4 * 512 ||
    matrix.exclusionVectors.length !== matrix.exclusionClasses.length * 512
  )
    throw new Error('SCORING_MATRIX_SHAPE');
  const scores: RoutingScores = [];
  for (let classIndex = 0; classIndex < matrix.competition.length; classIndex++) {
    let first = -Infinity;
    let second = -Infinity;
    for (let family = 0; family < 4; family++) {
      let score = 0;
      const offset = (classIndex * 4 + family) * 512;
      for (let dimension = 0; dimension < 512; dimension++)
        score += query[dimension]! * matrix.familyVectors[offset + dimension]!;
      if (score > first) {
        second = first;
        first = score;
      } else if (score > second) second = score;
    }
    const intent = matrix.competition[classIndex]!;
    let exclusion: number | null = null;
    for (let index = 0; index < matrix.exclusionClasses.length; index++) {
      if (matrix.exclusionClasses[index] !== intent) continue;
      let score = 0;
      for (let dimension = 0; dimension < 512; dimension++)
        score += query[dimension]! * matrix.exclusionVectors[index * 512 + dimension]!;
      if (exclusion === null || score > exclusion) exclusion = score;
    }
    // f32 unit storage may exceed mathematical cosine bounds by a few ulps.
    // The versioned clamp is shared, never applied only in calibration.
    scores.push({
      intent,
      score: Math.max(-1, Math.min(1, (first + second) / 2)),
      exclusion_score: exclusion === null ? null : Math.max(-1, Math.min(1, exclusion)),
    });
  }
  return scores;
}

export function selectIntent(scores: RoutingScores, policy: RoutingPolicy): RoutingIntent | null {
  if (policy.mode === 'off' || scores.length !== policy.competition.length) return null;
  const seen = new Set<string>();
  let winner: RoutingScores[number] | null = null;
  let runnerUp = -Infinity;
  for (const entry of scores) {
    if (
      seen.has(entry.intent) ||
      !policy.competition.includes(entry.intent) ||
      !Number.isFinite(entry.score) ||
      entry.score < -1 ||
      entry.score > 1 ||
      (entry.exclusion_score !== null &&
        (!Number.isFinite(entry.exclusion_score) ||
          entry.exclusion_score < -1 ||
          entry.exclusion_score > 1))
    )
      return null;
    seen.add(entry.intent);
    if (winner === null || entry.score > winner.score) {
      if (winner !== null) runnerUp = winner.score;
      winner = entry;
    } else if (entry.score > runnerUp) runnerUp = entry.score;
  }
  if (
    !winner ||
    winner.score === runnerUp ||
    !ROUTING_INTENTS.includes(winner.intent as RoutingIntent)
  )
    return null;
  const intent = winner.intent as RoutingIntent;
  const threshold = policy.thresholds[intent];
  if (
    !policy.candidate_intents.includes(intent) ||
    winner.exclusion_score === null ||
    winner.exclusion_score >= winner.score ||
    winner.score < threshold.tau_intent ||
    winner.score - runnerUp < threshold.tau_gap
  )
    return null;
  return intent;
}
