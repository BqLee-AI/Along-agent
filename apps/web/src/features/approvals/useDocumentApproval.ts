'use client';

import { useEffect, useReducer, useRef, useState } from 'react';
import {
  DocumentApprovalActionResultSchema,
  DocumentApprovalDetailSchema,
  type DocumentApprovalDetail,
} from '@along/contracts';
import { ApiReadError, readEnvelope, readRun } from '@/lib/conversation-run';
import { documentConfirmBody, documentEffectReadReducer } from '@/lib/document-loop';
import type { Me } from '@/lib/types';
import type { RunView } from '@along/contracts';

type Decision = 'confirm' | 'reject';
export function useDocumentApproval(initial: DocumentApprovalDetail, me: Me | null) {
  const [decision, setDecision] = useState(initial.state);
  const [busy, setBusy] = useState<Decision | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [blocked, setBlocked] = useState(false);
  const [uncertain, setUncertain] = useState<Decision | null>(null);
  const [decisionReading, setDecisionReading] = useState(false);
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const [decisionChecked, setDecisionChecked] = useState(false);
  const [effect, dispatchEffect] = useReducer(documentEffectReadReducer, {
    value: initial.effect,
    reading: false,
    error: null,
    current: true,
  });
  const [run, setRun] = useState<RunView | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [runReading, setRunReading] = useState(false);
  const keys = useRef<Partial<Record<Decision, string>>>({});
  const controllers = useRef<
    Partial<Record<'decision' | 'effect' | 'run' | 'post', AbortController>>
  >({});
  useEffect(
    () => () => {
      for (const controller of Object.values(controllers.current)) controller?.abort();
    },
    [],
  );

  async function refresh(resource: 'decision' | 'effect' | 'run') {
    if (controllers.current[resource] || (resource === 'decision' && controllers.current.post))
      return;
    const controller = new AbortController();
    controllers.current[resource] = controller;
    if (resource === 'decision') setDecisionReading(true);
    else if (resource === 'effect') dispatchEffect({ type: 'start' });
    else setRunReading(true);
    try {
      if (resource === 'run') {
        const next = await readRun(initial.conversation_id, initial.run_id, controller.signal);
        if (next.run_id !== initial.run_id || next.conversation_id !== initial.conversation_id)
          throw new Error('原运行响应关联不一致。');
        if (!controller.signal.aborted) {
          setRun(next);
          setRunError(null);
        }
      } else {
        const response = await fetch(
          `/api/v1/document-approvals/${encodeURIComponent(initial.approval_id)}`,
          { cache: 'no-store', signal: controller.signal },
        );
        const next = DocumentApprovalDetailSchema.parse(await readEnvelope(response));
        if (
          next.approval_id !== initial.approval_id ||
          next.conversation_id !== initial.conversation_id ||
          next.run_id !== initial.run_id ||
          next.presentation_hash !== initial.presentation_hash ||
          next.preview.body !== initial.preview.body ||
          next.base_version !== initial.base_version ||
          next.new_version !== initial.new_version ||
          next.exact_new_content !== initial.exact_new_content ||
          next.preview.before !== initial.preview.before ||
          next.preview.after !== initial.preview.after ||
          next.workspace_id !== initial.workspace_id ||
          next.relative_path !== initial.relative_path
        ) {
          if (!controller.signal.aborted) setBlocked(true);
          throw new Error('读取的冻结版本与原批准不一致，原全文仍保留，不能提交决议。');
        }
        if (controller.signal.aborted) return;
        if (resource === 'effect') dispatchEffect({ type: 'success', value: next.effect });
        else {
          if (next.state !== decision) dispatchEffect({ type: 'invalidate' });
          setDecision(next.state);
          setDecisionError(null);
          setDecisionChecked(true);
          if (next.state !== 'pending') setUncertain(null);
        }
      }
    } catch (failure) {
      if (controller.signal.aborted) return;
      const message = failure instanceof Error ? failure.message : '此资源暂不可读取。';
      if (resource === 'effect') dispatchEffect({ type: 'failure', message });
      else if (resource === 'decision') setDecisionError(message);
      else setRunError(message);
    } finally {
      if (!controller.signal.aborted) {
        if (resource === 'decision') setDecisionReading(false);
        if (resource === 'run') setRunReading(false);
      }
      if (controllers.current[resource] === controller) delete controllers.current[resource];
    }
  }

  async function decide(action: Decision, retry = false) {
    if (
      controllers.current.post ||
      controllers.current.decision ||
      decision !== 'pending' ||
      !me ||
      blocked
    )
      return;
    if (uncertain && (!retry || uncertain !== action || !decisionChecked)) return;
    const controller = new AbortController();
    controllers.current.post = controller;
    setBusy(action);
    setError(null);
    try {
      const key = (keys.current[action] ??= crypto.randomUUID());
      const body =
        action === 'confirm' ? documentConfirmBody(initial, key) : { idempotency_key: key };
      const response = await fetch(
        `/api/v1/document-approvals/${encodeURIComponent(initial.approval_id)}/actions/${action}`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(me.csrf_token ? { 'x-csrf-token': me.csrf_token } : {}),
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        },
      );
      const result = DocumentApprovalActionResultSchema.parse(await readEnvelope(response));
      if (
        result.approval_id !== initial.approval_id ||
        result.status !== (action === 'confirm' ? 'approved' : 'rejected')
      )
        throw new Error('决议响应目标或状态不一致，请读取原批准。');
      if (controller.signal.aborted) return;
      setDecision(result.status);
      setUncertain(null);
      setNotice(
        result.status === 'approved'
          ? '已授权此冻结版本。本次批准零文件写入，不等于整个运行成功。请回原标签页读取状态，再明确继续原运行。'
          : '已拒绝本次修改。保留原全文，原运行是否可继续请单独读取。',
      );
      controllers.current.effect?.abort();
      delete controllers.current.effect;
      dispatchEffect({ type: 'invalidate' });
      void refresh('effect');
    } catch (failure) {
      if (controller.signal.aborted) return;
      setError(failure instanceof Error ? failure.message : '决议响应未知，请先读取授权状态。');
      if (failure instanceof ApiReadError && failure.status < 500) {
        if (
          failure.status === 401 ||
          failure.status === 403 ||
          [
            'PRESENTATION_MISMATCH',
            'STATE_CONFLICT',
            'APPROVAL_EXPIRED',
            'APPROVAL_SUPERSEDED',
          ].includes(failure.code ?? '')
        )
          setBlocked(true);
      } else {
        setUncertain(action);
        setDecisionChecked(false);
      }
    } finally {
      if (!controller.signal.aborted) setBusy(null);
      if (controllers.current.post === controller) delete controllers.current.post;
    }
  }
  return {
    decision,
    busy,
    error,
    notice,
    blocked,
    uncertain,
    decisionReading,
    decisionError,
    decisionChecked,
    effect,
    run,
    runError,
    runReading,
    refresh,
    decide,
  };
}
