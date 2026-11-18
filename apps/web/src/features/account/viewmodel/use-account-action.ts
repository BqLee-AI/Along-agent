'use client';

import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { z } from 'zod';
import { submitAccountAction } from '../model/account-actions';
import type { ActionState, AccountActionPath } from '../model/account-actions';

export type AccountActionField = {
  name: string;
  label: string;
  type?: 'email' | 'password' | 'text' | 'checkbox';
  autoComplete?: string;
};

export type AccountActionConfig = {
  path: AccountActionPath;
  fields: AccountActionField[];
  inputSchema: z.ZodType;
  resultSchema: z.ZodType;
  csrfToken: string | null;
  values: Record<string, unknown>;
};

/** Owns one explicit account write: validation, a stable idempotency key, and no automatic replay. */
export function useAccountAction({
  path,
  fields,
  inputSchema,
  resultSchema,
  csrfToken,
  values,
}: AccountActionConfig) {
  const [state, setState] = useState<ActionState>({ kind: 'idle' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [idempotencyKey, setIdempotencyKey] = useState<string | null>(null);
  const submitting = useRef(false);
  const blocked =
    state.kind === 'submitting' ||
    state.kind === 'success' ||
    (state.kind === 'failure' && state.uncertain);

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
    if (outcome.kind === 'success') form.reset();
  }

  return { state, errors, blocked, submit };
}
