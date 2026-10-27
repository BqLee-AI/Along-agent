import { authStatusSchema } from '@along/contracts';
import { apiGet } from '../../lib/api';
import { loginHref, safeReturnTo } from '../../lib/account-navigation';
import { MeSchema } from '../../lib/types';
import AccountForm from './AccountForm';

export default async function AccountScreen({
  view,
  returnTo,
}: {
  view: 'account' | 'login' | 'setup' | 'claim' | 'logout';
  returnTo?: unknown;
}) {
  const destination = safeReturnTo(returnTo);
  const statusResult = await apiGet<unknown>('/api/v1/auth/status');
  if (!statusResult.ok)
    return (
      <section>
        <h1>账户状态暂不可核验</h1>
        <p className="error" role="alert">
          {statusResult.message}
        </p>
        <p>无法确认是否为空安装，当前不提供建号。请部署者检查认证服务后重新读取，不要另建安装。</p>
        <a href="/account">重新读取账户状态</a>
      </section>
    );
  const parsed = authStatusSchema.safeParse(statusResult.data);
  if (!parsed.success)
    return (
      <section>
        <h1>账户状态响应无效</h1>
        <p className="error" role="alert">
          无法核验安装状态，未开放建号。请部署者检查服务版本。
        </p>
        <a href="/account">重新读取账户状态</a>
      </section>
    );
  const status = parsed.data;
  if (status.state === 'setup_required')
    return (
      <section className="account-page">
        <h1>首次设置管理员账户</h1>
        <p>服务端已确认这是空安装。此安装只有一个管理员，不提供公众注册。</p>
        {view === 'setup' ? (
          <AccountForm operation="initialize" />
        ) : (
          <p>
            <a href={`/setup?${new URLSearchParams({ returnTo: destination })}`}>开始首次设置</a>
          </p>
        )}
        <p className="muted">
          账户建立后，再由部署者完成本机工作区登记。这里不设置模型或宿主资料路径。
        </p>
      </section>
    );
  if (view === 'login' && status.state === 'ready')
    return (
      <section className="account-page">
        <h1>登录 Along</h1>
        <p>使用此安装已绑定管理员的登录名和密码。</p>
        <AccountForm operation="sign-in" returnTo={destination} />
      </section>
    );
  const meResult = await apiGet<unknown>('/api/v1/me');
  if (!meResult.ok && meResult.status !== 401)
    return (
      <section>
        <h1>账户</h1>
        <p className="error" role="alert">
          {meResult.message}
        </p>
        <p>当前会话无法核验，未将服务错误视作已退出。请重新读取状态。</p>
        <a href="/account">重新读取</a>
      </section>
    );
  const me = meResult.ok ? MeSchema.safeParse(meResult.data) : null;
  if (me && !me.success)
    return (
      <section>
        <h1>账户</h1>
        <p className="error" role="alert">
          当前会话响应无效，请部署者检查服务版本。
        </p>
        <a href="/account">重新读取</a>
      </section>
    );
  const actor = me?.success ? me.data : null;
  if (status.state === 'legacy_claim_required')
    return (
      <section className="account-page">
        <h1>保留原身份，完成正式登录设置</h1>
        <p>此安装已有原账户或历史，不能重新建号或自动认领。</p>
        {status.can_claim === true && actor && actor.csrf_token !== null ? (
          <>
            <p>
              当前签名会话用户：<strong>{actor.user.display_name}</strong>
              。提交前请确认这是你的原账户。
            </p>
            {view === 'claim' ? (
              <AccountForm operation="claim" csrfToken={actor.csrf_token} />
            ) : (
              <a href="/claim">明确转正当前账户</a>
            )}
          </>
        ) : (
          <div className="panel">
            <h2>需要部署者在本机维护</h2>
            <p>当前没有可用于转正的旧签名会话，或此账户不符合转正条件。开发桥身份不能用于认领。</p>
            <p>
              请部署者在原安装使用正式 <code>local:account</code>{' '}
              维护入口，明确选择并确认原账户；已有密码须验证原口令，不能通过此页覆盖。
            </p>
            <p>
              <code>bun --no-env-file run local:account --config &lt;原私有配置&gt;</code>
            </p>
            <p>使用已启动且已升级到 0017 的同一安装；不要在命令参数中传递口令或 owner。</p>
            <p>不要重新初始化、合并其他 owner、复制身份 ID 或更换原卷及认证密钥。</p>
          </div>
        )}
        <p>
          <a href="/account">重新读取账户状态</a>
        </p>
      </section>
    );
  if (!actor)
    return (
      <section className="account-page">
        <h1>账户已配置</h1>
        <p>当前没有有效会话。管理员绑定保持不变，不会重新开放建号。</p>
        <a href={loginHref(destination)}>正式登录</a>
      </section>
    );
  const workspace = status.workspace_state;
  const workspaceMessage =
    workspace === 'loaded'
      ? '工作区登记已加载。这不表示模型或所有资料能力可用。'
      : workspace === 'unconfigured'
        ? '账户已配置，工作区尚未配置。'
        : workspace === 'invalid'
          ? '工作区登记无效；账户和历史仍然保留。'
          : workspace === 'unreadable'
            ? '工作区登记不可读；账户和历史仍然保留。'
            : '当前响应未提供可核验的工作区状态，不能认定资料能力已就绪。';
  return (
    <section className="account-page">
      <h1>{view === 'logout' ? '退出当前会话' : '账户'}</h1>
      <p>
        当前用户：<strong>{actor.user.display_name}</strong>
      </p>
      <div className="panel">
        <h2>账户已配置</h2>
        <p>正式会话固定七天到期，读取不会续期。</p>
        <h2>工作区状态</h2>
        <p>{workspaceMessage}</p>
        {workspace !== 'loaded' ? (
          <>
            <p>
              请部署者在原安装运行正式本机维护，检查并完成登记/配置重载。如果配置已保存但重载失败，只补做未完成的步骤，不要重新建号或更换原资料目录。
            </p>
            <p>
              <code>bun --no-env-file run local:account --config &lt;原私有配置&gt;</code>
            </p>
          </>
        ) : null}
      </div>
      {view === 'logout' ? (
        actor.csrf_token !== null ? (
          <AccountForm operation="sign-out" csrfToken={actor.csrf_token} />
        ) : (
          <p className="error" role="alert">
            当前是开发桥身份，不是可撤销的正式签名会话。请部署者关闭开发桥后使用正式登录。
          </p>
        )
      ) : (
        <div className="actions">
          <a href="/logout">退出当前会话</a>
          <a href="/">返回今日</a>
          <a href="/account">重新读取状态</a>
        </div>
      )}
    </section>
  );
}
