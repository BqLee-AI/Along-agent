'use client';

import { useEffect, useState, type ReactNode } from 'react';
import * as auth from '@along/contracts';
import { z } from 'zod';
import { Button } from '@lorelum/lumen-ui/components/button';
import AccountActionForm from './AccountActionForm';
import { readAccountCollection } from './account-actions';

const currentPassword = {
  name: 'current_password',
  label: '当前密码',
  type: 'password' as const,
  autoComplete: 'current-password',
};
const confirmed = { name: 'confirmed', label: '我确认此操作', type: 'checkbox' as const };
export type AccountDashboardProps = { account: auth.AccountView; csrfToken: string };
export type AccountCollectionProps<T extends { id: string }> = {
  path: string;
  schema: z.ZodType<{ items: T[]; next_cursor: string | null }>;
  title: string;
  render: (item: T) => ReactNode;
};
function Delivery({ delivery }: { delivery: auth.DeliveryView }) {
  const labels: Record<auth.DeliveryView['status'], string> = {
    queued: '排队中',
    submitting: '提交中',
    submitted: '邮件供应商已接受（不代表送达）',
    failed: '提交失败',
    unknown: '提交结果未知',
    suppressed: '已抑制',
  };
  return (
    <p className="text-sm text-muted-foreground">
      邮件状态：{labels[delivery.status]} ·{' '}
      <time dateTime={delivery.updated_at}>{delivery.updated_at}</time>
    </p>
  );
}
function Collection<T extends { id: string }>({
  path,
  schema,
  title,
  render,
}: AccountCollectionProps<T>) {
  const [items, setItems] = useState<T[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  async function load(next: string | null = null) {
    setBusy(true);
    setError(null);
    try {
      const result = await readAccountCollection(
        `${path}${next ? `?${new URLSearchParams({ cursor: next })}` : ''}`,
        schema,
      );
      setItems((old) => (next ? [...old, ...result.items] : result.items));
      setCursor(result.next_cursor);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '读取失败');
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void load();
  }, [path]);
  return (
    <section className="space-y-4" aria-busy={busy}>
      <h2 className="text-xl font-semibold">{title}</h2>
      {error ? <p role="alert">{error}</p> : null}
      {items.map((item) => (
        <article key={item.id} className="space-y-4 rounded-xl border border-border p-4">
          {render(item)}
        </article>
      ))}
      {!busy && !error && items.length === 0 ? (
        <p className="text-muted-foreground">暂无记录。</p>
      ) : null}
      {busy ? (
        <p role="status">正在读取…</p>
      ) : (
        <div className="flex flex-wrap gap-3">
          <Button variant="glass" color="default" onClick={() => void load()}>
            重新读取
          </Button>
          {cursor ? (
            <Button variant="glass" color="default" onClick={() => void load(cursor)}>
              读取下一页
            </Button>
          ) : null}
        </div>
      )}
    </section>
  );
}
export default function AccountDashboard({ account, csrfToken }: AccountDashboardProps) {
  return (
    <section className="mx-auto max-w-[640px] space-y-10 [overflow-wrap:anywhere]">
      <header className="space-y-3">
        <h1 className="text-3xl font-semibold">账户</h1>
        <p className="text-xl">{account.user.display_name}</p>
        <p className="text-muted-foreground">
          正式会话固定七天到期。读取不会续期；所有操作仅在明确提交时执行。
        </p>
      </header>
      <section className="space-y-4">
        <h2 className="text-xl font-semibold">联系邮箱</h2>
        <p>
          {account.contact.state === 'verified'
            ? `已验证：${account.contact.masked_email}`
            : '尚未绑定已验证邮箱'}
        </p>
        {account.contact.verified_at ? (
          <p>
            验证时间：
            <time dateTime={account.contact.verified_at}>{account.contact.verified_at}</time>
          </p>
        ) : null}
        {account.pending_contact ? (
          <div className="space-y-2 rounded-xl border border-border p-4">
            <p>待验证：{account.pending_contact.masked_email}</p>
            <p>有效期至 {account.pending_contact.expires_at}</p>
            <Delivery delivery={account.pending_contact.delivery} />
            <p>新请求会使上一封验证链接失效；原已验证邮箱在验证成功前保留。</p>
          </div>
        ) : null}
        <AccountActionForm
          path="contact/request"
          title={account.pending_contact ? '请求新一代验证邮件' : '绑定或更换联系邮箱'}
          fields={[
            { name: 'email', label: '联系邮箱', type: 'email', autoComplete: 'email' },
            currentPassword,
          ]}
          inputSchema={auth.authContactRequestSchema}
          resultSchema={auth.authContactRequestedSchema}
          csrfToken={csrfToken}
          success="验证请求已接受，请读取账户状态并检查邮件；不表示已经送达。"
        />
      </section>
      <section className="space-y-3">
        <h2 className="text-xl font-semibold">本人的资料工作区</h2>
        <p>
          {account.workspace.state === 'none'
            ? '你尚无资料工作区；仍可使用完整账户功能。'
            : account.workspace.state === 'available'
              ? `本人有 ${account.workspace.count} 个可用资料工作区。`
              : '本人的资料工作区暂不可用。'}
        </p>
        <p className="text-sm text-muted-foreground">工作区状态不代表模型可用性。</p>
      </section>
      <section className="space-y-4">
        <h2 className="text-xl font-semibold">密码</h2>
        <AccountActionForm
          path="password/change"
          title="修改密码并退出所有会话"
          fields={[
            currentPassword,
            {
              name: 'new_password',
              label: '新密码（8–128 位）',
              type: 'password',
              autoComplete: 'new-password',
            },
          ]}
          inputSchema={auth.authPasswordChangeSchema}
          resultSchema={auth.authPasswordChangedSchema}
          csrfToken={csrfToken}
          success="密码已更新，所有会话已撤销，请正式登录。"
        />
      </section>
      <Collection
        path="sessions"
        schema={auth.authSessionsSchema}
        title="本人的会话"
        render={(session) => (
          <>
            <h3 className="font-semibold">{session.current ? '当前会话' : '其他会话'}</h3>
            <p>{session.device_summary ?? '无设备摘要'}</p>
            <p>创建：{session.created_at}</p>
            <p>到期：{session.expires_at}</p>
            <p>{session.revoked_at ? `已撤销：${session.revoked_at}` : '未撤销'}</p>
            {!session.revoked_at ? (
              <AccountActionForm
                path={`sessions/${session.id}/revoke`}
                title={session.current ? '明确退出此会话' : '撤销此会话'}
                fields={[]}
                inputSchema={auth.authSessionRevokeSchema}
                resultSchema={auth.authSessionRevokedSchema}
                csrfToken={csrfToken}
                success="会话撤销已确认。若撤销的是当前会话，请重新登录。"
              />
            ) : null}
          </>
        )}
      />
      <section className="space-y-6">
        <h2 className="text-xl font-semibold">批量撤销会话</h2>
        {(['others', 'all'] as const).map((scope) => (
          <AccountActionForm
            key={scope}
            path="sessions/revoke"
            title={scope === 'others' ? '撤销其他全部会话' : '撤销全部会话（含当前）'}
            values={{ scope }}
            fields={[currentPassword]}
            inputSchema={auth.authSessionsRevokeSchema}
            resultSchema={auth.authSessionRevokedSchema}
            csrfToken={csrfToken}
            success={
              scope === 'all' ? '全部会话已撤销，请重新登录。' : '其他会话已撤销，当前会话保留。'
            }
          />
        ))}
      </section>
      {account.installation_admin ? (
        <>
          <section className="space-y-4">
            <h2 className="text-xl font-semibold">邀请普通账户</h2>
            <p>邀请不会授予跨用户资料访问权。接受者必须独立设置密码并正式登录。</p>
            {account.contact.state === 'verified' ? (
              <AccountActionForm
                path="invitations"
                title="创建邀请"
                values={{ idempotency_key: null }}
                fields={[
                  { name: 'email', label: '受邀邮箱', type: 'email', autoComplete: 'email' },
                  currentPassword,
                ]}
                inputSchema={auth.authInvitationCreateSchema}
                resultSchema={auth.authInvitationCreatedSchema}
                csrfToken={csrfToken}
                success="邀请已创建。请读取列表查看邮件状态，不代表已送达。"
              />
            ) : (
              <p>请先验证本人的联系邮箱，再创建邀请。</p>
            )}
          </section>
          <Collection
            path="invitations"
            schema={auth.authInvitationsSchema}
            title="邀请记录"
            render={(invitation) => (
              <>
                <h3 className="font-semibold">{invitation.masked_email}</h3>
                <p>
                  状态：{invitation.state} · 第 {invitation.generation} 代
                </p>
                <p>到期：{invitation.expires_at}</p>
                <Delivery delivery={invitation.delivery} />
                {invitation.state === 'pending' || invitation.state === 'expired' ? (
                  <>
                    <AccountActionForm
                      path={`invitations/${invitation.id}/resend`}
                      title="发送新一代邀请"
                      values={{ idempotency_key: null }}
                      fields={[currentPassword]}
                      inputSchema={auth.authInvitationResendSchema}
                      resultSchema={auth.authInvitationCreatedSchema}
                      csrfToken={csrfToken}
                      success="新一代邀请已接受，旧链接失效。请只读核对邮件状态。"
                    />
                    <AccountActionForm
                      path={`invitations/${invitation.id}/revoke`}
                      title="撤销邀请"
                      fields={[currentPassword]}
                      inputSchema={auth.authInvitationRevokeSchema}
                      resultSchema={auth.authInvitationRevokedSchema}
                      csrfToken={csrfToken}
                      success="邀请已撤销。"
                    />
                  </>
                ) : null}
              </>
            )}
          />
          <Collection
            path="users"
            schema={auth.authUsersSchema}
            title="账户管理"
            render={(user) => (
              <>
                <h3 className="font-semibold">{user.display_name}</h3>
                <p>
                  {user.status} · {user.masked_email ?? '无已验证邮箱'} ·{' '}
                  {user.admitted ? '已准入' : '未准入'}
                </p>
                {user.installation_admin ? (
                  <p>唯一管理员受保护，不可在线停用或申请删除。</p>
                ) : user.status === 'active' ? (
                  <AccountActionForm
                    path={`users/${user.id}/disable`}
                    title="停用此普通账户"
                    fields={[currentPassword, confirmed]}
                    inputSchema={auth.authDisableUserSchema}
                    resultSchema={auth.authUserDisabledSchema}
                    csrfToken={csrfToken}
                    success="账户已停用，其访问资格已撤销。"
                  />
                ) : null}
              </>
            )}
          />
        </>
      ) : null}
      <section className="space-y-4">
        <h2 className="text-xl font-semibold">删除申请</h2>
        {account.installation_admin ? (
          <p>唯一管理员受保护，不能在线申请删除。请联系部署者使用正式本机维护流程。</p>
        ) : (
          <>
            <p>申请后账户立即失去访问资格；这不表示历史数据已物理删除。</p>
            <AccountActionForm
              path="deletion-request"
              title="提交删除申请并退出"
              fields={[currentPassword, confirmed]}
              inputSchema={auth.authDeletionRequestSchema}
              resultSchema={auth.authDeletionRequestedSchema}
              csrfToken={csrfToken}
              success="删除申请已记录，所有会话已撤销。此回执不是物理删除完成证明。"
            />
          </>
        )}
      </section>
      <nav className="flex flex-wrap gap-6">
        <a className="inline-flex min-h-11 items-center text-primary underline" href="/logout">
          退出当前会话
        </a>
        <a className="inline-flex min-h-11 items-center text-primary underline" href="/">
          返回今日
        </a>
      </nav>
    </section>
  );
}
