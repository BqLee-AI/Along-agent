import { z } from 'zod';
import type { ToolPayload, ToolResult } from './contracts.js';
import { HarnessToolResultSchema } from '@along/contracts';

const small = z.string().max(512);
export const resultSchema = HarnessToolResultSchema;
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
