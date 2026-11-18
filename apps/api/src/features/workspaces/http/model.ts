import { z } from 'zod';
import { workspaceSummarySchema } from '@along/contracts';
export const WorkspacesSchema = z.object({ items: z.array(workspaceSummarySchema) });
