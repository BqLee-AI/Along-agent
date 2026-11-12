import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { z } from 'zod';
import {
  ApprovalDetailSchema,
  EnvelopeSchema,
  HarnessApprovalDecisionSchema,
  HarnessModelMessageSchema,
  RunViewSchema,
} from '@along/contracts';
import type { RunView } from '@along/contracts';
import type { HarnessModelReply } from '@along/contracts';
import { ThreadEventSchema } from '@along/stream-protocol';
import type { ThreadEvent } from '@along/stream-protocol';
import { handleRequest } from '../../src/http/app.js';
import { HttpError } from '../../src/http/errors.js';
import { confirmApproval, rejectApproval } from '../../src/modules/approvals/confirm.js';
import type { ConfirmResult, RejectResult } from '../../src/modules/approvals/confirm.js';
import { getApprovalDetail } from '../../src/modules/approvals/service.js';
import {
  cancelConversationRun,
  executeRun,
  getConversationDetail,
  getRunView,
  resumeConversationRun,
  startConversationRun,
} from '../../src/modules/conversations/service.js';
import type {
  ConversationDeps,
  RunContext,
  StartResult,
} from '../../src/modules/conversations/contracts.js';
import { createHarnessModelTransport } from '../../src/modules/conversations/harness-model.js';
import type { HarnessServices } from '../../src/modules/conversations/harness-process.js';
import { createContextPolicy } from '../../src/modules/conversations/context-policy.js';
import { measureHarnessContext } from '../../src/modules/conversations/harness-context.js';
import { configureTestModel } from './model-selection.js';
import { SendMessageBodySchema } from '../../src/modules/conversations/schemas.js';
import { seedAdmittedSession as seedSession } from '../integration/setup.js';
import type { SeededSession } from '../../src/modules/identity/seed.js';
import { loadTimeContext } from '../../src/modules/time/context.js';
import { createIntegrationDatabase } from '../integration/setup.js';
import type { IntegrationDatabase } from '../integration/setup.js';

type HarnessModelMessage = z.infer<typeof HarnessModelMessageSchema>;

// Inspect typed data delivered to the model, not native's explanatory prompt wording.
export function findModelObservation<T>(
  messages: readonly HarnessModelMessage[],
  schema: z.ZodType<T>,
): T | undefined {
  for (const message of messages) {
    const offset = message.content.indexOf('{');
    if (offset < 0) continue;
    let value: unknown;
    try {
      value = JSON.parse(message.content.slice(offset));
    } catch {
      continue;
    }
    const parsed = schema.safeParse(value);
    if (parsed.success) return parsed.data;
  }
  return undefined;
}

// These small HTTP/SSE helpers are shared with the original native integration suite.
export function frames(text: string): ThreadEvent[] {
  return text
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => ThreadEventSchema.parse(JSON.parse(line.slice(6))));
}

export function started(events: ThreadEvent[]) {
  const event = events.find((value) => value.type === 'thread.started');
  if (!event || event.type !== 'thread.started') throw new Error('missing started');
  return event.payload;
}

export function pending(events: ThreadEvent[]) {
  const event = events.find((value) => value.type === 'approval_required');
  if (!event || event.type !== 'approval_required') throw new Error('missing approval');
  return event.payload.approval_id;
}

export async function jsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const value of req) chunks.push(Buffer.isBuffer(value) ? value : Buffer.from(value));
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

// A provider fixture emits the production streaming protocol, including explicit
// choice/call indexes, terminal reason, usage-only chunk and stream terminator.
export function sendModelSse(res: ServerResponse, reply: HarnessModelReply): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const chunk = (value: unknown) => res.write(`data: ${JSON.stringify(value)}\n\n`);
  const { content, tool_calls: calls } = reply.message;
  if (content) {
    for (let offset = 0; offset < content.length;) {
      let end = Math.min(offset + 1000, content.length);
      if (end < content.length && /[\uD800-\uDBFF]/.test(content[end - 1]!)) end--;
      chunk({
        choices: [
          { index: 0, delta: { content: content.slice(offset, end) }, finish_reason: null },
        ],
      });
      offset = end;
    }
  }
  if (calls.length) {
    chunk({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: calls.map((call, index) => ({
              index,
              id: call.id,
              type: call.type,
              function: { name: call.function.name, arguments: '' },
            })),
          },
          finish_reason: null,
        },
      ],
    });
    for (const [index, call] of calls.entries()) {
      for (const fragment of call.function.arguments.match(/.{1,16}/gsu) ?? []) {
        chunk({
          choices: [
            {
              index: 0,
              delta: { tool_calls: [{ index, function: { arguments: fragment } }] },
              finish_reason: null,
            },
          ],
        });
      }
    }
  }
  chunk({
    choices: [{ index: 0, delta: {}, finish_reason: calls.length ? 'tool_calls' : 'stop' }],
  });
  if (reply.usage) chunk({ choices: [], usage: reply.usage });
  res.end('data: [DONE]\n\n');
}

export async function listen(server: Server): Promise<string> {
  const ready = once(server, 'listening');
  server.listen(0, '127.0.0.1');
  await ready;
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing port');
  return `http://127.0.0.1:${address.port}`;
}

export type ConsumerMode = 'local' | 'http';
export type ModelCase = 'create' | 'hold' | 'denied';
export interface ConsumerStream {
  context: RunContext | null;
  events: Promise<ThreadEvent[]>;
}
export interface ModelGate {
  started: PromiseWithResolvers<void>;
  closed: PromiseWithResolvers<boolean>;
  release: PromiseWithResolvers<void>;
}

const ModelBody = z.object({
  stream: z.literal(true),
  stream_options: z.object({ include_usage: z.literal(true) }),
  messages: z.array(HarnessModelMessageSchema),
});
const Confirmed = z.object({
  approval_id: z.string().uuid(),
  status: z.literal('consumed'),
  task_id: z.string().uuid(),
  duplicate: z.boolean(),
});
const Rejected = z.object({
  approval_id: z.string().uuid(),
  status: z.literal('rejected'),
  duplicate: z.boolean(),
});
const Conversation = z.object({
  conversation_id: z.string().uuid(),
  events: z.array(ThreadEventSchema),
});

async function successful(response: Response): Promise<unknown> {
  if (!response.ok) {
    if (response.headers.get('content-type')?.includes('text/event-stream')) {
      throw new Error('prewrite rejection incorrectly opened SSE');
    }
    const envelope = EnvelopeSchema.parse(await response.json());
    if (!envelope.error) throw new Error('missing typed HTTP error');
    if (envelope.error.request_id !== envelope.request_id) {
      throw new Error('HTTP error request identity mismatch');
    }
    throw new HttpError(
      response.status,
      envelope.code,
      envelope.error.code,
      envelope.error.message,
      envelope.error.details,
    );
  }
  const envelope = EnvelopeSchema.parse(await response.json());
  if (response.status !== 200 || envelope.code !== 0 || envelope.error !== null) {
    throw new Error('invalid successful HTTP envelope');
  }
  return envelope.data;
}

export class HarnessConsumer {
  readonly transcripts = new Map<string, HarnessModelMessage[][]>();
  readonly providerErrors: unknown[] = [];
  readonly gates = new Map<string, ModelGate>();
  readonly executions = new Set<Promise<unknown>>();
  readonly deps: ConversationDeps;
  model!: HarnessServices['model'];
  private server: Server | undefined;
  private modelServer: Server | undefined;
  private base = '';

  constructor(readonly database: IntegrationDatabase) {
    this.deps = { pool: database.pool, timeContext: loadTimeContext('fixture-v1') };
  }

  async initialize(): Promise<void> {
    const binaryPath = process.env.HARNESS_BINARY;
    const libraryPath = process.env.HARNESS_LIBRARY_PATH;
    if (!binaryPath || !libraryPath || !process.env.BETTER_AUTH_SECRET) {
      throw new Error('HARNESS_BINARY, HARNESS_LIBRARY_PATH and BETTER_AUTH_SECRET are required');
    }
    this.modelServer = createServer((req, res) => {
      void (async () => {
        const body = ModelBody.parse(await jsonBody(req));
        const original = body.messages.find((message) => message.content.includes('nativeCase:'));
        const marker = /nativeCase:([\w-]+):(\w+)/.exec(original?.content ?? '');
        if (!marker) throw new Error('missing fixture marker');
        const id = marker[1]!;
        const kind = marker[2]!;
        const calls = this.transcripts.get(id) ?? [];
        calls.push(body.messages);
        this.transcripts.set(id, calls);
        const gate = this.gates.get(id);
        if (kind === 'hold') {
          if (!gate) throw new Error('missing held provider');
          res.once('close', () => gate.closed.resolve(!res.writableEnded && res.destroyed));
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write(': provider waiting\n\n', () => gate.started.resolve());
          return;
        }
        // Synchronize on the real request, even if a mutant omitted its decision data.
        if (gate && calls.length > 1) {
          gate.started.resolve();
          await gate.release.promise;
        }
        const decision = findModelObservation(body.messages, HarnessApprovalDecisionSchema);
        if (decision?.kind === 'task') {
          sendModelSse(res, {
            message: { content: `记录结果 task:${decision.task_id}`, tool_calls: [] },
            usage: { total_tokens: 5 },
          });
          return;
        }
        // A second request after a denied result would be a product defect. Return
        // legal final text so the assertions observe that defect, not a fixture error.
        if (calls.length > 1) {
          sendModelSse(res, {
            message: { content: 'unexpected retry', tool_calls: [] },
            usage: { total_tokens: 5 },
          });
          return;
        }
        const name = kind === 'create' ? 'propose_task' : 'get_user_prefs';
        const args =
          kind === 'create'
            ? {
                raw_time_text: '2027-11-02 09:20',
                timezone_hint: 'Asia/Shanghai',
                note: `native-${id}`,
                occurrence: 'once',
              }
            : { owner_id: randomUUID() };
        sendModelSse(res, {
          message: {
            content: null,
            tool_calls: [
              {
                id: 'provider-id-is-not-invocation',
                type: 'function',
                function: { name, arguments: JSON.stringify(args) },
              },
            ],
          },
          usage: { total_tokens: 5 },
        });
      })().catch((error: unknown) => {
        this.providerErrors.push(error);
        if (!res.headersSent) res.writeHead(500);
        res.end('fixture provider failed');
      });
    });
    const modelBase = await listen(this.modelServer);
    this.deps.harness = {
      binaryPath,
      libraryPath,
      maxIterations: 8,
      maxTokens: 8000,
      contextPolicy: createContextPolicy({ completionCap: 1024, model: 'fixture-transport-only' }),
    };
    this.model = createHarnessModelTransport({
      baseUrl: `${modelBase}/v1`,
      model: 'fixture-transport-only',
    });
    // Test-only controlled provider seam: exercises native authority, not SDK
    // encoding, outbound-policy enforcement, or real provider acceptance.
    this.deps.modelTransport = async () => ({
      model: this.model,
      measure: measureHarnessContext,
    });
    this.server = createServer((req, res) => {
      void handleRequest(req, res, {
        pool: this.database.pool,
        tzdbVersion: 'fixture-v1',
        harness: this.deps.harness,
        modelTransport: this.deps.modelTransport,
        routing: this.deps.routing,
      }).catch(() => res.destroy());
    });
    this.base = await listen(this.server);
  }

  async actor(mode: ConsumerMode): Promise<HarnessActor> {
    const session = await seedSession(this.database.pool, { timezoneId: 'Europe/London' });
    const model = this.deps.harness!.contextPolicy.model_binding.model;
    await configureTestModel(this.database.pool, session.userId, model);
    return new HarnessActor(this, mode, session);
  }

  gate(id: string): ModelGate {
    const gate = {
      started: Promise.withResolvers<void>(),
      closed: Promise.withResolvers<boolean>(),
      release: Promise.withResolvers<void>(),
    };
    this.gates.set(id, gate);
    return gate;
  }

  input(id: string, kind: ModelCase) {
    return SendMessageBodySchema.parse({
      execution: 'harness',
      raw_text: `nativeCase:${id}:${kind} 2027-11-02 09:20`,
      confirmed_timezone: 'Asia/Shanghai',
      idempotency_key: randomUUID(),
    });
  }

  request(actor: HarnessActor, path: string, body?: unknown, csrf = true): Promise<Response> {
    return fetch(`${this.base}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        cookie: `better-auth.session_token=${actor.session.token}`,
        ...(csrf ? { 'x-csrf-token': actor.session.csrfToken } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  track<T>(work: Promise<T>): Promise<T> {
    this.executions.add(work);
    void work.finally(() => this.executions.delete(work)).catch(() => {});
    return work;
  }

  // Full durable rows, not counts: replay cannot replace an ID, advance a
  // checkpoint, append an audit row or mutate a state while preserving totals.
  async facts(ownerId: string): Promise<Record<string, unknown[]>> {
    const facts: Record<string, unknown[]> = {};
    for (const table of [
      'conversations',
      'messages',
      'agent_runs',
      'run_attempts',
      'run_checkpoints',
      'conversation_idempotency',
      'harness_resumes',
      'harness_cancellations',
      'tool_invocations',
      'tool_calls',
      'approvals',
      'tasks',
      'task_events',
      'outbox',
    ]) {
      facts[table] = (
        await this.database.pool.query<{ fact: unknown }>(
          `SELECT to_jsonb(t) AS fact FROM ${table} t WHERE owner_id=$1 ORDER BY to_jsonb(t)::text`,
          [ownerId],
        )
      ).rows.map((row) => row.fact);
    }
    return facts;
  }

  async close(): Promise<void> {
    try {
      const active = await this.database.pool.query<{
        owner_id: string;
        conversation_id: string;
        id: string;
      }>("SELECT owner_id,conversation_id,id FROM agent_runs WHERE status='running'");
      for (const run of active.rows) {
        await cancelConversationRun(
          this.deps,
          run.owner_id,
          run.conversation_id,
          run.id,
          randomUUID(),
          { idempotency_key: randomUUID(), reason: 'fixture_cleanup' },
        );
      }
      for (const gate of this.gates.values()) gate.release.resolve();
      await Promise.allSettled([...this.executions]);
    } finally {
      for (const running of [this.server, this.modelServer]) {
        if (!running?.listening) continue;
        const closed = once(running, 'close');
        running.closeAllConnections();
        running.close();
        await closed;
      }
      await this.database.close();
    }
  }
}

export class HarnessActor {
  constructor(
    readonly fixture: HarnessConsumer,
    readonly mode: ConsumerMode,
    readonly session: SeededSession,
  ) {}

  get ownerId(): string {
    return this.session.userId;
  }

  private execute(start: StartResult): ConsumerStream {
    const events: ThreadEvent[] = [];
    const work = start.replay
      ? Promise.resolve(start.replay)
      : (async () => {
          if (!start.context) throw new Error('missing executable context');
          await executeRun(this.fixture.deps, start.context, async (event) => {
            events.push(ThreadEventSchema.parse(event));
            return true;
          });
          return events;
        })();
    return { context: start.context, events: this.fixture.track(work) };
  }

  private async stream(response: Response): Promise<ConsumerStream> {
    if (!response.ok) {
      await successful(response);
      throw new Error('unreachable successful error response');
    }
    if (response.status !== 200) throw new Error('invalid SSE response status');
    if (!response.headers.get('content-type')?.includes('text/event-stream')) {
      throw new Error('missing SSE response');
    }
    return {
      context: null,
      events: this.fixture.track(response.text().then(frames)),
    };
  }

  async message(body: unknown): Promise<ConsumerStream> {
    if (this.mode === 'http') {
      return this.stream(await this.fixture.request(this, '/api/v1/conversations/messages', body));
    }
    return this.execute(
      await startConversationRun(this.fixture.deps, this.ownerId, randomUUID(), body, null),
    );
  }

  async resume(cid: string, rid: string, body: unknown): Promise<ConsumerStream> {
    if (this.mode === 'http') {
      return this.stream(
        await this.fixture.request(
          this,
          `/api/v1/conversations/${cid}/runs/${rid}/actions/resume`,
          body,
        ),
      );
    }
    return this.execute(
      await resumeConversationRun(this.fixture.deps, this.ownerId, cid, rid, randomUUID(), body),
    );
  }

  async cancel(cid: string, rid: string, body: unknown): Promise<RunView> {
    if (this.mode === 'local') {
      return cancelConversationRun(this.fixture.deps, this.ownerId, cid, rid, randomUUID(), body);
    }
    return RunViewSchema.parse(
      await successful(
        await this.fixture.request(
          this,
          `/api/v1/conversations/${cid}/runs/${rid}/actions/cancel`,
          body,
        ),
      ),
    );
  }

  async view(cid: string, rid: string): Promise<RunView> {
    if (this.mode === 'local') return getRunView(this.fixture.deps, this.ownerId, cid, rid);
    return RunViewSchema.parse(
      await successful(
        await this.fixture.request(this, `/api/v1/conversations/${cid}/runs/${rid}`),
      ),
    );
  }

  async history(cid: string): Promise<ThreadEvent[]> {
    if (this.mode === 'local') {
      return (await getConversationDetail(this.fixture.deps, this.ownerId, cid, {})).events;
    }
    return Conversation.parse(
      await successful(await this.fixture.request(this, `/api/v1/conversations/${cid}`)),
    ).events;
  }

  async confirm(approvalId: string): Promise<ConfirmResult> {
    const detail = ApprovalDetailSchema.parse(
      this.mode === 'local'
        ? (await getApprovalDetail(this.fixture.deps, this.ownerId, approvalId)).detail
        : await successful(await this.fixture.request(this, `/api/v1/approvals/${approvalId}`)),
    );
    const body = {
      presentation_hash: detail.presentation_hash,
      seen_content: detail.echo_text,
      idempotency_key: randomUUID(),
    };
    if (this.mode === 'local') {
      return confirmApproval(this.fixture.deps, this.ownerId, approvalId, body);
    }
    return Confirmed.parse(
      await successful(
        await this.fixture.request(this, `/api/v1/approvals/${approvalId}/actions/confirm`, body),
      ),
    );
  }

  async reject(approvalId: string): Promise<RejectResult> {
    const body = { idempotency_key: randomUUID(), reason: 'do not create' };
    if (this.mode === 'local') {
      return rejectApproval(this.fixture.deps, this.ownerId, approvalId, body);
    }
    return Rejected.parse(
      await successful(
        await this.fixture.request(this, `/api/v1/approvals/${approvalId}/actions/reject`, body),
      ),
    );
  }
}

export async function createHarnessConsumer(): Promise<HarnessConsumer> {
  const consumer = new HarnessConsumer(await createIntegrationDatabase());
  try {
    await consumer.initialize();
    return consumer;
  } catch (error) {
    await consumer.close();
    throw error;
  }
}
