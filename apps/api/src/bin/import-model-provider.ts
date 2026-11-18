import { createPool } from '../db/pool.js';
import { isUuid } from '../platform/errors.js';
import { importLegacyProvider } from '../features/model-providers/public.js';

// Administrator supplies the target user as argv[2], and JSON {name,base_url,
// api_key,model_id} via a protected stdin. No deployed model config is read.
async function main(): Promise<void> {
  const ownerId = process.argv[2];
  if (!ownerId || !isUuid(ownerId) || process.argv.length !== 3 || process.stdin.isTTY)
    throw new Error('invalid invocation');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 32768) throw new Error('input too large');
    chunks.push(bytes);
  }
  const input: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid input');
  const fields = input as Record<string, unknown>;
  if (
    Object.keys(fields).sort().join(',') !== 'api_key,base_url,model_id,name' ||
    typeof fields.name !== 'string' ||
    fields.name.length > 200 ||
    typeof fields.base_url !== 'string' ||
    fields.base_url.length > 2048 ||
    typeof fields.model_id !== 'string' ||
    (fields.api_key !== null &&
      (typeof fields.api_key !== 'string' || fields.api_key.length > 16384))
  )
    throw new Error('invalid input');
  const pool = createPool();
  if (!pool) throw new Error('database unavailable');
  try {
    const provider = await importLegacyProvider(pool, ownerId, {
      name: fields.name,
      base_url: fields.base_url,
      model_id: fields.model_id,
      api_key: fields.api_key as string | null,
    });
    console.log(`Imported provider ${provider.id} for the specified owner`);
  } finally {
    await pool.end();
  }
}

void main().catch(() => {
  console.error('Provider import failed');
  process.exitCode = 1;
});
