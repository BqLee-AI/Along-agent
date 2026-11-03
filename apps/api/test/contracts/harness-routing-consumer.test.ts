import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import type { ThreadEvent } from '@along/stream-protocol';
import { createRoutingRuntime } from '../../src/modules/conversations/routing/index.js';
import { digestInvocationArgs } from '../../src/modules/tools/invocations.js';
import { createRoutingFixture, type RoutingTestFixture } from '../routing-fixtures.js';
import {
  createHarnessConsumer,
  started,
  type HarnessConsumer,
} from '../helpers/harness-consumer.js';

let fixture: HarnessConsumer;
let bundle: RoutingTestFixture;
let providerCalls = 0;
let encoderCalls = 0;
beforeAll(async () => {
  // Orthogonal unit vectors are deliberately unused: this proves only the L1
  // native + authority + real gateway chain, not encoder quality or L2 acceptance.
  bundle = createRoutingFixture();
  fixture = await createHarnessConsumer();
  fixture.deps.routing = createRoutingRuntime({
    mode: 'enforce',
    bundlePath: bundle.path,
    encoderUrl: 'http://127.0.0.1:1',
    intents: ['task_list_bounded', 'prefs_timezone_read', 'brief_cards_read'],
    fetch: async () => {
      encoderCalls++;
      throw new Error('L1 must not encode');
    },
  });
  expect(fixture.deps.routing.policy().mode).toBe('enforce');
  fixture.deps.harness = {
    ...fixture.deps.harness!,
    model: async function* () {
      providerCalls++;
      throw new Error('direct L1 must not invoke provider');
    },
  };
}, 30000);
afterAll(async () => {
  try {
    await fixture?.close();
  } finally {
    if (bundle) await rm(bundle.directory, { recursive: true, force: true });
  }
});

for (const mode of ['local', 'http'] as const) {
  for (const [command, tool, expectedArgs, kind] of [
    ['/reminders 2', 'list_tasks', { limit: 2, state: null }, 'list_tasks'],
    ['/timezone', 'get_user_prefs', {}, 'prefs'],
    ['/brief 2026-10-31', 'read_brief_cards', { date: '2026-10-31' }, 'brief'],
  ] as const) {
    test(`D8.${mode}.native-readonly-${tool.replaceAll('_', '-')}`, async () => {
      const actor = await fixture.actor(mode);
      if (tool === 'read_brief_cards')
        await fixture.database.pool.query('UPDATE users SET timezone_id=NULL WHERE id=$1', [
          actor.ownerId,
        ]);
      const body = {
        execution: 'harness',
        raw_text: command,
        confirmed_timezone: 'Asia/Shanghai',
        idempotency_key: randomUUID(),
      };
      const events = await (await actor.message(body)).events;
      const run = started(events);
      expect(
        events.filter(
          (event) => event.type === 'thread.failed' || event.type === 'thread.cancelled',
        ),
      ).toEqual([]);
      expect(events.filter((event) => event.type === 'thread.completed')).toHaveLength(1);
      expect(await actor.view(run.conversation_id, run.run_id)).toMatchObject({ status: 'done' });
      const invocations = (
        await fixture.database.pool.query(
          'SELECT invocation_id,tool_id,call_key,args_hash,execution_kind,state,accepted_result FROM tool_invocations WHERE run_id=$1',
          [run.run_id],
        )
      ).rows;
      expect(invocations).toHaveLength(1);
      expect(invocations[0]).toMatchObject({
        tool_id: tool,
        call_key: 'harness/1',
        args_hash: digestInvocationArgs(expectedArgs).argsHash,
        execution_kind: 'read_only',
        state: 'completed',
        accepted_result: { status: 'ok', result: { kind } },
      });
      const receipt = (
        await fixture.database.pool.query(
          "SELECT c.kind,c.payload FROM run_checkpoints c JOIN run_attempts a ON a.id=c.attempt_id WHERE a.run_id=$1 AND c.kind LIKE 'harness_routing_%' ORDER BY c.seq",
          [run.run_id],
        )
      ).rows;
      expect(receipt.map((row) => row.kind).sort()).toEqual([
        'harness_routing_decision',
        'harness_routing_policy',
        'harness_routing_render',
      ]);
      const rendered = receipt.find((row) => row.kind === 'harness_routing_render')!;
      expect(rendered.payload.invocation_ref).toBe(invocations[0].invocation_id);
      const text = events
        .filter((event) => event.type === 'message.delta')
        .map((event) => event.payload.delta)
        .join('');
      if (tool === 'get_user_prefs') expect(text).toContain('Europe/London');
      if (tool === 'read_brief_cards') expect(text).toContain('2026-10-31');
      expect(providerCalls).toBe(0);
      expect(encoderCalls).toBe(0);
      expect(fixture.providerErrors).toEqual([]);
      const facts = await fixture.facts(actor.ownerId);
      expect(await actor.history(run.conversation_id)).toEqual(events);
      expect(await (await actor.message(body)).events).toEqual(events);
      expect(await fixture.facts(actor.ownerId)).toEqual(facts);
    }, 30000);
  }
  for (const kind of [
    'harness_routing_policy',
    'harness_routing_decision',
    'harness_snapshot',
    'harness_routing_render',
  ] as const) {
    test(`D8.${mode}.readonly-required-${kind.replaceAll('_', '-')}`, async () => {
      const actor = await fixture.actor(mode);
      const before = await fixture.facts(actor.ownerId);
      const beforeProvider = providerCalls;
      const beforeEncoder = encoderCalls;
      const trigger = `routing_skip_${randomUUID().replaceAll('-', '')}`;
      await fixture.database.pool.query(
        `CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END; $$;
         CREATE TRIGGER ${trigger} BEFORE INSERT ON run_checkpoints FOR EACH ROW
         WHEN (NEW.owner_id='${actor.ownerId}' AND NEW.kind='${kind}') EXECUTE FUNCTION ${trigger}()`,
      );
      let events: ThreadEvent[] = [];
      let admissionError: unknown;
      try {
        events = await (
          await actor.message({
            execution: 'harness',
            raw_text: '/timezone',
            idempotency_key: randomUUID(),
          })
        ).events;
      } catch (error) {
        admissionError = error;
      } finally {
        await fixture.database.pool.query(
          `DROP TRIGGER ${trigger} ON run_checkpoints; DROP FUNCTION ${trigger}()`,
        );
      }
      expect(providerCalls).toBe(beforeProvider);
      expect(encoderCalls).toBe(beforeEncoder);
      if (kind === 'harness_routing_policy') {
        expect(admissionError).toBeDefined();
        expect(await fixture.facts(actor.ownerId)).toEqual(before);
      } else {
        expect(admissionError).toBeUndefined();
        expect(events.at(-1)?.type).toBe('thread.failed');
        expect(events.filter((event) => event.type === 'message.delta')).toEqual([]);
      }
    }, 30000);
  }
}
