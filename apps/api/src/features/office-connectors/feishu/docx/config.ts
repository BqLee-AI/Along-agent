import { z } from 'zod';

const directDocx = /^https:\/\/[a-z0-9-]+\.feishu\.cn\/docx\/[A-Za-z0-9]{27}$/u;
const envRef = z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/u);
const configuration = z
  .object({
    connectionId: z.string().uuid(),
    revision: z.string().uuid(),
    ownerId: z.string().uuid(),
    appId: z.string().regex(/^cli_[a-z0-9]{12,64}$/iu),
    secretEnv: envRef,
    observationKeyEnv: envRef,
    documents: z.array(z.string().regex(directDocx)).min(1),
  })
  .strict()
  .refine((value) => value.secretEnv !== value.observationKeyEnv);

export type FeishuBotDocxConfiguration = z.infer<typeof configuration>;

export function loadFeishuBotDocxConfiguration(
  env: NodeJS.ProcessEnv = process.env,
): FeishuBotDocxConfiguration | null {
  const encoded = env.FEISHU_BOT_DOCX_CONFIG;
  if (!encoded) return null;
  try {
    const parsed = configuration.safeParse(JSON.parse(encoded));
    if (!parsed.success) return null;
    const { secretEnv, observationKeyEnv, ...policy } = parsed.data;
    if (!env[secretEnv] || !env[observationKeyEnv]) return null;
    return { ...policy, secretEnv, observationKeyEnv };
  } catch {
    return null;
  }
}

export function readFeishuBotObservationKey(
  config: FeishuBotDocxConfiguration,
  env: NodeJS.ProcessEnv = process.env,
) {
  const encoded = env[config.observationKeyEnv];
  if (!encoded) return null;
  const key = Buffer.from(encoded, 'base64');
  return key.length === 32 && key.toString('base64') === encoded ? key : null;
}
