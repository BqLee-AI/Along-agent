'use client';
import * as auth from '@along/contracts';
import AccountActionForm from './AccountActionForm';
export default function ForgotPassword() {
  return (
    <section className="mx-auto max-w-[480px] space-y-6 py-8">
      <h1 className="text-3xl font-semibold">找回密码</h1>
      <p>请输入已验证联系邮箱。接受请求不证明账户存在或邮件已送达。</p>
      <AccountActionForm
        path="password/forgot"
        title="明确请求恢复邮件"
        fields={[{ name: 'email', label: '联系邮箱', type: 'email', autoComplete: 'email' }]}
        inputSchema={auth.authPasswordForgotSchema}
        resultSchema={auth.authPasswordForgottenSchema}
        success="请求已接受。如果此邮箱对应可恢复账户，你将收到邮件。此回执不证明账户存在或邮件已发送。"
      />
      <a className="inline-flex min-h-11 items-center text-primary underline" href="/login">
        返回登录
      </a>
    </section>
  );
}
