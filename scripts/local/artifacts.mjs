import { createHash } from 'node:crypto';
import path from 'node:path';
import { cp, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { failure, hostEnvironment, readJson, run, writeJson } from './commands.mjs';
import { imageName, repositoryRoot } from './compose.mjs';

const directories = ['apps', 'packages', 'scripts', 'infra'];
const files = ['package.json', 'bun.lock', 'tsconfig.base.json', '.dockerignore'];
const excluded = new Set([
  'node_modules',
  'dist',
  '.next',
  '.git',
  'coverage',
  'target',
  '.cache',
  '.install-cache',
]);
export function buildInputAllowed(file) {
  return !file
    .split(/[\\/]/u)
    .some(
      (part) =>
        excluded.has(part) ||
        part === 'next-env.d.ts' ||
        part.endsWith('.tsbuildinfo') ||
        part.startsWith('.env'),
    );
}

async function inputFiles(root, relative = '') {
  const result = [];
  const entries = relative ? await readdir(path.join(root, relative), { withFileTypes: true }) : [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const candidate = path.join(relative, entry.name);
    if (!buildInputAllowed(candidate)) continue;
    if (entry.isSymbolicLink()) throw failure('SOURCE_SYMLINK');
    if (entry.isDirectory()) result.push(...(await inputFiles(root, candidate)));
    else if (entry.isFile()) result.push(candidate);
  }
  return result;
}

export async function sourceDigest(root = repositoryRoot) {
  const hash = createHash('sha256');
  for (const file of [
    ...files,
    ...(await Promise.all(directories.map((dir) => inputFiles(root, dir)))).flat(),
  ].sort()) {
    hash.update(file.replaceAll('\\', '/'));
    hash.update('\0');
    hash.update(await readFile(path.join(root, file)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

export async function copyBuildSource(source, destination) {
  await mkdir(destination, { recursive: true, mode: 0o700 });
  for (const name of [...directories, ...files]) {
    await cp(path.join(source, name), path.join(destination, name), {
      recursive: true,
      filter: (file) => buildInputAllowed(path.relative(source, file)),
    });
  }
}

export function artifactDirectory(directory, digest) {
  if (!/^[a-f0-9]{64}$/u.test(digest)) throw failure('INSTALLATION_STATE_INVALID');
  return path.join(directory, 'artifacts', digest);
}

export async function preparedArtifact(config, directory) {
  const artifact = await readJson(path.join(directory, 'prepared.json'));
  if (!artifact) throw failure('PREPARATION_REQUIRED');
  return verifyArtifact(config, directory, artifact);
}

export async function verifyArtifact(config, directory, artifact) {
  const source = artifactDirectory(directory, artifact.digest);
  if (artifact.image !== imageName(config, artifact.digest))
    throw failure('INSTALLATION_STATE_INVALID');
  const complete = await readJson(path.join(source, 'along-build.json'));
  if (complete?.digest !== artifact.digest || complete?.imageId !== artifact.imageId)
    throw failure('PREPARATION_REQUIRED');
  let imageId;
  try {
    imageId = (
      await run('docker', ['image', 'inspect', '--format', '{{.Id}}', artifact.image])
    ).trim();
    await readFile(path.join(source, 'apps/web/.next/BUILD_ID'));
  } catch {
    throw failure('PREPARATION_REQUIRED');
  }
  if (imageId !== artifact.imageId) throw failure('ARTIFACT_CHANGED');
  return { ...artifact, source };
}

export async function prepareArtifact(config, directory, { upgrade = false } = {}) {
  const digest = await sourceDigest();
  const previous = await readJson(path.join(directory, 'prepared.json'));
  if (previous && !upgrade && previous.digest !== digest) throw failure('UPGRADE_REQUIRED');
  const source = artifactDirectory(directory, digest);
  const complete = await readJson(path.join(source, 'along-build.json'));
  const image = imageName(config, digest);
  if (complete) {
    try {
      return await verifyArtifact(config, directory, { digest, image, imageId: complete.imageId });
    } catch (error) {
      if (error.code !== 'PREPARATION_REQUIRED') throw error;
    }
  }
  if (previous?.digest === digest && complete && !upgrade) throw failure('PREPARATION_REQUIRED');
  await rm(source, { recursive: true, force: true });
  await copyBuildSource(repositoryRoot, source);
  if ((await sourceDigest(source)) !== digest) throw failure('SOURCE_CHANGED');
  const log = path.join(directory, 'build.log');
  const env = hostEnvironment();
  await run(
    process.execPath,
    [
      '--no-env-file',
      'install',
      '--frozen-lockfile',
      '--backend=copyfile',
      '--cache-dir',
      path.join(directory, 'dependency-cache'),
    ],
    { cwd: source, env, log, code: 'DEPENDENCY_INSTALL_FAILED' },
  );
  // The host Web build needs API declarations before the API image exists.
  await run(process.execPath, ['--no-env-file', 'run', 'build:api'], {
    cwd: source,
    env,
    log,
    code: 'API_BUILD_FAILED',
  });
  await run(
    process.execPath,
    ['--no-env-file', 'run', '--bun', '--filter', '@along/web', 'build'],
    { cwd: source, env, log, code: 'WEB_BUILD_FAILED' },
  );
  await run(
    'docker',
    ['build', '--tag', image, '--file', path.join(source, 'infra/docker/Dockerfile'), source],
    { env, log, code: 'API_BUILD_FAILED' },
  );
  try {
    await run('docker', ['pull', 'postgres:16-alpine'], { env, log, code: 'POSTGRES_IMAGE_FAILED' });
  } catch {
    await run('docker', ['image', 'inspect', 'postgres:16-alpine'], {
      env,
      code: 'POSTGRES_IMAGE_FAILED',
    });
  }
  const imageId = (await run('docker', ['image', 'inspect', '--format', '{{.Id}}', image])).trim();
  const artifact = { digest, image, imageId };
  await writeJson(path.join(source, 'along-build.json'), { digest, imageId });
  return { ...artifact, source };
}

export async function selectArtifact(directory, artifact) {
  await writeJson(path.join(directory, 'prepared.json'), {
    digest: artifact.digest,
    image: artifact.image,
    imageId: artifact.imageId,
  });
}
