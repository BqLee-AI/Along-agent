import { workspaceSummarySchema } from '@along/contracts';
import type { WorkspaceSummary } from '@along/contracts';
import { z } from 'zod';
import { readEnvelope } from '@/shared/http/client';
import { api } from '@/shared/http/eden';

const WorkspaceRegistrationSchema = z.object({ items: z.array(workspaceSummarySchema) }).strict();

export async function readWorkspaceRegistration(signal: AbortSignal): Promise<WorkspaceSummary[]> {
  const response = await api.api.v1.workspaces.get({ fetch: { signal } });
  return WorkspaceRegistrationSchema.parse(await readEnvelope(response)).items;
}
