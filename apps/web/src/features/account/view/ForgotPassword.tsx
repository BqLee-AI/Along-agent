'use client';

import * as auth from '@along/contracts';
import { Button } from '@lorelum/lumen-ui/components/button';
import WorkspaceLink from '@/shell/view/workspace-link';
import AccountActionForm from './AccountActionForm';
import { AccountFrame } from './AccountFrame';

export default function ForgotPassword() {
  return (
    <AccountFrame
      view="standalone"
      title="找回密码"
      description="请输入已验证联系邮箱。接受请求不证明账户存在或邮件已送达。"
    >
      <AccountActionForm
        path="password/forgot"
        title="明确请求恢复邮件"
        fields={[{ name: 'email', label: '联系邮箱', type: 'email', autoComplete: 'email' }]}
        inputSchema={auth.authPasswordForgotSchema}
        resultSchema={auth.authPasswordForgottenSchema}
        success="请求已接受。如果此邮箱对应可恢复账户，你将收到邮件。此回执不证明账户存在或邮件已发送。"
      />
      <Button
        variant="clear"
        color="default"
        role="link"
        nativeButton={false}
        render={<WorkspaceLink href="/login" />}
      >
        返回登录
      </Button>
    </AccountFrame>
  );
}
