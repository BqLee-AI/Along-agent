import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

function aad(ownerId: string, providerId: string): Buffer {
  return Buffer.from(JSON.stringify([ownerId, providerId]), 'utf8');
}

export function encryptCredential(
  key: Buffer,
  ownerId: string,
  providerId: string,
  secret: string,
): string {
  if (key.length !== 32) throw new Error('invalid credential encryption key');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad(ownerId, providerId));
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
}

export function decryptCredential(
  key: Buffer,
  ownerId: string,
  providerId: string,
  encoded: string,
): string {
  if (key.length !== 32) throw new Error('invalid credential encryption key');
  const data = Buffer.from(encoded, 'base64');
  if (data.length < 28) throw new Error('invalid credential ciphertext');
  const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
  decipher.setAAD(aad(ownerId, providerId));
  decipher.setAuthTag(data.subarray(12, 28));
  return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8');
}

export function credentialKey(): Buffer {
  const value = process.env.MODEL_PROVIDER_ENCRYPTION_KEY;
  if (!value || !/^[A-Za-z0-9+/]{43}=$/.test(value))
    throw new Error('model provider encryption key unavailable');
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32 || key.toString('base64') !== value)
    throw new Error('model provider encryption key unavailable');
  return key;
}
