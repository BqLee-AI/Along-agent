import { workspaceSummarySchema } from '@along/contracts';
import type { WorkspaceSummary } from '@along/contracts';
import { z } from 'zod';
import { readEnvelope } from '@/shared/http/client';

const WorkspaceRegistrationSchema = z.object({ items: z.array(workspaceSummarySchema) }).strict();

export async function readWorkspaceRegistration(signal: AbortSignal): Promise<WorkspaceSummary[]> {
  const response = await fetch('/api/v1/workspaces', { cache: 'no-store', signal });
  return WorkspaceRegistrationSchema.parse(await readEnvelope(response)).items;
}
