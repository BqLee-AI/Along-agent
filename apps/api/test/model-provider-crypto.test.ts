import { describe, expect, test } from 'bun:test';
import {
  encryptCredential,
  decryptCredential,
} from '../src/features/model-providers/configuration/crypto.js';

const key = Buffer.alloc(32, 7);
describe('provider credential encryption', () => {
  test('encrypts without exposing the credential and binds it to owner and provider', () => {
    const ciphertext = encryptCredential(key, 'owner-a', 'provider-a', 'secret-value');
    expect(ciphertext).not.toContain('secret-value');
    expect(decryptCredential(key, 'owner-a', 'provider-a', ciphertext)).toBe('secret-value');
    expect(() => decryptCredential(key, 'owner-b', 'provider-a', ciphertext)).toThrow();
    expect(() => decryptCredential(key, 'owner-a', 'provider-b', ciphertext)).toThrow();
  });
});
