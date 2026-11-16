// Standard OpenAI-compatible API endpoints, not subscription-specific coding endpoints.
export const providerPresets = [
  {
    name: '智谱 BigModel',
    apiHost: 'https://open.bigmodel.cn/api/paas/v4',
    aliases: 'zhipu glm 智谱',
    icon: 'zhipu-color',
  },
  { name: 'Z.AI', apiHost: 'https://api.z.ai/api/paas/v4', aliases: 'zai glm', icon: 'zai' },
  {
    name: 'DeepSeek',
    apiHost: 'https://api.deepseek.com',
    aliases: '深度求索',
    icon: 'deepseek-color',
  },
  {
    name: 'Kimi',
    apiHost: 'https://api.moonshot.cn/v1',
    aliases: 'moonshot 月之暗面',
    icon: 'kimi-color',
  },
  {
    name: '阿里云百炼',
    apiHost: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    aliases: 'qwen 千问 dashscope',
    icon: 'alibabacloud-color',
  },
  {
    name: 'SiliconFlow 硅基流动',
    apiHost: 'https://api.siliconflow.cn/v1',
    aliases: '硅基',
    icon: 'siliconcloud-color',
  },
  { name: 'OpenAI', apiHost: 'https://api.openai.com/v1', aliases: 'gpt', icon: 'openai' },
  { name: 'OpenRouter', apiHost: 'https://openrouter.ai/api/v1', aliases: '', icon: 'openrouter' },
] as const;

export function availablePresets(providers: ReadonlyArray<{ name: string }>, query: string) {
  const term = query.trim().toLowerCase();
  const names = new Set(providers.map((provider) => provider.name.trim().toLowerCase()));
  return providerPresets.filter(
    (preset) =>
      !names.has(preset.name.toLowerCase()) &&
      `${preset.name} ${preset.aliases}`.toLowerCase().includes(term),
  );
}
