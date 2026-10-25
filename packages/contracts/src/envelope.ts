import { z } from 'zod';

// Envelope: success uses error:null; failures carry the typed request_id body.
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
  error: ErrorBodySchema.nullable().optional(),
  request_id: z.string(),
});

export type Envelope = z.infer<typeof EnvelopeSchema>;
export type ErrorBody = z.infer<typeof ErrorBodySchema>;
