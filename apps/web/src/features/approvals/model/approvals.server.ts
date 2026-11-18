import 'server-only';

import { ApprovalDetailSchema, DocumentApprovalDetailSchema } from '@along/contracts';
import { apiGet } from '@/shared/http/server';
import { pageReturnTo } from '@/shared/session/navigation';
import type { PageQuery } from '@/shared/session/navigation';
import { MeSchema } from '@/shared/session/identity';
import { ApprovalPageSchema, approvalFilter } from './approval';

export async function readApprovals(query: PageQuery) {
  const status = approvalFilter(query.status);
  const result = await apiGet(
    (api) => api.api.v1.approvals.get({ query: { status, limit: '50' } }),
    pageReturnTo('/approvals', query),
  );
  const parsed = result.ok ? ApprovalPageSchema.safeParse(result.data) : null;
  return {
    status,
    initial: parsed?.success ? parsed.data : null,
    initialError: !result.ok
      ? result.message
      : parsed && !parsed.success
        ? '提醒确认响应无法核验，未将错误当作空列表。'
        : null,
  };
}

export async function readReminderApproval(id: string, query: PageQuery) {
  const returnTo = pageReturnTo(`/approvals/${encodeURIComponent(id)}`, query);
  const [result, identity] = await Promise.all([
    apiGet((api) => api.api.v1.approvals({ id: encodeURIComponent(id) }).get(), returnTo),
    apiGet((api) => api.api.v1.me.get(), returnTo),
  ]);
  const parsed = result.ok ? ApprovalDetailSchema.safeParse(result.data) : null;
  const me = identity.ok ? MeSchema.safeParse(identity.data) : null;
  const detail = parsed?.success && parsed.data.approval_id === id ? parsed.data : null;
  return {
    returnTo,
    detail,
    error: !result.ok
      ? result.message
      : !detail
        ? '冻结确认内容无法核验，未开放任何决议操作。'
        : null,
    me: me?.success ? me.data : null,
    identityError: !identity.ok ? identity.message : !me?.success ? '身份响应无法核验。' : null,
  };
}

export async function readDocumentApproval(id: string, query: PageQuery) {
  const returnTo = pageReturnTo(`/document-approvals/${encodeURIComponent(id)}`, query);
  const [result, identity] = await Promise.all([
    apiGet(
      (api) => api.api.v1['document-approvals']({ id: encodeURIComponent(id) }).get(),
      returnTo,
    ),
    apiGet((api) => api.api.v1.me.get(), returnTo),
  ]);
  const parsed = result.ok ? DocumentApprovalDetailSchema.safeParse(result.data) : null;
  const me = identity.ok ? MeSchema.safeParse(identity.data) : null;
  const detail = parsed?.success && parsed.data.approval_id === id ? parsed.data : null;
  return {
    returnTo,
    detail,
    error: !result.ok ? result.message : !detail ? '冻结文档正文无法核验，因此不能批准。' : null,
    me: me?.success ? me.data : null,
    identityError: !identity.ok ? identity.message : !me?.success ? '身份响应无法核验。' : null,
  };
}
