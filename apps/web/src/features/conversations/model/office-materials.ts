import { z } from 'zod';
import { ApiReadError, readEnvelope } from '@/shared/http/client';
import { writeOptions } from '@/shared/http/eden';
import { MeSchema } from '@/shared/session/identity';

export type OfficeRole = 'notes' | 'tasks';

/** Signed viewer identity; new admission also needs explicit server enablement. */
export type OfficeSession = { ownerId: string; csrfToken: string };

export function officeViewer(identity: unknown): OfficeSession | undefined {
  const actor = MeSchema.safeParse(identity);
  if (actor.success && actor.data.csrf_token)
    return { ownerId: actor.data.user.id, csrfToken: actor.data.csrf_token };
  return undefined;
}

const officeCapabilities = z.object({ admission_enabled: z.literal(true) });

export function officeAdmissionSession(viewer: OfficeSession | undefined, capabilities: unknown) {
  return viewer && officeCapabilities.safeParse(capabilities).success ? viewer : undefined;
}

export type OfficeMaterials = {
  draft_id: string;
  notes_attachment_id?: string;
  tasks_attachment_id?: string;
};

const attachmentReceipt = z.object({
  attachment_id: z.string().uuid(),
  filename: z.string().min(1),
  format: z.enum(['txt', 'markdown', 'csv']),
  byte_length: z.number().int().positive(),
  expires_at: z.string().datetime(),
  status: z.enum(['available', 'consumed', 'expired', 'revoked']),
});

export type OfficeAttachment = z.infer<typeof attachmentReceipt>;

export function officeFileFormat(role: OfficeRole, filename: string) {
  const extension = /\.([^.]+)$/.exec(filename.toLowerCase())?.[1];
  if (role === 'tasks') return extension === 'csv' ? 'csv' : null;
  return extension === 'txt'
    ? 'txt'
    : extension === 'md' || extension === 'markdown'
      ? 'markdown'
      : null;
}

export function officeDraftQuery(draftId: string, conversationId: string | null) {
  return new URLSearchParams({
    draft_id: draftId,
    ...(conversationId ? { conversation_id: conversationId } : {}),
  });
}

export async function stageOfficeAttachment({
  draftId,
  conversationId,
  csrfToken,
  role,
  file,
  key,
  signal,
}: {
  draftId: string;
  conversationId: string | null;
  csrfToken: string;
  role: OfficeRole;
  file: File;
  key: string;
  signal: AbortSignal;
}): Promise<OfficeAttachment> {
  const format = officeFileFormat(role, file.name);
  if (!format)
    throw new Error(role === 'notes' ? '请选择 TXT 或 Markdown 文件。' : '请选择 CSV 文件。');
  const options = writeOptions(csrfToken, signal, key);
  const response = await fetch(
    `/api/v1/conversations/attachments?${officeDraftQuery(draftId, conversationId)}`,
    {
      method: 'POST',
      headers: {
        ...options.headers,
        'content-type': 'application/octet-stream',
        'x-along-filename': encodeURIComponent(file.name),
      },
      body: file,
      ...options.fetch,
    },
  );
  // A response for a discarded draft must not trigger auth navigation either.
  signal.throwIfAborted();
  const receipt = attachmentReceipt.safeParse(await readEnvelope(response));
  if (
    !receipt.success ||
    receipt.data.format !== format ||
    receipt.data.filename !== file.name ||
    receipt.data.byte_length !== file.size
  )
    throw new Error('暂存回执与所选文件不匹配，无法确认上传。');
  if (receipt.data.status !== 'available')
    throw new Error('该暂存文件已不可用，请移除后重新选择。');
  return receipt.data;
}

export async function revokeOfficeAttachment({
  id,
  draftId,
  conversationId,
  csrfToken,
  signal,
}: {
  id: string;
  draftId?: string;
  conversationId: string | null;
  csrfToken: string;
  signal: AbortSignal;
}) {
  const options = writeOptions(csrfToken, signal);
  const query = draftId
    ? officeDraftQuery(draftId, conversationId)
    : new URLSearchParams(conversationId ? { conversation_id: conversationId } : {});
  const response = await fetch(
    `/api/v1/conversations/attachments/${id}/actions/revoke${query.size ? `?${query}` : ''}`,
    { method: 'POST', headers: options.headers, ...options.fetch },
  );
  signal.throwIfAborted();
  if (!z.object({ revoked: z.literal(true) }).safeParse(await readEnvelope(response)).success)
    throw new Error('撤销结果尚未确认，请重试。');
}

export function officeUploadError(error: unknown): string {
  if (error instanceof ApiReadError) {
    switch (error.code) {
      case 'PAYLOAD_TOO_LARGE':
        return '文件超过 1 MiB 上限。';
      case 'OFFICE_QUOTA_EXCEEDED':
        return '暂存空间已满，请撤销不再使用的资料或等待到期。';
      case 'IDEMPOTENCY_CONFLICT':
        return '原上传请求与暂存记录冲突，请移除后重新选择。';
      case 'OFFICE_MATERIALS_UNAVAILABLE':
        return '该暂存文件已不可用，请移除后重新选择。';
      case 'VALIDATION_ERROR':
        return '文件未通过验证。请核对文件名、格式和 UTF-8 编码，并确认内容不为空。';
    }
    if (error.status === 401 || error.status === 403)
      return '当前登录无法上传，请重新确认登录状态。';
    if (error.status === 413) return '文件超过 1 MiB 上限。';
    return '服务端未确认暂存。可重试原上传，或移除该文件。';
  }
  if (error instanceof Error && !(error instanceof TypeError)) return error.message;
  return '暂存结果尚未确认。可重试原上传，或移除该文件。';
}
