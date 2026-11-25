import { z } from 'zod';

const loginName = z
  .string()
  .transform((value) => value.trim().toLowerCase())
  .pipe(z.string().min(1).max(128));
const password = z.string().min(8).max(128);
const displayName = z.string().trim().min(1).max(128);
export const authInitializeSchema = z
  .object({ login_name: loginName, password, display_name: displayName })
  .strict();
export const authClaimSchema = z
  .object({ login_name: loginName, password, confirmed: z.literal(true) })
  .strict();
export const authAccountProfileUpdateSchema = z
  .object({
    display_name: displayName.optional(),
    timezone_id: z.string().trim().min(1).max(100).nullable().optional(),
  })
  .strict()
  .refine((value) => value.display_name !== undefined || value.timezone_id !== undefined);
export const authAccountProfileSchema = z
  .object({ display_name: z.string(), timezone_id: z.string().nullable() })
  .strict();
// Syntax only here; identity owns the single mailbox policy and normalization.
const email = z
  .string()
  .transform((value) => value.replace(/^[\t\n\v\f\r ]+|[\t\n\v\f\r ]+$/g, ''))
  .pipe(
    z
      .string()
      .max(254)
      .regex(/^[\x21-\x3f\x41-\x7e]+@[A-Za-z0-9.-]+\.[A-Za-z0-9.-]+$/),
  );
export const authSignInSchema = z.union([
  z.object({ login_name: loginName, password }).strict(),
  z.object({ email, password }).strict(),
]);
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

const token = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const currentPassword = { current_password: password };
const idempotencyKey = { idempotency_key: z.string().uuid() };
export const authContactRequestSchema = z.object({ email, ...currentPassword }).strict();
export const authContactVerifySchema = z.object({ token }).strict();
export const authInvitationCreateSchema = z
  .object({ email, ...currentPassword, ...idempotencyKey })
  .strict();
export const authInvitationResendSchema = z
  .object({ ...currentPassword, ...idempotencyKey })
  .strict();
export const authInvitationRevokeSchema = z.object(currentPassword).strict();
export const authInvitationAcceptSchema = z
  .object({
    token,
    login_name: loginName,
    password,
    display_name: z.string().trim().min(1).max(128),
  })
  .strict();
export const authPasswordForgotSchema = z.object({ email }).strict();
export const authPasswordResetSchema = z.object({ token, new_password: password }).strict();
export const authPasswordChangeSchema = z
  .object({ ...currentPassword, new_password: password })
  .strict();
export const authSessionRevokeSchema = z.object({}).strict();
export const authSessionsRevokeSchema = z
  .object({ scope: z.enum(['others', 'all']), ...currentPassword })
  .strict();
export const authDisableUserSchema = z
  .object({ ...currentPassword, confirmed: z.literal(true) })
  .strict();
export const authDeletionRequestSchema = z
  .object({ ...currentPassword, confirmed: z.literal(true) })
  .strict();
export const authListQuerySchema = z
  .object({
    limit: z
      .union([
        z.number(),
        z
          .string()
          .regex(/^[0-9]+$/)
          .transform(Number),
      ])
      .pipe(z.number().int().min(1).max(50))
      .default(20),
    cursor: z.string().min(1).max(2048).optional(),
  })
  .strict();

const timestamp = z.string().datetime();
const uuid = z.string().uuid();
export const DeliveryViewSchema = z
  .object({
    delivery_id: uuid,
    status: z.enum(['queued', 'submitting', 'submitted', 'failed', 'unknown', 'suppressed']),
    updated_at: timestamp,
  })
  .strict();
export const InvitationViewSchema = z
  .object({
    id: uuid,
    masked_email: z.string(),
    state: z.enum(['pending', 'accepted', 'revoked', 'expired']),
    generation: z.number().int().positive(),
    created_at: timestamp,
    expires_at: timestamp,
    accepted_at: timestamp.nullable(),
    revoked_at: timestamp.nullable(),
    delivery: DeliveryViewSchema,
  })
  .strict();
export const AccountViewSchema = z
  .object({
    user: z.object({ id: uuid, display_name: z.string() }).strict(),
    account_status: z.literal('active'),
    installation_admin: z.boolean(),
    contact: z
      .object({
        state: z.enum(['unbound', 'verified']),
        masked_email: z.string().nullable(),
        verified_at: timestamp.nullable(),
      })
      .strict(),
    pending_contact: z
      .object({ masked_email: z.string(), expires_at: timestamp, delivery: DeliveryViewSchema })
      .strict()
      .nullable(),
    workspace: z
      .object({
        count: z.number().int().nonnegative(),
        state: z.enum(['none', 'available', 'unavailable']),
      })
      .strict(),
  })
  .strict();
export const SessionViewSchema = z
  .object({
    id: uuid,
    created_at: timestamp,
    expires_at: timestamp,
    revoked_at: timestamp.nullable(),
    current: z.boolean(),
    device_summary: z
      .string()
      .max(128)
      .regex(/^[\x20-\x7e\u0080-\uffff]*$/)
      .nullable(),
  })
  .strict();
export const ManagedAccountViewSchema = z
  .object({
    id: uuid,
    display_name: z.string(),
    status: z.enum(['active', 'disabled', 'deleted_requested']),
    admitted: z.boolean(),
    installation_admin: z.boolean(),
    masked_email: z.string().nullable(),
    created_at: timestamp,
  })
  .strict();
export const authContactRequestedSchema = z
  .object({ contact_state: z.literal('pending'), delivery: DeliveryViewSchema })
  .strict();
export const authContactVerifiedSchema = z
  .object({ contact_state: z.literal('verified') })
  .strict();
export const authInvitationCreatedSchema = z.object({ invitation: InvitationViewSchema }).strict();
export const authInvitationRevokedSchema = z.object({ revoked: z.literal(true) }).strict();
export const authInvitationAcceptedSchema = z
  .object({ account_created: z.literal(true), authenticated: z.literal(false) })
  .strict();
export const authPasswordForgottenSchema = z.object({ accepted: z.literal(true) }).strict();
export const authPasswordResetResultSchema = z
  .object({ password_changed: z.literal(true), authenticated: z.literal(false) })
  .strict();
export const authPasswordChangedSchema = z
  .object({ password_changed: z.literal(true), signed_out: z.literal(true) })
  .strict();
export const authSessionRevokedSchema = z
  .object({ revoked: z.literal(true), signed_out: z.boolean() })
  .strict();
export const authUserDisabledSchema = z.object({ disabled: z.literal(true) }).strict();
export const authDeletionRequestedSchema = z
  .object({ deletion_requested: z.literal(true), signed_out: z.literal(true) })
  .strict();
export const authInvitationsSchema = z
  .object({ items: z.array(InvitationViewSchema), next_cursor: z.string().nullable() })
  .strict();
export const authSessionsSchema = z
  .object({ items: z.array(SessionViewSchema), next_cursor: z.string().nullable() })
  .strict();
export const authUsersSchema = z
  .object({ items: z.array(ManagedAccountViewSchema), next_cursor: z.string().nullable() })
  .strict();
export type DeliveryView = z.infer<typeof DeliveryViewSchema>;
export type InvitationView = z.infer<typeof InvitationViewSchema>;
export type AccountView = z.infer<typeof AccountViewSchema>;
export type SessionView = z.infer<typeof SessionViewSchema>;
export type ManagedAccountView = z.infer<typeof ManagedAccountViewSchema>;
export type AuthContactRequestInput = z.infer<typeof authContactRequestSchema>;
export type AuthContactVerifyInput = z.infer<typeof authContactVerifySchema>;
export type AuthInvitationCreateInput = z.infer<typeof authInvitationCreateSchema>;
export type AuthInvitationResendInput = z.infer<typeof authInvitationResendSchema>;
export type AuthInvitationRevokeInput = z.infer<typeof authInvitationRevokeSchema>;
export type AuthInvitationAcceptInput = z.infer<typeof authInvitationAcceptSchema>;
export type AuthPasswordForgotInput = z.infer<typeof authPasswordForgotSchema>;
export type AuthPasswordResetInput = z.infer<typeof authPasswordResetSchema>;
export type AuthPasswordChangeInput = z.infer<typeof authPasswordChangeSchema>;
export type AuthSessionRevokeInput = z.infer<typeof authSessionRevokeSchema>;
export type AuthSessionsRevokeInput = z.infer<typeof authSessionsRevokeSchema>;
export type AuthDisableUserInput = z.infer<typeof authDisableUserSchema>;
export type AuthDeletionRequestInput = z.infer<typeof authDeletionRequestSchema>;
export type AuthListQuery = z.infer<typeof authListQuerySchema>;
