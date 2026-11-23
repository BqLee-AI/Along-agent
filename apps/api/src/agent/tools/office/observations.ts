import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { stateConflict } from '../../../platform/errors.js';
import type { ToolResult } from '../contracts.js';
import { parseResult } from '../result-schema.js';

type ObservationBinding = {
  ownerId: string;
  conversationId: string;
  runId: string;
  attemptId: string;
  invocationId: string;
  toolId: string;
};
export const OFFICE_OBSERVATION_ENCODING = 'along-office-aead/1';
const nonceBytes = 12;
const tagBytes = 16;
const maxObservationBytes = 64 * 1024;
const digestSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const envelopeSchema = z
  .object({
    encoding: z.literal(OFFICE_OBSERVATION_ENCODING),
    ciphertext: z.string().max(Math.ceil(((maxObservationBytes + nonceBytes + tagBytes) * 4) / 3)),
  })
  .strict();
const plaintextSchema = z
  .object({ value: z.unknown(), analysisDigest: digestSchema.optional() })
  .strict();

export function isPrivateOfficeObservation(tool: string): boolean {
  return tool === 'office_read_notes' || tool === 'office_analyze_tasks';
}

function aad(binding: ObservationBinding): Buffer {
  const { ownerId, conversationId, runId, attemptId, invocationId, toolId } = binding;
  return Buffer.from(
    JSON.stringify([
      OFFICE_OBSERVATION_ENCODING,
      ownerId,
      conversationId,
      runId,
      attemptId,
      invocationId,
      toolId,
    ]),
  );
}

function verifyObservation(toolId: string, value: ToolResult, analysisDigest?: string) {
  if (
    value.status !== 'ok' ||
    value.result.kind !== toolId ||
    !isPrivateOfficeObservation(toolId) ||
    (value.result.kind === 'office_analyze_tasks' && value.result.action === 'analyze') !==
      (analysisDigest !== undefined)
  )
    throw stateConflict('invalid office observation binding');
  if (analysisDigest !== undefined) digestSchema.parse(analysisDigest);
  return { value, analysisDigest };
}

export function sealOfficeObservation(
  key: Buffer,
  binding: ObservationBinding,
  value: ToolResult,
  analysisDigest?: string,
) {
  const plaintext = JSON.stringify(verifyObservation(binding.toolId, value, analysisDigest));
  if (Buffer.byteLength(plaintext) > maxObservationBytes)
    throw stateConflict('office observation too large');
  const nonce = randomBytes(nonceBytes);
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: tagBytes });
  cipher.setAAD(aad(binding));
  const encrypted = Buffer.concat([
    nonce,
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return { encoding: OFFICE_OBSERVATION_ENCODING, ciphertext: encrypted.toString('base64url') };
}

export function openOfficeObservation(key: Buffer, binding: ObservationBinding, raw: unknown) {
  try {
    const { ciphertext } = envelopeSchema.parse(raw);
    const encrypted = Buffer.from(ciphertext, 'base64url');
    if (encrypted.length <= nonceBytes + tagBytes || encrypted.toString('base64url') !== ciphertext)
      throw stateConflict('invalid office observation ciphertext');
    const decipher = createDecipheriv('aes-256-gcm', key, encrypted.subarray(0, nonceBytes), {
      authTagLength: tagBytes,
    });
    decipher.setAAD(aad(binding));
    decipher.setAuthTag(encrypted.subarray(-tagBytes));
    const plaintext = Buffer.concat([
      decipher.update(encrypted.subarray(nonceBytes, -tagBytes)),
      decipher.final(),
    ]).toString('utf8');
    const { value, analysisDigest } = plaintextSchema.parse(JSON.parse(plaintext));
    return verifyObservation(binding.toolId, parseResult(value), analysisDigest);
  } catch {
    throw stateConflict('invalid office observation ciphertext');
  }
}
