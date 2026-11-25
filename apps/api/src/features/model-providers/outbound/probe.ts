import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import {
  HARNESS_PROTOCOL_VERSION,
  HarnessModelStepSchema,
  type HarnessModelReply,
  type HarnessRequest,
  type HarnessTool,
  type ProviderConnectionTest,
  type ProviderTest,
} from '@along/contracts';
import { decryptCredential, credentialKey } from '../configuration/crypto.js';
import { ownedProvider } from '../configuration/service.js';
import { externalFailure } from './errors.js';
import { outboundJson, OutboundError } from './outbound.js';
import { withTransaction } from '../../../db/transaction.js';
import {
  ApplicationError,
  notReady,
  stateConflict,
  validationError,
} from '../../../platform/errors.js';
import type { ModelStepTransport, ModelTransportFactory } from '../inference/model-contract.js';
import { lockOwner } from '../run-binding.js';
type ProbeResult = {
  text_stream: ProbeStatus;
  tool_round_trip: ProbeStatus;
  usage: ProbeStatus;
};
type ProbeStatus = { status: 'passed' | 'failed' | 'not_tested'; latency_ms: number | null };
const untested = (): ProbeStatus => ({ status: 'not_tested', latency_ms: null });
const probeTool: HarnessTool = {
  name: 'probe_echo',
  description: 'Return the supplied synthetic value.',
  parameters: {
    type: 'object',
    properties: { value: { type: 'string' } },
    required: ['value'],
    additionalProperties: false,
  },
  risk: 'low',
};

async function resolveProbeConfig(
  pool: Pool,
  ownerId: string,
  id: string,
  input: ProviderConnectionTest,
): Promise<{ baseUrl: string; key: string | null }> {
  const row = await withTransaction(pool, async (client) => {
    await lockOwner(client, ownerId);
    const current = await ownedProvider(client, ownerId, id);
    const action = input.credential?.action ?? 'keep';
    if (input.base_url !== undefined && input.base_url !== current.base_url && action === 'keep')
      throw validationError('changing endpoint requires replacing or clearing the credential');
    return current;
  });
  const baseUrl = input.base_url ?? row.base_url;
  if (!baseUrl) throw stateConflict('provider unavailable');
  const action = input.credential ?? { action: 'keep' as const };
  const key =
    action.action === 'replace'
      ? action.api_key
      : action.action === 'clear'
        ? null
        : row.credential_ciphertext
          ? decryptCredential(credentialKey(), ownerId, id, row.credential_ciphertext)
          : null;
  return { baseUrl, key };
}

/** Probe the provider endpoint without synchronizing or changing its configuration. */
export async function testProviderConnection(
  pool: Pool,
  ownerId: string,
  id: string,
  input: ProviderConnectionTest,
  request: typeof outboundJson = outboundJson,
): Promise<{ status: 'passed'; latency_ms: number }> {
  const { baseUrl, key } = await resolveProbeConfig(pool, ownerId, id, input);
  const start = performance.now();
  try {
    await request(baseUrl, 'models', key);
  } catch (error) {
    externalFailure(error);
  }
  return { status: 'passed', latency_ms: Math.max(0, Math.round(performance.now() - start)) };
}

/** Uses the same single-step transport as inference, never a business tool gateway. */
export async function testProvider(
  pool: Pool,
  ownerId: string,
  id: string,
  input: ProviderTest,
  factory?: ModelTransportFactory,
  signal?: AbortSignal,
): Promise<ProbeResult> {
  if (!input.model_id) throw validationError('model id required');
  const { baseUrl, key } = await resolveProbeConfig(pool, ownerId, id, input);
  const result: ProbeResult = {
    text_stream: untested(),
    tool_round_trip: untested(),
    usage: untested(),
  };
  if (!factory) throw notReady('model provider test transport unavailable');
  const probeSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
    : AbortSignal.timeout(30_000);
  const abortable = async <T>(promise: Promise<T>): Promise<T> => {
    if (probeSignal.aborted) {
      void promise.catch(() => undefined);
      throw probeSignal.reason;
    }
    let onAbort: () => void = () => {};
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(probeSignal.reason);
      probeSignal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      return await Promise.race([promise, aborted]);
    } finally {
      probeSignal.removeEventListener('abort', onAbort);
    }
  };
  let model: ModelStepTransport;
  try {
    if (probeSignal.aborted) throw probeSignal.reason;
    model = (
      await abortable(factory({ base_url: baseUrl, api_key: key, model_id: input.model_id }))
    ).model;
  } catch (error) {
    if (probeSignal.aborted)
      throw new ApplicationError(504, 'MODEL_PROVIDER_TIMEOUT', 'model provider request failed');
    if (error instanceof OutboundError) externalFailure(error);
    throw new ApplicationError(502, 'MODEL_PROVIDER_CONNECTION', 'model provider request failed');
  }
  const start = performance.now();
  const measured = (status: 'passed' | 'failed', since: number): ProbeStatus => ({
    status,
    latency_ms: Math.max(0, Math.round(performance.now() - since)),
  });
  const run = async (
    messages: Extract<HarnessRequest, { type: 'model' }>['messages'],
    tools: readonly HarnessTool[],
  ) => {
    let reply: HarnessModelReply | undefined;
    let delta = false;
    const request: Extract<HarnessRequest, { type: 'model' }> = {
      protocol: HARNESS_PROTOCOL_VERSION,
      request_ref: randomUUID(),
      type: 'model',
      messages,
      remaining_tokens: 512,
      max_output_tokens: 128,
    };
    let size = 0;
    const stream = model(request, tools, probeSignal);
    try {
      while (true) {
        if (probeSignal.aborted) throw probeSignal.reason;
        const step = await abortable(stream.next());
        if (step.done) break;
        const raw = step.value;
        size += Buffer.byteLength(JSON.stringify(raw), 'utf8');
        if (size > 1024 * 1024) throw new OutboundError('incompatible');
        const parsed = HarnessModelStepSchema.safeParse(raw);
        if (!parsed.success || reply || parsed.data.type === 'failed')
          throw new OutboundError('incompatible');
        if (parsed.data.type === 'delta') delta = true;
        else reply = parsed.data.reply;
      }
    } finally {
      void stream.return(undefined).catch(() => undefined);
    }
    if (!reply) throw new OutboundError('incompatible');
    if (reply.usage !== null && result.usage.status !== 'passed')
      result.usage = measured('passed', start);
    return { reply, delta };
  };
  try {
    const text = await run([{ role: 'user', content: 'Reply with a short greeting.' }], []);
    result.text_stream = measured(text.delta ? 'passed' : 'failed', start);
  } catch (error) {
    if (error instanceof OutboundError) externalFailure(error);
    throw new ApplicationError(
      probeSignal.aborted ? 504 : 502,
      probeSignal.aborted ? 'MODEL_PROVIDER_TIMEOUT' : 'MODEL_PROVIDER_CONNECTION',
      'model provider request failed',
    );
  }
  const toolStart = performance.now();
  try {
    const initial = await run(
      [{ role: 'user', content: 'Call probe_echo with value "probe", then respond briefly.' }],
      [probeTool],
    );
    const calls = initial.reply.message.tool_calls;
    if (calls.length !== 1 || calls[0]!.function.name !== probeTool.name) {
      result.tool_round_trip = measured('failed', toolStart);
    } else {
      const call = calls[0]!;
      const args: unknown = JSON.parse(call.function.arguments);
      if (!args || typeof args !== 'object' || !('value' in args) || args.value !== 'probe')
        throw new Error('invalid probe call');
      const final = await run(
        [
          { role: 'user', content: 'Call probe_echo with value "probe", then respond briefly.' },
          { role: 'assistant', content: initial.reply.message.content ?? '', tool_calls: [call] },
          { role: 'tool', tool_call_id: call.id, content: 'probe' },
        ],
        [probeTool],
      );
      result.tool_round_trip = measured(
        final.reply.message.tool_calls.length === 0 &&
          (final.delta || !!final.reply.message.content)
          ? 'passed'
          : 'failed',
        toolStart,
      );
    }
  } catch {
    if (probeSignal.aborted)
      throw new ApplicationError(504, 'MODEL_PROVIDER_TIMEOUT', 'model provider request failed');
    result.tool_round_trip = measured('failed', toolStart);
  }
  if (result.usage.status === 'not_tested') result.usage = measured('failed', start);
  return result;
}
