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
export type OfficeSlot =
  | { state: 'uploading'; upload: Upload; request: AbortController }
  | { state: 'failed' | 'cancelled'; upload: Upload; message: string }
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
      for (const slot of Object.values(current.current?.slots ?? emptySlots)) {
        if ('request' in slot) slot.request.abort();
      }
      current.current = null;
    };
  }, [scope]);

  function reset() {
    for (const slot of Object.values(current.current?.slots ?? emptySlots)) {
      if ('request' in slot) slot.request.abort();
    }
    current.current = null;
    setDraft(null);
  }

  function update(draft: Draft, role: OfficeRole, slot?: OfficeSlot) {
    if (current.current !== draft || committedScope.current !== draft.scope) return;
    if (slot) draft.slots[role] = slot;
    else delete draft.slots[role];
    setDraft({ ...draft, slots: { ...draft.slots } });
  }

  async function upload(draft: Draft, role: OfficeRole, intent: Upload) {
    if (!session || committedScope.current !== draft.scope) return;
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
        update(draft, role, { state: 'failed', upload: intent, message: officeUploadError(error) });
    }
  }

  function choose(role: OfficeRole, file: File) {
    if (!scope || committedScope.current !== scope) return;
    const draft = (current.current ??= { scope, id: crypto.randomUUID(), slots: {} });
    if (!draft.slots[role]) void upload(draft, role, { file, key: crypto.randomUUID() });
  }

  function retry(role: OfficeRole) {
    const draft = current.current;
    const slot = draft?.slots[role];
    if (
      draft &&
      draft.scope === scope &&
      slot &&
      (slot.state === 'failed' || slot.state === 'cancelled')
    )
      void upload(draft, role, slot.upload);
  }

  function cancel(role: OfficeRole) {
    const draft = current.current;
    const slot = draft?.slots[role];
    if (!draft || draft.scope !== scope || slot?.state !== 'uploading') return;
    slot.request.abort();
    update(draft, role, {
      state: 'cancelled',
      upload: slot.upload,
      message: '已中止等待；未确认是否暂存。',
    });
  }

  async function remove(role: OfficeRole) {
    const draft = current.current;
    const slot = draft?.slots[role];
    if (!session || !draft || draft.scope !== scope || !slot) return;
    if (slot.state === 'failed' || slot.state === 'cancelled') {
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
    const draft = current.current;
    if (!scope || draft?.scope !== scope || blockedReason(draft.slots)) return null;
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
