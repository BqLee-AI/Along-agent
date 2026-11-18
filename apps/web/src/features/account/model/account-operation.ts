import {
  EnvelopeSchema,
  authAuthenticatedSchema,
  authClaimSchema,
  authInitializeSchema,
  authSignInSchema,
  authSignedOutSchema,
  authSignOutSchema,
} from '@along/contracts';
import { MeSchema } from '@/shared/session/identity';
import { createBrowserApi, writeOptions } from '@/shared/http/eden';

export type AccountOperation = 'initialize' | 'claim' | 'sign-in' | 'sign-out';
export type AccountFailure = {
  message: string;
  status: number | null;
  code: string | null;
  requestId: string | null;
};
export type AccountOutcome =
  | { kind: 'authenticated'; workspacePending: boolean }
  | { kind: 'signed-out' }
  | { kind: 'rejected'; failure: AccountFailure; rereadRequired: boolean }
  | { kind: 'unconfirmed'; failure: AccountFailure }
  | { kind: 'accepted-unverified'; failure: AccountFailure; workspacePending: boolean };

export function validateAccountFields(operation: AccountOperation, fields: FormData) {
  const login_name = String(fields.get('login_name') ?? '');
  const password = String(fields.get('password') ?? '');
  const body =
    operation === 'initialize'
      ? { login_name, password, display_name: String(fields.get('display_name') ?? '') }
      : operation === 'claim'
        ? { login_name, password, confirmed: fields.get('confirmed') === 'on' }
        : operation === 'sign-out'
          ? {}
          : fields.get('login_method') === 'email'
            ? { email: String(fields.get('email') ?? ''), password }
            : { login_name, password };
  const schema =
    operation === 'initialize'
      ? authInitializeSchema
      : operation === 'claim'
        ? authClaimSchema
        : operation === 'sign-out'
          ? authSignOutSchema
          : authSignInSchema;
  const parsed = schema.safeParse(body);
  const fieldErrors: Record<string, string> = {};
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const name = String(issue.path[0] ?? 'form');
      fieldErrors[name] ??=
        name === 'password'
          ? password.length === 0
            ? '请输入密码。'
            : password.length < 8
              ? '密码至少需要 8 位。'
              : '密码过长，请检查输入。'
          : name === 'confirmed'
            ? '请确认只为当前原账户设置正式登录。'
            : name === 'email' || (name === 'form' && fields.get('login_method') === 'email')
              ? '请输入有效的联系邮箱。'
              : name === 'display_name'
                ? '请填写 1–128 个字符的展示名。'
                : login_name.trim().length === 0
                  ? '请输入用户名。'
                  : '用户名过长，请检查输入。';
    }
  }
  if (
    (operation === 'initialize' || operation === 'claim') &&
    password !== fields.get('password_confirmation')
  ) {
    fieldErrors.password_confirmation = '两次输入的密码不一致。';
  }
  if (!parsed.success || Object.keys(fieldErrors).length) {
    return { ok: false as const, fieldErrors };
  }
  return { ok: true as const, body: parsed.data };
}

function rejectionMessage(operation: AccountOperation, status: number, reason: unknown): string {
  if (status === 401) {
    return operation === 'sign-in'
      ? '登录名或密码不正确，或此账户当前无法登录。请检查后重试。'
      : '当前签名会话已无效，本次操作未确认成功。请读取账户状态后正式登录。';
  }
  if (status === 403) {
    return reason === 'CSRF_MISMATCH'
      ? '当前请求的安全校验未通过（CSRF）。请重新读取账户状态；不会自动重试。'
      : reason === 'ORIGIN_MISMATCH'
        ? '当前访问来源未获允许。请使用原安装的正式访问地址，联系部署者检查来源配置。'
        : '当前请求无权执行。请重新读取账户状态或联系部署者，不要通过重新建号绕过限制。';
  }
  if (status === 409) {
    return '账户状态已变化或需要本机维护。请重新读取状态，不要重复建号、转正或覆盖已有口令。';
  }
  if (status === 404) return '此认证接口暂不可用。请部署者检查同一安装的服务版本。';
  if (status === 400 || status === 413) return '提交内容未被接受。请检查字段及长度后再次提交。';
  return '认证服务未返回可确认结果。请先读取账户状态，不要将本次操作当作成功或重复提交。';
}

/** A single explicit account operation, followed only by a canonical identity GET. */
export async function submitAccountOperation(
  operation: AccountOperation,
  body: object,
  csrfToken: string | null,
  request: (url: string, init: RequestInit) => Promise<Response> = fetch,
): Promise<AccountOutcome> {
  const api = createBrowserApi((input, init) => request(String(input), init ?? {})).api.v1;
  let result;
  try {
    const options = writeOptions(csrfToken);
    result =
      operation === 'initialize'
        ? await api.auth.initialize.post(authInitializeSchema.parse(body), options)
        : operation === 'claim'
          ? await api.auth.claim.post(authClaimSchema.parse(body), options)
          : operation === 'sign-in'
            ? await api.auth['sign-in'].post(authSignInSchema.parse(body), options)
            : await api.auth['sign-out'].post(authSignOutSchema.parse(body), options);
  } catch {
    return {
      kind: 'unconfirmed',
      failure: {
        message:
          '连接中断，操作结果尚未确认。请先读取账户状态；不会自动重发，也未将关闭页面视为退出。',
        status: null,
        code: null,
        requestId: null,
      },
    };
  }
  const { response } = result;
  const envelope = EnvelopeSchema.safeParse(result.error ? result.error.value : result.data);
  const failure: AccountFailure = {
    message: rejectionMessage(
      operation,
      response.status,
      envelope.success &&
        envelope.data.error?.details &&
        typeof envelope.data.error.details === 'object' &&
        'reason' in envelope.data.error.details
        ? envelope.data.error.details.reason
        : null,
    ),
    status: response.status,
    code: envelope.success ? (envelope.data.error?.code ?? null) : null,
    requestId: envelope.success ? envelope.data.request_id : response.headers.get('x-request-id'),
  };
  if (!response.ok) {
    if (response.status >= 500) return { kind: 'unconfirmed', failure };
    return {
      kind: 'rejected',
      failure,
      rereadRequired:
        ![400, 413].includes(response.status) &&
        !(response.status === 401 && operation === 'sign-in'),
    };
  }
  if (!envelope.success || envelope.data.code !== 0) {
    return {
      kind: 'unconfirmed',
      failure: {
        ...failure,
        message: '认证响应无法核验，操作结果未知。请先读取账户状态，不要重复提交。',
      },
    };
  }
  if (operation === 'sign-out') {
    return authSignedOutSchema.safeParse(envelope.data.data).success
      ? { kind: 'signed-out' }
      : {
          kind: 'unconfirmed',
          failure: {
            ...failure,
            message: '未收到可核验的撤销回执，不能确认本次退出成功。请读取账户状态。',
          },
        };
  }
  const authenticated = authAuthenticatedSchema.safeParse(envelope.data.data);
  if (!authenticated.success) {
    return {
      kind: 'unconfirmed',
      failure: {
        ...failure,
        message: '账户操作响应无法核验。请读取账户状态，不要重复建号或转正。',
      },
    };
  }
  const workspacePending = authenticated.data.workspace_binding === 'pending_local_configuration';
  let meResponse: Response | null = null;
  try {
    const meResult = await api.me.get();
    meResponse = meResult.response;
    const meEnvelope = EnvelopeSchema.safeParse(
      meResult.error ? meResult.error.value : meResult.data,
    );
    if (
      meResponse.ok &&
      meEnvelope.success &&
      meEnvelope.data.code === 0 &&
      MeSchema.safeParse(meEnvelope.data.data).success
    ) {
      return { kind: 'authenticated', workspacePending };
    }
    return {
      kind: 'accepted-unverified',
      workspacePending,
      failure: {
        message:
          '账户操作已获成功回执，但当前会话未能核验。请读取账户状态或正式登录，不要再次建号或转正。',
        status: meResponse.status,
        code: meEnvelope.success ? (meEnvelope.data.error?.code ?? null) : null,
        requestId: meEnvelope.success
          ? meEnvelope.data.request_id
          : meResponse.headers.get('x-request-id'),
      },
    };
  } catch {
    return {
      kind: 'accepted-unverified',
      workspacePending,
      failure: {
        message: '账户操作已获成功回执，但当前会话读取中断。请读取账户状态，不要再次建号或转正。',
        status: meResponse?.status ?? null,
        code: null,
        requestId: null,
      },
    };
  }
}
