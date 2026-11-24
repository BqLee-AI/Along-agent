'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Button } from '@lorelum/lumen-ui/components/button';
import { Accordion } from '@lorelum/lumen-ui/components/accordion';
import { ClipboardList } from 'lucide-react';
import { z } from 'zod';
import Link from '@/shell/view/workspace-link';
import { readEnvelope } from '@/shared/http/client';
import { api, writeOptions } from '@/shared/http/eden';
import { MeSchema } from '@/shared/session/identity';
import {
  analyzeOfficeCsv,
  officeReport,
  OFFICE_CSV_BYTES,
  OFFICE_NOTES_BYTES,
  readOfficeFile,
  type OfficeAnalysis,
} from '../model/office-materials';

const summaryResult = z.object({ summary: z.string() });
const controlClass =
  'min-h-11 w-full min-w-0 rounded-control border border-separator bg-background p-1.5 focus-visible:outline-2 focus-visible:outline-ring sm:min-h-9';

type Report = { analysis: OfficeAnalysis | null; notes: string };

function download(filename: string, type: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function OfficeMaterials() {
  return (
    <Accordion>
      <Accordion.Item value="office-materials">
        <Accordion.Header>
          <Accordion.Trigger className="px-4 py-3 [&>svg]:hidden">
            <span className="flex items-center gap-3">
              <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted text-secondary-foreground">
                <ClipboardList className="size-4" aria-hidden="true" />
              </span>
              纪要和任务表
            </span>
          </Accordion.Trigger>
        </Accordion.Header>
        <Accordion.Panel className="px-4 pb-4" keepMounted>
          <OfficeForm />
        </Accordion.Panel>
      </Accordion.Item>
    </Accordion>
  );
}

function OfficeForm() {
  const [report, setReport] = useState<Report | null>(null);
  const [summary, setSummary] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState<'files' | 'summary' | null>(null);
  const current = useRef<AbortController | null>(null);
  useEffect(() => () => current.current?.abort(), []);

  function clear() {
    current.current?.abort();
    setReport(null);
    setSummary('');
    setError('');
    setPending(null);
  }

  function begin(kind: NonNullable<typeof pending>) {
    current.current?.abort();
    const request = new AbortController();
    current.current = request;
    setError('');
    setPending(kind);
    return request;
  }

  async function generate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    clear();
    const request = begin('files');
    try {
      const data = new FormData(event.currentTarget);
      const csv = data.get('tasks');
      const notes = data.get('notes');
      const cutoff = data.get('cutoff');
      const tasks = csv instanceof File && !!csv.name ? csv : null;
      const minutes = notes instanceof File && !!notes.name ? notes : null;
      if (!tasks && !minutes) throw new Error('请至少选择一份资料。');
      if (tasks && !/\.csv$/iu.test(tasks.name)) throw new Error('任务表须为 .csv 文件。');
      if (minutes && !/\.(txt|md|markdown)$/iu.test(minutes.name))
        throw new Error('纪要须为 TXT 或 Markdown 文件。');
      const [taskText, notesText] = await Promise.all([
        tasks ? readOfficeFile(tasks, OFFICE_CSV_BYTES) : null,
        minutes ? readOfficeFile(minutes, OFFICE_NOTES_BYTES) : '',
      ]);
      if (request.signal.aborted) return;
      setReport({
        analysis: taskText !== null ? analyzeOfficeCsv(taskText, String(cutoff ?? '')) : null,
        notes: notesText,
      });
    } catch (failure) {
      if (!request.signal.aborted)
        setError(failure instanceof Error ? failure.message : '资料处理失败。');
    } finally {
      if (!request.signal.aborted) setPending(null);
    }
  }

  async function summarize(notes: string) {
    const request = begin('summary');
    const { signal } = request;
    try {
      const me = MeSchema.parse(await readEnvelope(await api.api.v1.me.get({ fetch: { signal } })));
      const result = await api.api.v1['model-providers'].actions['summarize-notes'].post(
        { notes },
        writeOptions(me.csrf_token, signal),
      );
      const { summary: text } = summaryResult.parse(await readEnvelope(result));
      if (!signal.aborted) setSummary(text);
    } catch (failure) {
      if (!signal.aborted) setError(failure instanceof Error ? failure.message : '纪要摘要失败。');
    } finally {
      if (!signal.aborted) setPending(null);
    }
  }

  return (
    <form
      className="grid gap-3 rounded-lg border border-separator bg-background p-3 text-sm"
      onSubmit={generate}
      onChange={clear}
      onReset={clear}
    >
      <div className="grid gap-2 sm:grid-cols-3">
        <label className="grid min-w-0 gap-1">
          纪要（TXT / Markdown）
          <input className={controlClass} type="file" name="notes" accept=".txt,.md,.markdown" />
        </label>
        <label className="grid min-w-0 gap-1">
          任务表（CSV）
          <input className={controlClass} type="file" name="tasks" accept=".csv,text/csv" />
        </label>
        <label className="grid min-w-0 gap-1">
          截至日
          <input className={controlClass} type="date" name="cutoff" />
        </label>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={pending !== null}>
          {pending === 'files' ? '正在处理…' : '生成报告'}
        </Button>
        <Button type="reset" variant="flat">
          清空
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      {report && (
        <div className="grid gap-2 border-t border-separator pt-2">
          <p role="status">
            {report.analysis
              ? `已检查 ${report.analysis.total} 条任务，逾期未完成 ${report.analysis.overdue} 条。`
              : '纪要报告可下载。'}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="flat"
              onClick={() =>
                download(
                  'office-report.md',
                  'text/markdown',
                  officeReport(report.analysis?.markdown ?? '', report.notes, summary),
                )
              }
            >
              下载 Markdown 报告
            </Button>
            {report.analysis && (
              <Button
                type="button"
                variant="flat"
                onClick={() => download('task-summary.csv', 'text/csv', report.analysis!.csv)}
              >
                下载 CSV 汇总
              </Button>
            )}
            <Link
              href="/conversations?intent=reminder"
              className="inline-flex min-h-9 items-center px-2 underline"
            >
              在对话中填写提醒
            </Link>
          </div>
          {report.notes && (
            <div className="grid justify-items-start gap-1">
              <p className="text-muted-foreground">纪要会发送给默认模型生成摘要。</p>
              {pending === 'summary' ? (
                <Button
                  type="button"
                  variant="flat"
                  onClick={() => {
                    current.current?.abort();
                    setPending(null);
                  }}
                >
                  停止等待摘要
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="flat"
                  disabled={!!summary}
                  onClick={() => void summarize(report.notes)}
                >
                  发送纪要并生成摘要
                </Button>
              )}
              {summary && (
                <p role="status" className="whitespace-pre-wrap wrap-anywhere">
                  {summary}
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </form>
  );
}
