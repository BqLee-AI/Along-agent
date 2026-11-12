'use client';

import { useEffect, useId, useRef, useState } from 'react';
import type { z } from 'zod';
import { Alert } from '@lorelum/lumen-ui/components/alert';
import { Button } from '@lorelum/lumen-ui/components/button';
import { Checkbox } from '@lorelum/lumen-ui/components/checkbox';
import { Input } from '@lorelum/lumen-ui/components/input';
import { Label } from '@lorelum/lumen-ui/components/label';
import WorkspaceLink from '@/shell/view/workspace-link';
import { useAccountAction } from '../viewmodel/use-account-action';
import type { AccountActionField } from '../viewmodel/use-account-action';

export type AccountActionFormProps = {
  path: string;
  title: string;
  fields: AccountActionField[];
  inputSchema: z.ZodType;
  resultSchema: z.ZodType;
  csrfToken?: string | null;
  values?: Record<string, unknown>;
  success: string;
};

const SIGN_IN_AFTER = /(?:password\/(?:reset|change)|deletion-request|invitations\/accept)/;

export default function AccountActionForm({
  path,
  title,
  fields,
  inputSchema,
  resultSchema,
  csrfToken = null,
  values = {},
  success,
}: AccountActionFormProps) {
  const { state, errors, blocked, submit } = useAccountAction({
    path,
    fields,
    inputSchema,
    resultSchema,
    csrfToken,
    values,
  });
  const [showPasswords, setShowPasswords] = useState(false);
  const feedback = useRef<HTMLDivElement>(null);
  const id = useId();
  useEffect(() => {
    if (state.kind === 'failure' || state.kind === 'success') feedback.current?.focus();
  }, [state]);
  const needsConfirmation = fields.some(
    (field) => field.name === 'new_password' || field.autoComplete === 'new-password',
  );
  const signInNext =
    state.kind === 'success' &&
    (SIGN_IN_AFTER.test(path) ||
      (typeof state.data === 'object' &&
        state.data !== null &&
        'signed_out' in state.data &&
        state.data.signed_out === true));
  return (
    <form
      method="post"
      onSubmit={submit}
      noValidate
      aria-busy={state.kind === 'submitting'}
      className="min-w-0 space-y-4"
    >
      <h3 className="text-sm font-medium">{title}</h3>
      {state.kind === 'failure' || state.kind === 'success' ? (
        <Alert
          ref={feedback}
          tabIndex={-1}
          color={state.kind === 'failure' ? 'danger' : undefined}
          role={state.kind === 'failure' ? 'alert' : 'status'}
          variant="glass"
          className="focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          <Alert.Content className="space-y-3">
            <Alert.Description className="space-y-3">
              <p>{state.kind === 'success' ? success : state.message}</p>
              {state.kind === 'failure' && Object.keys(errors).length ? (
                <ul className="space-y-1">
                  {Object.entries(errors).map(([name, message]) => (
                    <li key={name}>
                      <a
                        className="inline-flex min-h-8 max-lg:min-h-11 items-center text-primary underline underline-offset-4"
                        href={`#${id}-${name}`}
                      >
                        {message}
                      </a>
                    </li>
                  ))}
                </ul>
              ) : null}
              <div className="flex flex-wrap gap-3">
                <Button
                  variant="glass"
                  color="default"
                  role="link"
                  nativeButton={false}
                  render={<WorkspaceLink href="/account" />}
                >
                  只读核对账户状态
                </Button>
                {signInNext ? (
                  <Button
                    variant="clear"
                    color="default"
                    role="link"
                    nativeButton={false}
                    render={<WorkspaceLink href="/login?returnTo=%2Faccount" />}
                  >
                    前往正式登录
                  </Button>
                ) : null}
              </div>
            </Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}
      <fieldset disabled={blocked} className="min-w-0 space-y-4">
        {fields.map((field) => (
          <div key={field.name} className="space-y-2">
            {field.type === 'checkbox' ? (
              <Label
                htmlFor={`${id}-${field.name}`}
                className="flex min-h-8 max-lg:min-h-11 cursor-pointer items-start gap-3 p-3 text-sm leading-6"
              >
                <Checkbox
                  id={`${id}-${field.name}`}
                  name={field.name}
                  value="on"
                  required
                  aria-invalid={Boolean(errors[field.name])}
                  aria-describedby={errors[field.name] ? `${id}-${field.name}-error` : undefined}
                  className="mt-1.5 shrink-0"
                />
                <span>{field.label}</span>
              </Label>
            ) : (
              <>
                <Label htmlFor={`${id}-${field.name}`}>{field.label}</Label>
                <Input
                  id={`${id}-${field.name}`}
                  name={field.name}
                  type={
                    field.type === 'password' && showPasswords ? 'text' : (field.type ?? 'text')
                  }
                  autoComplete={field.autoComplete}
                  required
                  autoCapitalize="none"
                  spellCheck={false}
                  maxLength={field.type === 'email' ? 254 : 128}
                  aria-invalid={Boolean(errors[field.name])}
                  aria-describedby={errors[field.name] ? `${id}-${field.name}-error` : undefined}
                  variant="glass"
                />
              </>
            )}
            {errors[field.name] ? (
              <p
                id={`${id}-${field.name}-error`}
                className="text-sm leading-[22px] text-destructive"
              >
                {errors[field.name]}
              </p>
            ) : null}
          </div>
        ))}
        {needsConfirmation ? (
          <div className="space-y-2">
            <Label htmlFor={`${id}-password_confirmation`}>再次输入新密码</Label>
            <Input
              id={`${id}-password_confirmation`}
              name="password_confirmation"
              type={showPasswords ? 'text' : 'password'}
              autoComplete="new-password"
              required
              maxLength={128}
              aria-invalid={Boolean(errors.password_confirmation)}
              aria-describedby={`${id}-password_confirmation-error`}
              variant="glass"
            />
            <p
              id={`${id}-password_confirmation-error`}
              className="text-sm leading-[22px] text-destructive"
            >
              {errors.password_confirmation}
            </p>
          </div>
        ) : null}
        {fields.some((field) => field.type === 'password') ? (
          <Button
            type="button"
            variant="clear"
            color="default"
            aria-pressed={showPasswords}
            onClick={() => setShowPasswords(!showPasswords)}
          >
            {showPasswords ? '隐藏密码' : '显示密码'}
          </Button>
        ) : null}
        <Button type="submit">{state.kind === 'submitting' ? '正在提交…' : title}</Button>
      </fieldset>
    </form>
  );
}
