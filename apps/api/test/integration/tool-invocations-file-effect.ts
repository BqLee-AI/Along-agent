import { open, readFile } from 'node:fs/promises';
import { z } from 'zod';
import type {
  EffectBinding,
  EffectEvidence,
} from '../../src/agent/tools/invocations/invocations.js';

const recordSchema = z
  .object({
    invocationId: z.string().uuid(),
    argsHash: z.string().regex(/^[a-f0-9]{64}$/),
    evidenceRef: z.string(),
  })
  .strict();

// This test-only native effect is a real append followed by fsync. It is not a
// product tool, and cannot write outside the independently created temp fixture.
export async function appendFileEffect(
  path: string,
  binding: EffectBinding,
): Promise<EffectEvidence> {
  const evidenceRef = `file-line:${binding.invocationId}:${binding.argsHash}`;
  const file = await open(path, 'a');
  try {
    await file.writeFile(`${JSON.stringify({ ...binding, evidenceRef })}\n`);
    await file.sync();
  } finally {
    await file.close();
  }
  return {
    ...binding,
    evidenceRef,
    result: { status: 'ok', result: { kind: 'effect_evidence', evidence_ref: evidenceRef } },
  };
}

// No writes, repairs, or retries. Only exact invocation+content-bound records
// can establish a result. Missing records provide no evidence of non-application.
export async function reconcileFileEffect(
  path: string,
  binding: EffectBinding,
): Promise<EffectEvidence | null> {
  let bytes: string;
  try {
    bytes = await readFile(path, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
  for (const line of bytes.split('\n').filter(Boolean)) {
    const record = recordSchema.parse(JSON.parse(line));
    if (record.invocationId === binding.invocationId && record.argsHash === binding.argsHash) {
      return {
        ...binding,
        evidenceRef: record.evidenceRef,
        result: {
          status: 'ok',
          result: { kind: 'effect_evidence', evidence_ref: record.evidenceRef },
        },
      };
    }
  }
  return null;
}
