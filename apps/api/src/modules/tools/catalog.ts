// Public model-facing tool descriptors. Runtime input validators stay private
// to the gateway in schemas.ts; shared tool IDs and enums belong to contracts.ts.
import { TASK_STATES } from './contracts.js';

const workspaceParameters = (
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const workspacePath = { type: 'string' };
export const WORKSPACE_TOOL_DEFINITIONS = [
  {
    name: 'workspace_list',
    description: '列出当前工作区授权目录的真实直接子项；根目录 path 使用空串。',
    risk: 'low' as const,
    parameters: workspaceParameters({ path: workspacePath }, ['path']),
  },
  {
    name: 'workspace_grep',
    description: '在授权文本内进行区分大小写的逐行字面量搜索；检查逐文件失败。',
    risk: 'low' as const,
    parameters: workspaceParameters(
      { path: workspacePath, literal: { type: 'string', minLength: 1 } },
      ['path', 'literal'],
    ),
  },
  {
    name: 'workspace_read',
    description: '读取授权文件的精确全文和版本。修改必须引用此调用；保存后用新调用回读。',
    risk: 'low' as const,
    parameters: workspaceParameters({ path: workspacePath }, ['path']),
  },
  {
    name: 'workspace_propose_replace',
    description:
      '引用本 Run 接受的全文读取结果，提议恰好一次的精确字面量替换；须给出覆盖本次修改要求的完整目标并等待用户批准，不代表已写入。literal_not_found 表示参数与原文不同，应核对字符和换行后修正，不得把半成品冒充完整提议。',
    risk: 'medium' as const,
    parameters: workspaceParameters(
      {
        read_invocation_id: { type: 'string', format: 'uuid' },
        old_text: {
          type: 'string',
          minLength: 1,
          description:
            '逐字符复制该次全文中的原片段，包括真实换行。实际 CRLF 在 JSON 字符串中写成 \\r\\n；不能错写成 LF，也不能双重转义成文字 \\\\r\\\\n。',
        },
        new_text: {
          type: 'string',
          description:
            '一次完成该片段中的全部所需修改，原样保留其余字符、BOM 和换行；使用与 old_text 相同的 JSON 字符串转义规则。',
        },
      },
      ['read_invocation_id', 'old_text', 'new_text'],
    ),
  },
  {
    name: 'workspace_apply_replace',
    description:
      '执行本 Run 已批准的冻结替换；冲突未写入，未知不得重试；成功后仍须新调用全文回读。',
    risk: 'high' as const,
    parameters: workspaceParameters({ approval_id: { type: 'string', format: 'uuid' } }, [
      'approval_id',
    ]),
  },
];

export const HARNESS_TOOL_DEFINITIONS = [
  {
    name: 'propose_task',
    description: '提出提醒批准；只有用户在冻结确认页确认后才能创建任务。',
    risk: 'medium' as const,
    parameters: workspaceParameters(
      {
        raw_time_text: workspacePath,
        timezone_hint: { type: ['string', 'null'] },
        note: workspacePath,
        occurrence: { const: 'once' },
      },
      ['raw_time_text', 'note', 'occurrence'],
    ),
  },
  {
    name: 'request_cancel_task',
    description: '提出已有任务的取消批准，不直接取消。',
    risk: 'medium' as const,
    parameters: workspaceParameters(
      { task_id: { type: 'string', format: 'uuid' }, reason_text: { type: ['string', 'null'] } },
      ['task_id'],
    ),
  },
  {
    name: 'list_tasks',
    description:
      '读取当前用户提醒任务；默认只列活动任务，不是全量历史。saved/pending_schedule表示确认后等待后台调度，无需重复确认或手动排期；cancel_pending表示取消已提交、禁止后续新触发请求，等撤销回执不需重新取消，但不代表能撤回已发出通知。scheduled/cancelled只按实际回执状态报告。',
    risk: 'low' as const,
    parameters: workspaceParameters({
      state: { type: ['string', 'null'], enum: [...TASK_STATES, null] },
      limit: { type: 'integer', minimum: 1, maximum: 50 },
    }),
  },
  {
    name: 'read_brief_cards',
    description: '读取当前用户指定日期的简报。',
    risk: 'low' as const,
    parameters: workspaceParameters(
      {
        date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
        card_ids: {
          type: ['array', 'null'],
          items: { type: 'string', format: 'uuid' },
          maxItems: 50,
        },
      },
      ['date'],
    ),
  },
  {
    name: 'get_user_prefs',
    description: '读取当前用户的时区与偏好。',
    risk: 'low' as const,
    parameters: workspaceParameters({}),
  },
  ...WORKSPACE_TOOL_DEFINITIONS,
  {
    name: 'read_run_observation',
    description:
      '分页回取本 Run 已接受的原观察，不重新读取当前文件；不是新的全文读取或保存后核实。offset/end 按 Unicode 标量或数组元素计数，下一页从实际 end 继续。',
    risk: 'low' as const,
    parameters: workspaceParameters(
      {
        source_invocation_id: { type: 'string', format: 'uuid' },
        field: { type: 'string', enum: ['content', 'matches', 'entries', 'failures'] },
        offset: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
        limit: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
      },
      ['source_invocation_id', 'field', 'offset', 'limit'],
    ),
  },
];
