'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { authAccountProfileSchema, authAccountProfileUpdateSchema } from '@along/contracts';
import { Button } from '@lorelum/lumen-ui/components/button';
import { Input } from '@lorelum/lumen-ui/components/input';
import { Label } from '@lorelum/lumen-ui/components/label';
import { submitAccountAction } from '../model/account-actions';

export function AccountProfileForm({
  displayName,
  timezone,
  csrfToken,
}: {
  displayName: string;
  timezone: string | null;
  csrfToken: string;
}) {
  const router = useRouter();
  const [saved, setSaved] = useState({ name: displayName, zone: timezone ?? '' });
  const [draft, setDraft] = useState(saved);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const name = draft.name.trim();
  const zone = draft.zone.trim();
  const changed = name !== saved.name || zone !== saved.zone;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || !changed) return;
    const input = authAccountProfileUpdateSchema.safeParse({
      ...(name !== saved.name ? { display_name: name } : {}),
      ...(zone !== saved.zone ? { timezone_id: zone || null } : {}),
    });
    if (!input.success) {
      setMessage({ text: '请填写显示名称，时区最多 100 个字符。', error: true });
      return;
    }
    setPending(true);
    setMessage(null);
    const result = await submitAccountAction(
      'account/profile',
      input.data,
      csrfToken,
      authAccountProfileSchema,
    );
    setPending(false);
    if (result.kind === 'success') {
      const next = { name: result.data.display_name, zone: result.data.timezone_id ?? '' };
      setSaved(next);
      setDraft(next);
      setMessage({ text: '已保存', error: false });
      router.refresh();
    } else if (result.kind === 'failure') {
      setMessage({ text: result.message, error: true });
    }
  }

  return (
    <section
      id="profile-settings"
      className="scroll-mt-4 space-y-4 rounded-xl border border-separator bg-foreground/5 p-4"
    >
      <form onSubmit={submit} aria-busy={pending} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="min-w-0 space-y-2">
            <Label htmlFor="account-display-name">显示名称</Label>
            <Input
              id="account-display-name"
              autoComplete="name"
              required
              maxLength={128}
              disabled={pending}
              value={draft.name}
              onChange={(event) => {
                setDraft({ ...draft, name: event.target.value });
                setMessage(null);
              }}
            />
          </div>
          <div className="min-w-0 space-y-2">
            <Label htmlFor="account-timezone">默认时区</Label>
            <Input
              id="account-timezone"
              aria-describedby="account-timezone-help"
              autoComplete="off"
              spellCheck={false}
              placeholder="未设置"
              maxLength={100}
              disabled={pending}
              value={draft.zone}
              onChange={(event) => {
                setDraft({ ...draft, zone: event.target.value });
                setMessage(null);
              }}
            />
            <p id="account-timezone-help" className="text-xs leading-5 text-muted-foreground">
              用于新提醒，例如 Asia/Shanghai 或北京时间。留空可清除。
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={pending || !changed}>
            {pending ? '正在保存…' : '保存资料'}
          </Button>
          {message ? (
            <p
              role={message.error ? 'alert' : 'status'}
              className={
                message.error ? 'text-sm text-destructive' : 'text-sm text-muted-foreground'
              }
            >
              {message.text}
            </p>
          ) : null}
        </div>
      </form>
    </section>
  );
}
