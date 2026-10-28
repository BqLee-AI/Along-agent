'use client';

import { useEffect, useRef, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { loginHref } from '../../lib/account-navigation';
import type { AccountOperation } from './account-operation';
import { AccountDiagnostics, AccountMaintenance } from './AccountSupport';
import { useAccountOperation } from './use-account-operation';

export default function AccountForm({
  operation,
  csrfToken = null,
  returnTo = '/',
}: {
  operation: AccountOperation;
  csrfToken?: string | null;
  returnTo?: string;
}) {
  const state = useAccountOperation({ operation, csrfToken, returnTo });
  const [showPassword, setShowPassword] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const errorRef = useRef<HTMLDivElement>(null);
  const successRef = useRef<HTMLDivElement>(null);
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
  const disabledReason = state.busy
    ? `${label}请求正在提交，请等待回执。`
    : state.blocked
      ? '未核验可用于此操作的签名会话，请重新读取账户状态。'
      : state.rereadRequired
        ? '请先读取账户状态，核对已接受或未知的操作结果；此页不会重复提交。'
        : operation === 'claim' && !confirmed
          ? '请先确认原账户身份保留说明，再提交转正。'
          : null;

  useEffect(() => {
    if (state.failure) errorRef.current?.focus();
  }, [state.failure]);
  useEffect(() => {
    if (state.workspacePending) successRef.current?.focus();
  }, [state.workspacePending]);

  if (state.workspacePending) {
    return (
      <div className="space-y-6" ref={successRef} tabIndex={-1}>
        <Alert role="status">
          <AlertTitle>账户设置已接受，当前会话已核验</AlertTitle>
          <AlertDescription>
            原身份和历史继续保留。接下来由部署者完成本机资料登记，而不是再次提交账户表单。
          </AlertDescription>
        </Alert>
        <AccountMaintenance pending />
        <Button asChild className="w-full">
          <a href="/account">查看账户与工作区状态</a>
        </Button>
      </div>
    );
  }

  return (
    <form
      className="space-y-6 rounded-xl border border-border bg-card p-4 sm:p-6"
      onSubmit={state.submit}
      aria-busy={state.busy}
      noValidate
    >
      {state.failure ? (
        <div
          ref={errorRef}
          tabIndex={-1}
          role="alert"
          className="space-y-3 rounded-lg border border-destructive bg-destructive/5 p-4 text-base leading-7 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          <h2 className="font-semibold text-destructive">
            {state.rereadRequired ? '请先核对账户状态' : '本次提交未完成'}
          </h2>
          <p>{state.failure.message}</p>
          {Object.keys(state.fieldErrors).length ? (
            <ul className="space-y-1">
              {Object.entries(state.fieldErrors).map(([name, message]) => (
                <li key={name}>
                  <a
                    className="inline-flex min-h-11 items-center text-primary underline underline-offset-4"
                    href={`#${name}`}
                  >
                    {message}
                  </a>
                </li>
              ))}
            </ul>
          ) : null}
          <AccountDiagnostics failure={state.failure} />
          {state.rereadRequired ? (
            <div className="flex flex-col gap-3">
              <Button asChild variant="outline">
                <a href="/account">只读核对账户状态</a>
              </Button>
              {state.failure.status === 401 ? (
                <Button asChild variant="ghost">
                  <a href={loginHref('/account')}>前往正式登录</a>
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
      {!signingOut ? (
        <>
          {operation === 'initialize' ? (
            <div className="space-y-2">
              <Label htmlFor="display_name">展示名（必填）</Label>
              <Input
                id="display_name"
                name="display_name"
                autoComplete="name"
                required
                maxLength={128}
                readOnly={state.busy || state.rereadRequired}
                aria-invalid={Boolean(state.fieldErrors.display_name)}
                aria-describedby="display_name-help display_name-error"
              />
              <p id="display_name-help" className="text-sm leading-6 text-muted-foreground">
                用于账户和导航显示，不会改变已有身份归属。
              </p>
              <p id="display_name-error" className="text-sm leading-6 text-destructive">
                {state.fieldErrors.display_name}
              </p>
            </div>
          ) : null}
          <div className="space-y-2">
            <Label htmlFor="login_name">登录名（必填）</Label>
            <Input
              id="login_name"
              name="login_name"
              autoComplete="username"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              required
              maxLength={128}
              readOnly={state.busy || state.rereadRequired}
              aria-invalid={Boolean(state.fieldErrors.login_name)}
              aria-describedby="login_name-help login_name-error"
            />
            <p id="login_name-help" className="text-sm leading-6 text-muted-foreground">
              此安装的管理员登录名，不是邮箱；不区分大小写。
            </p>
            <p id="login_name-error" className="text-sm leading-6 text-destructive">
              {state.fieldErrors.login_name}
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">{newPassword ? '设置密码（必填）' : '密码（必填）'}</Label>
            <Input
              id="password"
              name="password"
              type={showPassword ? 'text' : 'password'}
              autoComplete={newPassword ? 'new-password' : 'current-password'}
              required
              minLength={8}
              maxLength={128}
              readOnly={state.busy || state.rereadRequired}
              aria-invalid={Boolean(state.fieldErrors.password)}
              aria-describedby="password-help password-error"
            />
            <p id="password-help" className="text-sm leading-6 text-muted-foreground">
              8–128 个字符，保留首尾空格。支持密码管理器与粘贴。
            </p>
            <p id="password-error" className="text-sm leading-6 text-destructive">
              {state.fieldErrors.password}
            </p>
            <Button
              type="button"
              variant="ghost"
              aria-controls={newPassword ? 'password password_confirmation' : 'password'}
              aria-pressed={showPassword}
              onClick={() => setShowPassword((visible) => !visible)}
            >
              {showPassword ? '隐藏密码' : '显示密码'}
            </Button>
          </div>
          {newPassword ? (
            <div className="space-y-2">
              <Label htmlFor="password_confirmation">再次输入密码（必填）</Label>
              <Input
                id="password_confirmation"
                name="password_confirmation"
                type={showPassword ? 'text' : 'password'}
                autoComplete="new-password"
                required
                minLength={8}
                maxLength={128}
                readOnly={state.busy || state.rereadRequired}
                aria-invalid={Boolean(state.fieldErrors.password_confirmation)}
                aria-describedby="password_confirmation-error"
              />
              <p id="password_confirmation-error" className="text-sm leading-6 text-destructive">
                {state.fieldErrors.password_confirmation}
              </p>
            </div>
          ) : null}
          {operation === 'claim' ? (
            <div className="space-y-2">
              <label
                htmlFor="confirmed"
                className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border border-border p-3 text-base leading-7"
              >
                <input
                  id="confirmed"
                  name="confirmed"
                  type="checkbox"
                  checked={confirmed}
                  onChange={(event) => setConfirmed(event.target.checked)}
                  required
                  disabled={state.busy || state.rereadRequired}
                  aria-invalid={Boolean(state.fieldErrors.confirmed)}
                  aria-describedby="confirmed-error"
                  className="mt-1.5 size-5 shrink-0 accent-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                />
                <span>
                  我确认只为当前已登录的原账户设置正式登录，保留原身份和历史，不认领或合并其他用户。
                </span>
              </label>
              <p id="confirmed-error" className="text-sm leading-6 text-destructive">
                {state.fieldErrors.confirmed}
              </p>
            </div>
          ) : null}
        </>
      ) : (
        <p className="text-base leading-7">
          只撤销当前签名会话，不删除账户、原历史或其他会话。只有收到服务端可核验的撤销回执后才离开此页。
        </p>
      )}
      <div className="space-y-3">
        <Button
          type="submit"
          className="w-full"
          variant={signingOut ? 'destructive' : 'default'}
          disabled={Boolean(disabledReason)}
          aria-describedby="account-submit-help"
        >
          {state.busy ? (
            <LoaderCircle
              className="size-4 animate-spin motion-reduce:animate-none"
              aria-hidden="true"
            />
          ) : null}
          {state.busy ? `正在${label}…` : label}
        </Button>
        <p
          id="account-submit-help"
          className="text-sm leading-6 text-muted-foreground"
          role="status"
        >
          {disabledReason ??
            (signingOut
              ? '打开本页不会退出；退出失败或丢失响应不表示已撤销。'
              : '会话固定七天到期，读取不会续期。成功登录后只读取返回页面，不自动重放业务操作。')}
        </p>
        <Button asChild variant="ghost" className="w-full">
          <a href="/account">返回账户</a>
        </Button>
      </div>
    </form>
  );
}
