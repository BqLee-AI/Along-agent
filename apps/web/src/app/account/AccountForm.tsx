'use client';

import { useRef, useState, type FormEvent } from 'react';
import {
  EnvelopeSchema,
  authInitializeSchema,
  authClaimSchema,
  authSignInSchema,
  authSignOutSchema,
  authAuthenticatedSchema,
  authSignedOutSchema,
} from '@along/contracts';
import {
  safeReturnTo,
  loginHref,
  requireClientSession,
  clearAppRetryState,
} from '../../lib/account-navigation';
import { MeSchema } from '../../lib/types';

type Operation = 'initialize' | 'claim' | 'sign-in' | 'sign-out';

export default function AccountForm({
  operation,
  csrfToken = null,
  returnTo = '/',
}: {
  operation: Operation;
  csrfToken?: string | null;
  returnTo?: string;
}) {
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [pendingWorkspace, setPendingWorkspace] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const errorRef = useRef<HTMLDivElement>(null);
  const newPassword = operation === 'initialize' || operation === 'claim';
  const signingOut = operation === 'sign-out';
  const label =
    operation === 'initialize'
      ? '创建管理员账户'
      : operation === 'claim'
        ? '确认转正当前账户'
        : signingOut
          ? '退出当前会话'
          : '登录';

  function showError(message: string) {
    setError(message);
    requestAnimationFrame(() => errorRef.current?.focus());
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current) return;
    const form = event.currentTarget;
    const fields = new FormData(form);
    const login_name = String(fields.get('login_name') ?? '');
    const password = String(fields.get('password') ?? '');
    const body =
      operation === 'initialize'
        ? { login_name, password, display_name: String(fields.get('display_name') ?? '') }
        : operation === 'claim'
          ? { login_name, password, confirmed: fields.get('confirmed') === 'on' }
          : signingOut
            ? {}
            : { login_name, password };
    const schema =
      operation === 'initialize'
        ? authInitializeSchema
        : operation === 'claim'
          ? authClaimSchema
          : signingOut
            ? authSignOutSchema
            : authSignInSchema;
    const parsed = schema.safeParse(body);
    const errors: Record<string, string> = {};
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const name = String(issue.path[0] ?? 'form');
        errors[name] ??=
          name === 'password'
            ? '密码须为 8–128 个字符，不会去除首尾空格。'
            : name === 'confirmed'
              ? '请明确确认只转正当前账户。'
              : '请填写此字段，长度为 1–128 个字符。';
      }
    }
    if (newPassword && password !== fields.get('password_confirmation')) {
      errors.password_confirmation = '两次输入的密码不一致。';
    }
    setFieldErrors(errors);
    setError(null);
    if (Object.keys(errors).length) {
      showError('请检查以下字段后再次提交。');
      return;
    }
    submitting.current = true;
    setBusy(true);
    try {
      const response = await fetch(`/api/v1/auth/${operation}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(csrfToken !== null ? { 'x-csrf-token': csrfToken } : {}),
        },
        body: JSON.stringify(parsed.data),
        cache: 'no-store',
      });
      if (operation === 'claim' || signingOut) requireClientSession(response);
      const payload = EnvelopeSchema.parse(await response.json());
      if (!response.ok || payload.code !== 0) {
        const message = payload.error?.message ?? `请求失败（${response.status}）`;
        showError(
          `${message} ${response.status === 401 ? '请检查登录名和密码。' : response.status === 409 ? '请重新读取账户状态；不要重复建号或覆盖已有口令，必要时联系部署者进行本机维护。' : response.status === 503 ? '服务暂时无法核验结果。请先读取账户状态；不要将本次操作当作成功。' : '请检查输入或来源后显式重试。'}`,
        );
        return;
      }
      if (signingOut) {
        authSignedOutSchema.parse(payload.data);
        clearAppRetryState();
        window.location.replace('/login');
        return;
      }
      const authenticated = authAuthenticatedSchema.parse(payload.data);
      // A successful form response is not a substitute for the canonical actor read.
      const meResponse = await fetch('/api/v1/me', { cache: 'no-store' });
      const meEnvelope = EnvelopeSchema.parse(await meResponse.json());
      if (!meResponse.ok || meEnvelope.code !== 0) {
        showError(
          `账户操作已返回成功，但当前会话暂时无法核验：${meEnvelope.error?.message ?? meResponse.status}。请读取账户状态或正式登录，不要再次建号/转正。`,
        );
        return;
      }
      MeSchema.parse(meEnvelope.data);
      form.reset();
      if (authenticated.workspace_binding === 'pending_local_configuration') {
        setPendingWorkspace(true);
      } else {
        window.location.replace(safeReturnTo(returnTo));
      }
    } catch (failure) {
      showError(
        failure instanceof Error
          ? `${failure.message} 请先读取账户状态再决定下一步；尚未确认操作结果。`
          : '未收到可核验结果。请先读取账户状态，不要重复建号或转正。',
      );
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  if (pendingWorkspace)
    return (
      <div className="panel" role="status">
        <h2>账户已完成，工作区待本机配置</h2>
        <p>你已登录。账户提交与资料工作区配置是两个步骤；当前不表示资料或模型能力可用。</p>
        <p>
          请部署者在原安装运行正式 <code>local:account</code>{' '}
          检查并完成登记/重载；不要重新创建账户。
        </p>
        <p>
          <code>bun --no-env-file run local:account --config &lt;原私有配置&gt;</code>
        </p>
        <p>
          请使用已启动并升级到 0017 的同一安装。配置已保存但重载失败时，只补做本机维护，不重建账户。
        </p>
        <a href="/account">查看账户与工作区状态</a>
      </div>
    );

  return (
    <form
      className="panel account-form"
      onSubmit={(event) => void submit(event)}
      aria-busy={busy}
      noValidate
    >
      <div
        ref={errorRef}
        tabIndex={-1}
        role={error ? 'alert' : undefined}
        className="error"
        hidden={!error}
      >
        <p>{error}</p>
        {Object.entries(fieldErrors).length ? (
          <ul>
            {Object.entries(fieldErrors).map(([name, message]) => (
              <li key={name}>
                <a href={`#${name}`}>{message}</a>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      {!signingOut ? (
        <>
          {operation === 'initialize' ? (
            <div className="form-field">
              <label htmlFor="display_name">展示名（必填）</label>
              <input
                id="display_name"
                name="display_name"
                autoComplete="name"
                required
                maxLength={128}
                aria-invalid={Boolean(fieldErrors.display_name)}
                aria-describedby={fieldErrors.display_name ? 'display_name-error' : undefined}
                disabled={busy}
              />
              {fieldErrors.display_name ? (
                <p className="error" id="display_name-error">
                  {fieldErrors.display_name}
                </p>
              ) : null}
            </div>
          ) : null}
          <div className="form-field">
            <label htmlFor="login_name">登录名（必填）</label>
            <input
              id="login_name"
              name="login_name"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              required
              maxLength={128}
              aria-invalid={Boolean(fieldErrors.login_name)}
              aria-describedby="login_name-help login_name-error"
              disabled={busy}
            />
            <p id="login_name-help" className="muted">
              登录名不区分大小写，不是电子邮箱。
            </p>
            <p className="error" id="login_name-error">
              {fieldErrors.login_name}
            </p>
          </div>
          <div className="form-field">
            <label htmlFor="password">密码（必填）</label>
            <input
              id="password"
              name="password"
              type={showPassword ? 'text' : 'password'}
              autoComplete={newPassword ? 'new-password' : 'current-password'}
              required
              minLength={8}
              maxLength={128}
              aria-invalid={Boolean(fieldErrors.password)}
              aria-describedby="password-help password-error"
              disabled={busy}
            />
            <p id="password-help" className="muted">
              8–128 个字符，保留首尾空格。支持密码管理器和粘贴。
            </p>
            <p className="error" id="password-error">
              {fieldErrors.password}
            </p>
            <button
              type="button"
              className="secondary"
              aria-controls="password"
              aria-pressed={showPassword}
              onClick={() => setShowPassword(!showPassword)}
              disabled={busy}
            >
              {showPassword ? '隐藏密码' : '显示密码'}
            </button>
          </div>
          {newPassword ? (
            <div className="form-field">
              <label htmlFor="password_confirmation">再次输入密码（必填）</label>
              <input
                id="password_confirmation"
                name="password_confirmation"
                type={showPassword ? 'text' : 'password'}
                autoComplete="new-password"
                required
                maxLength={128}
                aria-invalid={Boolean(fieldErrors.password_confirmation)}
                aria-describedby="password_confirmation-error"
                disabled={busy}
              />
              <p className="error" id="password_confirmation-error">
                {fieldErrors.password_confirmation}
              </p>
            </div>
          ) : null}
          {operation === 'claim' ? (
            <div className="form-field">
              <label className="checkbox-label" htmlFor="confirmed">
                <input
                  id="confirmed"
                  name="confirmed"
                  type="checkbox"
                  required
                  aria-invalid={Boolean(fieldErrors.confirmed)}
                  aria-describedby="confirmed-error"
                  disabled={busy}
                />
                我确认只为当前已登录的原账户设置正式登录，保留原身份和历史，不合并其他用户。
              </label>
              <p className="error" id="confirmed-error">
                {fieldErrors.confirmed}
              </p>
            </div>
          ) : null}
        </>
      ) : (
        <p>退出仅撤销当前会话。只有服务端确认撤销成功后才会离开此页；失败不表示已退出。</p>
      )}
      <div className="actions">
        <button type="submit" disabled={busy}>
          {busy ? '正在提交…' : label}
        </button>
        <a href="/account">读取账户状态</a>
        {newPassword ? <a href={loginHref(returnTo)}>正式登录</a> : null}
      </div>
      <p className="muted">
        {signingOut
          ? '若退出失败，请保留此页并联系部署者排查；不要把关闭标签页当作退出成功。'
          : '会话固定七天到期，读取页面不会续期。重登后只读取原页面，不会补发任何业务操作。'}
      </p>
    </form>
  );
}
