import { createHash } from 'node:crypto';
import { z } from 'zod';

const API = 'https://open.feishu.cn';
const MAX_RESPONSE_BYTES = 240_000;
const MAX_RESULT_BYTES = 240_000;
const docxPath = /^\/docx\/([A-Za-z0-9]{27})\/?$/u;
const metadata = z.object({
  document: z.object({
    document_id: z.string(),
    title: z.string(),
    revision_id: z.number().int().positive().safe(),
  }),
});
const raw = z.object({ content: z.string() });
const envelope = z.object({ code: z.number().int(), data: z.unknown().optional() });

type Failure =
  | 'unsupported_source'
  | 'permission_denied'
  | 'not_found'
  | 'reauthorization_required'
  | 'rate_limited'
  | 'range_too_large'
  | 'version_changed'
  | 'unavailable';

function failure(reason: Failure) {
  return { status: 'error' as const, reason };
}

async function readJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Missing Feishu response body');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let size = 0;
  let text = '';
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        return undefined;
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally {
    reader.releaseLock();
  }
}

export function suppliedFeishuDocxUrl(text: string): string | null {
  const links = new Set(
    text.match(/https:\/\/[a-z0-9-]+\.feishu\.cn\/docx\/[A-Za-z0-9]{27}(?![A-Za-z0-9_/-])/gu),
  );
  return links.size === 1 ? (links.values().next().value ?? null) : null;
}

/** Private transport: the caller must use the qualified bot's tenant token and
 * recheck binding and Run eligibility before accepting or disclosing the result. */
export async function readFeishuDocx(
  input: { documentUrl: string; tenantAccessToken: string; signal: AbortSignal },
  request: (url: string, init: RequestInit) => Promise<Response> = fetch,
) {
  let source: URL;
  try {
    source = new URL(input.documentUrl);
  } catch {
    return failure('unsupported_source');
  }
  const documentId = docxPath.exec(source.pathname)?.[1];
  if (
    source.protocol !== 'https:' ||
    !/^[a-z0-9-]+\.feishu\.cn$/u.test(source.hostname) ||
    source.port ||
    source.username ||
    source.password ||
    !documentId
  )
    return failure('unsupported_source');
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(10_000)]);
  async function get<T>(suffix: '' | '/raw_content', schema: z.ZodType<T>) {
    const response = await request(`${API}/open-apis/docx/v1/documents/${documentId}${suffix}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${input.tenantAccessToken}` },
      redirect: 'error',
      signal,
    });
    const body = await readJson(response);
    if (body === undefined) return failure('range_too_large');
    const parsed = envelope.safeParse(body);
    const code = parsed.success ? parsed.data.code : undefined;
    if (code === 1770032 || response.status === 403) return failure('permission_denied');
    if (code === 1770002 || code === 1770003 || response.status === 404)
      return failure('not_found');
    if (code === 1770033) return failure('range_too_large');
    if (code === 99991400 || response.status === 429) return failure('rate_limited');
    if (response.status === 401) return failure('reauthorization_required');
    if (!response.ok || !parsed.success || parsed.data.code !== 0) return failure('unavailable');
    return { status: 'ok' as const, data: schema.parse(parsed.data.data) };
  }
  try {
    const before = await get('', metadata);
    if (before.status === 'error') return before;
    if (before.data.document.document_id !== documentId) return failure('unavailable');
    const body = await get('/raw_content', raw);
    if (body.status === 'error') return body;
    const after = await get('', metadata);
    if (after.status === 'error') return after;
    if (after.data.document.document_id !== documentId) return failure('unavailable');
    if (
      before.data.document.revision_id !== after.data.document.revision_id ||
      before.data.document.title !== after.data.document.title
    )
      return failure('version_changed');
    const content = body.data.content;
    const result = {
      status: 'ok' as const,
      source: {
        type: 'feishu_docx' as const,
        document_id: documentId,
        url: `${source.origin}/docx/${documentId}`,
        title: after.data.document.title,
      },
      revision: {
        before: before.data.document.revision_id,
        after: after.data.document.revision_id,
      },
      fetched_at: new Date().toISOString(),
      content_hash: createHash('sha256').update(content).digest('hex'),
      representation: 'plain_text' as const,
      completeness: 'complete_plain_text' as const,
      content,
    };
    if (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_RESULT_BYTES)
      return failure('range_too_large');
    input.signal.throwIfAborted();
    return result;
  } catch {
    input.signal.throwIfAborted();
    return failure('unavailable');
  }
}
