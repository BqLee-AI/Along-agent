import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import type { AccountFailure } from './account-operation';

export function AccountMaintenance({ pending = false }: { pending?: boolean }) {
  return (
    <section
      className="space-y-4 rounded-xl border border-border bg-card p-4 sm:p-6"
      aria-labelledby="account-maintenance-title"
    >
      <h2 id="account-maintenance-title" className="text-lg font-semibold leading-7">
        {pending ? '账户已完成，资料登记待本机配置' : '原安装的本机维护'}
      </h2>
      <p className="text-base leading-7 text-muted-foreground">
        {pending
          ? '账户提交与资料工作区配置是两个步骤。请保留当前账户，不要重新建号；当前不表示资料或模型能力可用。'
          : '请部署者在原安装使用正式 local:account 入口检查账户和工作区登记。这里不接收宿主路径、owner 或模型密钥。'}
      </p>
      <pre className="whitespace-pre-wrap rounded-lg bg-muted p-3 font-mono text-sm leading-6 [overflow-wrap:anywhere]">
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
    <Alert variant="destructive">
      <AlertTitle>{failure.status === 403 ? '当前请求无权读取' : '账户信息暂不可核验'}</AlertTitle>
      <AlertDescription className="space-y-3">
        <p>
          {failure.status === 403
            ? '权限或请求安全校验未通过。这不是会话过期；请使用原安装的正式地址并联系部署者检查。'
            : identityOnly
              ? '安装状态读取成功，但当前身份响应尚未通过核验。未将此错误当作已退出，也没有开放转正、建号或撤销会话。'
              : '服务连接或响应未能通过核验，不能确定当前身份或空安装状态。未开放建号，也没有将此错误当作已退出或模型未配置。'}
        </p>
        <AccountDiagnostics failure={failure} />
      </AlertDescription>
    </Alert>
  );
}
