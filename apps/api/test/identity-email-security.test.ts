import { describe, expect, it } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  challengeDigests,
  issueToken,
  loadIdentityKeyring,
  lookupDigest,
  normalizeContactEmail,
  openIdentity,
  parseIdentityKeyring,
  sealIdentity,
  tokenDigest,
} from '../src/features/identity/security/email-security.js';
import {
  createResendIdentitySender,
  requireIdentityMailReady,
} from '../src/features/identity/delivery/transport.js';
import { identityKeyfileFixture, identityKeysFixture } from './helpers/identity-security.js';

describe('identity strict email and recoverable cryptographic boundary', () => {
  it('preserves delivery local case, folds lookup, and masks short locals', () => {
    expect(normalizeContactEmail('\t A.b+tag@EXAMPLE.COM\r\n')).toEqual({
      address: 'A.b+tag@example.com',
      normalized: 'a.b+tag@example.com',
      masked: 'a***@example.com',
    });
    expect(normalizeContactEmail('a@xn--test-9db.example').masked).toBe(
      'a***@xn--test-9db.example',
    );
    expect(normalizeContactEmail(`${'a'.repeat(64)}@example.com`).address).toHaveLength(76);
    expect(normalizeContactEmail(`a@${'b'.repeat(63)}.com`).normalized).toContain('@');
    const boundary = `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(61)}`;
    expect(normalizeContactEmail(boundary).address).toHaveLength(254);
    expect(() => normalizeContactEmail(`${boundary}d`)).toThrow();
  });
  it.each([
    '',
    'a@localhost',
    '.a@example.com',
    'a.@example.com',
    'a..b@example.com',
    'a b@example.com',
    'A <a@example.com>',
    'a(comment)@example.com',
    '"a"@example.com',
    'a@[127.0.0.1]',
    'a@example.com.',
    'a@-example.com',
    'a@example-.com',
    'a@exam_ple.com',
    'a@example..com',
    'a@example.com,b@example.com',
    'é@example.com',
    'a@例子.com',
    '\u00a0a@example.com',
    'a\0@example.com',
    'a\r\nb@example.com',
    `${'a'.repeat(65)}@example.com`,
    `a@${'b'.repeat(64)}.com`,
  ])('rejects unsupported mailbox %j', (input) => {
    expect(() => normalizeContactEmail(input)).toThrow();
  });
  it('binds ciphertext to logical record, owner, purpose, generation, key ID and bytes', () => {
    const keys = identityKeysFixture();
    const aad = 'identity:challenge:record:owner:verify_contact:1';
    const sealed = sealIdentity(keys, 'SecretAddress@example.com', aad);
    expect(openIdentity(keys, sealed, aad)).toBe('SecretAddress@example.com');
    expect(sealed.nonce).toHaveLength(12);
    expect(sealed.tag).toHaveLength(16);
    for (const other of [
      'identity:challenge:other:owner:verify_contact:1',
      'identity:challenge:record:other:verify_contact:1',
      'identity:challenge:record:owner:reset_password:1',
      'identity:challenge:record:owner:verify_contact:2',
    ])
      expect(() => openIdentity(keys, sealed, other)).toThrow();
    for (const field of ['nonce', 'tag', 'ciphertext'] as const) {
      const changed = { ...sealed, [field]: Buffer.from(sealed[field]) };
      changed[field][0] = changed[field][0]! ^ 1;
      expect(() => openIdentity(keys, changed, aad)).toThrow();
    }
    keys.encryption.keys.alias = keys.encryption.keys[keys.encryption.active]!;
    expect(() => openIdentity(keys, { ...sealed, encryption_key_id: 'alias' }, aad)).toThrow();
  });
  it('retains old AEAD/challenge keys on rotation without cross-purpose digests', () => {
    const keys = identityKeysFixture();
    const token = issueToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const sealed = sealIdentity(keys, 'address', 'identity:contact:id:owner:1');
    const old = tokenDigest(keys, 'invitation', token);
    keys.challenge.keys.next = randomBytes(32);
    keys.challenge.active = 'next';
    keys.encryption.keys.next = randomBytes(32);
    keys.encryption.active = 'next';
    expect(openIdentity(keys, sealed, 'identity:contact:id:owner:1')).toBe('address');
    expect(
      challengeDigests(keys, 'invitation', token).some((item) => item.digest.equals(old)),
    ).toBe(true);
    expect(tokenDigest(keys, 'reset_password', token).equals(old)).toBe(false);
    expect(tokenDigest(keys, 'invitation', token).equals(old)).toBe(false);
    expect(lookupDigest(keys, token).equals(old)).toBe(false);
    delete keys.encryption.keys[sealed.encryption_key_id];
    expect(() => openIdentity(keys, sealed, 'identity:contact:id:owner:1')).toThrow();
    expect(() => tokenDigest(keys, 'invitation', token, 'missing')).toThrow();
  });
  it('rejects missing, oversized, ambiguous or reused key families', () => {
    for (const invalid of [
      null,
      {},
      { ...identityKeyfileFixture(), extra: true },
      { ...identityKeyfileFixture(), version: 2 },
    ])
      expect(() => parseIdentityKeyring(invalid)).toThrow();
    const fixture = identityKeyfileFixture();
    expect(() => parseIdentityKeyring({ ...fixture, rateLimit: fixture.lookup })).toThrow();
    expect(() =>
      parseIdentityKeyring({
        ...fixture,
        challenge: { active: 'missing', keys: fixture.challenge.keys },
      }),
    ).toThrow();
    expect(() =>
      parseIdentityKeyring({
        ...fixture,
        challenge: {
          active: 'k0',
          keys: Object.fromEntries(
            Array.from({ length: 9 }, (_, i) => [`k${i}`, randomBytes(32).toString('base64')]),
          ),
        },
      }),
    ).toThrow();
    expect(() =>
      parseIdentityKeyring({ ...fixture, lookup: { id: 'bad', key: 'not-base64' } }),
    ).toThrow();
  });
  it('recovers after a missing keyfile is repaired, without caching failure', () => {
    const root = mkdtempSync(join(tmpdir(), 'along112-keys-'));
    const previous = process.env.IDENTITY_KEYRING_FILE;
    process.env.IDENTITY_KEYRING_FILE = join(root, 'keys.json');
    try {
      expect(() => loadIdentityKeyring()).toThrow();
      writeFileSync(process.env.IDENTITY_KEYRING_FILE, JSON.stringify(identityKeyfileFixture()), {
        mode: 0o600,
      });
      chmodSync(process.env.IDENTITY_KEYRING_FILE, 0o600);
      expect(loadIdentityKeyring().version).toBe(1);
      writeFileSync(process.env.IDENTITY_KEYRING_FILE, '{broken');
      expect(() => loadIdentityKeyring()).toThrow();
      writeFileSync(process.env.IDENTITY_KEYRING_FILE, JSON.stringify(identityKeyfileFixture()));
      expect(loadIdentityKeyring().version).toBe(1);
    } finally {
      if (previous === undefined) delete process.env.IDENTITY_KEYRING_FILE;
      else process.env.IDENTITY_KEYRING_FILE = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('requires explicit valid mail readiness and forbids external plaintext transport', () => {
    const send = async () => ({ status: 'submitted' as const });
    expect(
      requireIdentityMailReady({
        mail: { origin: 'http://localhost:3000', from: 'test@example.com', send },
      }).send,
    ).toBe(send);
    for (const origin of [
      'http://external.example',
      'https://example.com/path',
      'https://example.com/?token=x',
    ])
      expect(() =>
        requireIdentityMailReady({ mail: { origin, from: 'test@example.com', send } }),
      ).toThrow();
    expect(() =>
      createResendIdentitySender({
        apiKey: 'isolated',
        from: 'test@example.com',
        endpoint: 'http://external.example/emails',
      }),
    ).toThrow();
  });
});
