import { z } from 'zod';

export const chatMessageLimit = 20_000;
export const chatFileCountLimit = 5;
const prefix = 'Along chat with files v1\n';

export const ChatFilesSchema = z
  .array(
    z
      .object({
        name: z
          .string()
          .min(1)
          .max(255)
          .refine((name) => !name.includes('\0')),
        text: z
          .string()
          .min(1)
          .max(chatMessageLimit)
          .refine((text) => !text.includes('\0') && Boolean(text.trim())),
      })
      .strict(),
  )
  .min(1)
  .max(chatFileCountLimit);

export type ChatFile = z.infer<typeof ChatFilesSchema>[number];

export function encodeChatMessage(instruction: string, files: readonly ChatFile[]): string {
  // Escape literal uses of the envelope marker, including pasted envelopes.
  return files.length || instruction.startsWith(prefix)
    ? prefix + JSON.stringify({ instruction, files_to_analyze_as_data: files })
    : instruction;
}

const stored = z
  .object({
    instruction: z.string(),
    files_to_analyze_as_data: z.union([ChatFilesSchema, z.tuple([])]),
  })
  .strict();

export function decodeChatMessage(content: string): z.infer<typeof stored> | null {
  if (!content.startsWith(prefix)) return null;
  try {
    const decoded = stored.safeParse(JSON.parse(content.slice(prefix.length)));
    return decoded.success ? decoded.data : null;
  } catch {
    return null;
  }
}
