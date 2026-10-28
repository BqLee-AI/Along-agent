import type { ReactNode } from 'react';
import { authStatusSchema } from '@along/contracts';
import { PageHeading } from '@/components/page';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { apiGet } from '../../lib/api';
import { loginHref, safeReturnTo } from '../../lib/account-navigation';
import { MeSchema } from '../../lib/types';
import AccountForm from './AccountForm';
import { AccountMaintenance, AccountReadError } from './AccountSupport';

type AccountView = 'account' | 'login' | 'setup' | 'claim' | 'logout';

function AccountFrame({
  view,
  title,
  description,
  children,
}: {
  view: AccountView;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section
      className={
        view === 'account'
          ? 'mx-auto w-full min-w-0 max-w-[640px] space-y-8 [overflow-wrap:anywhere]'
          : 'mx-auto w-full min-w-0 max-w-[400px] space-y-6 [overflow-wrap:anywhere]'
      }
    >
      {view !== 'account' ? (
        <a
          href="/"
          className="inline-flex min-h-11 items-center text-xl font-semibold text-primary underline-offset-4 hover:underline focus-visible:rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          Along
        </a>
      ) : null}
      <PageHeading title={title} description={description} />
      {children}
    </section>
  );
}

export default async function AccountScreen({
  view,
  returnTo,
}: {
  view: AccountView;
  returnTo?: unknown;
}) {
  const destination = safeReturnTo(returnTo);
  const titles = {
    account: '账户',
    login: '登录 Along',
    setup: '首次设置管理员',
    claim: '为原账户设置正式登录',
    logout: '退出当前会话',
  };
  const retryHref =
    view === 'account'
      ? '/account'
      : view === 'login' || view === 'setup'
        ? `/${view}?${new URLSearchParams({ returnTo: destination })}`
        : `/${view}`;
  const statusResult = await apiGet<unknown>('/api/v1/auth/status');
  const parsed = statusResult.ok ? authStatusSchema.safeParse(statusResult.data) : null;
  if (!statusResult.ok || !parsed?.success) {
    return (
      <AccountFrame
        view={view}
        title={titles[view]}
        description="先核验原安装状态，再决定安全的下一步。"
      >
        <AccountReadError
          failure={statusResult.ok ? { status: 200, code: null, requestId: null } : statusResult}
        />
        <div className="flex flex-col gap-3">
          <Button asChild variant="outline">
            <a href={retryHref}>重新读取账户状态</a>
          </Button>
          {view !== 'account' ? (
            <Button asChild variant="ghost">
              <a href="/account">返回账户</a>
            </Button>
          ) : null}
        </div>
        <AccountMaintenance />
      </AccountFrame>
    );
  }
  const status = parsed.data;
  if (status.state === 'setup_required') {
    return (
      <AccountFrame
        view={view}
        title={view === 'setup' ? titles.setup : titles[view]}
        description="服务端已确认这是空安装，尚未建立管理员账户。"
      >
        <Alert>
          <AlertTitle>仅此空安装可首次建号</AlertTitle>
          <AlertDescription>
            此安装只有一个管理员，不提供公众注册。已有历史或会话失效都不能用首次建号替代身份恢复。
          </AlertDescription>
        </Alert>
        {view === 'setup' ? (
          <AccountForm operation="initialize" />
        ) : (
          <div className="space-y-3">
            {view === 'logout' ? (
              <p className="text-base leading-7">
                此安装尚无可撤销的管理员会话；打开此页没有执行退出。
              </p>
            ) : null}
            <Button asChild>
              <a href="/setup">开始首次设置</a>
            </Button>
            {view !== 'account' ? (
              <Button asChild variant="ghost">
                <a href="/account">返回账户</a>
              </Button>
            ) : null}
          </div>
        )}
        <p className="text-sm leading-6 text-muted-foreground">
          账户建立后，再由部署者完成本机资料登记。这里不设置模型或宿主资料路径。
        </p>
      </AccountFrame>
    );
  }
  if (view === 'login' && status.state === 'ready') {
    const category =
      (
        {
          conversations: '原对话页面',
          approvals: '原提醒确认页面',
          'document-approvals': '原文档批准页面',
          tasks: '原提醒任务页面',
          activity: '活动页面',
          account: '账户页面',
        } as Record<string, string>
      )[destination.split(/[/?#]/, 2)[1]] ?? '今日页面';
    return (
      <AccountFrame
        view={view}
        title={titles.login}
        description="使用此安装已绑定管理员的登录名和密码。"
      >
        <p className="text-base leading-7 text-muted-foreground">
          登录成功后只读返回{category}
          。不会保存口令、恢复旧正文或自动补发发送、批准、继续和取消操作。
        </p>
        <AccountForm operation="sign-in" returnTo={destination} />
        <p className="text-sm leading-6 text-muted-foreground">
          此安装不开放公众注册或在线找回密码。无法登录时，请部署者通过原安装的本机维护入口处理。
        </p>
      </AccountFrame>
    );
  }

  const meResult = await apiGet<unknown>('/api/v1/me');
  const me = meResult.ok ? MeSchema.safeParse(meResult.data) : null;
  if ((!meResult.ok && meResult.status !== 401) || (meResult.ok && !me?.success)) {
    return (
      <AccountFrame
        view={view}
        title={titles[view]}
        description="安装状态读取成功，当前会话仍需单独核验。"
      >
        <Badge variant="secondary">
          {status.state === 'ready' ? '管理员已配置' : '需保留原身份完成转正'}
        </Badge>
        <AccountReadError
          identityOnly
          failure={meResult.ok ? { status: 200, code: null, requestId: null } : meResult}
        />
        <p className="text-base leading-7 text-muted-foreground">
          已配置的身份与历史不会因本次读取失败而重新建立。当前没有开放转正或退出操作。
        </p>
        <div className="flex flex-col gap-3">
          <Button asChild variant="outline">
            <a href={retryHref}>重新核验当前会话</a>
          </Button>
          {view !== 'account' ? (
            <Button asChild variant="ghost">
              <a href="/account">返回账户</a>
            </Button>
          ) : null}
        </div>
        <AccountMaintenance />
      </AccountFrame>
    );
  }
  const actor = me?.success ? me.data : null;

  if (view === 'logout') {
    return (
      <AccountFrame
        view={view}
        title={titles.logout}
        description="仅明确提交才会请求撤销当前会话。"
      >
        {actor ? (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">当前用户</p>
            <p className="text-xl font-semibold leading-8">{actor.user.display_name}</p>
            {actor.csrf_token !== null ? (
              <AccountForm operation="sign-out" csrfToken={actor.csrf_token} />
            ) : (
              <>
                <Alert>
                  <AlertTitle>当前不是可撤销的签名会话</AlertTitle>
                  <AlertDescription>
                    这是开发桥身份，不能作为正式退出凭据。请部署者关闭开发桥后使用正式登录；未发送退出请求。
                  </AlertDescription>
                </Alert>
                <Button asChild variant="outline">
                  <a href="/account">返回账户</a>
                </Button>
              </>
            )}
          </div>
        ) : (
          <div className="space-y-6">
            <Alert>
              <AlertTitle>当前没有有效会话</AlertTitle>
              <AlertDescription>
                身份自检返回未认证。这是当前读取到的事实，不代表本页执行过撤销，也不证明之前丢失响应的退出结果。
              </AlertDescription>
            </Alert>
            <div className="flex flex-col gap-3">
              <Button asChild>
                <a href={loginHref('/account')}>正式登录</a>
              </Button>
              <Button asChild variant="ghost">
                <a href="/account">返回账户</a>
              </Button>
            </div>
          </div>
        )}
      </AccountFrame>
    );
  }

  if (status.state === 'legacy_claim_required') {
    const canClaim = status.can_claim === true && actor !== null && actor.csrf_token !== null;
    return (
      <AccountFrame
        view={view}
        title={view === 'account' ? titles.account : '保留原身份，设置正式登录'}
        description="此安装已有原账户或历史，不能重新建号或自动认领。"
      >
        {actor ? (
          <section className="space-y-3 rounded-xl border border-border bg-card p-4 sm:p-6">
            <h2 className="text-sm font-medium text-muted-foreground">当前原账户的展示名</h2>
            <p className="text-xl font-semibold leading-8">{actor.user.display_name}</p>
            <Badge variant="secondary">
              {actor.csrf_token !== null ? '原签名会话已核验' : '开发桥身份，不可转正'}
            </Badge>
            <p className="text-base leading-7">
              转正只为这个账户建立正式登录，不更换身份、不合并其他用户，也不迁移原历史归属。
            </p>
          </section>
        ) : null}
        {canClaim && actor ? (
          view === 'claim' ? (
            <AccountForm operation="claim" csrfToken={actor.csrf_token} />
          ) : (
            <div className="space-y-3">
              <Button asChild>
                <a href="/claim">明确转正当前原账户</a>
              </Button>
              {view !== 'account' ? (
                <Button asChild variant="ghost">
                  <a href="/account">返回账户</a>
                </Button>
              ) : null}
            </div>
          )
        ) : (
          <>
            <Alert>
              <AlertTitle>需要部署者在本机维护</AlertTitle>
              <AlertDescription>
                当前没有符合转正条件的原签名会话。会话失效不是空安装；开发桥身份也不能认领账户。请部署者在原安装明确选择并确认原账户，已有口令须验证，不能在此覆盖。
              </AlertDescription>
            </Alert>
            <AccountMaintenance />
          </>
        )}
        <div className="flex flex-wrap gap-3">
          <Button asChild variant="outline">
            <a href={retryHref}>重新读取状态</a>
          </Button>
          {view !== 'account' && !canClaim ? (
            <Button asChild variant="ghost">
              <a href="/account">返回账户</a>
            </Button>
          ) : null}
          {view === 'account' ? (
            <Button asChild variant="ghost">
              <a href="/">返回今日</a>
            </Button>
          ) : null}
          {view === 'account' && actor?.csrf_token != null ? (
            <Button asChild variant="ghost">
              <a href="/logout">退出当前会话</a>
            </Button>
          ) : null}
        </div>
      </AccountFrame>
    );
  }

  if (view === 'setup' || view === 'claim') {
    return (
      <AccountFrame
        view={view}
        title={titles[view]}
        description="此安装的管理员已配置，不再开放首次建号或原身份转正。"
      >
        <Alert>
          <AlertTitle>请继续使用原账户</AlertTitle>
          <AlertDescription>
            原身份和历史保持不变。不要重新建号或用此页覆盖已有口令；需要维护时请联系部署者。
          </AlertDescription>
        </Alert>
        <div className="flex flex-col gap-3">
          <Button asChild>
            <a href={actor ? '/account' : loginHref('/account')}>
              {actor ? '查看当前账户' : '正式登录'}
            </a>
          </Button>
          <Button asChild variant="ghost">
            <a href="/account">返回账户</a>
          </Button>
        </div>
      </AccountFrame>
    );
  }

  if (!actor) {
    return (
      <AccountFrame
        view={view}
        title={titles.account}
        description="管理员已配置，当前没有有效会话。"
      >
        <Alert>
          <AlertTitle>登录后查看当前身份</AlertTitle>
          <AlertDescription>
            管理员绑定保持不变，不会因退出或会话失效重新开放建号。正式登录后只读返回原页面。
          </AlertDescription>
        </Alert>
        <Button asChild>
          <a href={loginHref(destination)}>正式登录</a>
        </Button>
        <AccountMaintenance />
      </AccountFrame>
    );
  }
  const workspace = status.workspace_state;
  const workspaceLabel =
    workspace === 'loaded'
      ? '登记已加载'
      : workspace === 'unconfigured'
        ? '尚未配置'
        : workspace === 'invalid'
          ? '登记无效'
          : workspace === 'unreadable'
            ? '登记不可读'
            : '状态未知';
  const workspaceMessage =
    workspace === 'loaded'
      ? '仅表示资料工作区登记已加载，不证明模型、文件存在或所有资料能力可用。实际资料范围以任务入口读取的登记为准。'
      : workspace === 'unconfigured'
        ? '账户已配置，资料工作区尚未配置。原身份和历史仍然保留。'
        : workspace === 'invalid'
          ? '资料工作区登记无效，请部署者检查原配置；账户和历史仍然保留。'
          : workspace === 'unreadable'
            ? '资料工作区登记不可读，请部署者检查原安装；账户和历史仍然保留。'
            : '当前响应没有提供可核验的工作区状态，不能认定资料或模型能力已就绪。';
  return (
    <AccountFrame
      view="account"
      title={titles.account}
      description="确认当前身份、会话边界与原安装的资料登记状态。"
    >
      <section
        className="space-y-4 rounded-xl border border-border bg-card p-4 sm:p-6"
        aria-labelledby="account-identity-title"
      >
        <h2 id="account-identity-title" className="text-sm font-medium text-muted-foreground">
          当前账户的展示名
        </h2>
        <p className="text-2xl font-semibold leading-9">{actor.user.display_name}</p>
        <Badge variant="secondary">
          {actor.csrf_token !== null ? '签名会话已核验' : '开发桥身份'}
        </Badge>
        <p className="text-base leading-7 text-muted-foreground">
          {actor.csrf_token !== null
            ? '正式会话固定七天到期，读取页面不会续期。退出只撤销当前会话，不删除原身份或历史。'
            : '此身份不提供会话绑定的 CSRF 凭据，不能用于原账户转正或撤销正式会话。请部署者关闭开发桥并使用正式登录。'}
        </p>
        <details className="text-sm">
          <summary className="flex min-h-11 cursor-pointer items-center text-primary underline-offset-4 hover:underline focus-visible:rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
            技术信息
          </summary>
          <dl className="space-y-2 leading-6">
            <dt className="text-muted-foreground">完整身份标识</dt>
            <dd className="select-text font-mono">{actor.user.id}</dd>
            <dt className="text-muted-foreground">已确认时区</dt>
            <dd>{actor.confirmed_timezone ?? '未确认；不会以浏览器时区补写提醒'}</dd>
          </dl>
        </details>
      </section>
      <section className="space-y-3" aria-labelledby="account-workspace-title">
        <div className="flex flex-wrap items-center gap-3">
          <h2 id="account-workspace-title" className="text-lg font-semibold">
            资料工作区
          </h2>
          <Badge variant="outline">{workspaceLabel}</Badge>
        </div>
        <p className="text-base leading-7 text-muted-foreground">{workspaceMessage}</p>
      </section>
      <AccountMaintenance />
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
        <Button asChild variant="outline">
          <a href="/account">重新读取状态</a>
        </Button>
        <Button asChild variant="ghost">
          <a href="/">返回今日</a>
        </Button>
        {actor.csrf_token !== null ? (
          <Button asChild variant="ghost">
            <a href="/logout">退出当前会话</a>
          </Button>
        ) : (
          <Button asChild variant="ghost">
            <a href={loginHref('/account')}>使用正式登录</a>
          </Button>
        )}
      </div>
    </AccountFrame>
  );
}
