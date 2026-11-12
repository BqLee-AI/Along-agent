import WorkspaceLink from '@/shell/view/workspace-link';
import type { ReactNode } from 'react';
import { Badge } from '@lorelum/lumen-ui/components/badge';
import { Button } from '@lorelum/lumen-ui/components/button';
import { loginHref } from '@/shared/session/navigation';
import type { AccountScreenState, AccountView } from '../model/account';
import AccountDashboard from './AccountDashboard';
import AccountForm from './AccountForm';
import { AccountFrame } from './AccountFrame';
import { AccountMaintenance, AccountReadError, AccountStatusNotice } from './AccountSupport';

const titles: Record<AccountView, string> = {
  account: '账户',
  login: '登录 Along',
  setup: '首次设置管理员',
  claim: '为原账户设置正式登录',
  logout: '退出当前会话',
};

function AccountLink({
  href,
  children,
  primary = false,
}: {
  href: string;
  children: ReactNode;
  primary?: boolean;
}) {
  return (
    <Button
      variant={primary ? 'solid' : 'clear'}
      color={primary ? 'primary' : 'default'}
      role="link"
      nativeButton={false}
      render={<WorkspaceLink href={href} />}
    >
      {children}
    </Button>
  );
}

function AccountRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-h-12 items-center justify-between gap-6 py-3">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}

/** Presentation only: the server viewmodel owns all reads and eligibility decisions. */
export default function AccountScreen({ state }: { state: AccountScreenState }) {
  const { view, destination, retryHref } = state;
  if (state.mode === 'account-error') {
    return (
      <AccountFrame
        view={view}
        title={titles.account}
        description="账户资料暂时无法核验；不会将读取失败视为成功或执行任何写入。"
      >
        <AccountReadError failure={state.failure} accountOnly />
        <AccountLink href={retryHref} primary>
          重新读取账户
        </AccountLink>
      </AccountFrame>
    );
  }
  if (state.mode === 'status-error' || state.mode === 'identity-error') {
    return (
      <AccountFrame
        view={view}
        title={titles[view]}
        description={
          state.mode === 'identity-error'
            ? '安装状态获取成功，当前会话仍需单独核验。'
            : '先核验原安装状态，再决定安全的下一步。'
        }
      >
        {state.mode === 'identity-error' ? (
          <Badge variant="glass">
            {state.status.state === 'ready' ? '管理员已配置' : '需保留原身份完成转正'}
          </Badge>
        ) : null}
        <AccountReadError failure={state.failure} identityOnly={state.mode === 'identity-error'} />
        <div className="flex flex-wrap gap-3">
          <AccountLink href={retryHref} primary>
            重新读取账户状态
          </AccountLink>
          {view !== 'account' ? <AccountLink href="/account">返回账户</AccountLink> : null}
        </div>
      </AccountFrame>
    );
  }
  if (state.mode === 'setup') {
    return (
      <AccountFrame
        view={view}
        title={titles[view]}
        description="服务端已确认这是空安装，尚未建立管理员账户。"
      >
        <AccountStatusNotice kind="setup" />
        {view === 'setup' ? (
          <AccountForm operation="initialize" />
        ) : (
          <div className="space-y-3">
            {view === 'logout' ? (
              <p className="text-sm leading-6">
                此安装尚无可撤销的管理员会话；打开此页没有执行退出。
              </p>
            ) : null}
            <div className="flex flex-wrap gap-3">
              <AccountLink href="/setup" primary>
                开始首次设置
              </AccountLink>
              {view !== 'account' ? <AccountLink href="/account">返回账户</AccountLink> : null}
            </div>
          </div>
        )}
        <p className="text-sm leading-[22px] text-muted-foreground">
          账户建立后，再由部署者完成本机资料登记。这里不设置模型或宿主资料路径。
        </p>
      </AccountFrame>
    );
  }
  if (state.mode === 'login') {
    return (
      <AccountFrame view={view} title="欢迎回来" description="登录 Along，继续你的对话与日常安排。">
        <AccountForm key={destination} operation="sign-in" returnTo={destination} />
        <details className="border-t border-border/60 pt-3 text-sm">
          <summary className="min-h-8 max-lg:min-h-11 cursor-pointer content-center text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
            登录遇到问题？
          </summary>
          <div className="space-y-3 pt-3 leading-[22px] text-muted-foreground">
            <p>可明确选择用户名或已验证联系邮箱登录；用户名不区分大小写。</p>
            <p>
              支持密码管理器自动填充和粘贴。不开放公众注册；受邀者通过邮件链接设置账户后正式登录。
            </p>
            <AccountLink href="/forgot-password">使用已验证邮箱找回密码</AccountLink>
            <p>
              登录成功后返回{state.destinationLabel}
              ，不会自动发送消息或提交批准等操作。登录请求的口令不会保存在本应用中。
            </p>
            <AccountLink href="/account">查看账户状态</AccountLink>
          </div>
        </details>
      </AccountFrame>
    );
  }
  const { actor, canClaim, canSignOut } = state;
  if (state.mode === 'logout') {
    return (
      <AccountFrame
        view={view}
        title={titles.logout}
        description="仅明确提交才会请求撤销当前会话。"
      >
        {actor ? (
          <div className="space-y-5">
            <div className="space-y-1">
              <p className="text-sm leading-[22px] text-muted-foreground">当前用户</p>
              <p className="text-sm font-medium leading-6">{actor.user.display_name}</p>
            </div>
            {canSignOut ? (
              <AccountForm
                key={`${actor.user.id}:${actor.csrf_token}`}
                operation="sign-out"
                csrfToken={actor.csrf_token}
              />
            ) : (
              <>
                <AccountStatusNotice kind="unsigned" />
                <AccountLink href="/account">返回账户</AccountLink>
              </>
            )}
          </div>
        ) : (
          <>
            <AccountStatusNotice kind="unauthenticated" />
            <div className="flex flex-wrap gap-3">
              <AccountLink href={loginHref('/account')} primary>
                正式登录
              </AccountLink>
              <AccountLink href="/account">返回账户</AccountLink>
            </div>
          </>
        )}
      </AccountFrame>
    );
  }
  if (state.mode === 'legacy') {
    return (
      <AccountFrame
        view={view}
        title={view === 'account' ? titles.account : '保留原身份，设置正式登录'}
        description="此安装已有原账户或历史，不能重新建号或自动认领。"
      >
        {actor ? (
          <section
            className="space-y-3 border-b border-border/60 pb-5"
            aria-labelledby="legacy-identity-title"
          >
            <h2 id="legacy-identity-title" className="text-sm leading-[22px] text-muted-foreground">
              当前原账户
            </h2>
            <p className="text-sm font-medium leading-6">{actor.user.display_name}</p>
            <Badge variant="glass">
              {canSignOut ? '原签名会话已核验' : '开发桥身份，不可转正'}
            </Badge>
            <p className="text-sm leading-[22px] text-muted-foreground">
              转正只为这个账户建立正式登录，不更换身份、不合并其他用户，也不迁移原历史归属。
            </p>
          </section>
        ) : null}
        {canClaim && actor ? (
          view === 'claim' ? (
            <AccountForm
              key={`${actor.user.id}:${actor.csrf_token}`}
              operation="claim"
              csrfToken={actor.csrf_token}
            />
          ) : (
            <AccountLink href="/claim" primary>
              明确转正当前原账户
            </AccountLink>
          )
        ) : (
          <>
            <AccountStatusNotice kind="legacy" />
            <AccountMaintenance />
          </>
        )}
        <div className="flex flex-wrap gap-3">
          <AccountLink href={retryHref}>重新读取状态</AccountLink>
          {view !== 'account' ? (
            <AccountLink href="/account">返回账户</AccountLink>
          ) : (
            <AccountLink href="/">返回今日</AccountLink>
          )}
          {view === 'account' && canSignOut ? (
            <AccountLink href="/logout">退出当前会话</AccountLink>
          ) : null}
        </div>
      </AccountFrame>
    );
  }
  if (state.mode === 'configured') {
    return (
      <AccountFrame
        view={view}
        title={titles[view]}
        description="此安装的管理员已配置，不再开放首次建号或原身份转正。"
      >
        <AccountStatusNotice kind="configured" />
        <div className="flex flex-wrap gap-3">
          <AccountLink href={actor ? '/account' : loginHref('/account')} primary>
            {actor ? '查看当前账户' : '正式登录'}
          </AccountLink>
          <AccountLink href="/account">返回账户</AccountLink>
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
        <AccountStatusNotice kind="login" />
        <AccountLink href={loginHref(destination)} primary>
          正式登录
        </AccountLink>
      </AccountFrame>
    );
  }
  const name = actor.user.display_name;
  return (
    <AccountFrame view="account" title={titles.account} description="">
      <section className="flex items-center gap-4" aria-label="当前用户">
        <span
          className="grid size-14 shrink-0 place-items-center rounded-full bg-foreground/10 text-xl font-semibold"
          aria-hidden="true"
        >
          {name.slice(0, 1).toUpperCase()}
        </span>
        <div className="min-w-0 space-y-1">
          <p className="truncate text-lg leading-6 font-semibold">{name}</p>
          <Badge variant="glass">{canSignOut ? '已登录' : '临时身份'}</Badge>
        </div>
      </section>
      <dl className="divide-y divide-separator rounded-xl bg-foreground/5 px-4 text-sm">
        <AccountRow label="显示名称">{name}</AccountRow>
        <AccountRow label="时区">{actor.confirmed_timezone ?? '未设置'}</AccountRow>
        {state.account ? (
          <AccountRow label="联系邮箱">
            {state.account.contact.state === 'verified'
              ? (state.account.contact.masked_email ?? '已验证')
              : '未绑定'}
          </AccountRow>
        ) : null}
        <AccountRow label="可处理的资料">
          <span className="inline-flex items-center gap-2">
            <Badge variant="glass">{state.workspaceLabel}</Badge>
          </span>
        </AccountRow>
        <AccountRow label="账户编号">
          <span className="select-text font-mono text-xs">{actor.user.id}</span>
        </AccountRow>
      </dl>
      <div className="space-y-1 text-[13px] leading-5 text-muted-foreground">
        {actor.confirmed_timezone ? null : (
          <p>还没设置时区。Along 不会用浏览器的时区替你设置提醒时间。</p>
        )}
        <p>{state.workspaceMessage}</p>
        <p>
          {canSignOut
            ? '登录有效期七天，到期后需要重新登录。退出登录只结束当前登录，不会删除账户或聊天记录。'
            : '当前是开发用的临时身份，不能退出登录，也不能升级为正式登录。请联系部署者关闭它，改用正式登录。'}
        </p>
      </div>
      <div className="flex flex-wrap gap-3">
        {canSignOut ? (
          <AccountLink href="/logout">退出登录</AccountLink>
        ) : (
          <AccountLink href={loginHref('/account')}>改用正式登录</AccountLink>
        )}
      </div>
      {state.account && actor.csrf_token !== null ? (
        <AccountDashboard account={state.account} csrfToken={actor.csrf_token} />
      ) : (
        <AccountMaintenance />
      )}
    </AccountFrame>
  );
}
