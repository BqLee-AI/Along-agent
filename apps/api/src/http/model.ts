import { z } from 'zod';

export const ErrorEnvelopeSchema = z.object({
  code: z.number(),
  data: z.null(),
  msg: z.string(),
  error: z.object({
    code: z.string(),
    message: z.string(),
    request_id: z.string(),
    details: z.unknown().optional(),
  }),
  request_id: z.string(),
});
export const errorResponses = {
  400: ErrorEnvelopeSchema,
  401: ErrorEnvelopeSchema,
  403: ErrorEnvelopeSchema,
  404: ErrorEnvelopeSchema,
  409: ErrorEnvelopeSchema,
  410: ErrorEnvelopeSchema,
  413: ErrorEnvelopeSchema,
  422: ErrorEnvelopeSchema,
  429: ErrorEnvelopeSchema,
  500: ErrorEnvelopeSchema,
  502: ErrorEnvelopeSchema,
  503: ErrorEnvelopeSchema,
  504: ErrorEnvelopeSchema,
} as const;
export function envelope<T extends z.ZodTypeAny>(data: T) {
  return z.object({
    code: z.literal(0),
    data,
    msg: z.literal('ok'),
    error: z.null(),
    request_id: z.string(),
  });
}
export function responses<T extends z.ZodTypeAny>(data: T) {
  return { 200: envelope(data), ...errorResponses };
}
