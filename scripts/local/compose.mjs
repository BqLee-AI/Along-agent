import path from 'node:path';
import { lstat, mkdir, open } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { loadPrivateJson, localModelProxyToken } from './config.mjs';
import net from 'node:net';
import { failure, hostEnvironment, readJson, run, writeJson } from './commands.mjs';

export const repositoryRoot = path.resolve(import.meta.dirname, '../..');
export const installationDirectory = (file, config) =>
  path.join(path.dirname(path.resolve(file)), 'installations', config.installationId);
export const imageName = (config, digest) => `along-local-${config.installationId}:${digest}`;

export function assertExternalConfiguration(file) {
  const relative = path.relative(repositoryRoot, path.resolve(file));
  if (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
    throw failure('CONFIG_LOCATION_INVALID');
}

export function assertLoopbackBinding(container, servicePort, hostPort) {
  const bindings = container.ports?.[`${servicePort}/tcp`];
  if (
    !Array.isArray(bindings) ||
    bindings.length !== 1 ||
    bindings[0].HostIp !== '127.0.0.1' ||
    Number(bindings[0].HostPort) !== hostPort
  )
    throw failure('CONFIG_RELOAD_REQUIRED');
}

export async function configuredIdentityKeys(config, source = repositoryRoot) {
  if (!config.identityKeyringFile) return undefined;
  assertExternalConfiguration(config.identityKeyringFile);
  try {
    const input = await loadPrivateJson(config.identityKeyringFile);
    const { parseIdentityKeyring } = await import(
      pathToFileURL(path.join(source, 'apps/api/src/features/identity/public.ts')).href
    );
    return parseIdentityKeyring(input);
  } catch {
    throw failure('IDENTITY_KEYRING_FILE_INVALID');
  }
}

export function installationEnvironment(config, image = 'along-local:unprepared') {
  const databaseUrl = new URL('postgresql://postgres:5432');
  databaseUrl.username = config.database.user;
  databaseUrl.password = config.database.password;
  databaseUrl.pathname = `/${config.database.name}`;
  const limits = config.harnessLimits ?? config.model;
  return hostEnvironment({
    ALONG_INSTALLATION: config.installationId,
    ALONG_DB_USER: config.database.user,
    ALONG_DB_PASSWORD: config.database.password,
    ALONG_DB_NAME: config.database.name,
    ALONG_DB_PORT: String(config.ports.postgres),
    ALONG_API_PORT: String(config.ports.api),
    ALONG_PG_VOLUME: config.postgresVolume,
    ALONG_WORKSPACE_VOLUME: config.workspaceVolume,
    ALONG_WORKSPACE_MOUNT: config.workspaceMount,
    ALONG_API_IMAGE: image,
    DATABASE_URL: databaseUrl.toString(),
    BETTER_AUTH_SECRET: config.authSecret,
    MODEL_PROVIDER_ENCRYPTION_KEY: config.modelProviderEncryptionKey,
    ALONG_LOCAL_MODEL_PROXY_TOKEN: localModelProxyToken(config),
    MODEL_PROVIDER_ALLOWED_LOCAL_ORIGINS: (config.modelProviderAllowedLocalOrigins ?? []).join(','),
    MODEL_PROVIDER_ALLOWED_FAKE_DNS_ORIGINS: (config.modelProviderAllowedFakeDnsOrigins ?? []).join(
      ',',
    ),
    APP_ORIGIN: config.origin,
    IDENTITY_KEYRING_FILE: config.identityKeyringFile ? '/run/along-identity-keyring.json' : '',
    IDENTITY_MAIL_PROVIDER: config.identityMail?.provider ?? '',
    IDENTITY_MAIL_FROM: config.identityMail?.from ?? '',
    IDENTITY_MAIL_API_KEY: config.identityMail?.apiKey ?? '',
    API_BASE: `http://127.0.0.1:${config.ports.api}`,
    TZDB_VERSION: config.tzdbVersion,
    HARNESS_MAX_ITERATIONS: String(limits?.maxIterations ?? 24),
    HARNESS_MAX_TOKENS: String(limits?.maxTokens ?? 64000),
    HARNESS_COMPLETION_CAP: String(config.harnessCompletionCap),
    HARNESS_MODEL_WINDOW_TOKENS:
      limits?.modelWindowTokens == null ? '' : String(limits.modelWindowTokens),
    HARNESS_ROUTING_MODE: config.routing?.mode ?? 'off',
    HARNESS_ROUTING_BUNDLE: config.routing ? '/run/along-routing-bundle.json' : '',
    HARNESS_ROUTING_ENCODER_URL: config.routing?.encoderUrl ?? '',
    HARNESS_ROUTING_INTENTS: config.routing?.intents.join(',') ?? '',
    HARNESS_CONTEXT_RESERVE_TOKENS: String(limits?.reserveTokens ?? 0),
    WORKSPACE_REGISTRY_FILE: config.registryFile ? '/run/along-registry.json' : '',
  });
}

function feishuApiEnvironment() {
  const { FEISHU_APP_ID, FEISHU_REDIRECT_URI, FEISHU_CREDENTIAL_KEY } = process.env;
  const legacy =
    FEISHU_APP_ID && FEISHU_REDIRECT_URI && FEISHU_CREDENTIAL_KEY
      ? { FEISHU_APP_ID, FEISHU_REDIRECT_URI, FEISHU_CREDENTIAL_KEY }
      : {};
  const encoded = process.env.FEISHU_BOT_DOCX_CONFIG;
  if (!encoded) return legacy;

  // Never let policy references disclose arbitrary host values to the container.
  let policy;
  try {
    policy = JSON.parse(encoded);
  } catch {
    return legacy;
  }
  const { secretEnv, observationKeyEnv } = policy ?? {};
  if (
    typeof secretEnv !== 'string' ||
    secretEnv.length > 128 ||
    !/^FEISHU_BOT_DOCX_APP_SECRET(?:_[A-Z0-9][A-Z0-9_]*)?$/u.test(secretEnv) ||
    typeof observationKeyEnv !== 'string' ||
    observationKeyEnv.length > 128 ||
    !/^FEISHU_BOT_DOCX_OBSERVATION_KEY(?:_[A-Z0-9][A-Z0-9_]*)?$/u.test(observationKeyEnv)
  ) {
    return legacy;
  }
  const secret = process.env[secretEnv];
  const key = process.env[observationKeyEnv];
  if (!secret || !key) return legacy;
  return {
    ...legacy,
    FEISHU_BOT_DOCX_CONFIG: encoded,
    [secretEnv]: secret,
    [observationKeyEnv]: key,
  };
}

export async function compose(
  config,
  directory,
  args,
  { image, source = repositoryRoot, input, withFeishu = false } = {},
) {
  const registration = path.join(directory, 'registry.compose.json');
  const feishu = withFeishu ? feishuApiEnvironment() : {};
  const feishuNames = Object.keys(feishu);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let readableRegistration = false;
  if (config.registryFile) {
    try {
      if ((await lstat(config.registryFile)).isFile()) {
        const file = await open(config.registryFile, 'r');
        await file.close();
        readableRegistration = true;
      }
    } catch {
      // Keep the configured in-container path absent. The API reports unreadable
      // registration without taking unrelated authenticated business offline.
    }
  }
  await writeJson(registration, {
    services: {
      api: {
        // Compose resolves null references from its process environment, not this file.
        ...(feishuNames.length
          ? { environment: Object.fromEntries(feishuNames.map((name) => [name, null])) }
          : {}),
        ...(config.identityKeyringFile
          ? {
              // Windows ACL-private binds can appear as mode 0777 in Linux.
              // Seal the validated, read-only source without weakening the loader.
              command: [
                'sh',
                '-ec',
                'umask 077; cp /run/along-identity-keyring-source.json /run/along-identity-keyring.json; chmod 600 /run/along-identity-keyring.json; exec bun --no-env-file apps/api/dist/main.js',
              ],
            }
          : {}),
        volumes: [
          ...(config.routing
            ? [
                {
                  type: 'bind',
                  source: config.routing.bundleFile,
                  target: '/run/along-routing-bundle.json',
                  read_only: true,
                  bind: { create_host_path: false },
                },
              ]
            : []),
          ...(readableRegistration
            ? [
                {
                  type: 'bind',
                  source: config.registryFile,
                  target: '/run/along-registry.json',
                  read_only: true,
                  bind: { create_host_path: false },
                },
              ]
            : []),
          ...(config.identityKeyringFile
            ? [
                {
                  type: 'bind',
                  source: config.identityKeyringFile,
                  target: '/run/along-identity-keyring-source.json',
                  read_only: true,
                  bind: { create_host_path: false },
                },
              ]
            : []),
        ],
      },
    },
  });
  return run(
    'docker',
    [
      'compose',
      '--project-name',
      config.project,
      '-f',
      path.join(source, 'infra/compose/compose.yaml'),
      '-f',
      path.join(source, 'infra/compose/local.yaml'),
      '-f',
      registration,
      ...args,
    ],
    {
      env: { ...installationEnvironment(config, image), ...feishu },
      code: 'COMPOSE_FAILED',
      input,
    },
  );
}

const inspectTemplate =
  '{"id":{{json .Id}},"running":{{json .State.Running}},"labels":{{json .Config.Labels}},"image":{{json .Image}},"ports":{{json .HostConfig.PortBindings}}}';
export async function projectContainers(config) {
  const ids = (
    await run(
      'docker',
      ['ps', '-aq', '--filter', `label=com.docker.compose.project=${config.project}`],
      { code: 'DOCKER_UNAVAILABLE' },
    )
  )
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
  return Promise.all(
    ids.map(async (id) =>
      JSON.parse(await run('docker', ['inspect', '--format', inspectTemplate, id])),
    ),
  );
}

export function assertOwned(containers, config, { adopting = false } = {}) {
  for (const item of containers) {
    if (item.labels?.['io.along.installation'] === config.installationId) continue;
    if (
      adopting &&
      !item.running &&
      ['api', 'postgres'].includes(item.labels?.['com.docker.compose.service'])
    )
      continue;
    throw failure('UNKNOWN_PROCESS');
  }
}

export async function assertNoForeignVolumeUsers(config) {
  for (const volume of [config.postgresVolume, config.workspaceVolume]) {
    const ids = (await run('docker', ['ps', '-q', '--filter', `volume=${volume}`]))
      .trim()
      .split(/\s+/u)
      .filter(Boolean);
    for (const id of ids) {
      const item = JSON.parse(await run('docker', ['inspect', '--format', inspectTemplate, id]));
      if (
        item.labels?.['io.along.installation'] !== config.installationId ||
        item.labels?.['com.docker.compose.project'] !== config.project
      )
        throw failure('UNKNOWN_PROCESS');
    }
  }
}

async function volumeInfo(name) {
  try {
    return JSON.parse(
      await run('docker', [
        'volume',
        'inspect',
        '--format',
        '{"name":{{json .Name}},"created":{{json .CreatedAt}},"labels":{{json .Labels}}}',
        name,
      ]),
    );
  } catch {
    return null;
  }
}

export async function prepareVolumes(config, directory) {
  const original = await readJson(path.join(directory, 'objects.json'));
  const objects = {};
  for (const [kind, name] of [
    ['postgres', config.postgresVolume],
    ['workspace', config.workspaceVolume],
  ]) {
    let info = await volumeInfo(name);
    if (!info) {
      if (config.mode !== 'new' || original) throw failure('ORIGINAL_VOLUME_MISSING');
      await run('docker', [
        'volume',
        'create',
        '--label',
        `io.along.installation=${config.installationId}`,
        name,
      ]);
      info = await volumeInfo(name);
    } else if (
      !original &&
      config.mode === 'new' &&
      info.labels?.['io.along.installation'] !== config.installationId
    ) {
      throw failure('VOLUME_NOT_OWNED');
    }
    if (!info?.created) throw failure('VOLUME_IDENTITY_UNAVAILABLE');
    objects[kind] = { name: info.name, created: info.created };
  }
  if (original && JSON.stringify(original) !== JSON.stringify(objects))
    throw failure('VOLUME_IDENTITY_CHANGED');
  if (!original) await writeJson(path.join(directory, 'objects.json'), objects);
}

export async function verifyVolumes(config, directory) {
  if (!(await readJson(path.join(directory, 'objects.json'))))
    throw failure('PREPARATION_REQUIRED');
  await prepareVolumes(config, directory);
}

export async function assertPortFree(port, { replacingOwned = false } = {}) {
  // Windows can reject an exclusive bind for ~60s after Docker has stopped,
  // even with no listener. Only a verified owned handoff may probe listeners
  // instead; Docker still performs the actual bind and rejects any collision.
  if (process.platform === 'win32' && replacingOwned) {
    await new Promise((resolve, reject) => {
      const socket = net.connect({ host: '127.0.0.1', port });
      const finish = (occupied) => {
        socket.destroy();
        if (occupied) reject(failure('PORT_IN_USE'));
        else resolve();
      };
      socket.once('connect', () => finish(true));
      socket.once('error', (error) => finish(error.code !== 'ECONNREFUSED'));
      socket.setTimeout(1000, () => finish(true));
    });
    return;
  }
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', () => reject(failure('PORT_IN_USE')));
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => server.close(resolve));
  });
}

export async function checkDependencies() {
  if (process.versions.bun !== '1.4.2') throw failure('BUN_VERSION');
  const platform = (
    await run('docker', ['info', '--format', '{{.OSType}}/{{.Architecture}}'], {
      code: 'DOCKER_UNAVAILABLE',
    })
  ).trim();
  if (!['linux/x86_64', 'linux/amd64'].includes(platform)) throw failure('DOCKER_PLATFORM');
  const version = (
    await run('docker', ['compose', 'version', '--short'], { code: 'COMPOSE_VERSION' })
  )
    .trim()
    .replace(/^v/u, '')
    .split('.')
    .map(Number);
  if (
    version[0] < 2 ||
    (version[0] === 2 && (version[1] < 24 || (version[1] === 24 && version[2] < 4)))
  )
    throw failure('COMPOSE_VERSION');
}
