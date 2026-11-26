import { copyFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

// A historical fixture must hold its migration ceiling when its purpose is to
// prove preservation of facts that a later migration deliberately rejects.
export async function copyMigrationsThrough(directory: string, version: string) {
  const source = new URL('../../../infra/migrations/', import.meta.url);
  for (const name of await readdir(source)) {
    if (/^\d{4}_.*\.sql$/.test(name) && name.slice(0, 4) <= version)
      await copyFile(new URL(name, source), join(directory, name));
  }
}
