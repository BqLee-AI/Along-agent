import { expect, test } from 'bun:test';
import {
  openFeishuBotObservation,
  openFeishuObservation,
  sealFeishuBotObservation,
  type FeishuBotDocxGrant,
} from '../src/features/office-connectors/public.js';

const ownerId = '11111111-1111-4111-8111-111111111111';
const invocationId = '22222222-2222-4222-8222-222222222222';
const runId = '33333333-3333-4333-8333-333333333333';
const key = Buffer.alloc(32, 0x42);

// Frozen v1 synthetic receipt: 12-byte nonce, ciphertext, 16-byte GCM tag.
const legacyCiphertext =
  'FxcXFxcXFxcXFxcXh4D+3RKbHHepoFyRxLDbV0UGraxFE1k69hIr0wKlSMFkEA/YYmCWTpfV8ORXafuM';

test('opens a historical receipt only under its original owner and invocation', () => {
  expect(openFeishuObservation(key, ownerId, invocationId, legacyCiphertext)).toEqual({
    content: 'historical receipt',
  });
  expect(() => openFeishuObservation(key, ownerId, runId, legacyCiphertext)).toThrow();
  expect(() => openFeishuObservation(key, runId, invocationId, legacyCiphertext)).toThrow();
});

test('bot receipts bind the run and grant and never fall back to legacy AAD', () => {
  const grant: FeishuBotDocxGrant = {
    kind: 'feishu-docx-bot/1',
    connectionId: '44444444-4444-4444-8444-444444444444',
    revision: '55555555-5555-4555-8555-555555555555',
    generation: '66666666-6666-4666-8666-666666666666',
    appId: 'cli_abcdefghijkl',
    sessionId: '77777777-7777-4777-8777-777777777777',
    url: 'https://test.feishu.cn/docx/TestDocument000000000000000',
  };
  const binding = { ownerId, invocationId, runId, grant };
  const result = { content: 'bot receipt' };
  const ciphertext = sealFeishuBotObservation(key, binding, JSON.stringify(result));
  expect(openFeishuBotObservation(key, binding, ciphertext)).toEqual(result);
  expect(() => openFeishuBotObservation(key, { ...binding, runId: ownerId }, ciphertext)).toThrow();
  expect(() =>
    openFeishuBotObservation(
      key,
      { ...binding, grant: { ...grant, generation: grant.revision } },
      ciphertext,
    ),
  ).toThrow();
  expect(() => openFeishuObservation(key, ownerId, invocationId, ciphertext)).toThrow();
  expect(() => openFeishuBotObservation(key, binding, legacyCiphertext)).toThrow();
});
