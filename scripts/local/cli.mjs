import path from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { failure, run } from './commands.mjs';

const usage = `本机生命周期（Bun 1.4.2 / Windows + Docker Linux x64）
  bun --no-env-file run local:init --new [--config <私有 JSON>]
  bun --no-env-file run local:init --adopt [--config <私有 JSON>]
  bun --no-env-file run local:start [--config <私有 JSON>]
  bun --no-env-file run local:stop [--config <私有 JSON>]
  bun --no-env-file run local:upgrade [--config <私有 JSON>]
  bun --no-env-file run local:account [--admit | --workspace] [--config <私有 JSON>]
  --admit：明确选择原普通用户并验证/设置本人凭证后准入，不绑定管理员
  --workspace：明确选择已准入 owner，有限新增工作区，保留全部原登记
已有配置时 local:init 只复用，不覆盖；首次 --new/--adopt 通过终端输入。
未登录、缺模型或工作区均独立提示；启动不自动发模型请求。`;

function options(args) {
  const [action, ...rest] = args;
  if (!['init', 'start', 'stop', 'upgrade', 'account'].includes(action))
    throw failure('ARGUMENT_INVALID');
  const value = { action, mode: null, operation: 'administrator', file: null, help: false };
  for (let index = 0; index < rest.length; index++) {
    const flag = rest[index];
    if (flag === '--help' || flag === '-h') value.help = true;
    else if (flag === '--config' && rest[index + 1] && !value.file)
      value.file = path.resolve(rest[++index]);
    else if (['--new', '--adopt'].includes(flag) && !value.mode && action === 'init')
      value.mode = flag.slice(2);
    else if (
      ['--admit', '--workspace'].includes(flag) &&
      value.operation === 'administrator' &&
      action === 'account'
    )
      value.operation = flag.slice(2);
    else throw failure('ARGUMENT_INVALID');
  }
  return value;
}

async function prepareDependencies(action) {
  const require = createRequire(import.meta.url);
  try {
    require.resolve('pg');
    require.resolve('zod');
  } catch {
    if (action !== 'init') throw failure('PREPARATION_REQUIRED');
    const cache = await mkdtemp(path.join(tmpdir(), 'along-dependencies-'));
    try {
      await run(
        process.execPath,
        [
          '--no-env-file',
          'install',
          '--frozen-lockfile',
          '--backend=copyfile',
          '--cache-dir',
          cache,
        ],
        { cwd: path.resolve(import.meta.dirname, '../..'), code: 'DEPENDENCY_INSTALL_FAILED' },
      );
    } finally {
      await rm(cache, { recursive: true, force: true });
    }
  }
}

async function newInstallationInput(mode) {
  if (!mode || !process.stdin.isTTY) throw failure('CONFIG_INPUT_REQUIRED');
  const resource = JSON.parse(
    await readFile(
      new URL('../../apps/api/resources/time/fixture-v1.json', import.meta.url),
      'utf8',
    ),
  );
  let muted = false;
  const output = new Writable({
    write(chunk, encoding, done) {
      if (!muted) process.stdout.write(chunk, encoding);
      done();
    },
  });
  const input = createInterface({ input: process.stdin, output, terminal: true });
  const ask = async (label, fallback, hidden = false) => {
    process.stdout.write(`${label}${fallback === undefined ? '' : ` [${fallback}]`}: `);
    muted = hidden;
    try {
      const answer = await input.question('');
      const text = hidden ? answer : answer.trim();
      return text || fallback;
    } finally {
      muted = false;
      if (hidden) process.stdout.write('\n');
    }
  };
  try {
    const values = {
      mode,
      ports: {
        postgres: Number(await ask('PG loopback 端口', 55432)),
        api: Number(await ask('API loopback 端口', 3000)),
        web: Number(await ask('Web loopback 端口', 3100)),
      },
      tzdbVersion: await ask(
        'TZDB_VERSION（必须与本版本时间资源相符）',
        mode === 'new' ? resource.tzdb_version : undefined,
      ),
    };
    if (mode === 'adopt') {
      console.log('接入前请手动停止原 API/worker/Web；本入口不认领未知进程或创建替代数据。');
      Object.assign(values, {
        version: 1,
        installationId: randomUUID(),
        project: await ask('原 Compose 项目名'),
        postgresVolume: await ask('原 PG 卷名'),
        workspaceVolume: await ask('原资料卷名'),
        workspaceMount: await ask('原资料容器挂载位置', '/var/lib/along/workspaces'),
        database: {
          user: await ask('原数据库用户'),
          password: await ask('原数据库密码（隐藏输入）', undefined, true),
          name: await ask('原数据库名'),
        },
        authSecret: await ask('原 BETTER_AUTH_SECRET（隐藏输入，不能遗失或替换）', undefined, true),
        origin: await ask('原 APP_ORIGIN / Web origin（隐藏输入）', undefined, true),
        registryFile: (await ask('原登记 JSON 绝对路径；原本无登记才可留空', '', true)) || null,
        model: null,
      });
    }
    const model = await ask(
      mode === 'adopt'
        ? '原部署有模型配置？有请填 y；原本无配置回车'
        : '配置已授权模型？填 y；暂不配置回车',
      'n',
    );
    if (model === 'y') {
      values.model = {
        baseUrl: await ask('HARNESS_MODEL_BASE_URL（隐藏输入）', undefined, true),
        name: await ask('HARNESS_MODEL（不提供默认替代值）', undefined, true),
        apiKey: await ask('HARNESS_MODEL_API_KEY（隐藏输入；原服务无认证才留空）', '', true),
        maxIterations: Number(await ask('HARNESS_MAX_ITERATIONS', 24)),
        maxTokens: Number(await ask('HARNESS_MAX_TOKENS', 64000)),
        completionCap: Number(
          await ask('HARNESS_COMPLETION_CAP（必填：独立单次输出上限；不借用 Run 预算）'),
        ),
        reserveTokens: Number(await ask('HARNESS_CONTEXT_RESERVE_TOKENS', 0)),
      };
      const window = await ask(
        'HARNESS_MODEL_WINDOW_TOKENS（可选：有依据的模型窗口；未知留空）',
        '',
      );
      values.model.modelWindowTokens = window === '' ? null : Number(window);
    }
    return values;
  } finally {
    input.close();
  }
}

const explanations = {
  CONFIG_MISSING: '缺少私有配置；先运行 local:init --new 或 --adopt。不要重建原安装密钥。',
  CONFIG_INPUT_REQUIRED:
    '首次初始化需在交互终端显式选择 --new 或 --adopt。已有部署请先恢复原配置和登记。',
  CONFIG_INVALID:
    '私有 JSON 缺少必填项或字段无效；已配置模型必须显式补 model.completionCap（独立单次输出上限），不能借用 maxTokens。核对指南，不要重建配置或替换原安装密钥。',
  CONFIG_PERMISSIONS: '配置目录或文件不是当前用户专有；请使用专用私有目录并修复权限。',
  CONFIG_EXISTS: '配置已存在；重用它，不覆盖原值。',
  PORT_IN_USE: '固定端口已被占用；核实原进程归属并按原部署流程停写，不会抢端口或杀未知进程。',
  UNKNOWN_PROCESS: '不能证明原进程归属；请手动核实并停止原 API/worker/Web，再接入或升级。',
  LOCK_BUSY: '同一安装另有操作正在执行；等待它退出再重试，不删除标记或凭 PID 杀进程。',
  LOCK_UNAVAILABLE: '安装锁的本机监听资源被占用；核实归属后处理，不自动抢占。',
  PREPARATION_REQUIRED: '缺少成套产物或安装记录；先初始化，已准备安装用显式 local:upgrade 修复。',
  UPGRADE_REQUIRED:
    '源码、运行产物或数据库版本不一致；使用显式 local:upgrade，不在普通启动中迁移。',
  UPGRADE_INCOMPLETE:
    '上次升级未完成，写者保持停止；核对备份、账本和失败阶段后显式重试 local:upgrade。',
  DATABASE_UNSUPPORTED:
    '数据库不是完整受支持基线；先备份并人工核对，不猜版本、stamp、重放全量或清库。',
  CONFIG_LOCATION_INVALID: '配置必须位于 checkout 外的专用私有目录，不能把秘密放入代码仓库。',
  CONFIG_RELOAD_REQUIRED:
    '已运行服务的固定地址与配置不同；先 local:stop，再按明确的新配置启动，不在线改绑或抢端口。',
  CONNECTION_FAILED: '数据库不可连接或原认证材料不符；连接失败不是空库，核对原私有配置和 PG 状态。',
  UNMANAGED_DATABASE_CLIENTS:
    '仍有不属于本次停写的数据库客户端；手动核实原 API/worker，停稳后再升级。',
  DEPLOYMENT_BUSY: '同一数据库已有部署操作持许可；待其结束再重试。',
  DEPLOYMENT_LEASE_LOST: '数据库部署许可丢失；保持停写，核对账本后显式重试升级。',
  ORIGINAL_VOLUME_MISSING: '找不到原持久卷；恢复原对象，不创建替代卷。',
  VOLUME_IDENTITY_CHANGED:
    '持久卷身份发生变化；恢复原卷并核对数据和 root 身份，不能以复制新目录修复。',
  BUN_VERSION: '需要 Bun 1.4.2。',
  DOCKER_UNAVAILABLE: 'Docker 不可用；检查正在使用的 Docker Desktop Linux 引擎。',
  DOCKER_PLATFORM: '需要 Linux x64 Docker 引擎，不回退到另一 native 路径。',
  COMPOSE_VERSION: '需要 Docker Compose 2.24.4 或更高版本。',
  ACCOUNT_TERMINAL_REQUIRED: '账户维护需要交互终端；口令不通过 argv 或输出传输。',
  ACCOUNT_POSTGRES_REQUIRED: '请先使用同一配置运行 local:start；账户入口不另建或接管数据库。',
  ACCOUNT_SELECTION_INVALID: '请选择列表中的明确可用序号，不默认认领或输入 owner ID。',
  ACCOUNT_CONFIRMATION_REQUIRED: '未收到明确确认；没有替你选择或授权。',
  ACCOUNT_PASSWORD_MISMATCH: '两次口令不一致；口令未提交。',
  ACCOUNT_INSTALLATION_CHANGED: '安装事实已变化；重新读取并显式维护，不自动重试。',
  CONFIG_VERSION_CONFLICT: '私有配置字节版本已变化；保持原文件并重新读取，不覆盖并发修改。',
  IDENTITY_KEYRING_FILE_INVALID:
    'IDENTITY_KEYRING_FILE 对应的私有 identityKeyringFile 不可读或格式无效；请显式配置独立密钥，不自动生成或沿用 BETTER_AUTH_SECRET。',
  WORKSPACE_REGISTRY_INVALID:
    '登记无效；保留原文件，修复其格式、有限路径或原 root 后重试 local:account。',
  WORKSPACE_REGISTRY_ABSENT: '原配置指定的登记文件缺失；恢复原私有文件，不另建或覆盖原登记。',
  WORKSPACE_REGISTRY_UNREADABLE: '登记不可读；恢复同一私有文件及权限后重试，不覆盖原件。',
  WORKSPACE_OWNER_MISSING: '原登记没有已绑定管理员的工作区；不修改其他 owner，请核对原登记来源。',
  WORKSPACE_ROOT_INVALID: '新 root 必须是原受管资料卷中的明确子目录，不能默认授权整个卷。',
  WORKSPACE_IDENTITY_CHANGED:
    '登记或 root 物理身份已变化；保持原材料，重新核对，不能复制新 root 代替。',
  WORKSPACE_LOAD_FAILED: '配置已保存但登记未确认加载；账户保留，修复后仅重试 local:account 收尾。',
  UNAUTHENTICATED: '原口令不符或账户不活跃；不会重置口令或激活原用户，请核对原材料。',
  STATE_CONFLICT: '原 credential、登录名或管理员绑定冲突；保留原身份，按维护说明核对，不自动合并。',
  NOT_READY:
    '账户依赖或提交结果不可核验；核对 IDENTITY_KEYRING_FILE、APP_ORIGIN、IDENTITY_MAIL_PROVIDER、IDENTITY_MAIL_FROM、IDENTITY_MAIL_API_KEY 的显式配置，保留原安装，不重复开户。',
};

try {
  const request = options(process.argv.slice(2));
  if (request.help) {
    console.log(usage);
  } else {
    await prepareDependencies(request.action);
    const { defaultConfigPath, loadConfig } = await import('./config.mjs');
    const file = request.file ?? defaultConfigPath();
    const { assertExternalConfiguration } = await import('./compose.mjs');
    assertExternalConfiguration(file);
    let initialInput;
    if (request.action === 'init') {
      try {
        await loadConfig(file);
      } catch (error) {
        if (error.code !== 'CONFIG_MISSING') throw error;
        initialInput = await newInstallationInput(request.mode);
      }
    }
    if (request.action === 'account') {
      const { maintainAccount, createAccountTerminalIO } = await import('./account.mjs');
      const io = createAccountTerminalIO();
      try {
        await maintainAccount(file, io, {}, { operation: request.operation });
      } finally {
        io.close();
      }
    } else {
      const runtime = await import('./runtime.mjs');
      const actions = {
        init: runtime.initializeInstallation,
        start: runtime.startInstallation,
        stop: runtime.stopInstallation,
        upgrade: runtime.upgradeInstallation,
      };
      const result = await actions[request.action](file, initialInput);
      console.log(
        result.phase === 'prepared'
          ? result.schema.upgradeRequired
            ? `本安装已准备；原数据库 ${result.schema.version} 尚未升级至 ${result.schema.targetVersion}。API/worker/Web 未启动；必须先显式运行 local:upgrade，不能直接 local:start。`
            : `本安装已准备；数据库 ${result.schema.version} 已核验为目标版本。API/worker/Web 未由初始化启动，可运行 local:start。`
          : result.phase === 'stopped'
            ? '本安装已停止；配置、数据卷和资料保留。'
            : `Web 已启动：${result.webUrl}`,
      );
      if (result.phase !== 'stopped') {
        console.log('账户状态请在 Web 检查；首次建号/登录后用 local:account 完成本机登记。');
        console.log(
          result.model === 'unconfigured'
            ? '模型尚未配置，资料任务能力不可用。'
            : '模型已配置但真实调用未核验；启动没有发出模型请求。',
        );
        const workspace =
          typeof result.workspace === 'string'
            ? result.workspace
            : result.workspace?.state === 'loaded' && result.workspace.accepted === 0
              ? 'unconfigured'
              : result.workspace?.state;
        console.log(
          ['unconfigured', 'unverified'].includes(workspace)
            ? workspace === 'unconfigured'
              ? '工作区尚未配置。'
              : '工作区登记已指定，尚未核验。'
            : workspace === 'loaded'
              ? '工作区登记已加载；访问仍受原 owner 和有限路径规则控制。'
              : '工作区登记读取或资格校验失败，失效项未开放；核对私有登记和原根目录。',
        );
      }
    }
  }
} catch (error) {
  const code =
    typeof error.code === 'string' && /^[A-Z_][A-Z0-9_]{1,63}$/iu.test(error.code)
      ? error.code.toUpperCase()
      : 'LOCAL_OPERATION_FAILED';
  console.error(
    `[${code}] ${explanations[code] ?? '操作失败；检查依赖和专用私有目录内的诊断记录。不会自动清库、换密钥或回退旧写者。'}`,
  );
  process.exitCode = 1;
}
