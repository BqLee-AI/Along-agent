import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { openSync, readSync, closeSync, fstatSync } from 'node:fs';
import { notReady, validationError } from '../../http/errors.js';

export type Purpose = 'invitation' | 'verify_contact' | 'reset_password';
export interface IdentityKeyring {
  version: 1;
  lookup: { id: string; key: Buffer };
  challenge: { active: string; keys: Record<string, Buffer> };
  encryption: { active: string; keys: Record<string, Buffer> };
  rateLimit: { id: string; key: Buffer };
}
export interface EncryptedFields {
  ciphertext: Buffer;
  nonce: Buffer;
  tag: Buffer;
  encryption_key_id: string;
}
const MAX_KEYS = 8;
const KEY_ID = /^[A-Za-z0-9_-]{1,64}$/;
function record(value: unknown, fields?: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('object required');
  const result = value as Record<string, unknown>;
  if (
    fields &&
    (Object.keys(result).length !== fields.length ||
      fields.some((key) => !Object.hasOwn(result, key)))
  )
    throw new Error('invalid fields');
  return result;
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !KEY_ID.test(value) || value === 'erased')
    throw new Error('invalid key id');
  return value;
}
function key(value: unknown): Buffer {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(value))
    throw new Error('invalid key');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length !== 32 || bytes.toString('base64') !== value) throw new Error('invalid key');
  return bytes;
}
export function parseIdentityKeyring(value: unknown): IdentityKeyring {
  try {
    const root = record(value, ['version', 'lookup', 'challenge', 'encryption', 'rateLimit']);
    if (root.version !== 1) throw new Error('unsupported version');
    const single = (value: unknown) => {
      const entry = record(value, ['id', 'key']);
      return { id: id(entry.id), key: key(entry.key) };
    };
    const ring = (value: unknown) => {
      const entry = record(value, ['active', 'keys']);
      const active = id(entry.active);
      const source = record(entry.keys);
      const names = Object.keys(source);
      if (!names.length || names.length > MAX_KEYS || !Object.hasOwn(source, active))
        throw new Error('invalid keyring');
      const keys: Record<string, Buffer> = Object.create(null);
      for (const name of names) keys[id(name)] = key(source[name]);
      return { active, keys };
    };
    const result: IdentityKeyring = {
      version: 1,
      lookup: single(root.lookup),
      challenge: ring(root.challenge),
      encryption: ring(root.encryption),
      rateLimit: single(root.rateLimit),
    };
    // Separation is a configuration invariant, not merely a naming convention.
    const families = [
      [result.lookup.key],
      Object.values(result.challenge.keys),
      Object.values(result.encryption.keys),
      [result.rateLimit.key],
    ];
    for (let a = 0; a < families.length; a++)
      for (let b = a + 1; b < families.length; b++) {
        if (families[a]!.some((left) => families[b]!.some((right) => left.equals(right))))
          throw new Error('key reuse');
      }
    return result;
  } catch {
    throw notReady('identity key configuration unavailable');
  }
}
export function loadIdentityKeyring(): IdentityKeyring {
  let fd: number | undefined;
  try {
    const path = process.env.IDENTITY_KEYRING_FILE;
    if (!path) throw new Error('missing keyring');
    fd = openSync(path, 'r');
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.size > 65536 ||
      (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)
    )
      throw new Error('invalid private keyfile');
    const bytes = Buffer.alloc(65537);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length > 65536) throw new Error('keyfile too large');
    return parseIdentityKeyring(JSON.parse(bytes.subarray(0, length).toString('utf8')));
  } catch {
    throw notReady('identity key configuration unavailable');
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
export function normalizeContactEmail(input: string): {
  address: string;
  normalized: string;
  masked: string;
} {
  if (typeof input !== 'string') throw validationError('invalid contact email');
  const value = input.replace(/^[\x09-\x0d\x20]+|[\x09-\x0d\x20]+$/g, '');
  if (value.length > 254 || /[^\x21-\x7e]/.test(value))
    throw validationError('invalid contact email');
  const parts = value.split('@');
  if (parts.length !== 2) throw validationError('invalid contact email');
  const [local = '', domain = ''] = parts;
  if (
    !local.length ||
    local.length > 64 ||
    !/^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~]+(?:\.[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~]+)*$/.test(local)
  )
    throw validationError('invalid contact email');
  const labels = domain.split('.');
  if (
    labels.length < 2 ||
    labels.some((label) => !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label))
  )
    throw validationError('invalid contact email');
  const address = `${local}@${domain.toLowerCase()}`;
  return {
    address,
    normalized: address.toLowerCase(),
    masked: `${local[0]!.toLowerCase()}***@${domain.toLowerCase()}`,
  };
}
export function lookupDigest(keys: IdentityKeyring, normalized: string): Buffer {
  return createHmac('sha256', keys.lookup.key).update(`identity:contact:v1:${normalized}`).digest();
}
function assertPurpose(purpose: Purpose): void {
  if (!['invitation', 'verify_contact', 'reset_password'].includes(purpose))
    throw notReady('identity purpose unavailable');
}
export function tokenDigest(
  keys: IdentityKeyring,
  purpose: Purpose,
  raw: string,
  keyId = keys.challenge.active,
): Buffer {
  assertPurpose(purpose);
  const secret = keys.challenge.keys[keyId];
  if (!secret) throw notReady('identity challenge key unavailable');
  return createHmac('sha256', secret)
    .update(`identity:challenge:v1:${purpose}:`)
    .update(raw)
    .digest();
}
export function challengeDigests(
  keys: IdentityKeyring,
  purpose: Purpose,
  raw: string,
): { keyId: string; digest: Buffer }[] {
  return Object.keys(keys.challenge.keys).map((keyId) => ({
    keyId,
    digest: tokenDigest(keys, purpose, raw, keyId),
  }));
}
export function issueToken(): string {
  return randomBytes(32).toString('base64url');
}
function aadBytes(aad: string, keyId: string): Buffer {
  return Buffer.from(JSON.stringify(['identity:aead:v1', aad, keyId]));
}
export function sealIdentity(
  keys: IdentityKeyring,
  plaintext: string,
  aad: string,
): EncryptedFields {
  try {
    const keyId = keys.encryption.active;
    const secret = keys.encryption.keys[keyId];
    if (!secret) throw new Error('missing encryption key');
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', secret, nonce);
    cipher.setAAD(aadBytes(aad, keyId));
    return {
      ciphertext: Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]),
      nonce,
      tag: cipher.getAuthTag(),
      encryption_key_id: keyId,
    };
  } catch {
    throw notReady('identity encryption unavailable');
  }
}
export function openIdentity(keys: IdentityKeyring, fields: EncryptedFields, aad: string): string {
  try {
    const secret = keys.encryption.keys[fields.encryption_key_id];
    if (!secret || fields.nonce.length !== 12 || fields.tag.length !== 16)
      throw new Error('invalid encryption context');
    const decipher = createDecipheriv('aes-256-gcm', secret, fields.nonce);
    decipher.setAAD(aadBytes(aad, fields.encryption_key_id));
    decipher.setAuthTag(fields.tag);
    return Buffer.concat([decipher.update(fields.ciphertext), decipher.final()]).toString('utf8');
  } catch {
    throw notReady('identity decryption unavailable');
  }
}
