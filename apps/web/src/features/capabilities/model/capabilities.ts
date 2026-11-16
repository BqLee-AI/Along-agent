export const capabilities = {
  materials: {
    title: '资料',
    description: '管理 Along 能读取的文件和文件夹。',
    boundary:
      '资料管理还在准备中。已经登记过的资料，仍可在聊天里选用，登记情况可在「账户」里查看。',
    related: [
      { href: '/account', label: '查看已登记的资料' },
      { href: '/conversations?intent=document', label: '在聊天里处理资料' },
    ],
  },
  journal: {
    title: '日记',
    description: '按日期记录每天发生的事。',
    boundary: '这个功能还在准备中，现在不会保存任何日记。',
    related: [],
  },
  profile: {
    title: '助理资料',
    description: '',
    boundary: '',
    related: [],
  },
  skills: {
    title: '技能',
    description: '让 Along 学会做更多事，比如整理文件、查资料。',
    boundary: '这个功能还在准备中，现在没有可以安装或开启的技能。',
    related: [],
  },
  connectors: {
    title: '连接应用',
    description: '把日历、邮箱等应用连给 Along，让它帮你处理。',
    boundary: '这个功能还在准备中，现在不会向任何应用请求授权。',
    related: [],
  },
  channels: {
    title: '聊天工具',
    description: '在其他聊天工具里也能和 Along 对话。',
    boundary: '这个功能还在准备中，现在还不能绑定任何聊天工具。',
    related: [],
  },
  devices: {
    title: '设备',
    description: '把你的电脑或手机连给 Along。',
    boundary: '这个功能还在准备中，现在不能添加或控制设备。',
    related: [],
  },
  todos: {
    title: '待办',
    description: '记下不需要定时提醒的事。',
    boundary: '这个功能还在准备中。需要到点提醒的事，请到「提醒」页。',
    related: [{ href: '/tasks', label: '查看提醒' }],
  },
} as const;
export type Capability = keyof typeof capabilities;

export const settingsGroups = [
  {
    title: '通用',
    items: [
      { href: '/account', label: '账户' },
      { href: '/models', label: '模型' },
      { href: '/materials', label: '资料' },
    ],
  },
  {
    title: '扩展',
    items: [
      { href: '/skills', label: '技能' },
      { href: '/connectors', label: '连接应用' },
      { href: '/channels', label: '聊天工具' },
      { href: '/devices', label: '设备' },
    ],
  },
] as const;

const settingsPaths: readonly string[] = settingsGroups.flatMap((group) =>
  group.items.map((item) => item.href),
);

export function isSettingsPath(pathname: string): boolean {
  return pathname === '/settings' || settingsPaths.includes(pathname);
}
