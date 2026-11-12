import { z } from 'zod';

export const MeSchema = z.object({
  user: z.object({ id: z.string().uuid(), display_name: z.string() }),
  csrf_token: z.string().nullable(),
  confirmed_timezone: z.string().nullable(),
});
export type Me = z.infer<typeof MeSchema>;
