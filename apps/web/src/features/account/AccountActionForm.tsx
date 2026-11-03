'use client';

import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { z } from 'zod';
import { Button } from '@lorelum/lumen-ui/components/button';
import { Input } from '@lorelum/lumen-ui/components/input';
import { Label } from '@lorelum/lumen-ui/components/label';
import { submitAccountAction, type ActionState } from './account-actions';

export type AccountActionField = {
  name: string;
  label: string;
  type?: 'email' | 'password' | 'text' | 'checkbox';
  autoComplete?: string;
};
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
  const [state, setState] = useState<ActionState>({ kind: 'idle' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [showPasswords, setShowPasswords] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState<string | null>(null);
  const submitting = useRef(false);
  const feedback = useRef<HTMLDivElement>(null);
  const id = useId();
  const blocked =
    state.kind === 'submitting' ||
    state.kind === 'success' ||
    (state.kind === 'failure' && state.uncertain);
  useEffect(() => {
    if (state.kind === 'failure' || state.kind === 'success') feedback.current?.focus();
  }, [state]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current || blocked) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const body: Record<string, unknown> = { ...values };
    for (const field of fields)
      body[field.name] =
        field.type === 'checkbox'
          ? data.get(field.name) === 'on'
          : String(data.get(field.name) ?? '');
    // UUID is stable for this explicit intent; unknown outcomes block further submission.
    if ('idempotency_key' in values) {
      const key = idempotencyKey ?? crypto.randomUUID();
      setIdempotencyKey(key);
      body.idempotency_key = key;
    }
    const parsed = inputSchema.safeParse(body);
    const issues: Record<string, string> = {};
    if (!parsed.success)
      for (const issue of parsed.error.issues)
        issues[String(issue.path[0] ?? 'form')] = '请检查此字段的格式与长度。';
    const newPasswordName = fields.some((field) => field.name === 'new_password')
      ? 'new_password'
      : fields.some((field) => field.autoComplete === 'new-password')
        ? 'password'
        : null;
    if (newPasswordName && data.get(newPasswordName) !== data.get('password_confirmation'))
      issues.password_confirmation = '两次密码不一致。';
    setErrors(issues);
    if (!parsed.success || Object.keys(issues).length) {
      setState({
        kind: 'failure',
        status: 400,
        message: '请检查标出的字段。',
        uncertain: false,
        currentPassword: false,
      });
      return;
    }
    submitting.current = true;
    setState({ kind: 'submitting' });
    const outcome = await submitAccountAction(path, parsed.data, csrfToken, resultSchema);
    submitting.current = false;
    if (outcome.kind === 'failure' && outcome.currentPassword)
      setErrors({ current_password: outcome.message });
    setState(outcome);
    if (outcome.kind === 'success') {
      form.reset();
    }
  }
  return (
    <form
      method="post"
      onSubmit={submit}
      noValidate
      aria-busy={state.kind === 'submitting'}
      className="space-y-4"
    >
      <h3 className="text-base font-semibold">{title}</h3>
      {state.kind === 'failure' || state.kind === 'success' ? (
        <div
          ref={feedback}
          tabIndex={-1}
          role={state.kind === 'failure' ? 'alert' : 'status'}
          className="space-y-2 rounded-lg border border-border p-3 focus-visible:outline-2 focus-visible:outline-ring"
        >
          <p>{state.kind === 'success' ? success : state.message}</p>
          {state.kind === 'failure' &&
            Object.entries(errors).map(([name, message]) => (
              <a key={name} className="block underline" href={`#${id}-${name}`}>
                {message}
              </a>
            ))}
          <a className="inline-flex min-h-11 items-center text-primary underline" href="/account">
            只读核对账户状态
          </a>
          {state.kind === 'success' &&
          (/(?:password\/(?:reset|change)|deletion-request|invitations\/accept)/.test(path) ||
            (typeof state.data === 'object' &&
              state.data !== null &&
              'signed_out' in state.data &&
              state.data.signed_out === true)) ? (
            <a
              className="ml-4 inline-flex min-h-11 items-center text-primary underline"
              href="/login?returnTo=%2Faccount"
            >
              前往正式登录
            </a>
          ) : null}
        </div>
      ) : null}
      <fieldset disabled={blocked} className="space-y-4">
        {fields.map((field) => (
          <div key={field.name} className="space-y-2">
            <Label htmlFor={`${id}-${field.name}`}>{field.label}</Label>
            <Input
              id={`${id}-${field.name}`}
              name={field.name}
              type={field.type === 'password' && showPasswords ? 'text' : (field.type ?? 'text')}
              autoComplete={field.autoComplete}
              required
              autoCapitalize="none"
              spellCheck={false}
              maxLength={field.type === 'email' ? 254 : field.type === 'checkbox' ? undefined : 128}
              aria-invalid={Boolean(errors[field.name])}
              aria-describedby={errors[field.name] ? `${id}-${field.name}-error` : undefined}
            />
            {errors[field.name] ? (
              <p id={`${id}-${field.name}-error`} className="text-sm text-destructive">
                {errors[field.name]}
              </p>
            ) : null}
          </div>
        ))}
        {fields.some(
          (field) => field.name === 'new_password' || field.autoComplete === 'new-password',
        ) ? (
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
            />
            <p id={`${id}-password_confirmation-error`} className="text-sm text-destructive">
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
