import { describe, expect, test } from 'bun:test';
import { cases, controlled, runCase } from '../experiments/tool-supply.mjs';

describe('#167 isolated tool supply evaluator', () => {
  test('unqualified discovery never discloses schema and direct calls never execute', async () => {
    const scenario = cases.find((item) => item.id === 'not-qualified');
    const row = await runCase(scenario, 'demand', (request, context) => {
      if (context.round === 0)
        return { name: 'tool_search', arguments: { names: ['workspace_read'] } };
      if (context.round === 1) {
        const observation = JSON.parse(request.messages.at(-1).content);
        expect(observation.tools).toEqual([]);
        expect(observation.missing).toEqual(['workspace_read']);
        expect(request.tools.some((tool) => tool.function.name === 'workspace_read')).toBe(false);
        return {
          name: 'workspace_read',
          arguments: { workspace_id: 'repo', path: 'docs/demo/fault-injection-smoke.md' },
        };
      }
      expect(JSON.parse(request.messages.at(-1).content)).toEqual({ error: 'TOOL_DENIED' });
      return { status: 'unavailable', answer: '无资格，未读取。' };
    });
    expect(row.businessCalls).toEqual([]);
    expect(row.rejected).toEqual(['workspace_read']);
  });

  test('a successful copy cannot count as complete without independent readback', async () => {
    const scenario = cases.find((item) => item.id === 'file-delivery');
    const row = await runCase(scenario, 'full', (request, context) => {
      if (context.businessCalls.length === 2)
        return { status: 'complete', answer: 'smoke-copy.md 已完成' };
      return controlled(request, context);
    });
    expect(row.businessCalls).toEqual(['workspace_read', 'workspace_create']);
    expect(row.success).toBe(false);
  });

  test('nonexistent discovery returns no substitute capability', async () => {
    const scenario = cases.find((item) => item.id === 'not-found');
    const row = await runCase(scenario, 'demand', (request, context) => {
      if (context.round === 1) {
        expect(JSON.parse(request.messages.at(-1).content)).toEqual({
          tools: [],
          missing: ['send_email'],
        });
      }
      return controlled(request, context);
    });
    expect(row.businessCalls).toEqual([]);
    expect(row.success).toBe(true);
  });
});
