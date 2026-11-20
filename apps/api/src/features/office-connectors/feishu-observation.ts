import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { FeishuBotDocxGrant } from './feishu-bot-docx-binding.js';

/** Decrypt historical user-identity receipts without supporting new v1 writes. */
export function openFeishuObservation(
  key: Buffer,
  ownerId: string,
  invocationId: string,
  ciphertext: string,
): unknown {
  const bytes = Buffer.from(ciphertext, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
  decipher.setAAD(Buffer.from(JSON.stringify(['feishu-observation/1', ownerId, invocationId])));
  decipher.setAuthTag(bytes.subarray(-16));
  const json = decipher.update(bytes.subarray(12, -16), undefined, 'utf8') + decipher.final('utf8');
  return JSON.parse(json);
}

interface BotObservationBinding {
  ownerId: string;
  runId: string;
  invocationId: string;
  grant: FeishuBotDocxGrant;
}

function botObservationAad({ ownerId, runId, invocationId, grant }: BotObservationBinding) {
  return Buffer.from(
    JSON.stringify([
      'feishu-observation/2',
      ownerId,
      runId,
      invocationId,
      grant.kind,
      grant.connectionId,
      grant.revision,
      grant.generation,
      grant.appId,
      grant.sessionId,
      grant.url,
    ]),
  );
}

export function sealFeishuBotObservation(
  key: Buffer,
  binding: BotObservationBinding,
  json: string,
) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(botObservationAad(binding));
  return Buffer.concat([
    iv,
    cipher.update(json, 'utf8'),
    cipher.final(),
    cipher.getAuthTag(),
  ]).toString('base64');
}

export function openFeishuBotObservation(
  key: Buffer,
  binding: BotObservationBinding,
  ciphertext: string,
): unknown {
  const bytes = Buffer.from(ciphertext, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
  decipher.setAAD(botObservationAad(binding));
  decipher.setAuthTag(bytes.subarray(-16));
  return JSON.parse(
    decipher.update(bytes.subarray(12, -16), undefined, 'utf8') + decipher.final('utf8'),
  );
}
