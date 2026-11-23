import { describe, expect, test } from 'bun:test';
import { readOfficeUpload } from '../src/features/native-office/upload.js';

function upload(
  body: string | Uint8Array<ArrayBuffer>,
  headers: Record<string, string> = {},
): Request {
  return new Request('http://localhost/', {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream',
      'x-along-filename': encodeURIComponent('纪要.md'),
      ...headers,
    },
    body,
  });
}

describe('private office uploads', () => {
  test('preserves UTF-8 bytes and a safe decoded filename', async () => {
    const bytes = new TextEncoder().encode('第一行\r\n第二行');
    const result = await readOfficeUpload(upload(bytes));
    expect(result.filename).toBe('纪要.md');
    expect(result.format).toBe('markdown');
    expect(result.bytes).toEqual(Buffer.from(bytes));
  });

  test('rejects unsupported encodings, unsafe names and invalid UTF-8', async () => {
    await expect(readOfficeUpload(upload('x', { 'content-encoding': 'gzip' }))).rejects.toThrow();
    await expect(
      readOfficeUpload(upload('x', { 'x-along-filename': encodeURIComponent('../secret.csv') })),
    ).rejects.toThrow();
    await expect(readOfficeUpload(upload('x', { 'x-along-filename': 'csv' }))).rejects.toThrow();
    await expect(readOfficeUpload(upload(new Uint8Array([0xff])))).rejects.toThrow();
  });

  test('rejects oversized actual bytes without trusting the declared length', async () => {
    await expect(readOfficeUpload(upload(new Uint8Array(1024 * 1024 + 1)))).rejects.toMatchObject({
      code: 413,
      errorCode: 'PAYLOAD_TOO_LARGE',
    });
  });
});
