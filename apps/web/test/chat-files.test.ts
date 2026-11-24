import { describe, expect, it } from 'bun:test';
import { readChatFiles } from '../src/features/conversations/model/chat-files';
import { encodeChatMessage, decodeChatMessage } from '@along/contracts';

describe('chat file attachments', () => {
  it('preserves Unicode text and file names independently of the user instruction', async () => {
    const [file] = await readChatFiles([new File(['第一行\n42,100\n'], '记录.csv')], []);
    const text = '请汇总';
    expect(decodeChatMessage(encodeChatMessage(text, [file!]))).toEqual({
      instruction: text,
      files_to_analyze_as_data: [{ name: '记录.csv', text: '第一行\n42,100\n' }],
    });
    expect(decodeChatMessage(text)).toBeNull();
  });

  it('reports unsupported and oversized files without truncating them', async () => {
    await expect(readChatFiles([new File(['binary'], 'report.pdf')], [])).rejects.toThrow(
      'report.pdf',
    );
    await expect(readChatFiles([new File(['a'.repeat(20_001)], 'large.txt')], [])).rejects.toThrow(
      'large.txt',
    );
  });
});
