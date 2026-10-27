import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sourceDigest } from '../local/artifacts.mjs';

test('构建身份忽略秘密和增量缓存，但必须反映业务源码变化', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'along-build-input-'));
  try {
    for (const name of ['apps', 'packages', 'scripts', 'infra']) await mkdir(path.join(root, name));
    for (const name of ['package.json', 'bun.lock', 'tsconfig.base.json', '.dockerignore'])
      await writeFile(path.join(root, name), '{}');
    await writeFile(path.join(root, 'apps', 'app.ts'), 'export const value = 1;');
    const original = await sourceDigest(root);
    await writeFile(
      path.join(root, 'apps', 'tsconfig.tsbuildinfo'),
      'generated incremental compiler cache',
    );
    await writeFile(path.join(root, 'apps', '.env.private'), 'fixture-only-do-not-copy');
    await writeFile(path.join(root, 'apps', 'next-env.d.ts'), 'generated Next declaration');
    expect(await sourceDigest(root)).toBe(original);
    await writeFile(path.join(root, 'apps', 'app.ts'), 'export const value = 2;');
    expect(await sourceDigest(root)).not.toBe(original);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
