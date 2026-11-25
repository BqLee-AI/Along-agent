import {
  chatFileCountLimit,
  chatMessageLimit,
  encodeChatMessage,
  type ChatFile,
} from '@along/contracts';

export const chatFileAccept = '.txt,.md,.markdown,.csv,.tsv,.json,.jsonl,.log,.xml,.yaml,.yml';
const extensions = new Set(chatFileAccept.split(','));

export async function readChatFiles(
  files: readonly File[],
  existing: readonly ChatFile[],
): Promise<ChatFile[]> {
  if (existing.length + files.length > chatFileCountLimit)
    throw new Error(`最多添加 ${chatFileCountLimit} 个文件。`);
  const result = [...existing];
  for (const file of files) {
    if (!extensions.has(file.name.slice(file.name.lastIndexOf('.')).toLowerCase())) {
      throw new Error(`“${file.name}”的格式暂不支持。请选择 TXT、Markdown、CSV、JSON 等文本文件。`);
    }
    if (file.size > chatMessageLimit * 4 || file.name.length > 255)
      throw new Error(`“${file.name}”超过单条消息的容量。`);
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
    } catch {
      throw new Error(`无法读取“${file.name}”。请选择 UTF-8 文本文件。`);
    }
    if (!text.trim() || text.includes('\0')) throw new Error(`“${file.name}”没有可读取的文本。`);
    result.push({ name: file.name, text });
    if (encodeChatMessage('', result).length >= chatMessageLimit) {
      throw new Error(`添加“${file.name}”后超过单条消息的容量。请移除部分文件或缩短内容。`);
    }
  }
  return result;
}
