import type { HarnessTool } from '@along/contracts';
const text = { type: 'string', minLength: 1, maxLength: 8192 };
const object = (properties: Record<string, unknown>, required: string[]) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
export const GOAL_CONTROL_TOOL: HarnessTool = {
  name: 'finish_goal',
  risk: 'low',
  description:
    '结束本轮目标并报告真实结果，不是领域写入。每个目标列出状态和实际接受 invocation_id 收据。保存/清除必须引用真实设置回执；拒绝或失败的调用不是成功收据。不要把工具成功或执行结束等同目标完成。纯回答也列出 achieved 项，可无收据。无效参数会返回 accepted:false 控制反馈；只修正结构化结果，不再调用业务工具，继续使用原预算。',
  parameters: object(
    {
      status: { type: 'string', enum: ['completed', 'partial', 'blocked', 'cancelled', 'unknown'] },
      outcomes: {
        type: 'array',
        minItems: 1,
        maxItems: 64,
        items: object(
          {
            description: text,
            status: { type: 'string', enum: ['achieved', 'not_done', 'blocked', 'unknown'] },
            receipt_refs: {
              type: 'array',
              maxItems: 64,
              uniqueItems: true,
              items: { type: 'string', format: 'uuid' },
            },
            create_resolution: object(
              {
                source_message_id: { type: 'string', format: 'uuid' },
                source_quote: text,
                zero_write_invocation_ids: {
                  type: 'array',
                  minItems: 1,
                  maxItems: 64,
                  uniqueItems: true,
                  items: { type: 'string', format: 'uuid' },
                },
                created_invocation_id: { type: 'string', format: 'uuid' },
                read_invocation_id: { type: 'string', format: 'uuid' },
              },
              [
                'source_message_id',
                'source_quote',
                'zero_write_invocation_ids',
                'created_invocation_id',
                'read_invocation_id',
              ],
            ),
          },
          ['description', 'status', 'receipt_refs'],
        ),
      },
      clarification: {
        anyOf: [
          { type: 'null' },
          object(
            {
              kind: {
                type: 'string',
                enum: ['time', 'timezone', 'target_selection', 'destination'],
              },
              question: text,
            },
            ['kind', 'question'],
          ),
        ],
      },
      answer: text,
    },
    ['status', 'outcomes', 'clarification', 'answer'],
  ),
};
