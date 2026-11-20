import type { PoolClient } from 'pg';
import { decodeHistoricalSnapshot, decodeCompactSnapshot } from '../harness/frame-codec.js';
import type { HarnessSnapshot, HarnessR3Snapshot } from '@along/contracts';
import { stateConflict } from '../../platform/errors.js';
import { BUSINESS_TOOL_IDS } from '../tools/contracts.js';
import { readRunInvocationStates } from '../tools/invocations/run-state.js';
import { readRunSnapshotPayload, type RunRow } from '../../features/conversations/public.js';

export async function readSnapshot(
  client: PoolClient,
  run: RunRow,
  checkpointId: string,
): Promise<HarnessSnapshot | HarnessR3Snapshot> {
  const payload = await readRunSnapshotPayload(
    client,
    {
      ownerId: run.owner_id,
      conversationId: run.conversation_id,
      runId: run.id,
    },
    checkpointId,
  );
  if (run.frozen_context?.execution_profile === 'compact-memory/1')
    return decodeCompactSnapshot(payload);
  const snapshot = decodeHistoricalSnapshot(payload);
  if (snapshot.version === 1) {
    if (run.frozen_context?.workspaceGrant)
      throw stateConflict('historical snapshot cannot gain workspace authority');
    const states = await readRunInvocationStates(client, {
      ownerId: run.owner_id,
      conversationId: run.conversation_id,
      runId: run.id,
    });
    for (const invocationId of snapshot.tool_refs) {
      const row = states.find((state) => state.invocation_id === invocationId);
      if (
        !row ||
        row.state !== 'completed' ||
        !(BUSINESS_TOOL_IDS as readonly string[]).includes(row.tool_id) ||
        row.approval_ref?.kind === 'document'
      )
        throw stateConflict('historical snapshot contains non-task capability');
    }
  }
  return { ...snapshot, version: 2 };
}
