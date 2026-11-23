import { ApplicationError, validationError } from '../../platform/errors.js';

const MAX_ATTACHMENT_BYTES = 1024 * 1024;

export type OfficeUpload = {
  filename: string;
  format: 'txt' | 'markdown' | 'csv';
  bytes: Buffer;
};

/** Read only after the HTTP entry point has authenticated the user and checked CSRF. */
export async function readOfficeUpload(request: Request): Promise<OfficeUpload> {
  const encoding = request.headers.get('content-encoding');
  if (encoding && encoding.toLowerCase() !== 'identity')
    throw validationError('unsupported content encoding');
  if (request.headers.get('content-type')?.toLowerCase() !== 'application/octet-stream')
    throw validationError('unsupported content type');
  const encodedName = request.headers.get('x-along-filename');
  let filename: string;
  try {
    filename = decodeURIComponent(encodedName ?? '');
  } catch {
    throw validationError('invalid filename');
  }
  if (
    !filename ||
    filename.length > 255 ||
    filename === '.' ||
    filename === '..' ||
    /[\u0000-\u001f\u007f/\\]/u.test(filename)
  )
    throw validationError('invalid filename');
  const extension = filename.includes('.') ? filename.toLowerCase().split('.').at(-1) : undefined;
  const format = extension === 'md' ? 'markdown' : extension;
  if (format !== 'txt' && format !== 'markdown' && format !== 'csv')
    throw validationError('unsupported attachment format');
  const length = request.headers.get('content-length');
  if (length && /^\d+$/.test(length) && Number(length) > MAX_ATTACHMENT_BYTES)
    throw new ApplicationError(413, 'PAYLOAD_TOO_LARGE', 'attachment too large');
  if (!request.body) throw validationError('empty attachment');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_ATTACHMENT_BYTES)
        throw new ApplicationError(413, 'PAYLOAD_TOO_LARGE', 'attachment too large');
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (!size) throw validationError('empty attachment');
  const bytes = Buffer.concat(chunks, size);
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw validationError('invalid UTF-8 attachment');
  }
  return { filename, format, bytes };
}
