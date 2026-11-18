import { ApplicationError, validationError } from '../../platform/errors.js';

const MAX_BODY_BYTES = 131072;

export async function readBody(request: Request): Promise<{ body: unknown } | null> {
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_BODY_BYTES) {
        throw new ApplicationError(413, 'PAYLOAD_TOO_LARGE', 'request body too large');
      }
      chunks.push(Buffer.from(chunk.value));
    }
    try {
      return { body: JSON.parse(Buffer.concat(chunks, bytes).toString('utf8')) as unknown };
    } catch {
      throw validationError('invalid JSON body');
    }
  } catch (error) {
    if (error instanceof ApplicationError) throw error;
    return null;
  } finally {
    reader.releaseLock();
  }
}

export function checkDeclaredBodySize(length: string | string[] | undefined): void {
  if (typeof length === 'string' && Number(length) > MAX_BODY_BYTES)
    throw new ApplicationError(413, 'PAYLOAD_TOO_LARGE', 'request body too large');
}
