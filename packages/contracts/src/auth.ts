import { z } from 'zod';

const loginName = z
  .string()
  .transform((value) => value.trim().toLowerCase())
  .pipe(z.string().min(1).max(128));
const password = z.string().min(8).max(128);
export const authInitializeSchema = z
  .object({ login_name: loginName, password, display_name: z.string().trim().min(1).max(128) })
  .strict();
export const authClaimSchema = z
  .object({ login_name: loginName, password, confirmed: z.literal(true) })
  .strict();
export const authSignInSchema = z.object({ login_name: loginName, password }).strict();
export const authSignOutSchema = z.object({}).strict();
export const authStatusSchema = z
  .object({
    state: z.enum(['setup_required', 'legacy_claim_required', 'ready']),
    can_claim: z.boolean().optional(),
    workspace_state: z.enum(['unconfigured', 'loaded', 'invalid', 'unreadable']).optional(),
  })
  .strict();
export const authAuthenticatedSchema = z
  .object({
    authenticated: z.literal(true),
    workspace_binding: z.literal('pending_local_configuration').optional(),
  })
  .strict();
export const authSignedOutSchema = z.object({ signed_out: z.literal(true) }).strict();
export type AuthInitializeInput = z.infer<typeof authInitializeSchema>;
export type AuthClaimInput = z.infer<typeof authClaimSchema>;
export type AuthSignInInput = z.infer<typeof authSignInSchema>;
export type AuthSignOutInput = z.infer<typeof authSignOutSchema>;
export type AuthStatus = z.infer<typeof authStatusSchema>;
export type AuthAuthenticated = z.infer<typeof authAuthenticatedSchema>;
export type AuthSignedOut = z.infer<typeof authSignedOutSchema>;
