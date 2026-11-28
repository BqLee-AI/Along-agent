import { z } from 'zod';

export const SKILL_FILE_MAX_BYTES = 64 * 1024;
export const SKILL_BODY_MAX_BYTES = 16 * 1024;

const text = z
  .string()
  .refine((value) => !value.includes('\0') && !/[\uD800-\uDFFF]/u.test(value), 'Invalid text');
const revision = z.number().int().positive().max(2147483647);
const name = text.refine((value) => {
  const normalized = value.normalize('NFKC');
  return (
    /^[\s\S]{1,64}$/u.test(value) &&
    /^[\s\S]{1,64}$/u.test(normalized) &&
    normalized === normalized.toLowerCase() &&
    /^[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*$/u.test(normalized)
  );
}, 'Use 1–64 lowercase letters, digits and single hyphens');
const description = text.refine(
  (value) => value.trim().length > 0 && /^[\s\S]{1,1024}$/u.test(value),
  'Description must be 1–1024 characters',
);
const body = text
  .refine((value) => value.trim().length > 0, 'Body is required')
  .refine(
    (value) => new TextEncoder().encode(value).byteLength <= SKILL_BODY_MAX_BYTES,
    'Body must be at most 16 KiB in UTF-8',
  );

export const SkillInputSchema = z.object({ name, description, body }).strict();
export const SkillSelectionSchema = z.object({ id: z.string().uuid(), revision }).strict();
export const SkillMetadataSchema = SkillSelectionSchema.extend({
  name,
  description,
  disabled_at: z.string().datetime().nullable(),
});
export const SkillDetailSchema = SkillMetadataSchema.extend({ body });
export const SkillUpdateSchema = SkillInputSchema.extend({ expected_revision: revision });
export const SkillDisableSchema = z.object({ expected_revision: revision }).strict();
export const SkillListPageSchema = z
  .object({ items: z.array(SkillMetadataSchema), next_cursor: z.string().nullable() })
  .strict();
export const SkillImportPreviewSchema = SkillInputSchema.extend({
  extras: z
    .object({
      license: text.optional(),
      compatibility: text
        .refine((value) => /^[\s\S]{1,500}$/u.test(value), 'Compatibility must be 1–500 characters')
        .optional(),
      metadata: z.record(text).optional(),
      'allowed-tools': text.optional(),
    })
    .strict(),
});

export type SkillInput = z.infer<typeof SkillInputSchema>;
export type SkillSelection = z.infer<typeof SkillSelectionSchema>;
export type SkillMetadata = z.infer<typeof SkillMetadataSchema>;
export type SkillDetail = z.infer<typeof SkillDetailSchema>;
export type SkillImportPreview = z.infer<typeof SkillImportPreviewSchema>;
