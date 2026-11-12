'use client';

import * as auth from '@along/contracts';
import { Button } from '@lorelum/lumen-ui/components/button';
import WorkspaceLink from '@/shell/view/workspace-link';
import type { AccountLinkPurpose } from '../model/account-link';
import { useAccountLink } from '../viewmodel/use-account-link';
import AccountActionForm from './AccountActionForm';
import { AccountFrame } from './AccountFrame';

const titles: Record<AccountLinkPurpose, string> = {
  invitation: '接受邀请',
  reset: '重置密码',
  contact: '验证联系邮箱',
};

export default function AccountLinkPage({ purpose }: { purpose: AccountLinkPurpose }) {
  const { token, ready, csrf, message } = useAccountLink(purpose);
  return (
    <AccountFrame
      view="standalone"
      title={titles[purpose]}
      description="打开页面不会提交。链接凭据仅在此页内存中，刷新后需重新打开邮件。"
    >
      {!ready || !token ? (
        <p role="status" className="text-sm leading-6 text-muted-foreground">
          {message}
        </p>
      ) : purpose === 'invitation' ? (
        <AccountActionForm
          key={token}
          path="invitations/accept"
          title="确认创建账户"
          values={{ token }}
          inputSchema={auth.authInvitationAcceptSchema}
          resultSchema={auth.authInvitationAcceptedSchema}
          fields={[
            { name: 'login_name', label: '用户名', autoComplete: 'username' },
            { name: 'display_name', label: '展示名', autoComplete: 'name' },
            {
              name: 'password',
              label: '设置密码（8–128 位）',
              type: 'password',
              autoComplete: 'new-password',
            },
          ]}
          success="账户已创建。邀请不会自动登录，请明确前往登录。"
        />
      ) : purpose === 'reset' ? (
        <AccountActionForm
          key={token}
          path="password/reset"
          title="确认重置密码"
          values={{ token }}
          inputSchema={auth.authPasswordResetSchema}
          resultSchema={auth.authPasswordResetResultSchema}
          fields={[
            {
              name: 'new_password',
              label: '新密码（8–128 位）',
              type: 'password',
              autoComplete: 'new-password',
            },
          ]}
          success="密码已更新，原会话已撤销。请正式登录。"
        />
      ) : (
        <AccountActionForm
          key={token}
          path="contact/verify"
          title="确认验证本人邮箱"
          values={{ token }}
          inputSchema={auth.authContactVerifySchema}
          resultSchema={auth.authContactVerifiedSchema}
          csrfToken={csrf}
          fields={[]}
          success="联系邮箱已验证。未建立新的会话。"
        />
      )}
      <nav className="flex flex-wrap gap-3 border-t border-border/60 pt-3" aria-label="账户入口">
        <Button
          variant="clear"
          color="default"
          role="link"
          nativeButton={false}
          render={<WorkspaceLink href="/account" />}
        >
          账户
        </Button>
        <Button
          variant="clear"
          color="default"
          role="link"
          nativeButton={false}
          render={<WorkspaceLink href="/login?returnTo=%2Faccount" />}
        >
          正式登录
        </Button>
        <Button
          variant="clear"
          color="default"
          role="link"
          nativeButton={false}
          render={<WorkspaceLink href="/logout" />}
        >
          退出当前账户
        </Button>
      </nav>
    </AccountFrame>
  );
}
