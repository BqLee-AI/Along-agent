import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { createConfig, loadConfig, saveConfig } from './config.mjs';
import { withInstallationLock } from './lock.mjs';
import { DeploymentDatabase, hostDatabaseUrl } from './database.mjs';
import { failure, readJson, run, waitFor, writeJson } from './commands.mjs';
import { prepareArtifact, preparedArtifact, selectArtifact, sourceDigest } from './artifacts.mjs';
import {
  assertExternalConfiguration,
  assertLoopbackBinding,
  assertNoForeignVolumeUsers,
  assertOwned,
  assertPortFree,
  checkDependencies,
  compose,
  installationDirectory,
  prepareVolumes,
  projectContainers,
  verifyVolumes,
} from './compose.mjs';
import { startWeb, stopWeb, webIsRunning } from './web.mjs';
import { backupInstallation } from './backup.mjs';

async function withInstallation(file, action, initialInput) {
  assertExternalConfiguration(file);
  return withInstallationLock(file, async () => {
    let config;
    try {
      config = await loadConfig(file);
    } catch (error) {
      if (error.code !== 'CONFIG_MISSING' || !initialInput) throw error;
      config = createConfig(initialInput);
      await saveConfig(file, config, { exclusive: true });
    }
    const directory = installationDirectory(file, config);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await checkDependencies();
    return action(config, directory);
  });
}

function stoppedBindingMatches(container, internalPort, hostPort) {
  return Boolean(
    container &&
    !container.running &&
    container.ports?.[`${internalPort}/tcp`]?.some(
      (binding) => binding.HostIp === '127.0.0.1' && Number(binding.HostPort) === hostPort,
    ),
  );
}

async function ensurePostgres(config, directory, options = {}) {
  const before = await projectContainers(config);
  assertOwned(before, config, { adopting: options.adopting });
  const current = before.find((item) => item.labels?.['com.docker.compose.service'] === 'postgres');
  if (current?.running) {
    assertLoopbackBinding(current, 5432, config.ports.postgres);
    return current.id;
  }
  await assertPortFree(config.ports.postgres, {
    replacingOwned: stoppedBindingMatches(current, 5432, config.ports.postgres),
  });
  await compose(
    config,
    directory,
    ['up', '-d', '--no-build', '--pull', 'never', 'postgres'],
    options,
  );
  const postgres = (await projectContainers(config)).find(
    (item) => item.labels?.['com.docker.compose.service'] === 'postgres',
  );
  if (!postgres) throw failure('POSTGRES_START_FAILED');
  await waitFor(
    async () =>
      (
        await run('docker', ['inspect', '--format', '{{.State.Health.Status}}', postgres.id])
      ).trim() === 'healthy',
    'POSTGRES_START_FAILED',
  );
  return postgres.id;
}

async function openDatabase(config, source) {
  const database = new DeploymentDatabase({
    connectionString: hostDatabaseUrl(config),
    migrationsDirectory: path.join(source, 'infra/migrations'),
    verificationDirectory: path.join(source, 'scripts/local/baselines'),
  });
  try {
    await database.connect();
    await database.acquireLease();
    return database;
  } catch (error) {
    await database.close();
    throw error;
  }
}

async function waitForStoppedBindings(containers, service, containerPort) {
  // Docker Desktop can acknowledge stop before its host-side proxy releases.
  // Only the previously running, owned bindings are eligible for this wait.
  for (const item of containers) {
    if (!item.running || item.labels?.['com.docker.compose.service'] !== service) continue;
    for (const binding of item.ports?.[`${containerPort}/tcp`] ?? []) {
      if (binding.HostIp !== '127.0.0.1') continue;
      await waitFor(
        async () => {
          try {
            await assertPortFree(Number(binding.HostPort), { replacingOwned: true });
            return true;
          } catch (error) {
            if (error.code !== 'PORT_IN_USE') throw error;
            return false;
          }
        },
        'PORT_IN_USE',
        10000,
      );
    }
  }
}

async function stopWriters(config, directory) {
  const containers = await projectContainers(config);
  assertOwned(containers, config);
  await stopWeb(directory);
  for (const item of containers.filter(
    (item) => item.labels?.['com.docker.compose.service'] === 'api',
  )) {
    await run('docker', ['update', '--restart=no', item.id]);
  }
  await compose(config, directory, ['stop', '--timeout', '10', 'api']);
  if (
    (await projectContainers(config)).some(
      (item) => item.running && item.labels?.['com.docker.compose.service'] !== 'postgres',
    )
  )
    throw failure('WRITERS_NOT_STOPPED');
  await waitForStoppedBindings(containers, 'api', 3000);
}

async function startWriters(file, config, directory, artifact, database) {
  await database.assertLease();
  await assertNoForeignVolumeUsers(config);
  const containers = await projectContainers(config);
  assertOwned(containers, config);
  const api = containers.find((item) => item.labels?.['com.docker.compose.service'] === 'api');
  if (api?.running && api.image !== artifact.imageId) throw failure('UPGRADE_REQUIRED');
  if (api?.running) assertLoopbackBinding(api, 3000, config.ports.api);
  if (!api?.running) {
    await assertPortFree(config.ports.api, {
      replacingOwned: stoppedBindingMatches(api, 3000, config.ports.api),
    });
    await database.assertNoOtherClients();
    await database.assertLease();
    await compose(
      config,
      directory,
      ['up', '-d', '--no-build', '--no-deps', '--force-recreate', '--pull', 'never', 'api'],
      { image: artifact.image, source: artifact.source },
    );
  }
  await waitFor(async () => {
    await database.assertLease();
    try {
      const response = await fetch(`http://127.0.0.1:${config.ports.api}/readyz`, {
        signal: AbortSignal.timeout(2000),
      });
      await response.body?.cancel();
      return response.status === 200;
    } catch {
      return false;
    }
  }, 'API_START_FAILED');
  await database.assertLease();
  await startWeb(file, config, directory, artifact);
  await database.assertLease();
}

async function runtimeReport(config, directory) {
  let workspace = { state: 'unconfigured', accepted: 0, rejected: 0 };
  if (config.registryFile) {
    try {
      workspace = JSON.parse(
        await compose(config, directory, [
          'exec',
          '-T',
          'api',
          'bun',
          '--no-env-file',
          '-e',
          'import {loadWorkspaceRegistry} from "./apps/api/dist/modules/workspaces/service.js"; console.log(JSON.stringify(await loadWorkspaceRegistry()));',
        ]),
      );
    } catch {
      workspace = { state: 'unreadable', accepted: 0, rejected: 0 };
    }
  }
  return {
    phase: 'running',
    webUrl: config.origin,
    account: 'unverified',
    workspace,
    model: config.model ? 'configured_unverified' : 'unconfigured',
  };
}

function assertTargetSchema(state, targetVersion) {
  if (state.kind === 'supported' && state.version === targetVersion) return;
  throw failure(
    state.kind === 'supported' ? 'UPGRADE_REQUIRED' : `DATABASE_${state.reason.toUpperCase()}`,
  );
}

export async function initializeInstallation(file, initialInput) {
  return withInstallation(
    file,
    async (config, directory) => {
      const containers = await projectContainers(config);
      const adopting =
        config.mode === 'adopt' && !(await readJson(path.join(directory, 'prepared.json')));
      assertOwned(containers, config, { adopting });
      const api = containers.find((item) => item.labels?.['com.docker.compose.service'] === 'api');
      if (!api?.running)
        await assertPortFree(config.ports.api, {
          replacingOwned: stoppedBindingMatches(api, 3000, config.ports.api),
        });
      if (!(await webIsRunning(directory))) await assertPortFree(config.ports.web);
      await prepareVolumes(config, directory);
      await assertNoForeignVolumeUsers(config);
      const artifact = await prepareArtifact(config, directory);
      await ensurePostgres(config, directory, {
        adopting,
        image: artifact.image,
        source: artifact.source,
      });
      const database = await openDatabase(config, artifact.source);
      try {
        const state = await database.classify();
        if (state.kind === 'empty') {
          if (config.mode !== 'new') throw failure('DATABASE_EMPTY_ADOPTION_REFUSED');
          await database.assertNoOtherClients();
          await database.initialize();
        } else {
          assertTargetSchema(state, database.targetVersion);
        }
        await database.assertLease();
        if (adopting) {
          // Claim the explicitly stopped legacy service without starting writers.
          // Volumes, database and registry were verified above; only its
          // disposable container and installation labels are replaced.
          await compose(
            config,
            directory,
            [
              'up',
              '--no-start',
              '--no-deps',
              '--no-build',
              '--force-recreate',
              '--pull',
              'never',
              'api',
            ],
            { image: artifact.image, source: artifact.source },
          );
          await database.assertLease();
        }
        await selectArtifact(directory, artifact);
      } finally {
        await database.close();
      }
      return {
        phase: 'prepared',
        account: 'unverified',
        model: config.model ? 'configured_unverified' : 'unconfigured',
        workspace: config.registryFile ? 'unverified' : 'unconfigured',
      };
    },
    initialInput,
  );
}

export async function startInstallation(file) {
  return withInstallation(file, async (config, directory) => {
    const pending = await readJson(path.join(directory, 'upgrade.json'));
    if (pending && pending.phase !== 'complete') throw failure('UPGRADE_INCOMPLETE');
    await verifyVolumes(config, directory);
    const artifact = await preparedArtifact(config, directory);
    assertOwned(await projectContainers(config), config);
    await assertNoForeignVolumeUsers(config);
    await ensurePostgres(config, directory, { image: artifact.image, source: artifact.source });
    const database = await openDatabase(config, artifact.source);
    try {
      const state = await database.classify();
      if (state.kind !== 'supported' || state.version !== database.targetVersion) {
        await stopWriters(config, directory);
        assertTargetSchema(state, database.targetVersion);
      }
      try {
        await startWriters(file, config, directory, artifact, database);
      } catch (error) {
        await stopWriters(config, directory);
        throw error;
      }
      return await runtimeReport(config, directory);
    } finally {
      await database.close();
    }
  });
}

export async function stopInstallation(file) {
  return withInstallation(file, async (config, directory) => {
    const containers = await projectContainers(config);
    assertOwned(containers, config);
    await stopWriters(config, directory);
    await compose(config, directory, ['stop', '--timeout', '10', 'postgres']);
    if ((await projectContainers(config)).some((item) => item.running))
      throw failure('STOP_FAILED');
    await waitForStoppedBindings(containers, 'postgres', 5432);
    return { phase: 'stopped' };
  });
}

export async function upgradeInstallation(file) {
  return withInstallation(file, async (config, directory) => {
    await verifyVolumes(config, directory);
    assertOwned(await projectContainers(config), config);
    await assertNoForeignVolumeUsers(config);
    const previous = await readJson(path.join(directory, 'prepared.json'));
    if (!previous) throw failure('PREPARATION_REQUIRED');
    const digest = await sourceDigest();
    // A normal new generation is built without mutating the running generation.
    // Repairing a missing same-generation build first stops its consumers.
    if (previous.digest === digest) await stopWriters(config, directory);
    const artifact = await prepareArtifact(config, directory, { upgrade: true });
    const postgres = await ensurePostgres(config, directory, {
      image: artifact.image,
      source: artifact.source,
    });
    const database = await openDatabase(config, artifact.source);
    try {
      await writeJson(path.join(directory, 'upgrade.json'), {
        phase: 'stopping',
        target: artifact.digest,
      });
      await stopWriters(config, directory);
      await database.assertNoOtherClients();
      await backupInstallation(config, directory, postgres);
      await database.assertLease();
      await writeJson(path.join(directory, 'upgrade.json'), {
        phase: 'migrating',
        target: artifact.digest,
      });
      await database.upgrade();
      const state = await database.classify();
      assertTargetSchema(state, database.targetVersion);
      await writeJson(path.join(directory, 'upgrade.json'), {
        phase: 'starting',
        target: artifact.digest,
      });
      await startWriters(file, config, directory, artifact, database);
      await selectArtifact(directory, artifact);
      await database.assertLease();
      await writeJson(path.join(directory, 'upgrade.json'), {
        phase: 'complete',
        target: artifact.digest,
      });
      return await runtimeReport(config, directory);
    } catch (error) {
      await stopWriters(config, directory);
      throw error;
    } finally {
      await database.close();
    }
  });
}

// #68 calls this after updateConfig; no identity selection or Agent resume occurs.
export async function reloadInstallation(file, { expectedConfig } = {}) {
  return withInstallation(file, async (config, directory) => {
    if (expectedConfig && JSON.stringify(config) !== JSON.stringify(expectedConfig))
      throw failure('ACCOUNT_INSTALLATION_CHANGED');
    const pending = await readJson(path.join(directory, 'upgrade.json'));
    if (pending && pending.phase !== 'complete') throw failure('UPGRADE_INCOMPLETE');
    await verifyVolumes(config, directory);
    const artifact = await preparedArtifact(config, directory);
    assertOwned(await projectContainers(config), config);
    await ensurePostgres(config, directory, { image: artifact.image, source: artifact.source });
    const database = await openDatabase(config, artifact.source);
    try {
      await stopWriters(config, directory);
      assertTargetSchema(await database.classify(), database.targetVersion);
      await database.assertNoOtherClients();
      await startWriters(file, config, directory, artifact, database);
      return await runtimeReport(config, directory);
    } catch (error) {
      await stopWriters(config, directory);
      throw error;
    } finally {
      await database.close();
    }
  });
}
