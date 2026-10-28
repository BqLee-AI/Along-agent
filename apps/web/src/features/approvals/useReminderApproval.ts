'use client';

import { useEffect, useRef, useState } from 'react';
import { ApprovalDetailSchema, type ApprovalDetail } from '@along/contracts';
import { AmbiguousTimeDetailsSchema } from '@along/stream-protocol';
import { z } from 'zod';
import type { Me } from '@/lib/types';
import { readEnvelope } from '@/lib/conversation-run';
import {
  ApprovalActionFailure,
  postReminderDecision,
  reminderActionBody,
  type FoldChoice,
  type ReminderAction,
  type ReminderRequestBody,
} from './model';

const ReferencesSchema = z.object({
  task_id: z.string().uuid().optional(),
  successor_approval_id: z.string().uuid().optional(),
});
export function useReminderApproval(initial: ApprovalDetail, me: Me | null) {
  const [detail, setDetail] = useState(initial);
  const [busy, setBusy] = useState<ReminderAction | null>(null);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [rawText, setRawText] = useState(initial.original_text ?? '');
  const [timezone, setTimezone] = useState(initial.snapshot.timezone_id);
  const [fold, setFold] = useState<FoldChoice>('none');
  const [ambiguity, setAmbiguity] = useState<z.infer<typeof AmbiguousTimeDetailsSchema> | null>(
    null,
  );
  const [uncertain, setUncertain] = useState(false);
  const [readAfterFailure, setReadAfterFailure] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [related, setRelated] = useState<{
    task_id?: string;
    successor_approval_id?: string;
  } | null>(null);
  const [successorDetail, setSuccessorDetail] = useState<ApprovalDetail | null>(null);
  const [successorError, setSuccessorError] = useState<string | null>(null);
  const [successorReading, setSuccessorReading] = useState(false);
  const request = useRef<{ action: ReminderAction; body: ReminderRequestBody } | null>(null);
  const actionController = useRef<AbortController | null>(null);
  const readController = useRef<AbortController | null>(null);
  const successorController = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      actionController.current?.abort();
      readController.current?.abort();
      successorController.current?.abort();
    },
    [],
  );
  const canAct = detail.status === 'pending' && me !== null && !blocked && !uncertain && !notice;

  async function readSuccessor(id: string) {
    if (successorController.current) return;
    const controller = new AbortController();
    successorController.current = controller;
    setSuccessorReading(true);
    try {
      const response = await fetch(`/api/v1/approvals/${encodeURIComponent(id)}`, {
        cache: 'no-store',
        signal: controller.signal,
      });
      const next = ApprovalDetailSchema.parse(await readEnvelope(response));
      if (next.approval_id !== id) throw new Error('后继提议响应关联不一致。');
      if (!controller.signal.aborted) {
        setSuccessorDetail(next);
        setSuccessorError(null);
      }
    } catch (failure) {
      if (!controller.signal.aborted)
        setSuccessorError(
          failure instanceof Error ? failure.message : '后继提议暂不可读取。修改决议仍已接受。',
        );
    } finally {
      if (!controller.signal.aborted) setSuccessorReading(false);
      if (successorController.current === controller) successorController.current = null;
    }
  }

  async function refresh() {
    if (readController.current || actionController.current) return;
    const controller = new AbortController();
    readController.current = controller;
    setReading(true);
    try {
      const response = await fetch(`/api/v1/approvals/${encodeURIComponent(initial.approval_id)}`, {
        cache: 'no-store',
        signal: controller.signal,
      });
      const next = ApprovalDetailSchema.parse(await readEnvelope(response));
      if (
        next.approval_id !== initial.approval_id ||
        next.presentation_hash !== initial.presentation_hash ||
        next.echo_text !== initial.echo_text
      ) {
        if (!controller.signal.aborted) setBlocked(true);
        throw new Error('读取的提议或冻结版本不匹配，原内容已保留。');
      }
      if (controller.signal.aborted) return;
      setDetail(next);
      setReadError(null);
      setReadAfterFailure(true);
      if (next.status !== 'pending') {
        setUncertain(false);
        setEditing(false);
      }
    } catch (failure) {
      if (!controller.signal.aborted)
        setReadError(failure instanceof Error ? failure.message : '提议结果暂不可读取。');
    } finally {
      if (!controller.signal.aborted) setReading(false);
      if (readController.current === controller) readController.current = null;
    }
  }

  async function decide(action: ReminderAction, retry = false) {
    if (
      actionController.current ||
      readController.current ||
      !me ||
      detail.status !== 'pending' ||
      blocked ||
      notice
    )
      return;
    if (retry ? !uncertain || !readAfterFailure || request.current?.action !== action : !canAct)
      return;
    if (
      action === 'revise' &&
      (!editing ||
        detail.kind !== 'create_task' ||
        !rawText ||
        !timezone ||
        (ambiguity && fold === 'none'))
    )
      return;
    const controller = new AbortController();
    actionController.current = controller;
    setBusy(action);
    setError(null);
    const saved = request.current;
    const current =
      saved?.action === action
        ? saved
        : {
            action,
            body: reminderActionBody(detail, action, crypto.randomUUID(), {
              raw_text: rawText,
              confirmed_timezone: timezone,
              fold_choice: fold,
            }),
          };
    request.current = current;
    try {
      const result = await postReminderDecision(
        detail,
        action,
        current.body,
        me.csrf_token,
        controller.signal,
      );
      if (controller.signal.aborted) return;
      setUncertain(false);
      setEditing(false);
      if ('successor_approval_id' in result) {
        setDetail({
          ...detail,
          status: 'superseded',
          result: { ...detail.result, successor_approval_id: result.successor_approval_id },
        });
        setRelated({ successor_approval_id: result.successor_approval_id });
        setNotice('修改已接受。原冻结内容保留；请打开实际后继提议，重新审阅后再确认。');
        void readSuccessor(result.successor_approval_id);
      } else {
        setDetail({
          ...detail,
          status: result.status,
          result: {
            ...detail.result,
            task_id: 'task_id' in result ? result.task_id : detail.result.task_id,
          },
        });
        setRelated('task_id' in result ? { task_id: result.task_id } : null);
        setNotice(
          result.status === 'consumed'
            ? detail.kind === 'cancel_task'
              ? '取消决议已接受。实际取消状态请查看提醒任务，不代表通知已撤回。'
              : '确认已接受。实际提醒与排期状态请查看任务。'
            : '已拒绝这条提议。',
        );
      }
    } catch (failure) {
      if (controller.signal.aborted) return;
      setError(failure instanceof Error ? failure.message : '未收到可核验的操作结果。');
      const domain = failure instanceof ApprovalActionFailure ? failure : null;
      if (domain) {
        const refs = ReferencesSchema.safeParse(domain.details);
        if (refs.success) setRelated(refs.data);
        const parsed =
          domain.code === 'AMBIGUOUS_LOCAL_TIME'
            ? AmbiguousTimeDetailsSchema.safeParse(domain.details)
            : null;
        setAmbiguity(parsed?.success ? parsed.data : null);
        if (
          [
            'APPROVAL_SUPERSEDED',
            'APPROVAL_EXPIRED',
            'STATE_CONFLICT',
            'PRESENTATION_MISMATCH',
          ].includes(domain.code ?? '') ||
          domain.status === 401 ||
          domain.status === 403
        )
          setBlocked(true);
      }
      const unknown = !domain || domain.status >= 500;
      setUncertain(unknown);
      setReadAfterFailure(false);
    } finally {
      if (!controller.signal.aborted) setBusy(null);
      if (actionController.current === controller) actionController.current = null;
    }
  }
  function changeInput(field: 'text' | 'timezone' | 'fold', value: string) {
    if (
      busy ||
      uncertain ||
      blocked ||
      value === (field === 'text' ? rawText : field === 'timezone' ? timezone : fold)
    )
      return;
    request.current = null;
    setError(null);
    if (field === 'fold') setFold(value as FoldChoice);
    else {
      if (field === 'text') setRawText(value);
      else setTimezone(value);
      setFold('none');
      setAmbiguity(null);
    }
  }
  function toggleEditing(next: boolean) {
    if (busy || uncertain || blocked) return;
    setEditing(next);
    setError(null);
    request.current = null;
    if (!next) {
      setRawText(initial.original_text ?? '');
      setTimezone(initial.snapshot.timezone_id);
      setFold('none');
      setAmbiguity(null);
    }
  }
  return {
    detail,
    busy,
    reading,
    error,
    readError,
    editing,
    rawText,
    timezone,
    fold,
    ambiguity,
    uncertain,
    readAfterFailure,
    blocked,
    notice,
    related,
    canAct,
    successorDetail,
    successorError,
    successorReading,
    readSuccessor,
    retryAction: request.current?.action,
    refresh,
    decide,
    changeInput,
    toggleEditing,
  };
}
