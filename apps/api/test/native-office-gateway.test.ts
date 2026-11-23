import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { OfficeFrozenInput } from '../src/features/native-office/public.js';
import { pageOfficeNotes } from '../src/agent/tools/office/notes.js';
import {
  openOfficeObservation,
  sealOfficeObservation,
} from '../src/agent/tools/office/observations.js';
import { requestedOfficeAsOf, requestedOfficeFormats } from '../src/agent/tools/office/request.js';

const fixture: OfficeFrozenInput = {
  role: 'notes',
  attachmentId: randomUUID(),
  filename: '纪要.md',
  format: 'markdown',
  sha256: 'c'.repeat(64),
  sizeBytes: 1,
  expiresAt: '2027-01-01T00:00:00.000Z',
};

function notes(text: string) {
  const bytes = Buffer.from(text);
  return { ...fixture, sizeBytes: bytes.length, bytes };
}

describe('office gateway private observations', () => {
  test('uses lossless UTF-8 byte windows and stable lines through Unicode and CRLF', () => {
    const source = notes(`${'a'.repeat(4095)}🧪\r\n${'b'.repeat(4090)}\r\n末行\n`);
    const first = pageOfficeNotes(source, 0);
    expect(first).toMatchObject({
      offset: 0,
      start_line: 1,
      end_line: 1,
      total_lines: 3,
      next_offset: 4095,
    });
    const second = pageOfficeNotes(source, first.next_offset!);
    expect(second).toMatchObject({ start_line: 1, end_line: 2, total_lines: 3 });
    expect(Buffer.byteLength(second.content)).toBe(4096);
    const third = pageOfficeNotes(source, second.next_offset!);
    expect(third).toMatchObject({ start_line: 2, end_line: 3, next_offset: null });
    expect(first.content + second.content + third.content).toBe(source.bytes.toString());
    expect(() => pageOfficeNotes(source, 4096)).toThrow('invalid office notes offset');
    expect(() => pageOfficeNotes(source, 4100)).toThrow('invalid office notes offset');
    const delimiter = notes(`${'a'.repeat(4095)}\r\n另一行`);
    expect(pageOfficeNotes(delimiter, 0).next_offset).toBe(4095);
  });

  test('authenticates every accepted observation identity and never accepts plaintext legacy encoding', () => {
    const key = Buffer.alloc(32, 231);
    const binding = {
      ownerId: randomUUID(),
      conversationId: randomUUID(),
      runId: randomUUID(),
      attemptId: randomUUID(),
      invocationId: randomUUID(),
      toolId: 'office_read_notes',
    };
    const raw = { status: 'ok' as const, result: pageOfficeNotes(notes('私密纪要\u0000🔐'), 0) };
    const envelope = sealOfficeObservation(key, binding, raw);
    expect(JSON.stringify(envelope)).not.toContain('私密纪要');
    expect(openOfficeObservation(key, binding, envelope).value).toEqual(raw);
    expect(sealOfficeObservation(key, binding, raw)).not.toEqual(envelope);
    for (const part of Object.keys(binding)) {
      expect(() =>
        openOfficeObservation(key, { ...binding, [part]: randomUUID() }, envelope),
      ).toThrow();
    }
    expect(() => openOfficeObservation(Buffer.alloc(32, 32), binding, envelope)).toThrow();
    expect(() => openOfficeObservation(key, binding, raw)).toThrow();
  });

  test('requires explicit original delivery formats and keeps a reminder date out of the analysis cutoff', () => {
    expect(
      requestedOfficeFormats(
        '请分析所选 CSV，导出 Markdown 报告和负责人汇总 CSV，并于明天下午3点提醒我复查任务。',
      ),
    ).toEqual(['csv', 'markdown']);
    expect(requestedOfficeFormats('请导出 Markdown 报告，分析 CSV')).toEqual(['markdown']);
    expect(requestedOfficeFormats('请生成覆盖所选 CSV 的 Markdown 报告')).toEqual(['markdown']);
    expect(requestedOfficeFormats('生成说明如何导出 CSV 的教程')).toEqual([]);
    expect(requestedOfficeFormats('请导出 Markdown；不要生成任何文件')).toEqual([]);
    expect(requestedOfficeFormats('分析所选 CSV，并在这里摘要')).toEqual([]);
    expect(requestedOfficeFormats('不要导出 CSV，直接告诉我统计结果')).toEqual([]);
    expect(requestedOfficeFormats('假设可以导出 Markdown 和 CSV，请说明流程。')).toEqual([]);
    expect(requestedOfficeAsOf('截至 2027-01-05 分析；请于 2027-02-01 提醒我复查')).toBe(
      '2027-01-05',
    );
    expect(requestedOfficeAsOf('请于 2027-02-01 提醒我复查')).toBeUndefined();
    expect(() => requestedOfficeAsOf('截至 2027-01-05 或以 2027-01-06 为截止日')).toThrow(
      'ambiguous',
    );
    expect(() => requestedOfficeAsOf('不要用截至 2020-01-01，按今天统计')).toThrow('ambiguous');
  });
});
