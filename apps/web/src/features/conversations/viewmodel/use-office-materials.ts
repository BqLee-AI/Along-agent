'use client';

import { useLayoutEffect, useRef, useState } from 'react';
import {
  officeUploadError,
  revokeOfficeAttachment,
  stageOfficeAttachment,
  type OfficeAttachment,
  type OfficeMaterials,
  type OfficeRole,
  type OfficeSession,
} from '../model/office-materials';

type Upload = { file: File; key: string };
type OfficeSlot =
  | { state: 'uploading'; upload: Upload; request: AbortController }
  | { state: 'failed'; upload: Upload; message: string }
  | { state: 'ready'; receipt: OfficeAttachment }
  | { state: 'revoking'; receipt: OfficeAttachment; request: AbortController }
  | { state: 'revoke_failed'; receipt: OfficeAttachment };

type Draft = { scope: string; id: string; slots: Partial<Record<OfficeRole, OfficeSlot>> };

export interface OfficeDraft {
  slots: Draft['slots'];
  blockedReason: string | null;
  choose: (role: OfficeRole, file: File) => void;
  retry: (role: OfficeRole) => void;
  cancel: (role: OfficeRole) => void;
  remove: (role: OfficeRole) => Promise<void>;
  reset: () => void;
  submission: () => OfficeMaterials | null;
}
const emptySlots: Draft['slots'] = {};

function abortDraft(draft: Draft | null) {
  for (const slot of Object.values(draft?.slots ?? emptySlots)) {
    if ('request' in slot) slot.request.abort();
  }
}

function blockedReason(slots: Draft['slots']): string | null {
  const selected = Object.values(slots);
  if (!selected.length) return '请至少选择一份会话资料。';
  if (selected.some((slot) => slot.state === 'uploading' || slot.state === 'revoking'))
    return '请等待资料操作完成后再发送。';
  if (selected.some((slot) => slot.state !== 'ready'))
    return '请先重试未完成的资料操作，或移除未暂存的文件。';
  return null;
}

export function useOfficeMaterials({
  session,
  conversationId,
  runId,
}: {
  session: OfficeSession | undefined;
  conversationId: string | null;
  runId: string | null;
}): OfficeDraft {
  const scope = session
    ? JSON.stringify([session.ownerId, session.csrfToken, conversationId, runId])
    : null;
  const current = useRef<Draft | null>(null);
  const committedScope = useRef<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const slots = scope && draft?.scope === scope ? draft.slots : emptySlots;

  useLayoutEffect(() => {
    committedScope.current = scope;
    setDraft(null);
    return () => {
      committedScope.current = null;
      abortDraft(current.current);
      current.current = null;
    };
  }, [scope]);

  function reset() {
    abortDraft(current.current);
    current.current = null;
    setDraft(null);
  }

  function activeDraft() {
    const draft = current.current;
    return draft?.scope === scope ? draft : null;
  }

  function update(draft: Draft, role: OfficeRole, slot?: OfficeSlot) {
    const latest = current.current;
    if (latest?.id !== draft.id) return;
    const slots = { ...latest.slots };
    if (slot) slots[role] = slot;
    else delete slots[role];
    current.current = { ...latest, slots };
    setDraft(current.current);
  }

  async function upload(draft: Draft, role: OfficeRole, intent: Upload) {
    if (!session) return;
    const request = new AbortController();
    update(draft, role, { state: 'uploading', upload: intent, request });
    try {
      const receipt = await stageOfficeAttachment({
        draftId: draft.id,
        conversationId,
        csrfToken: session.csrfToken,
        role,
        file: intent.file,
        key: intent.key,
        signal: request.signal,
      });
      if (!request.signal.aborted) update(draft, role, { state: 'ready', receipt });
    } catch (error) {
      if (!request.signal.aborted)
        update(draft, role, {
          state: 'failed',
          upload: intent,
          message: `上传未确认：${officeUploadError(error)}`,
        });
    }
  }

  function choose(role: OfficeRole, file: File) {
    if (!scope || committedScope.current !== scope) return;
    const draft = (current.current ??= { scope, id: crypto.randomUUID(), slots: {} });
    if (!draft.slots[role]) void upload(draft, role, { file, key: crypto.randomUUID() });
  }

  function retry(role: OfficeRole) {
    const draft = activeDraft();
    const slot = draft?.slots[role];
    if (draft && slot?.state === 'failed') void upload(draft, role, slot.upload);
  }

  function cancel(role: OfficeRole) {
    const draft = activeDraft();
    const slot = draft?.slots[role];
    if (!draft || slot?.state !== 'uploading') return;
    slot.request.abort();
    update(draft, role, {
      state: 'failed',
      upload: slot.upload,
      message: '已中止等待；未确认是否暂存。',
    });
  }

  async function remove(role: OfficeRole) {
    const draft = activeDraft();
    const slot = draft?.slots[role];
    if (!session || !draft || !slot) return;
    if (slot.state === 'failed') {
      update(draft, role);
      return;
    }
    if (slot.state !== 'ready' && slot.state !== 'revoke_failed') return;
    const request = new AbortController();
    const receipt = slot.receipt;
    update(draft, role, { state: 'revoking', receipt, request });
    try {
      await revokeOfficeAttachment({
        id: receipt.attachment_id,
        draftId: draft.id,
        conversationId,
        csrfToken: session.csrfToken,
        signal: request.signal,
      });
      if (!request.signal.aborted) update(draft, role);
    } catch {
      if (!request.signal.aborted) update(draft, role, { state: 'revoke_failed', receipt });
    }
  }

  function submission(): OfficeMaterials | null {
    const draft = activeDraft();
    if (!draft || blockedReason(draft.slots)) return null;
    const { notes, tasks } = draft.slots;
    return {
      draft_id: draft.id,
      ...(notes?.state === 'ready' ? { notes_attachment_id: notes.receipt.attachment_id } : {}),
      ...(tasks?.state === 'ready' ? { tasks_attachment_id: tasks.receipt.attachment_id } : {}),
    };
  }

  return {
    slots,
    blockedReason: blockedReason(slots),
    choose,
    retry,
    cancel,
    remove,
    reset,
    submission,
  };
}
