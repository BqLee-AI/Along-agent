import { expect, test } from 'bun:test';
import { readOfficeObservationKey } from '../src/features/native-office/public.js';

test('Along reads only a canonical padded base64 encoding of 32 bytes', () => {
  const key = Buffer.alloc(32, 0xff);
  const canonical = key.toString('base64');
  const read = (value: string) => readOfficeObservationKey({ ALONG_OFFICE_OBSERVATION_KEY: value });
  expect(read(canonical)).toEqual(key);
  expect(readOfficeObservationKey({ FEISHU_BOT_OBSERVATION_KEY: canonical })).toBeNull();
  for (const invalid of [
    '',
    `${canonical}\n`,
    ` ${canonical}`,
    canonical.slice(0, -1),
    key.toString('base64url'),
    `${key.toString('base64url')}=`,
    Buffer.alloc(31).toString('base64'),
    Buffer.alloc(33).toString('base64'),
    `${'A'.repeat(42)}B=`, // Nonzero pad bits decode to the same zero bytes as the canonical key.
  ]) {
    expect(read(invalid)).toBeNull();
  }
});
