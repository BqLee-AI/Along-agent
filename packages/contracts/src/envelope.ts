import { z } from "zod";

// Envelope: docs/design/10 §1 { code, data, msg, error? }; error carries request_id.
export const ErrorBodySchema = z.object({
  code: z.string(),
  message: z.string(),
  request_id: z.string(),
  details: z.unknown().optional(),
});

export const EnvelopeSchema = z.object({
  code: z.number(),
  data: z.unknown().optional(),
  msg: z.string(),
  error: ErrorBodySchema.optional(),
  request_id: z.string(),
});

export type Envelope = z.infer<typeof EnvelopeSchema>;
export type ErrorBody = z.infer<typeof ErrorBodySchema>;
