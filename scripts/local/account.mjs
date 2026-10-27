import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import pg from 'pg';
import { loadConfig, updateConfig, loadPrivateJson, savePrivateJson } from './config.mjs';
import { withInstallationLock } from './lock.mjs';
import { DeploymentDatabase, hostDatabaseUrl } from './database.mjs';
import { preparedArtifact } from './artifacts.mjs';
import { failure, readJson } from './commands.mjs';
import {
  assertExternalConfiguration,
  assertLoopbackBinding,
  assertOwned,
  checkDependencies,
  compose,
  installationDirectory,
  projectContainers,
  verifyVolumes,
} from './compose.mjs';
import { reloadInstallation } from './runtime.mjs';

export function createAccountTerminalIO() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw failure('ACCOUNT_TERMINAL_REQUIRED');
  let hidden = false;
  const output = new Writable({
    write(chunk, encoding, done) {
      if (!hidden) process.stdout.write(chunk, encoding);
      done();
    },
  });
  const terminal = createInterface({ input: process.stdin, output, terminal: true });
  return {
    write: (message) => console.log(message),
    async ask(label, { secret = false } = {}) {
      process.stdout.write(`${label}: `);
      hidden = secret;
      try {
        const value = await terminal.question('');
        return secret ? value : value.trim();
      } finally {
        hidden = false;
        if (secret) process.stdout.write('\n');
      }
    },
    close: () => terminal.close(),
  };
}

const registryProgram = `
import {configureWorkspaceRegistry,listWorkspaces,getWorkspaceGrant} from './apps/api/dist/modules/workspaces/service.js';
const input=JSON.parse(await Bun.stdin.text());
const report=await configureWorkspaceRegistry(input);
const owners=Array.isArray(input)?[...new Set(input.map(v=>v?.owner_id).filter(v=>typeof v==='string'))]:[];
const grants=owners.flatMap(owner=>listWorkspaces(owner).map(item=>getWorkspaceGrant(owner,item.workspace_id)));
console.log(JSON.stringify({...report,ownerIds:[...new Set(grants.map(v=>v.owner_id))],grants}));
`;

async function prepare(file, config) {
  const directory = installationDirectory(file, config);
  await checkDependencies();
  const pending = await readJson(path.join(directory, 'upgrade.json'));
  if (pending && pending.phase !== 'complete') throw failure('UPGRADE_INCOMPLETE');
  await verifyVolumes(config, directory);
  const artifact = await preparedArtifact(config, directory);
  const containers = await projectContainers(config);
  assertOwned(containers, config);
  const postgres = containers.find(
    (item) => item.labels?.['com.docker.compose.service'] === 'postgres',
  );
  if (!postgres?.running) throw failure('ACCOUNT_POSTGRES_REQUIRED');
  assertLoopbackBinding(postgres, 5432, config.ports.postgres);
  const database = new DeploymentDatabase({
    connectionString: hostDatabaseUrl(config),
    migrationsDirectory: path.join(artifact.source, 'infra/migrations'),
    verificationDirectory: path.join(artifact.source, 'scripts/local/baselines'),
  });
  try {
    await database.connect();
    await database.acquireLease();
    const state = await database.classify();
    if (state.kind !== 'supported') throw failure('DATABASE_UNSUPPORTED');
    if (state.version !== database.targetVersion || state.version < '0017')
      throw failure('UPGRADE_REQUIRED');
  } finally {
    await database.close();
  }
  return { directory, artifact };
}

async function openIdentity(config, context, workspaceStatus) {
  const { createAccountService } = await import(
    pathToFileURL(
      path.join(context.artifact.source, 'apps/api/src/modules/identity/account-service.ts'),
    ).href
  );
  const pool = new pg.Pool({
    host: '127.0.0.1',
    port: config.ports.postgres,
    user: config.database.user,
    password: config.database.password,
    database: config.database.name,
    ssl: false,
    max: 1,
    connectionTimeoutMillis: 5000,
    application_name: 'along-local-account',
    options: '-c search_path=public,pg_catalog',
    replication: 'false',
    client_encoding: 'UTF8',
  });
  pool.on('error', () => {});
  return {
    service: createAccountService(pool, {
      secret: config.authSecret,
      origin: config.origin,
      workspaceStatus,
    }),
    close: () => pool.end(),
  };
}

async function verifyRegistry(config, context, input) {
  return JSON.parse(
    await compose(
      config,
      context.directory,
      ['run', '--rm', '--no-deps', '-T', 'api', 'bun', '--no-env-file', '-e', registryProgram],
      { ...context.artifact, input: JSON.stringify(input) },
    ),
  );
}

const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const stateReport = (io, state) => io.write(`[${state}]`);

async function registryFact(file, config, context, dependencies) {
  if (!file) return { state: 'unconfigured', ownerIds: [], grants: [], input: null };
  let input;
  try {
    input = await dependencies.loadRegistry(file);
  } catch (error) {
    return {
      state:
        error.code === 'ENOENT'
          ? 'absent'
          : error instanceof SyntaxError
            ? 'invalid'
            : 'unreadable',
      ownerIds: [],
      grants: [],
      input: null,
    };
  }
  const result = await dependencies.verifyRegistry(config, context, input);
  return { ...result, input };
}

async function selectLegacy(service, io) {
  const candidates = await service.listMaintenanceCandidates();
  if (!candidates.length) {
    stateReport(io, 'account_unconfigured');
    io.write('没有可认领的原用户。空安装请先在 Web 首次建号；不要 seed 或输入 owner ID。');
    return null;
  }
  candidates.forEach((item, index) =>
    io.write(
      `${index + 1}. ${JSON.stringify(item.displayName)} | ${JSON.stringify(item.status)} | ${item.hasPassword ? '需原口令' : '设置口令'} | ${item.eligible ? '可选择' : '不可认领，需人工维护'}`,
    ),
  );
  const answer = await io.ask('明确选择序号（无默认值；留空退出）');
  if (!answer) return null;
  if (!/^[1-9][0-9]*$/.test(answer)) throw failure('ACCOUNT_SELECTION_INVALID');
  const candidate = candidates[Number(answer) - 1];
  if (!candidate?.eligible) throw failure('ACCOUNT_SELECTION_INVALID');
  const confirmation = await io.ask(`确认保留该原用户及全部历史；输入 CONFIRM ${answer}`);
  if (confirmation !== `CONFIRM ${answer}`) throw failure('ACCOUNT_CONFIRMATION_REQUIRED');
  const loginName = await io.ask('登录名（规范化后 1–128 字符，不是邮箱）');
  const password = await io.ask(
    candidate.hasPassword ? '原口令（隐藏，不重置）' : '新口令（隐藏，8–128 字符）',
    { secret: true },
  );
  if (
    !candidate.hasPassword &&
    password !== (await io.ask('再次输入新口令（隐藏）', { secret: true }))
  )
    throw failure('ACCOUNT_PASSWORD_MISMATCH');
  await service.bindLocal({ selection: candidate.selection, confirmed: true, loginName, password });
  return service.getBoundAdministrator();
}

async function requestRegistration(ownerId, config, io) {
  io.write('先由部署者在原受管资料卷内准备目录和资料；本命令不创建或复制 root，不授权整个卷。');
  const root = await io.ask(
    `资料根目录（Linux 容器绝对路径，必须位于 ${config.workspaceMount} 内的子目录）`,
  );
  const relative = path.posix.relative(config.workspaceMount, root);
  if (
    !path.posix.isAbsolute(root) ||
    !relative ||
    relative === '..' ||
    relative.startsWith('../') ||
    path.posix.normalize(root) !== root ||
    root.includes('\\')
  )
    throw failure('WORKSPACE_ROOT_INVALID');
  const label = await io.ask('工作区显示名');
  if (!label || label.length > 128) throw failure('WORKSPACE_REGISTRY_INVALID');
  const readable = await io.ask('明确允许读取的相对文件路径（JSON 字符串数组，无默认值）');
  const writable = await io.ask('明确允许写入的相对文件路径（JSON 字符串数组，可填 []）');
  let readablePaths, writablePaths;
  try {
    readablePaths = JSON.parse(readable);
    writablePaths = JSON.parse(writable);
  } catch {
    throw failure('WORKSPACE_REGISTRY_INVALID');
  }
  if (!Array.isArray(readablePaths) || !readablePaths.length || !Array.isArray(writablePaths))
    throw failure('WORKSPACE_REGISTRY_INVALID');
  if ((await io.ask('确认仅授权这些有限路径；输入 REGISTER')) !== 'REGISTER')
    throw failure('ACCOUNT_CONFIRMATION_REQUIRED');
  return [
    {
      workspace_id: randomUUID(),
      owner_id: ownerId,
      label,
      root,
      readable_paths: readablePaths,
      writable_paths: writablePaths,
    },
  ];
}

/** One-shot maintenance. IO/dependencies are injectable for isolated acceptance; no argv secrets. */
export async function maintainAccount(file, io, injected = {}) {
  const dependencies = {
    lock: withInstallationLock,
    loadConfig,
    updateConfig,
    prepare,
    openIdentity,
    loadRegistry: loadPrivateJson,
    publishRegistry: savePrivateJson,
    verifyRegistry,
    reload: reloadInstallation,
    ...injected,
  };
  assertExternalConfiguration(file);
  let committed = false,
    saved = false,
    bound,
    snapshot,
    context,
    registryFile,
    verified;
  try {
    const prepared = await dependencies.lock(file, async () => {
      snapshot = await dependencies.loadConfig(file);
      context = await dependencies.prepare(file, snapshot);
      const original = await registryFact(snapshot.registryFile, snapshot, context, dependencies);
      const identity = await dependencies.openIdentity(snapshot, context, async () => ({
        ...original,
        state: original.state === 'absent' ? 'unreadable' : original.state,
      }));
      try {
        bound = await identity.service.getBoundAdministrator();
        if (!bound) bound = await selectLegacy(identity.service, io);
        if (!bound) return false;
        committed = true;
        stateReport(io, 'account_committed');
      } finally {
        await identity.close();
      }
      if (['absent', 'invalid', 'unreadable'].includes(original.state)) {
        stateReport(io, `registry_${original.state}`);
        throw failure(`WORKSPACE_REGISTRY_${original.state.toUpperCase()}`);
      }
      registryFile =
        snapshot.registryFile ??
        path.join(path.dirname(path.resolve(file)), 'workspace-registry.json');
      let fact = snapshot.registryFile
        ? original
        : await registryFact(registryFile, snapshot, context, dependencies);
      if (fact.state === 'absent') {
        stateReport(io, 'registry_absent');
        fact = { state: 'unconfigured', ownerIds: [], grants: [], input: null };
      }
      if (['invalid', 'unreadable'].includes(fact.state)) {
        stateReport(io, `registry_${fact.state}`);
        throw failure(`WORKSPACE_REGISTRY_${fact.state.toUpperCase()}`);
      }
      if (fact.state === 'loaded' && fact.ownerIds.includes(bound.userId)) {
        verified = fact;
        io.write(
          '原管理员登记已核验；保留文件字节、workspace_id、root、物理身份及有限权限，其他 owner 不变。',
        );
      } else {
        stateReport(io, 'account_committed_workspace_unconfigured');
        if (fact.input !== null) {
          // Never rewrite an existing registry, including one belonging to another owner.
          io.write(
            '原登记不属于已绑定管理员；保留原文件和所有 owner。请先核对原登记来源，不自动增补或改归属。',
          );
          throw failure('WORKSPACE_OWNER_MISSING');
        }
        if (
          (await io.ask('创建新有限路径登记？输入 CONFIGURE；留空保持账户已配置')) !== 'CONFIGURE'
        )
          return false;
        const input = await requestRegistration(bound.userId, snapshot, io);
        verified = { ...(await dependencies.verifyRegistry(snapshot, context, input)), input };
        if (verified.state !== 'loaded' || !verified.ownerIds.includes(bound.userId))
          throw failure('WORKSPACE_REGISTRY_INVALID');
        await dependencies.publishRegistry(registryFile, input, { exclusive: true });
        stateReport(io, 'registry_published');
      }
      return true;
    });
    if (!prepared)
      return { account: committed ? 'committed' : 'unconfigured', workspace: 'unconfigured' };
    // updateConfig and reloadInstallation each acquire their own lock; never nest them.
    if (snapshot.registryFile !== registryFile) {
      snapshot = await dependencies.updateConfig(file, (current) => {
        if (!same(current, snapshot)) throw failure('ACCOUNT_INSTALLATION_CHANGED');
        return { ...current, registryFile };
      });
    }
    saved = true;
    stateReport(io, 'config_saved');
    await dependencies.lock(file, async () => {
      const current = await dependencies.loadConfig(file);
      if (!same(current, snapshot)) throw failure('ACCOUNT_INSTALLATION_CHANGED');
      const identity = await dependencies.openIdentity(current, context, async () => verified);
      try {
        if (!same(await identity.service.getBoundAdministrator(), bound))
          throw failure('ACCOUNT_INSTALLATION_CHANGED');
      } finally {
        await identity.close();
      }
      const latest = await registryFact(registryFile, current, context, dependencies);
      if (latest.state !== 'loaded' || !same(latest.grants, verified.grants))
        throw failure('WORKSPACE_IDENTITY_CHANGED');
    });
    const result = await dependencies.reload(file, { expectedConfig: snapshot });
    const loaded = await registryFact(registryFile, snapshot, context, dependencies);
    if (
      result.workspace?.state !== 'loaded' ||
      loaded.state !== 'loaded' ||
      !same(loaded.grants, verified.grants)
    )
      throw failure('WORKSPACE_LOAD_FAILED');
    stateReport(io, 'registry_loaded');
    io.write('登记已加载；请在 Web 正式登录。不会自动执行任务、调用模型或重放业务请求。');
    return { account: 'committed', workspace: 'loaded' };
  } catch (error) {
    if (saved) stateReport(io, 'config_saved_reload_failed');
    else if (committed) stateReport(io, 'account_committed_workspace_pending');
    throw error;
  }
}
