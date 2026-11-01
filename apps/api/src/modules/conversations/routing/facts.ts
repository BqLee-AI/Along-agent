import { createHash, randomUUID } from 'node:crypto';
import type {
  RoutingCandidate,
  RoutingFacts,
  RoutingPolicy,
  RoutingSource,
} from '@along/contracts';
import { REVISIONS, type RoutingInput } from './types.js';

export function normalizeEncodingText(text: string): string {
  return text.normalize('NFC').replace(/\r\n/g, '\n').trim();
}
export function inputDigest(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
export function isGregorianDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (year < 1 || month < 1 || month > 12) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= days[month - 1]!;
}

export function collectFacts(input: RoutingInput, policy: RoutingPolicy): RoutingFacts {
  const result: RoutingFacts = {
    facts_ref: randomUUID(),
    input_sha256: inputDigest(input.text),
    bundle_sha256: policy.mode === 'off' ? '0'.repeat(64) : policy.bundle_sha256,
    eligible: false,
    reason: null,
    rule_intent: null,
    candidates: [],
  };
  if (policy.mode === 'off') return { ...result, reason: 'OFF' };
  if (
    Object.entries(REVISIONS).some(
      ([key, value]) => policy[key as keyof typeof REVISIONS] !== value,
    )
  )
    return { ...result, reason: 'REVISION_MISMATCH' };
  if (input.hasPendingApproval) return { ...result, reason: 'PENDING_APPROVAL' };
  if (input.workspaceSelected) return { ...result, reason: 'WORKSPACE_CONTEXT' };
  // Invalid scalar sequences cannot provide cross-language source coordinates.
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(input.text))
    return { ...result, reason: 'INVALID_UNICODE' };
  const text = input.text.trim();
  if (!text) return { ...result, reason: 'EMPTY' };
  const source = (field: string, raw: string, utf16Start: number): RoutingSource => ({
    field,
    source: 'message',
    message_id: input.messageId,
    raw,
    start: Array.from(input.text.slice(0, utf16Start)).length,
    end: Array.from(input.text.slice(0, utf16Start + raw.length)).length,
    parser_revision: REVISIONS.parser_revision,
  });
  const defaultLimit: RoutingSource = {
    field: 'limit',
    source: 'contract_default',
    parser_revision: REVISIONS.parser_revision,
  };
  const defaultState: RoutingSource = {
    field: 'state',
    source: 'contract_default',
    parser_revision: REVISIONS.parser_revision,
  };
  // Commands are anchored over the entire input; punctuation handling is versioned.
  const command =
    /^\/(reminders|timezone|brief)(?:[\t ]+([^\s。.!！?？]+))?[\t ]*[。.!！?？]?$/u.exec(text);
  if (text.startsWith('/')) {
    if (!command) return { ...result, reason: 'INCOMPLETE_COMMAND' };
    const name = command[1];
    const argument = command[2];
    let candidate: RoutingCandidate;
    if (name === 'reminders') {
      if (argument !== undefined && (!/^[1-9]\d?$/.test(argument) || Number(argument) > 50))
        return { ...result, reason: 'QUANTITY_INVALID' };
      candidate = {
        intent: 'task_list_bounded',
        tool_id: 'list_tasks',
        args: { limit: argument ? Number(argument) : 20, state: null },
        sources: argument
          ? [
              source(
                'limit',
                argument,
                input.text.indexOf(argument, input.text.indexOf('/reminders') + 10),
              ),
              defaultState,
            ]
          : [defaultLimit, defaultState],
      };
    } else if (name === 'timezone') {
      if (argument !== undefined) return { ...result, reason: 'UNSUPPORTED_CONSTRAINT' };
      candidate = {
        intent: 'prefs_timezone_read',
        tool_id: 'get_user_prefs',
        args: {},
        sources: [],
      };
    } else {
      if (!argument || !isGregorianDate(argument)) return { ...result, reason: 'DATE_INVALID' };
      candidate = {
        intent: 'brief_cards_read',
        tool_id: 'read_brief_cards',
        args: { date: argument },
        sources: [source('date', argument, input.text.indexOf(argument))],
      };
    }
    if (!policy.candidate_intents.includes(candidate.intent))
      return { ...result, reason: 'INTENT_DISABLED' };
    return { ...result, eligible: true, rule_intent: candidate.intent, candidates: [candidate] };
  }
  // These gates recognize unsupported constraints, not a second positive action grammar.
  if (
    /["“”「」『』`]|假设|例如|举例|测试(?:一下|命令|句子)|解释|什么意思|怎么(?:用|设置)|如何|为什么|如果|若是|除非|要是|只有.*才|是否.*(?:再|就)/u.test(
      text,
    )
  )
    return { ...result, reason: 'QUOTED_OR_CONDITIONAL' };
  if (
    /然后|之后|接着|顺便|同时|并且|以及|并(?:修改|取消|删除|设置|生成|发送)|再(?:帮|把|改|取消|删除|生成|设置|发)|[;；]/u.test(
      text,
    )
  )
    return { ...result, reason: 'MULTI_GOAL' };
  if (
    /^(?:继续|确认|同意|批准|撤回|撤销|恢复|停止|取消)(?:[。.!！?？]|$)|(?:刚才|上面|前面|那个|这个|它们|它|照旧|照着|改口|还是|换成|我说的是|同样的|同一个)|(?:照|依(?:照|据)?|按(?:照)?|根据|参照|沿用|遵循|遵照)[^\n。！？!?，,；;]{0,24}(?:之前|先前|上次|上回|以前|那份|那条|那项)|^(?:那|再来|也来|接上)/u.test(
      text,
    )
  )
    return { ...result, reason: 'CONTEXT_UNKNOWN' };
  if (
    input.messages.length > 0 &&
    !/查|读|列|显示|看|打开|获取|知道|告诉|是什么|什么时区|哪个时区|记录的时区|哪些/u.test(text)
  )
    return { ...result, reason: 'CONTEXT_UNKNOWN' };
  if (
    /(?:不要|别|不用|不必|不想|无需|并不是(?:要|想)|不是(?:要|想))(?!更(?:长|多)|太(?:长|多)|超过|增加|加长)[^\n。！？!?，,；;]{0,64}(?:阅读|读取|读|查询|查|列出|列|展示|显示|看|打开|获取|告诉)|(?:不|别)执行|(?:不需要|不想要|不要)(?:这个|这些|我的|当前|活动|现有)?(?:提醒|待办|任务|简报|时区)(?:列表|卡片)?/u.test(
      text,
    )
  )
    return { ...result, reason: 'ACTION_DECLINED' };
  if (
    /新增|新建|设为|设成|改成|改为|更改|修改|调整|更新|切换|删除|取消|撤销|关闭|重建|重新生成|生成|总结|分析|比较|评价|发送|共享|分享|转发|分发|发布|公开|上传|同步|授权|授予|邀请|导出|下载|排序|核实|送达|收到|触发|有没有执行|是否执行|是否生效|(?:添加|创建|设置)(?:一|个|条|提醒|待办)|(?:帮我|请|给我)(?:添加|创建|设置)/u.test(
      text,
    )
  )
    return { ...result, reason: 'UNSUPPORTED_GOAL' };
  // Directional insertion and delivery request writes, not a read of the target.
  // Past/participial insertion descriptions still allow listing existing items.
  if (
    /(?<!过去|曾经|已经|先前|之前|原先|曾|已)(?:(?:加|添)(?:入|进)|放(?:进|入|到)|插入|写入|纳入|记(?:入|进|到))(?!过|了|的)|发(?:给|到|往|至)|寄(?:给|到|往|至)|投递|推送/u.test(
      text,
    )
  )
    return { ...result, reason: 'UNSUPPORTED_GOAL' };
  if (
    /全部|所有|查全|完整(?:列表|内容|全文|资料)|全文|一条不漏|一张不漏|总共|多少(?:条|个|张)|(?:只|仅)(?:要|看|读|查|列出)?(?:已|未|状态)|筛选|按(?:日期|时间|名称|关键词|状态)|关键词|包含|名字|标题(?:为|是|含)|历史时区|服务器|浏览器|电脑|系统当前时间/u.test(
      text,
    )
  )
    return { ...result, reason: 'UNSUPPORTED_CONSTRAINT' };
  if (
    /至少|不少于|大约|约\s*\p{N}|差不多|左右|(?:条|个|项|张)(?:以上|起步)|负\s*[\p{N}零一二两三四五六七八九十百千万]|第\s*[\p{N}零一二两三四五六七八九十百千万]+\s*(?:条|个|项)/u.test(
      text,
    )
  )
    return { ...result, reason: 'QUANTITY_UNSUPPORTED' };

  const dates = [...input.text.matchAll(/(?<!\p{N})\d{4}-\d{2}-\d{2}(?!\p{N})/gu)];
  if (dates.length > 1 || (dates.length === 1 && !isGregorianDate(dates[0]![0])))
    return { ...result, reason: 'DATE_INVALID' };
  // Any date-like fragment not consumed by one complete ISO date must not be repaired.
  const dateResidue = input.text.replace(/(?<!\p{N})\d{4}-\d{2}-\d{2}(?!\p{N})/gu, '');
  if (/\d{1,4}[-/年]\d|\d{1,2}月|\d{1,2}日|\d{4}-\d{1,2}(?!\d)/u.test(dateResidue))
    return { ...result, reason: 'DATE_INCOMPLETE' };
  const quantities = [
    ...input.text.matchAll(
      /([+\-−﹣－＋]?\p{N}+(?:[.,]\p{N}+)?|[零〇一二两三四五六七八九十百千万半几数]+)\s*(?:条|个|项|张)/gu,
    ),
  ];
  if (quantities.length > 1) return { ...result, reason: 'QUANTITY_CONFLICT' };
  let limit = 20;
  let limitSource: RoutingSource = defaultLimit;
  if (quantities.length === 1) {
    const match = quantities[0]!;
    const raw = match[1]!;
    if (!/^[1-9]\d?$/.test(raw) || Number(raw) > 50)
      return { ...result, reason: 'QUANTITY_INVALID' };
    limit = Number(raw);
    limitSource = source('limit', raw, match.index!);
  }
  if (
    quantities.length === 0 &&
    (/(?:前|最多|至少|不超过|上限|限量|限定|数量|条数|第)\s*(?:[\p{N}零一二两三四五六七八九十百千万]|为|是|要求)|(?:多一点|少一点|若干|几条)|[\p{N}零〇一二两三四五六七八九十百千万半几数]+\s*(?:提醒|待办|任务)/u.test(
      text,
    ) ||
      /\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|hundred)\b/iu.test(
        text,
      ))
  )
    return { ...result, reason: 'QUANTITY_UNKNOWN' };
  if (/分页|下一页|上一页|第.+页|page|offset/iu.test(text))
    return { ...result, reason: 'UNSUPPORTED_PAGINATION' };
  const hasTasks = /提醒|待办|任务|reminder|todo/iu.test(text);
  const hasPrefs = /时区|timezone/iu.test(text);
  const hasBrief = /简报|brief/iu.test(text);
  if (Number(hasTasks) + Number(hasPrefs) + Number(hasBrief) !== 1)
    return { ...result, reason: 'OBJECT_UNKNOWN' };
  if (/文档|文件|合同|工作区|网页|邮件|日程|天气|新闻|资料/u.test(text))
    return { ...result, reason: 'OTHER_OBJECT' };
  if (
    hasTasks &&
    /完成|取消|删除|失效|过期|归档|停用|禁用|暂停|历史(?:记录|提醒|任务|待办)|(?:今天|昨天|明天|本周|这周|上周|本月|下周)|(?<!读)(?:从|至).*(?:到|至)|(?:已|已经|未|尚未|没有)(?:安排|执行|发送|触发|送达)|按/u.test(
      text,
    )
  )
    return { ...result, reason: 'UNSUPPORTED_FILTER' };
  if (
    hasTasks &&
    /重复|周期|循环|定期|一次性|(?:每|隔)(?:[\p{N}零〇一二两三四五六七八九十百千万半]+)?(?:天|日|周|月|年)|每隔|日度|周度|月度|季度|年度|工作日|周末|周内|星期|周[一二三四五六日天]|升序|降序|倒序|正序|逆序|倒着|(?:从|由)(?:新|旧|早|晚|近|远)到(?:新|旧|早|晚|近|远)|最(?:新|旧|早|晚)|优先级|紧急|重要|先后|标签|星标|(?:标|打|加)(?:了|过)?星|(?:带|标有)星(?:号)?|收藏|关注|标记|标注|(?:只|仅)(?:保留|选择|选取|留下)|分组|类别|分类|负责人|地点|位置/u.test(
      text,
    )
  )
    return { ...result, reason: 'UNSUPPORTED_TASK_CONSTRAINT' };
  if (
    hasTasks &&
    /(?:这|那|某|指定|其中|单独)(?:一)?(?:条|个|项)|第[\p{N}零〇一二两三四五六七八九十百千万]+(?:条|个|项)|名称|名叫|叫做|具体(?:的)?(?:(?:执行|触发|发送|送达|本地|预定|安排)?时间|内容|安排)|正文|原文|详情|详细(?:信息|内容)|几点|何时|什么时候|(?:提醒|待办|任务)(?:的)?(?:(?:执行|触发|发送|送达|本地|预定)?时间|内容|安排|备注|说明|状态)/u.test(
      text,
    )
  )
    return { ...result, reason: 'UNSUPPORTED_TASK_DETAIL' };
  if (
    hasPrefs &&
    /之前|以前|过去|历史|别人的|他的|她的|所在地|所在(?:城市|地区|国家)|位置|地理|城市|地区|国家|地址|住在|居住|经纬|经度|纬度|推断|推测|猜|估计|建议|推荐|应(?:该|当)|适合|合适|选择|选用|选哪|判断|分析|比较|对比|区别|差异|差多少|换算|转换|根据|基于|结合|夏令时|偏移|标准时间|含义|定义|原理|规则|概念|知识|由来|计算|几点|对不对|好不好|是否(?:合理|合适|正确|适用)/u.test(
      text,
    )
  )
    return { ...result, reason: 'UNSUPPORTED_PREFS' };
  // Account ownership and operating-system settings are different subjects from
  // the current user's saved preference; “系统记录” alone is not device scope.
  if (
    hasPrefs &&
    /(?<!我|本人|自己|个人)的(?:账户|账号|帐号)|他人|别人|非本人|(?:其他|另一(?:位|个)?)(?:用户|账户|账号|帐号)|(?:你|您|他|她|它)(?:们)?的|操作系统|设备|手机|平板|本机|终端|系统(?:当前|目前|现在)?(?:采用|使用|设置|配置|显示|时区)/u.test(
      text,
    )
  )
    return { ...result, reason: 'UNSUPPORTED_PREFS' };
  if (hasBrief) {
    if (dates.length !== 1 || quantities.length !== 0 || /\p{N}/u.test(dateResidue))
      return { ...result, reason: 'DATE_REQUIRED' };
    const relatives = [
      ...text.matchAll(/今天|今日|昨天|昨日|明天|明日|前天|后天|本周|上周|下周/gu),
    ];
    const relative = relatives[0];
    // A scene-setting clause does not request another date. It must precede the
    // explicit date and express the present desire to read, not a second target.
    if (
      relatives.length > 1 ||
      (relative &&
        !(
          relative.index! < text.indexOf(dates[0]![0]) &&
          /^(?:我)?(?:今天|今日)(?:现在)?(?:想|打算|准备|要)(?:读|看|查|翻阅)/u.test(text)
        ))
    )
      return { ...result, reason: 'RELATIVE_DATE' };
    if (
      /(?:到|至|之前|之后|以来|期间|之间|起止|范围)(?:的)?(?:简报|卡片)|(?:从|至)\s*\d{4}-|\d{4}-\d{2}-\d{2}\s*(?:到|至|起)/u.test(
        text,
      )
    )
      return { ...result, reason: 'DATE_RANGE' };
    const match = dates[0]!;
    result.candidates.push({
      intent: 'brief_cards_read',
      tool_id: 'read_brief_cards',
      args: { date: match[0] },
      sources: [source('date', match[0], match.index!)],
    });
  } else if (hasTasks) {
    if (dates.length || /\p{N}/u.test(dateResidue.replace(/(?:[1-9]\d?)\s*(?:条|个|项)/g, '')))
      return { ...result, reason: 'UNSUPPORTED_FILTER' };
    result.candidates.push({
      intent: 'task_list_bounded',
      tool_id: 'list_tasks',
      args: { limit, state: null },
      sources: [limitSource, defaultState],
    });
  } else {
    if (dates.length || quantities.length || /\p{N}/u.test(text))
      return { ...result, reason: 'UNSUPPORTED_CONSTRAINT' };
    result.candidates.push({
      intent: 'prefs_timezone_read',
      tool_id: 'get_user_prefs',
      args: {},
      sources: [],
    });
  }
  result.candidates = result.candidates.filter((candidate) =>
    policy.candidate_intents.includes(candidate.intent),
  );
  result.eligible = result.candidates.length > 0;
  result.reason = result.eligible ? null : 'INTENT_DISABLED';
  return result;
}
