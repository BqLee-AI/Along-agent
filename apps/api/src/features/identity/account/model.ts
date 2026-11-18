import { z } from 'zod';
import {
  authContactVerifySchema,
  authInvitationAcceptSchema,
  authPasswordResetSchema,
} from '@along/contracts';
export * from '@along/contracts';
// These capabilities consume durable quota even for malformed bounded input.
// Validation remains in the account use case, after its quota admission.
export const ContactVerifyInputSchema = z.custom<z.input<typeof authContactVerifySchema>>(
  () => true,
);
export const InvitationAcceptInputSchema = z.custom<z.input<typeof authInvitationAcceptSchema>>(
  () => true,
);
export const PasswordResetInputSchema = z.custom<z.input<typeof authPasswordResetSchema>>(
  () => true,
);
export const MeSchema = z.object({
  user: z.object({ id: z.string(), display_name: z.string() }),
  csrf_token: z.string().nullable(),
  confirmed_timezone: z.string().nullable(),
});
