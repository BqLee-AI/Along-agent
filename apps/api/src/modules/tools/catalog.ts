// Public model-facing tool descriptors. Runtime input validators stay private
// to the gateway in schemas.ts; shared tool IDs and enums belong to contracts.ts.
import { DELEGATION_TOOL_IDS, TASK_STATES } from './contracts.js';

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
    description:
      '提出提醒批准；raw_time_text必须逐字引用本轮用户原话（可信澄清时引用原提醒），不得补猜日期、时刻或换算中文钟数/相对日期。缺字段先澄清。只有用户审阅冻结预览并点击确认按钮后才能创建任务，对话内可确认并继续原运行。',
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

// A separate profile: the legacy catalog and its approval semantics stay intact.
export const DELEGATION_TOOL_DEFINITIONS = [
  ...HARNESS_TOOL_DEFINITIONS.filter((tool) =>
    DELEGATION_TOOL_IDS.some((id) => id === tool.name),
  ).map((tool) =>
    tool.name === 'list_tasks'
      ? {
          ...tool,
          description: `${tool.description} 按 next_cursor 继续读取全部所需页；仅在用户明确限定未来提醒时传 future_only=true，按本轮可信接纳时间筛选。取消全部只覆盖实际读取的范围。`,
          parameters: workspaceParameters({
            state: { type: ['string', 'null'], enum: [...TASK_STATES, null] },
            limit: { type: 'integer', minimum: 1, maximum: 50 },
            after_task_id: { type: 'string', format: 'uuid' },
            future_only: { type: 'boolean' },
          }),
        }
      : tool,
  ),
  {
    name: 'get_task',
    description: '读取当前用户提醒的完整内容以定位目标。',
    risk: 'low' as const,
    parameters: workspaceParameters({ task_id: { type: 'string', format: 'uuid' } }, ['task_id']),
  },
  {
    name: 'cancel_reminder',
    description:
      '取消本人明确委托的提醒。先确定用户目标，再提供同一任务的 ID、完整名称、冻结本地时间和时区；各字段必须来自同一条记录，名称被截断时先用 get_task。若身份不匹配，重新读取并自行修正，不向用户重复索权。若返回 TARGET_SCOPE_UNCLEAR，未取消；将工具返回的完整 text 原样作为回答和目标澄清问题，以便用户按展示序号选择。cancel_pending 只是已提交并等待撤销回执，不代表已经取消；逐项报告实际结果。',
    risk: 'medium' as const,
    parameters: workspaceParameters(
      {
        task_id: { type: 'string', format: 'uuid' },
        expected_note: { type: ['string', 'null'] },
        expected_wall_time: { type: 'string' },
        expected_timezone_id: { type: 'string' },
      },
      ['task_id', 'expected_note', 'expected_wall_time', 'expected_timezone_id'],
    ),
  },
  {
    name: 'create_reminder',
    description:
      '在本人明确委托内直接创建一次性提醒，无需逐项确认；多个独立事项逐项调用。raw_time_text逐字引用本轮或可信同目标来源中的时间事实，不提交UTC。严格秒、分钟、小时及其明确组合，仅当可信上下文 elapsed_revision 为 elapsed/1 时，传 time_kind=elapsed 和解析的正整数 duration_seconds；模糊时间和日历时间不能当固定秒数。墙上/日历时间不传这两个字段。timezone_hint仅为本次明确时区，不保存默认。缺口先澄清。task_created只证明已记录，不代表已排期、触发或通知。',
    risk: 'medium' as const,
    parameters: workspaceParameters(
      {
        raw_time_text: { type: 'string', minLength: 1, maxLength: 1000 },
        timezone_hint: { type: ['string', 'null'], minLength: 1, maxLength: 100 },
        note: { type: 'string', minLength: 1, maxLength: 1000 },
        occurrence: { const: 'once' },
        time_kind: { const: 'elapsed' },
        duration_seconds: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
      },
      ['raw_time_text', 'note', 'occurrence'],
    ),
  },
  {
    name: 'set_user_timezone',
    description:
      '在本人明确委托内直接保存默认时区；timezone_id 为 null 时清除。仅支持实际规则包中的规范时区或已登记别名，不修改历史提醒；单次时区不保存。只按 timezone_setting 接受回执报告已保存或已清除，不生成批准。',
    risk: 'medium' as const,
    parameters: workspaceParameters(
      { timezone_id: { type: ['string', 'null'], minLength: 1, maxLength: 100 } },
      ['timezone_id'],
    ),
  },
];
