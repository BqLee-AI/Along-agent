import { z } from 'zod';
import type { ToolPayload, ToolResult } from './contracts.js';
import {
  workspaceListResultSchema,
  workspaceSearchResultSchema,
  workspaceReadResultSchema,
  workspaceOperationErrorSchema,
  workspaceAppliedResultSchema,
  workspaceConflictResultSchema,
} from '@along/contracts';
import { DocumentApprovalReceiptSchema } from '@along/contracts';

const text = z.string().max(8192);
const small = z.string().max(512);
const failure = z.object({ code: small, message: text }).strict();
const timeFailure = z
  .object({
    code: z.enum([
      'NONEXISTENT_LOCAL_TIME',
      'AMBIGUOUS_LOCAL_TIME',
      'TZDB_UNAVAILABLE',
      'UNKNOWN_TIMEZONE',
    ]),
    message: text,
    http_status: z.union([z.literal(422), z.literal(503)]),
    details: z
      .object({
        wall_time: small,
        timezone_id: small,
        ruleset_id: small,
        candidates: z
          .array(
            z
              .object({
                fold_choice: z.enum(['first', 'second']),
                offset_seconds: z.number().int(),
                fire_at_utc: small,
              })
              .strict(),
          )
          .max(2)
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
const approval = z
  .object({
    approvalId: z.string().uuid(),
    originalText: text,
    presentationHash: small,
    presentationVersion: small,
    expiresAt: small,
    wallTime: small,
    timezoneId: small,
    fold: z.union([z.literal(0), z.literal(1)]),
    offsetSeconds: z.number().int(),
    fireAtUtc: small,
  })
  .strict();
export const payloadSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('approval'),
      approval,
      echo_text: text,
      card_id: small,
      original_text: text,
    })
    .strict(),
  z.object({ kind: z.literal('clarify'), reason: small, phrase_key: small, text }).strict(),
  z.object({ kind: z.literal('time_error'), error: timeFailure }).strict(),
  z
    .object({
      kind: z.literal('list_tasks'),
      tasks: z
        .array(
          z
            .object({
              task_id: z.string().uuid(),
              note_preview: z.string().max(30),
              fire_at_local_text: small,
              timezone_id: small,
              state: small,
            })
            .strict(),
        )
        .max(50),
      has_more: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('brief'),
      brief_id: small,
      date: small,
      cards: z
        .array(
          z
            .object({
              card_id: small,
              kind: small,
              title: z.string().max(30),
              body_text: text,
              source_refs: z.array(small).max(10),
              presentation_version: small,
            })
            .strict(),
        )
        .max(50),
    })
    .strict(),
  z
    .object({
      kind: z.literal('prefs'),
      timezone_id: small.nullable(),
      alias_version: small,
      quiet_hours: z.null(),
      locale: z.null(),
    })
    .strict(),
  z.object({ kind: z.literal('effect_evidence'), evidence_ref: small }).strict(),
  workspaceListResultSchema,
  workspaceSearchResultSchema,
  workspaceReadResultSchema,
  workspaceOperationErrorSchema,
  workspaceAppliedResultSchema,
  workspaceConflictResultSchema,
  z
    .object({ kind: z.literal('document_approval'), approval: DocumentApprovalReceiptSchema })
    .strict(),
]);
export const resultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), result: payloadSchema }).strict(),
  z.object({ status: z.literal('denied'), error: failure }).strict(),
  z.object({ status: z.literal('failed'), error: failure }).strict(),
  z.object({ status: z.literal('unknown'), error: failure }).strict(),
]);
export const approvalReceiptSchema = z
  .object({
    approvalId: z.string().uuid(),
    fireAtUtc: small,
    presentationHash: small,
    presentationVersion: small,
  })
  .strict();
export function parseResult(value: unknown): ToolResult {
  return resultSchema.parse(value);
}
export function resultKind(result: ToolResult): string {
  if (result.status !== 'ok') return result.status;
  const payload: ToolPayload = result.result;
  if (payload.kind === 'approval' || payload.kind === 'document_approval')
    return 'approval_pending';
  if (payload.kind === 'clarify') return 'clarification';
  if (payload.kind === 'time_error') return 'time_error';
  return 'success';
}
