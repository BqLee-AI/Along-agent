import { expect, test } from 'bun:test';
import {
  analyzeOfficeCsv,
  officeReport,
  readOfficeFile,
} from '../src/features/conversations/model/office-materials';

const cutoff = '2026-11-23';
const header = 'task_id,title,owner,due_date,status\r\n';

test('reordered columns, quoted lines and textual IDs produce matching reports', () => {
  const result = analyzeOfficeCsv(
    '\ufeffstatus,task_id,title,owner,due_date\r\n' +
      'todo,0001,"核对\r\n交付", 李 ,2026-11-22\r\n' +
      'done,0002,完成,李,2026-11-21\r\n' +
      'in_progress,0003,当天,李,2026-11-23\r\n' +
      'canceled,0004,取消,李,2026-11-20\r\n' +
      'other,0005,异常,＝导出,2026-02-29\r\n' +
      'todo,0006,无日期,,\r\n' +
      'todo,0007,字面负责人,（未分配）,2026-12-23\r\n',
    cutoff,
  );
  expect(result.csv).toBe(
    '负责人,已分配,总数,逾期,缺日期,非法日期,异常状态\r\n' +
      ",否,1,0,1,0,0\r\n李,是,4,1,0,0,0\r\n（未分配）,是,1,0,0,0,0\r\n'＝导出,是,1,0,0,1,1\r\n",
  );
  expect(result.markdown).toContain('| 1 | 0001 | 核对  交付 | 李 | 2026-11-22 | 逾期 |');
  expect(result.markdown).toContain(
    '| 5 | 0005 | 异常 | ＝导出 | 2026-02-29 | 非法日期、异常状态 |',
  );
  expect(result.markdown).not.toMatch(/000[234]/u);
  const report = officeReport(result.markdown, '原始纪要', '复核交付');
  expect(report).toContain('## 模型纪要摘要\n\n    复核交付');
  expect(report).not.toContain('原始纪要');
});

test('rejects malformed data instead of emitting partial statistics', async () => {
  expect(() => analyzeOfficeCsv(header + '1,first,A,,todo\r\n2,short,A,\r\n', cutoff)).toThrow(
    '格式有误',
  );
  expect(() =>
    analyzeOfficeCsv(header + '0001,first,A,,todo\r\n0001,second,A,,todo\r\n', cutoff),
  ).toThrow('为空或重复');
  expect(() => analyzeOfficeCsv(header.replace('title', 'owner'), cutoff)).toThrow('表头');
  expect(() => analyzeOfficeCsv(header, '2026-02-29')).toThrow('有效的截至日期');
  const oversized =
    header + Array.from({ length: 5001 }, (_, i) => `${i},title,A,,todo\r\n`).join('');
  expect(() => analyzeOfficeCsv(oversized, cutoff)).toThrow('最多支持 5000 条记录');
  await expect(
    readOfficeFile(new File([Uint8Array.of(0xc3, 0x28)], 'tasks.csv'), 1024),
  ).rejects.toThrow('UTF-8');
});
