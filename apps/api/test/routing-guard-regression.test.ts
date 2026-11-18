import { describe, expect, it } from 'bun:test';
import { collectFacts } from '../src/agent/routing/facts.js';
import { REVISIONS } from '../src/agent/routing/types.js';
import type { RoutingPolicy } from '@along/contracts';

const policy: RoutingPolicy = {
  revision: 'r2b/1',
  mode: 'shadow',
  bundle_sha256: 'a'.repeat(64),
  encoding_sha256: 'b'.repeat(64),
  candidate_intents: ['task_list_bounded', 'prefs_timezone_read', 'brief_cards_read'],
  direct_intents: [],
  competition: ['task_list_bounded', 'prefs_timezone_read', 'brief_cards_read', 'ordinary_chat'],
  thresholds: {
    task_list_bounded: { tau_intent: 1, tau_gap: 2 },
    prefs_timezone_read: { tau_intent: 1, tau_gap: 2 },
    brief_cards_read: { tau_intent: 1, tau_gap: 2 },
  },
  deadline_ms: 1000,
  max_inflight: 2,
  ...REVISIONS,
};
function facts(text: string, messages: { role: 'user' | 'assistant'; content: string }[] = []) {
  return collectFacts(
    {
      messageId: '00000000-0000-4000-8000-000000000001',
      text,
      messages,
      hasPendingApproval: false,
      workspaceSelected: false,
    },
    policy,
  );
}
function eligible(text: string): boolean {
  return facts(text).eligible;
}
describe('whole-goal routing guard regressions', () => {
  it('refuses a specified reminder or a requested detail instead of silently listing', () => {
    for (const text of [
      '告诉我修空调这条提醒的具体时间。',
      '查一下买药那项待办的详情。',
      '告诉我提醒的具体执行时间。',
      '查看某条任务的内容。',
      '把名称叫体检的提醒给我看。',
      '看看提醒列表中第二条的时间。',
    ])
      expect(eligible(text)).toBe(false);
  });
  it('refuses nonactive lifecycle constraints, including completed records', () => {
    for (const text of [
      '我只想查已经完成的待办记录。',
      '给我看看完成了的任务。',
      '列出被取消的提醒。',
      '查一下过期的提醒记录。',
      '显示已经触发的任务。',
    ])
      expect(eligible(text)).toBe(false);
  });
  it('refuses negated reads even when the object precedes the negation', () => {
    for (const text of [
      '提醒列表暂时别给我看，我只是说说。',
      '待办先不要展示给我。',
      '我不想看提醒列表。',
      '我的时区别告诉我。',
      '2026-10-31的简报不用给我读。',
      '不要把提醒列表打开。',
      '提醒我并不是要查询，只是讨论。',
    ])
      expect(eligible(text)).toBe(false);
  });
  it('keeps scoped list-length negation and past-addition wording eligible', () => {
    for (const text of [
      '列出20条提醒，不用更长的列表',
      '列出过去添加的提醒',
      '把活动提醒列表给我看看。',
    ])
      expect(eligible(text)).toBe(true);
  });
  it('refuses recurrence, scheduling and ordering constraints instead of returning an unfiltered list', () => {
    for (const text of [
      '查一查我有哪些每月重复的提醒。',
      '列出每周循环的待办。',
      '只看工作日的提醒。',
      '把提醒按优先级排列。',
      '将提醒从新到旧给我看。',
      '显示一次性的任务。',
      '列出带标签的待办。',
      '看看定期提醒。',
      '列出每两周的提醒。',
      '将待办逆序列出。',
    ])
      expect(eligible(text)).toBe(false);
  });
  it('refuses timezone inference, selection and analysis instead of substituting stored preferences', () => {
    for (const text of [
      '根据我所在城市推断应当使用什么时区。',
      '我住在上海，建议选哪个时区？',
      '帮我推荐合适的时区。',
      '比较一下我的时区和UTC。',
      '我的时区对不对？',
      '看看我时区的夏令时规则。',
      '用经纬度判断时区。',
      '我的时区是否合理？',
    ])
      expect(eligible(text)).toBe(false);
  });
  it('keeps stored preference reads and unconstrained current lists eligible', () => {
    for (const text of [
      '查询我已保存的时区。',
      '本人系统记录的时区是什么？',
      '看看当前的活动待办列表。',
      '列出过去添加的提醒。',
    ])
      expect(eligible(text)).toBe(true);
  });
  it('refuses complete item text rather than substituting a title preview', () => {
    for (const text of [
      '我要提醒条目的完整正文，不要标题预览。',
      '请给我任务的原文。',
      '读取待办正文。',
    ])
      expect(eligible(text)).toBe(false);
  });
  it('refuses references to earlier requirements even without available history', () => {
    for (const text of [
      '照之前那份清单的要求，读取我的活动提醒。',
      '依据上次讲好的方式列出待办。',
      '遵循先前的要求读取2026-10-31的简报。',
    ])
      expect(eligible(text)).toBe(false);
  });
  it('refuses annotation filters instead of silently returning unfiltered tasks', () => {
    for (const text of [
      '当前活动提醒仅保留我加了星标的那些。',
      '列出我收藏的待办。',
      '只选择我标记过的任务。',
    ])
      expect(eligible(text)).toBe(false);
  });
  it('refuses sharing and recipients rather than treating outbound delivery as a read', () => {
    for (const text of [
      '将本人的活动提醒清单共享给另一位用户。',
      '分享我的任务列表。',
      '把2026-10-31的简报转发给同事。',
    ])
      expect(eligible(text)).toBe(false);
  });
});

describe('finite readonly candidates preserve the whole requested goal', () => {
  const contexts: {
    name: string;
    messages: { role: 'user' | 'assistant'; content: string }[];
  }[] = [
    { name: 'without history', messages: [] },
    {
      name: 'with history',
      messages: [
        { role: 'user', content: '你好。' },
        { role: 'assistant', content: '你好，有什么可以帮你？' },
      ],
    },
  ];
  const refused: { family: string; texts: string[] }[] = [
    {
      family: 'nonactive lifecycle state',
      texts: [
        '现在我有哪些停用后的提醒？',
        '目前我有哪些已停用的提醒？',
        '列出被停用的待办。',
        '查看禁用状态的任务。',
        '看看暂停中的提醒。',
      ],
    },
    {
      family: 'star annotation filter',
      texts: [
        '我有哪些被标星的待办事项？',
        '查看标了星的提醒。',
        '列出打星的任务。',
        '看看带星号的待办。',
        '查看标有星号的提醒。',
      ],
    },
    {
      family: 'task insertion rather than listing',
      texts: [
        '把检查雨伞这件事放进我的待办列表。',
        '把更换净水滤芯放进我的待办。',
        '请把买牛奶放入待办清单。',
        '将检查门锁记入任务列表。',
        '帮我把买菜加入提醒列表。',
        '把检查门窗纳入我的待办。',
        '有哪些提醒？看完把买牛奶加进去。',
        '请把修雨伞加进我的待办清单。',
      ],
    },
    {
      family: 'outbound delivery rather than brief reading',
      texts: [
        '将2030-09-14的简报卡片发到邮箱。',
        '把2026-10-31的简报发给同事。',
        '请将2026-10-31的简报寄到邮箱。',
        '把2026-10-31的简报发往群聊。',
        '请把2026-10-31的简报推送给别人。',
      ],
    },
    {
      family: 'brief insertion rather than reading',
      texts: [
        '把notes/new.txt加入2028-06-07的简报卡片。',
        '将notes/today.txt放入2026-10-31的简报。',
        '请把这段内容写入2026-10-31的简报卡片。',
        '把notes/checklist.txt插入2026-10-31的简报。',
        '将notes/task.txt纳入2026-10-31的简报卡片。',
      ],
    },
    {
      family: 'another account rather than current-user preferences',
      texts: [
        '同事的账户时区偏好告诉我。',
        '查看朋友的账号时区。',
        '查询张三的账户保存的时区。',
        '其他用户的时区偏好是什么？',
        '读取另一位用户的时区。',
        '客户的帐号时区是什么？',
      ],
    },
    {
      family: 'device timezone rather than account preferences',
      texts: [
        '查一下手机操作系统当前采用的时区。',
        '查看手机当前使用的时区。',
        '读取设备配置的时区。',
        '查一下操作系统的时区。',
        '看看平板当前的时区。',
        '系统当前采用的时区是什么？',
      ],
    },
  ];
  const accepted = [
    {
      intent: 'task_list_bounded',
      tool_id: 'list_tasks',
      args: { limit: 20, state: null },
      texts: [
        '我现在有哪些提醒',
        '当前我有哪些活动待办？',
        '把活动提醒列表给我看看。',
        '将我的待办列表显示出来。',
        '列出过去添加的提醒。',
        '查看曾经加入的待办。',
        '列出过去放进待办列表的提醒。',
        '查看已经记入任务列表的待办。',
        '列出先前加进列表的活动提醒。',
      ],
    },
    {
      intent: 'prefs_timezone_read',
      tool_id: 'get_user_prefs',
      args: {},
      texts: [
        '本人系统记录的时区是什么？',
        '查询我已保存的时区。',
        '我的账户时区偏好告诉我。',
        '查看我自己的账号时区。',
        '本人的账户时区是什么？',
        '查询当前账户保存的时区。',
        '读取系统为本人记录的时区。',
      ],
    },
    {
      intent: 'brief_cards_read',
      tool_id: 'read_brief_cards',
      args: { date: '2026-10-31' },
      texts: [
        '把2026-10-31的简报卡片给我看看。',
        '将2026-10-31的简报读给我。',
        '读取2026-10-31的简报卡片。',
        '我想读到2026-10-31的简报。',
        '今天想读2026-10-31的简报。',
      ],
    },
  ];
  for (const context of contexts) {
    describe(context.name, () => {
      for (const { family, texts } of refused) {
        for (const text of texts) {
          it(`refuses ${family}: ${text}`, () => {
            const result = facts(text, context.messages);
            expect(result.eligible).toBe(false);
            expect(result.candidates).toEqual([]);
          });
        }
      }
      for (const { intent, tool_id, args, texts } of accepted) {
        for (const text of texts) {
          it(`preserves ${intent}: ${text}`, () => {
            const result = facts(text, context.messages);
            expect(result.eligible).toBe(true);
            expect(result.candidates).toHaveLength(1);
            expect(result.candidates[0]).toMatchObject({ intent, tool_id, args });
          });
        }
      }
    });
  }
});
