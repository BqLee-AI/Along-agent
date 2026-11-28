import { ModelSelectionSchema, workspaceSummarySchema } from '@along/contracts';
import { z } from 'zod';
const revision = z.number().int().positive().max(2_147_483_647);

export const PersonalBotConfigSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    introduction: z.string().max(2000),
    role: z.string().max(4000),
    instructions: z.string().max(16000),
    model_selection: ModelSelectionSchema.nullable(),
    tool_ids: z
      .array(
        z
          .string()
          .min(1)
          .max(128)
          .regex(/^[a-z][a-z0-9_]*$/),
      )
      .refine((ids) => new Set(ids).size === ids.length),
    workspace_ids: z
      .array(workspaceSummarySchema.shape.workspace_id)
      .refine((ids) => new Set(ids).size === ids.length),
    skill_ids: z
      .array(
        z
          .string()
          .uuid()
          .transform((id) => id.toLowerCase()),
      )
      .refine((ids) => new Set(ids).size === ids.length)
      .optional(),
  })
  .strict();
export const UpdatePersonalBotSchema = PersonalBotConfigSchema.extend({ revision });
export const PersonalBotSchema = z
  .object({ id: z.string().uuid(), revision, config: PersonalBotConfigSchema })
  .strict();
export type PersonalBotConfig = z.infer<typeof PersonalBotConfigSchema>;
export type PersonalBot = z.infer<typeof PersonalBotSchema>;
