'use client';

import { Alert } from '@lorelum/lumen-ui/components/alert';
import type { AccountFailure } from './account-operation';

export function AccountMaintenance({ pending = false }: { pending?: boolean }) {
  return (
    <section className="space-y-4 p-4 sm:p-6" aria-labelledby="account-maintenance-title">
      <h2 id="account-maintenance-title" className="text-lg font-semibold leading-7">
        {pending ? '账户已完成，资料登记待本机配置' : '原安装的本机维护'}
      </h2>
      <p className="text-base leading-7 text-muted-foreground">
        {pending
          ? '账户提交与资料工作区配置是两个步骤。请保留当前账户，不要重新建号；当前不表示资料或模型能力可用。'
          : '请部署者在原安装使用正式 local:account 入口检查账户和工作区登记。这里不接收宿主路径、owner 或模型密钥。'}
      </p>
      <pre className="whitespace-pre-wrap p-3 font-mono text-sm leading-6 [overflow-wrap:anywhere]">
        {'bun --no-env-file run local:account --config <原私有配置>'}
      </pre>
      <p className="text-sm leading-6 text-muted-foreground">
        使用原安装已启动并完成升级与版本核验的同一服务。配置已保存但重载失败时，只补做未完成步骤；不要重新初始化、合并其他身份、更换原卷或认证密钥，也不要在命令参数中传递口令或
        owner。
      </p>
    </section>
  );
}

export function AccountDiagnostics({
  failure,
}: {
  failure: Pick<AccountFailure, 'status' | 'code' | 'requestId'>;
}) {
  if (failure.status === null && !failure.code && !failure.requestId) return null;
  return (
    <details className="min-w-0 text-sm">
      <summary className="flex min-h-11 cursor-pointer items-center text-primary underline-offset-4 hover:underline focus-visible:rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
        查看安全诊断
      </summary>
      <dl className="space-y-2 border-l-2 border-border pl-4 leading-6 [overflow-wrap:anywhere]">
        {failure.status !== null ? (
          <div>
            <dt className="inline text-muted-foreground">HTTP：</dt>
            <dd className="inline font-mono">
              {failure.status === 0 ? '连接未建立' : failure.status}
            </dd>
          </div>
        ) : null}
        {failure.code ? (
          <div>
            <dt className="inline text-muted-foreground">错误代码：</dt>
            <dd className="inline font-mono">{failure.code}</dd>
          </div>
        ) : null}
        {failure.requestId ? (
          <div>
            <dt className="inline text-muted-foreground">请求标识：</dt>
            <dd className="inline font-mono">{failure.requestId}</dd>
          </div>
        ) : null}
      </dl>
    </details>
  );
}

export function AccountReadError({
  failure,
  identityOnly = false,
}: {
  failure: Pick<AccountFailure, 'status' | 'code' | 'requestId'>;
  identityOnly?: boolean;
}) {
  return (
    <Alert color="danger" role="alert">
      <Alert.Content>
        <Alert.Title>
          {failure.status === 403 ? '当前请求无权读取' : '账户信息暂不可核验'}
        </Alert.Title>
        <Alert.Description className="space-y-3">
          <p>
            {failure.status === 403
              ? '权限或请求安全校验未通过。这不是会话过期；请使用原安装的正式地址并联系部署者检查。'
              : identityOnly
                ? '安装状态读取成功，但当前身份响应尚未通过核验。未将此错误当作已退出，也没有开放转正、建号或撤销会话。'
                : '服务连接或响应未能通过核验，不能确定当前身份或空安装状态。未开放建号，也没有将此错误当作已退出或模型未配置。'}
          </p>
          <AccountDiagnostics failure={failure} />
        </Alert.Description>
      </Alert.Content>
    </Alert>
  );
}

const accountNotices = {
  setup: {
    title: '仅此空安装可首次建号',
    description:
      '此安装只有一个管理员，不提供公众注册。已有历史或会话失效都不能用首次建号替代身份恢复。',
  },
  unsigned: {
    title: '当前不是可撤销的签名会话',
    description:
      '这是开发桥身份，不能作为正式退出凭据。请部署者关闭开发桥后使用正式登录；未发送退出请求。',
  },
  unauthenticated: {
    title: '当前没有有效会话',
    description:
      '身份自检返回未认证。这是当前读取到的事实，不代表本页执行过撤销，也不证明之前丢失响应的退出结果。',
  },
  legacy: {
    title: '需要部署者在本机维护',
    description:
      '当前没有符合转正条件的原签名会话。会话失效不是空安装；开发桥身份也不能认领账户。请部署者在原安装明确选择并确认原账户，已有口令须验证，不能在此覆盖。',
  },
  configured: {
    title: '请继续使用原账户',
    description: '原身份和历史保持不变。不要重新建号或用此页覆盖已有口令；需要维护时请联系部署者。',
  },
  login: {
    title: '登录后查看当前身份',
    description: '管理员绑定保持不变，不会因退出或会话失效重新开放建号。正式登录后只读返回原页面。',
  },
} as const;

export function AccountStatusNotice({ kind }: { kind: keyof typeof accountNotices }) {
  const notice = accountNotices[kind];
  return (
    <Alert>
      <Alert.Content>
        <Alert.Title>{notice.title}</Alert.Title>
        <Alert.Description>{notice.description}</Alert.Description>
      </Alert.Content>
    </Alert>
  );
}
