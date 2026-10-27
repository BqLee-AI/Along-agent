import { afterEach, describe, expect, it } from 'bun:test';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { createInterface } from 'node:readline';
import { withInstallationLock } from '../local/lock.mjs';

const directories: string[] = [];
const children: Array<{ child: ChildProcessWithoutNullStreams; exited: Promise<number | null> }> =
  [];
const moduleUrl = new URL('../local/lock.mjs', import.meta.url).href;

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'along-lock-test-'));
  directories.push(directory);
  const file = join(directory, 'private', 'local.json');
  const script = join(directory, 'worker.mjs');
  await writeFile(
    script,
    `
import { withInstallationLock } from ${JSON.stringify(moduleUrl)};
const [file, action] = process.argv.slice(2);
try {
  await withInstallationLock(file, async () => {
    process.stdout.write('acquired\\n');
    if (action === 'exit') process.exit(17);
    if (action === 'hold') {
      const gate = Promise.withResolvers();
      process.stdin.once('data', gate.resolve);
      await gate.promise;
    }
  });
  process.stdout.write('released\\n');
} catch (error) {
  process.stdout.write((error.code || 'CALLBACK_FAILED') + '\\n');
  process.exitCode = 23;
}
`,
  );
  return { file, script };
}

function worker(script: string, file: string, action: string) {
  const child = spawn(process.execPath, [script, file, action], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const reader = createInterface({ input: child.stdout });
  const lines = reader[Symbol.asyncIterator]();
  const {
    promise: exited,
    resolve: resolveExit,
    reject: rejectExit,
  } = Promise.withResolvers<number | null>();
  child.once('error', rejectExit);
  child.once('exit', resolveExit);
  children.push({ child, exited });
  return { child, lines, exited };
}

afterEach(async () => {
  const owned = children.splice(0);
  for (const { child } of owned) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
  await Promise.allSettled(owned.map(({ exited }) => exited));
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('installation lifecycle lease', () => {
  it('returns callback results and releases ownership on callback exceptions', async () => {
    const { file } = await fixture();
    expect(await withInstallationLock(file, () => 41)).toBe(41);
    const failure = new Error('controlled callback failure');
    await expect(
      withInstallationLock(file, () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(await withInstallationLock(file, async () => 42)).toBe(42);
  });

  it('rejects nested and concurrent same-process operations, including path aliases, without entering callbacks', async () => {
    const { file } = await fixture();
    const { promise: entered, resolve: enter } = Promise.withResolvers<void>();
    const { promise: barrier, resolve: release } = Promise.withResolvers<void>();
    let forbiddenEntries = 0;
    const held = withInstallationLock(file, async () => {
      enter();
      await expect(
        withInstallationLock(file, () => {
          forbiddenEntries += 1;
        }),
      ).rejects.toMatchObject({ code: 'LOCK_BUSY' });
      await barrier;
    });
    await entered;
    try {
      await expect(
        withInstallationLock(relative(process.cwd(), file), () => {
          forbiddenEntries += 1;
        }),
      ).rejects.toMatchObject({ code: 'LOCK_BUSY' });
      if (process.platform === 'win32') {
        await expect(
          withInstallationLock(file.toUpperCase(), () => {
            forbiddenEntries += 1;
          }),
        ).rejects.toMatchObject({ code: 'LOCK_BUSY' });
      }
      expect(forbiddenEntries).toBe(0);
    } finally {
      release();
      await held;
    }
    expect(await withInstallationLock(file, () => 'after release')).toBe('after release');
  });

  it('two simultaneous processes cannot enter the same installation and the loser can retry after release', async () => {
    const { file, script } = await fixture();
    const first = worker(script, file, 'hold');
    const second = worker(script, file, 'hold');
    const outcomes = await Promise.all([first.lines.next(), second.lines.next()]);
    expect(outcomes.map((line) => line.value).sort()).toEqual(['LOCK_BUSY', 'acquired']);
    const owner = outcomes[0].value === 'acquired' ? first : second;
    const rejected = owner === first ? second : first;
    expect(await rejected.exited).toBe(23);
    owner.child.stdin.end('release\n');
    expect((await owner.lines.next()).value).toBe('released');
    expect(await owner.exited).toBe(0);
    const retry = worker(script, file, 'once');
    expect((await retry.lines.next()).value).toBe('acquired');
    expect((await retry.lines.next()).value).toBe('released');
    expect(await retry.exited).toBe(0);
  }, 30_000);

  it('does not take a live lease but recovers automatically after an owner exits without finally cleanup', async () => {
    const { file, script } = await fixture();
    const holder = worker(script, file, 'hold');
    expect((await holder.lines.next()).value).toBe('acquired');
    await expect(withInstallationLock(file, () => 'must not run')).rejects.toMatchObject({
      code: 'LOCK_BUSY',
    });
    holder.child.kill();
    await holder.exited;
    expect(await withInstallationLock(file, () => 'recovered after termination')).toBe(
      'recovered after termination',
    );
    const abrupt = worker(script, file, 'exit');
    expect((await abrupt.lines.next()).value).toBe('acquired');
    expect(await abrupt.exited).toBe(17);
    expect(await withInstallationLock(file, () => 'recovered after abrupt exit')).toBe(
      'recovered after abrupt exit',
    );
  }, 30_000);
});
