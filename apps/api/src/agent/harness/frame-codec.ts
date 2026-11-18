import {
  HarnessRequestSchema,
  HarnessSnapshotSchema,
  HarnessR3SnapshotSchema,
  HistoricalHarnessSnapshotSchema,
} from '@along/contracts';
import { stateConflict } from '../../platform/errors.js';

/** Structural decoding only; execution and stored-fact qualification belong to runtime. */
export function decodeHarnessRequest(input: unknown, protocol: string) {
  const request = HarnessRequestSchema.parse(input);
  if (request.protocol !== protocol) throw stateConflict('harness protocol version conflict');
  return request;
}

export function decodeCurrentSnapshot(input: unknown) {
  const version =
    input && typeof input === 'object' && 'version' in input ? input.version : undefined;
  return version === 4 ? HarnessR3SnapshotSchema.parse(input) : HarnessSnapshotSchema.parse(input);
}

export function decodeHistoricalSnapshot(input: unknown) {
  return HistoricalHarnessSnapshotSchema.parse(input);
}

export function decodeCompactSnapshot(input: unknown) {
  return HarnessR3SnapshotSchema.parse(input);
}
