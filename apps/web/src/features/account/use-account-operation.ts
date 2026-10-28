'use client';

import { useRef, useState, type FormEvent } from 'react';
import { clearAppRetryState, safeReturnTo } from '../../lib/account-navigation';
import {
  submitAccountOperation,
  validateAccountFields,
  type AccountFailure,
  type AccountOperation,
} from './account-operation';

export function useAccountOperation({
  operation,
  csrfToken,
  returnTo,
}: {
  operation: AccountOperation;
  csrfToken: string | null;
  returnTo: string;
}) {
  const submitting = useRef(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<AccountFailure | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [rereadRequired, setRereadRequired] = useState(false);
  const [workspacePending, setWorkspacePending] = useState(false);
  const signedSessionRequired = operation === 'claim' || operation === 'sign-out';
  const blocked = signedSessionRequired && csrfToken === null;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current || blocked || rereadRequired || workspacePending) return;
    const form = event.currentTarget;
    const parsed = validateAccountFields(operation, new FormData(form));
    setFieldErrors(parsed.ok ? {} : parsed.fieldErrors);
    if (!parsed.ok) {
      setFailure({
        message: '请检查以下字段后再次提交。',
        status: null,
        code: null,
        requestId: null,
      });
      return;
    }
    submitting.current = true;
    setBusy(true);
    setFailure(null);
    try {
      const outcome = await submitAccountOperation(operation, parsed.body, csrfToken);
      if (outcome.kind === 'signed-out') {
        setRereadRequired(true);
        clearAppRetryState();
        window.location.replace('/login');
        return;
      }
      if (outcome.kind === 'authenticated') {
        setRereadRequired(true);
        clearAppRetryState();
        form.reset();
        if (outcome.workspacePending) {
          setWorkspacePending(true);
        } else {
          window.location.replace(operation === 'sign-in' ? safeReturnTo(returnTo) : '/account');
        }
        return;
      }
      setFailure(outcome.failure);
      setRereadRequired(outcome.kind !== 'rejected' || outcome.rereadRequired);
      if (
        outcome.kind === 'rejected' &&
        outcome.failure.status === 401 &&
        operation === 'sign-in'
      ) {
        setFieldErrors({ login_name: '请核对登录名。', password: '请核对密码。' });
      }
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  return { submit, busy, failure, fieldErrors, rereadRequired, workspacePending, blocked };
}
