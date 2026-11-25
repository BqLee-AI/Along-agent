import WorkspaceLink from '@/shell/view/workspace-link';
import type { ReactNode } from 'react';
import { Badge } from '@lorelum/lumen-ui/components/badge';
import { ChevronRight } from 'lucide-react';
import { Button } from '@lorelum/lumen-ui/components/button';
import { loginHref } from '@/shared/session/navigation';
import type { AccountScreenState, AccountView } from '../model/account';
import AccountDashboard from './AccountDashboard';
import AccountForm from './AccountForm';
import { AccountFrame } from './AccountFrame';
import { AccountProfileForm } from './AccountProfileForm';
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

function AccountSectionLink({
  section,
  children,
  summary,
}: {
  section: string;
  children: ReactNode;
  summary?: string | null;
}) {
  return (
    <WorkspaceLink
      href={`/account?section=${section}`}
      className="flex min-h-12 items-center justify-between gap-3 px-4 py-2 text-sm transition-colors hover:bg-foreground/5 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
    >
      <span className="font-medium">{children}</span>
      <span className="flex min-w-0 items-center gap-2 text-right text-muted-foreground">
        {summary ? <span className="wrap-anywhere">{summary}</span> : null}
        <ChevronRight className="size-4 shrink-0" aria-hidden="true" />
      </span>
    </WorkspaceLink>
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
export default function AccountScreen({
  state,
  requestedSection,
}: {
  state: AccountScreenState;
  requestedSection?: string | string[];
}) {
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
  const account = state.account;
  const csrfToken = actor.csrf_token;
  const signed = account !== null && csrfToken !== null;
  const workspaceSummary =
    state.workspaces === null
      ? '暂不可用'
      : state.workspaces.length
        ? `${state.workspaces.length} 个已登记`
        : '未登记';
  const section = typeof requestedSection === 'string' ? requestedSection : null;

  if (section === 'profile') {
    return (
      <AccountFrame view="account" title="个人资料" description="">
        <AccountLink href="/account">返回账户</AccountLink>
        {signed ? (
          <AccountProfileForm
            key={actor.user.id}
            displayName={name}
            timezone={actor.confirmed_timezone}
            csrfToken={csrfToken}
          />
        ) : null}
        <dl className="divide-y divide-separator rounded-xl bg-foreground/5 px-4 text-sm">
          {!signed ? (
            <AccountRow label="默认时区">{actor.confirmed_timezone ?? '未设置'}</AccountRow>
          ) : null}
          <AccountRow label="账户编号">
            <span className="select-text font-mono text-xs">{actor.user.id}</span>
          </AccountRow>
        </dl>
      </AccountFrame>
    );
  }

  if (section === 'workspace') {
    return (
      <AccountFrame view="account" title="工作区登记" description="">
        <AccountLink href="/account">返回账户</AccountLink>
        <WorkspaceRegistration workspaces={state.workspaces} />
      </AccountFrame>
    );
  }

  if (
    signed &&
    (section === 'contact' ||
      section === 'password' ||
      section === 'sessions' ||
      section === 'deletion' ||
      (section === 'admin' && account.installation_admin))
  ) {
    const title = {
      contact: '联系邮箱',
      password: '修改密码',
      sessions: '会话管理',
      deletion: '删除申请',
      admin: '账户管理',
    }[section];
    return (
      <AccountFrame view="account" title={title} description="">
        <AccountLink href="/account">返回账户</AccountLink>
        <AccountDashboard key={section} account={account} csrfToken={csrfToken} section={section} />
      </AccountFrame>
    );
  }

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
      <nav aria-label="账户设置分区" className="space-y-5">
        <div className="divide-y divide-separator rounded-xl border border-separator bg-foreground/5">
          <AccountSectionLink section="profile" summary={actor.confirmed_timezone ?? '时区未设置'}>
            个人资料
          </AccountSectionLink>
          <AccountSectionLink section="workspace" summary={workspaceSummary}>
            工作区登记
          </AccountSectionLink>
        </div>
        {signed ? (
          <section className="space-y-2" aria-labelledby="account-security">
            <h2 id="account-security" className="text-sm font-semibold text-muted-foreground">
              账户安全
            </h2>
            <div className="divide-y divide-separator rounded-xl border border-separator bg-foreground/5">
              <AccountSectionLink
                section="contact"
                summary={
                  account.pending_contact
                    ? '待验证'
                    : account.contact.state === 'verified'
                      ? account.contact.masked_email
                      : '未绑定'
                }
              >
                联系邮箱
              </AccountSectionLink>
              <AccountSectionLink section="password">修改密码</AccountSectionLink>
              <AccountSectionLink section="sessions">会话管理</AccountSectionLink>
              {!account.installation_admin ? (
                <AccountSectionLink section="deletion">删除申请</AccountSectionLink>
              ) : null}
            </div>
          </section>
        ) : null}
        {signed && account.installation_admin ? (
          <div className="rounded-xl border border-separator bg-foreground/5">
            <AccountSectionLink section="admin" summary="邀请与账户">
              管理员设置
            </AccountSectionLink>
          </div>
        ) : null}
      </nav>
      <div className="flex flex-wrap gap-3">
        {canSignOut ? (
          <AccountLink href="/logout">退出登录</AccountLink>
        ) : (
          <AccountLink href={loginHref('/account')}>改用正式登录</AccountLink>
        )}
      </div>
      {!signed ? <AccountMaintenance /> : null}
    </AccountFrame>
  );
}

function WorkspaceRegistration({
  workspaces,
}: {
  workspaces: Extract<AccountScreenState, { workspaces: unknown }>['workspaces'];
}) {
  return (
    <section
      id="workspace-registration"
      aria-label="登记的工作区"
      className="space-y-3 rounded-xl border border-separator bg-foreground/5 p-4 text-sm"
    >
      {workspaces === null ? (
        <p className="text-muted-foreground">暂时无法读取登记。</p>
      ) : workspaces.length === 0 ? (
        <p className="text-muted-foreground">还没有登记工作区。</p>
      ) : (
        <ul className="divide-y divide-separator">
          {workspaces.map((workspace) => (
            <li key={workspace.workspace_id} className="space-y-1 py-2">
              <p className="font-medium">{workspace.label}</p>
              <dl className="space-y-1 text-xs text-muted-foreground">
                <div className="flex gap-2">
                  <dt className="shrink-0">可读</dt>
                  <dd>
                    {workspace.readable_paths.map((path) => path || '工作区根目录').join('、') ||
                      '无'}
                  </dd>
                </div>
                <div className="flex gap-2">
                  <dt className="shrink-0">可写</dt>
                  <dd>
                    {workspace.writable_paths.map((path) => path || '工作区根目录').join('、') ||
                      '无'}
                  </dd>
                </div>
              </dl>
            </li>
          ))}
        </ul>
      )}
      <details>
        <summary className="w-fit cursor-pointer font-medium text-brand-ink">登记目录</summary>
        <p className="mt-2 text-muted-foreground">
          在 Along 所在的主机运行以下命令，并按提示选择账户和目录。
        </p>
        <code className="mt-2 block rounded-lg bg-background p-2 text-xs">
          {'bun --no-env-file run local:account --workspace --config "<安装配置文件>"'}
        </code>
      </details>
    </section>
  );
}
