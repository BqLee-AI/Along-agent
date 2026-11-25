import { z } from 'zod';
import {
  ContextPolicySchema,
  HARNESS_MAX_FRAME_BYTES,
  HARNESS_PROTOCOL_VERSION,
  HarnessContextMeasurementSchema,
  type ContextPolicy,
  type HarnessRequest,
} from '@along/contracts';
import type {
  ModelStepTransport,
  ModelContextMeasurement,
} from '../../features/model-providers/public.js';
import { ApplicationError } from '../../platform/errors.js';
import { callNativeCompact, type HarnessProcessServices } from '../harness/harness-process.js';

const ref = z.string().min(1).max(128);
const item = z.object({ sequence: z.number().int().nonnegative().safe(), id: ref }).strict();
const source = item
  .extend({ role: z.enum(['user', 'assistant']), text: z.string().max(HARNESS_MAX_FRAME_BYTES) })
  .strict();
const coverage = z.array(item).min(1).max(4096);
const inputSchema = z
  .object({
    messages: z.array(source).min(1).max(4096),
    previous: z
      .object({ text: z.string().min(1).max(HARNESS_MAX_FRAME_BYTES), coverage })
      .strict()
      .nullable(),
    policy: ContextPolicySchema,
    selectedModelId: z.string().min(1),
    budget: z
      .object({
        iterationsRemaining: z.number().int().nonnegative().safe(),
        continuationIterations: z.number().int().nonnegative().safe(),
        tokensRemaining: z.number().int().nonnegative().safe().nullable(),
        continuationTokens: z.number().int().nonnegative().safe(),
        maxOutputTokens: z.number().int().positive().safe(),
      })
      .strict(),
  })
  .strict();
const nativeRequest = z.discriminatedUnion('status', [
  z.object({ status: z.literal('context_limit') }).strict(),
  z.object({ status: z.literal('invalid_coverage') }).strict(),
  z.object({ status: z.literal('budget') }).strict(),
  z
    .object({
      status: z.literal('assembled'),
      coverage,
      request: z
        .object({
          protocol: z.literal(HARNESS_PROTOCOL_VERSION),
          type: z.literal('model'),
          request_ref: z.literal('compact-model'),
          messages: z.tuple([
            z.object({ role: z.literal('system'), content: z.string() }).strict(),
            z.object({ role: z.literal('user'), content: z.string() }).strict(),
          ]),
          remaining_tokens: z.number().int().nonnegative().safe().nullable(),
          max_output_tokens: z.number().int().positive().safe(),
        })
        .strict(),
    })
    .strict(),
]);
const nativeCandidates = z.discriminatedUnion('ok', [
  z
    .object({
      ok: z.literal(true),
      items: z.array(z.object({ content: z.string(), messageIds: z.array(ref) }).strict()),
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      code: z.enum(['COMPACT_INVALID_CANDIDATES', 'COMPACT_CANDIDATES_TOO_LARGE']),
    })
    .strict(),
]);
const nativeResponse = z.discriminatedUnion('status', [
  z.object({ status: z.literal('invalid_summary') }).strict(),
  z
    .object({
      status: z.literal('interpreted'),
      text: z.string(),
      candidates: nativeCandidates,
    })
    .strict(),
]);

function nativeProtocolError(): ApplicationError {
  return new ApplicationError(502, 'HARNESS_PROTOCOL_ERROR', 'invalid compact harness reply');
}

export type CompactModelInput = z.input<typeof inputSchema>;
export type CompactCoverage = z.output<typeof coverage>;
export type CompactCandidates = z.output<typeof nativeCandidates>;
export interface CompactModelTransport {
  model: ModelStepTransport;
  measure: ModelContextMeasurement;
}
export type CompactModelResult =
  | {
      ok: true;
      text: string;
      coverage: CompactCoverage;
      candidates: CompactCandidates;
      usage: { total_tokens: number } | null;
      started: true;
    }
  | { ok: false; code: string; usage: { total_tokens: number } | null; started: boolean };

/**
 * Builds a separate, tool-free model call. The caller supplies the transport produced
 * from the Run's resolved frozen selection, never the current default. Eligibility
 * checks are short guarded operations, not transactions held across model I/O.
 * onStart must durably reserve the iteration in a short guarded transaction before
 * model I/O. The caller must account for every successful reservation (including
 * cancellation and null usage), and CAS/recheck eligibility, source ownership,
 * coverage, budget and cancellation at publication. Abort alone is not a fence.
 */
export async function requestCompactModel(
  input: CompactModelInput,
  transport: CompactModelTransport,
  signal: AbortSignal,
  assertEligible: () => Promise<void>,
  onStart: () => Promise<void>,
  harness: HarnessProcessServices,
): Promise<CompactModelResult> {
  let started = false;
  let qualifying = false;
  let usage: { total_tokens: number } | null = null;
  const fail = (code: string): CompactModelResult => ({ ok: false, code, started, usage });
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) return fail('COMPACT_INVALID_INPUT');
  const frozen = parsed.data;
  if (frozen.policy.model_binding.model !== frozen.selectedModelId)
    return fail('COMPACT_MODEL_BINDING_MISMATCH');
  const previous = frozen.previous?.coverage ?? [];
  const messages = frozen.messages;
  const b = frozen.budget;
  // Bound the IPC allocation before serializing source bodies. Native adds the
  // instruction to the exact original aggregate estimate before assembly.
  let sourceBytes = 0;
  for (const message of messages) {
    sourceBytes +=
      Buffer.byteLength(message.text, 'utf8') + Buffer.byteLength(message.id, 'utf8') + 100;
    if (sourceBytes > HARNESS_MAX_FRAME_BYTES) break;
  }
  if (frozen.previous && sourceBytes <= HARNESS_MAX_FRAME_BYTES) {
    sourceBytes += Buffer.byteLength(frozen.previous.text, 'utf8');
    for (const entry of previous) sourceBytes += Buffer.byteLength(entry.id, 'utf8') + 100;
  }
  // Pass only metadata for oversized input so native can still check
  // coverage and budget before reporting the size error.
  const oversized = sourceBytes > HARNESS_MAX_FRAME_BYTES;
  const prior = frozen.previous;
  const sourceMessages = oversized ? messages.map((m) => ({ ...m, text: '' })) : messages;
  const priorSource = oversized && prior ? { ...prior, text: '' } : prior;
  const remaining = b.tokensRemaining === null ? null : b.tokensRemaining - b.continuationTokens;
  try {
    if (signal.aborted) return fail('COMPACT_CANCELLED');
    const assembled = nativeRequest.safeParse(
      await callNativeCompact(
        harness,
        'assemble',
        {
          previous: priorSource,
          messages: sourceMessages,
          source_bytes: sourceBytes,
          budget: b,
        },
        signal,
      ),
    );
    if (!assembled.success) throw nativeProtocolError();
    if (assembled.data.status === 'context_limit') return fail('HARNESS_CONTEXT_LIMIT');
    if (assembled.data.status === 'invalid_coverage') return fail('COMPACT_INVALID_COVERAGE');
    if (assembled.data.status === 'budget') return fail('BUDGET_EXCEEDED');
    const all = assembled.data.coverage;
    const request: Extract<HarnessRequest, { type: 'model' }> = assembled.data.request;
    if (request.remaining_tokens !== remaining || request.max_output_tokens !== b.maxOutputTokens)
      throw nativeProtocolError();
    qualifying = true;
    await assertEligible();
    qualifying = false;
    if (signal.aborted) return fail('COMPACT_CANCELLED');
    const measurement = HarnessContextMeasurementSchema.parse(
      await transport.measure(
        { ...request, type: 'measure_context' },
        [],
        frozen.policy as ContextPolicy,
      ),
    );
    if (
      measurement.limit_reason === 'budget' ||
      (remaining !== null &&
        measurement.input_meter.input_tokens !== null &&
        measurement.input_meter.input_tokens + b.maxOutputTokens > remaining)
    )
      return fail('BUDGET_EXCEEDED');
    if (
      measurement.limit_reason ||
      measurement.output_ceiling < b.maxOutputTokens ||
      measurement.wire_bytes > HARNESS_MAX_FRAME_BYTES ||
      measurement.http_bytes > HARNESS_MAX_FRAME_BYTES
    )
      return fail('HARNESS_CONTEXT_LIMIT');
    qualifying = true;
    await assertEligible();
    qualifying = false;
    if (signal.aborted) return fail('COMPACT_CANCELLED');
    try {
      await onStart();
    } catch (error) {
      return fail(
        signal.aborted
          ? 'COMPACT_CANCELLED'
          : error instanceof ApplicationError
            ? error.errorCode
            : 'COMPACT_START_FAILED',
      );
    }
    started = true;
    if (signal.aborted) return fail('COMPACT_CANCELLED');
    let response: { value: unknown; bytes: number } | undefined;
    for await (const step of transport.model(request, [], signal)) {
      if (step.type === 'failed') {
        usage = step.usage;
        return fail(signal.aborted ? 'COMPACT_CANCELLED' : step.error.code);
      }
      if (step.type === 'complete') {
        usage = step.reply.usage;
        if (
          response !== undefined ||
          step.reply.message.tool_calls.length ||
          step.reply.message.content === null
        )
          return fail('COMPACT_INVALID_RESPONSE');
        // Transport decodes syntax here, before advancing the provider stream.
        // The native operation alone interprets the decoded summary fields.
        try {
          response = {
            value: JSON.parse(step.reply.message.content) as unknown,
            bytes: Buffer.byteLength(step.reply.message.content, 'utf8'),
          };
        } catch {
          return fail('COMPACT_INVALID_RESPONSE');
        }
      }
    }
    if (signal.aborted) return fail('COMPACT_CANCELLED');
    if (!response) return fail('COMPACT_INVALID_RESPONSE');
    if (remaining !== null && usage !== null && usage.total_tokens > remaining)
      return fail('BUDGET_EXCEEDED');
    // Transport sizes are measured on the original JS JSON representation,
    // not on its private native encoding or a library-specific reserialization.
    let candidateBytes: number | null = 0;
    if (
      response.bytes <= HARNESS_MAX_FRAME_BYTES &&
      response.value &&
      typeof response.value === 'object' &&
      'candidates' in response.value &&
      Object.hasOwn(response.value, 'candidates')
    ) {
      try {
        candidateBytes = Buffer.byteLength(JSON.stringify(response.value.candidates), 'utf8');
      } catch {
        candidateBytes = null;
      }
    }
    const interpreted = nativeResponse.safeParse(
      await callNativeCompact(
        harness,
        'interpret',
        {
          response: response.value,
          response_bytes: response.bytes,
          candidate_bytes: candidateBytes,
          coverage: all,
          sources: messages.map(({ id, role }) => [id, role]),
        },
        signal,
      ),
    );
    if (!interpreted.success) throw nativeProtocolError();
    const result = interpreted.data;
    if (result.status !== 'interpreted') return fail('COMPACT_INVALID_RESPONSE');
    if (candidateBytes === null) return fail('HARNESS_UNAVAILABLE');
    const candidates = result.candidates;
    qualifying = true;
    await assertEligible();
    qualifying = false;
    if (signal.aborted) return fail('COMPACT_CANCELLED');
    return { ok: true, text: result.text, coverage: all, candidates, usage, started: true };
  } catch (error) {
    return fail(
      signal.aborted
        ? 'COMPACT_CANCELLED'
        : qualifying
          ? 'COMPACT_NOT_ELIGIBLE'
          : error instanceof ApplicationError
            ? error.errorCode
            : 'HARNESS_UNAVAILABLE',
    );
  }
}
