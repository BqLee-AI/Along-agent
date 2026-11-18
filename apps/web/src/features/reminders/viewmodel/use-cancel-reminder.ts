'use client';

import { useEffect, useRef, useState } from 'react';
import { EnvelopeSchema } from '@along/contracts';
import { requireClientSession } from '@/shared/session/navigation';
import type { ApiResult } from '@/shared/http/result';
import { api, writeOptions } from '@/shared/http/eden';
import { MeSchema } from '@/shared/session/identity';
import type { Me } from '@/shared/session/identity';
import {
  cancelReceipt,
  cancellationAllowed,
  invalidResponse,
  readReminder,
  readTask,
} from '../model/data';
import type { ResourceFailure } from '../model/data';

export function useCancelReminder(taskId: string, initialState: string, initialMe: ApiResult<Me>) {
  const [identity, setIdentity] = useState(initialMe);
  const [state, setState] = useState(initialState);
  const [error, setError] = useState<ResourceFailure | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState<'cancel' | 'read' | null>(null);
  const key = useRef<string | null>(null);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  const canCancel =
    identity.ok &&
    Boolean(identity.data.csrf_token) &&
    cancellationAllowed(state) &&
    !uncertain &&
    !busy;
  async function recover(resource: 'identity' | 'state' = 'state') {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy('read');
    try {
      if (resource === 'identity') {
        const me = await readReminder(
          (api) => api.api.v1.me.get({ fetch: { signal: controller.signal } }),
          MeSchema,
          controller.signal,
        );
        if (!controller.signal.aborted) setIdentity(me);
      } else {
        const task = await readTask(taskId, controller.signal);
        if (!controller.signal.aborted) {
          if (task.ok) {
            setState(task.data.state);
            setUncertain(false);
            setError(null);
          } else setError(task);
        }
      }
    } catch (cause) {
      if (!controller.signal.aborted) throw cause;
    } finally {
      if (request.current === controller) request.current = null;
      if (!controller.signal.aborted) setBusy(null);
    }
  }
  async function cancel() {
    if (!canCancel || request.current || !identity.ok) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy('cancel');
    setError(null);
    key.current ??= crypto.randomUUID();
    try {
      const result = await api.api.v1
        .tasks({ id: encodeURIComponent(taskId) })
        .actions.cancel.post(
          { idempotency_key: key.current },
          writeOptions(identity.data.csrf_token, controller.signal),
        );
      const { response } = result;
      requireClientSession(response);
      const envelope = EnvelopeSchema.safeParse(result.error ? result.error.value : result.data);
      if (controller.signal.aborted) return;
      if (response.ok && envelope.success && envelope.data.code === 0) {
        const receipt = cancelReceipt(envelope.data.data, taskId);
        if (receipt) {
          setState(receipt.state);
          setAccepted(true);
          setUncertain(false);
        } else {
          setError(invalidResponse);
          setUncertain(true);
        }
      } else {
        setError({
          ok: false,
          status: response.status,
          code: envelope.success ? (envelope.data.error?.code ?? null) : null,
          requestId: envelope.success
            ? envelope.data.request_id
            : response.headers.get('x-request-id'),
          message: '取消请求未确认。',
        });
        setUncertain(true);
        if (response.status === 401 || response.status === 403) {
          key.current = null;
          setIdentity({
            ok: false,
            status: response.status,
            code: null,
            requestId: null,
            message: '需要重新核验身份。',
          });
        }
      }
    } catch {
      if (!controller.signal.aborted) {
        setUncertain(true);
        setError({ ok: false, status: 0, code: null, requestId: null, message: '取消结果未知。' });
      }
    } finally {
      if (request.current === controller) request.current = null;
      if (!controller.signal.aborted) setBusy(null);
    }
  }
  return { identity, state, error, uncertain, accepted, busy, canCancel, recover, cancel };
}
