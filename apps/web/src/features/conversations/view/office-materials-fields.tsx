'use client';

import { useRef } from 'react';
import { Button } from '@lorelum/lumen-ui/components/button';
import type { OfficeRole } from '../model/office-materials';
import type { OfficeDraft } from '../viewmodel/use-office-materials';

const slots = [
  { role: 'notes', label: '会议纪要（TXT / Markdown）', accept: '.txt,.md,.markdown' },
  { role: 'tasks', label: '任务表（CSV）', accept: '.csv' },
] as const;

function OfficeSlotField({
  role,
  label,
  accept,
  draft,
  disabled,
}: {
  role: OfficeRole;
  label: string;
  accept: string;
  draft: OfficeDraft;
  disabled: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const slot = draft.slots[role];
  const receipt = slot && 'receipt' in slot ? slot.receipt : null;
  const filename = slot && 'upload' in slot ? slot.upload.file.name : receipt?.filename;
  const retryUpload = slot?.state === 'failed';
  const removeLabel = retryUpload
    ? '从草稿移除'
    : slot?.state === 'ready'
      ? '撤销暂存并移除'
      : slot?.state === 'revoke_failed'
        ? '重试撤销'
        : null;
  return (
    <fieldset
      className="min-w-0 space-y-2 rounded-lg border border-separator px-3 pb-3"
      disabled={disabled}
    >
      <legend className="px-1 font-medium">{label}</legend>
      <div role="status" className="space-y-1 text-secondary-foreground [overflow-wrap:anywhere]">
        {filename ? <p className="text-foreground">{filename}</p> : null}
        {!slot ? <p>未选择</p> : null}
        {slot?.state === 'uploading' ? <p>正在上传…</p> : null}
        {slot?.state === 'failed' ? <p>{slot.message}</p> : null}
        {slot?.state === 'revoking' ? <p>正在撤销暂存…</p> : null}
        {slot?.state === 'revoke_failed' ? <p>撤销结果尚未确认，请重试。</p> : null}
        {slot?.state === 'ready' ? (
          <>
            <p>
              上传已确认，发送时重新核验
              {' · '}
              {slot.receipt.format.toUpperCase()}
              {' · '}
              {slot.receipt.byte_length} 字节
            </p>
            <p>
              有效期至 <time dateTime={slot.receipt.expires_at}>{slot.receipt.expires_at}</time>
            </p>
          </>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-2">
        {!slot ? (
          <>
            <input
              ref={input}
              type="file"
              hidden
              aria-label={label}
              accept={accept}
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = '';
                if (file) draft.choose(role, file);
              }}
            />
            <Button
              type="button"
              variant="glass"
              color="default"
              className="min-h-11"
              aria-label={`选择${label}`}
              onClick={() => input.current?.click()}
            >
              选择文件
            </Button>
          </>
        ) : null}
        {slot?.state === 'uploading' || retryUpload ? (
          <Button
            type="button"
            variant="glass"
            color="default"
            className="min-h-11"
            onClick={() => (retryUpload ? draft.retry(role) : draft.cancel(role))}
          >
            {retryUpload ? '重试原上传' : '取消上传'}
          </Button>
        ) : null}
        {removeLabel ? (
          <Button
            type="button"
            variant="clear"
            color="default"
            className="min-h-11"
            onClick={() => void draft.remove(role)}
          >
            {removeLabel}
          </Button>
        ) : null}
      </div>
    </fieldset>
  );
}

export function OfficeMaterialsFields({
  draft,
  disabled,
}: {
  draft: OfficeDraft;
  disabled: boolean;
}) {
  return (
    <section aria-label="本轮会话资料" className="space-y-3 pb-2">
      <p id="office-materials-help" className="text-secondary-foreground">
        选取文件只会暂存。点击发送后，本轮所选资料将提供给你配置的模型处理，不保证离线。
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        {slots.map((slot) => (
          <OfficeSlotField key={slot.role} {...slot} draft={draft} disabled={disabled} />
        ))}
      </div>
    </section>
  );
}
