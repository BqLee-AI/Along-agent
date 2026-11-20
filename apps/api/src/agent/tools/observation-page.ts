import type { PoolClient } from 'pg';
import { contextSliceResultSchema, type ContextSliceResult } from '@along/contracts';
import type { ToolContext, ToolResult } from './contracts.js';
import type { ReadRunObservationInput } from './schemas.js';
import {
  assertContextSourceAuthorized,
  contextSourceCorrupt,
} from './invocations/context-source.js';
import { readRunContextSource } from './invocations/context-query.js';

const PAGE_BYTES = 16384;

// A page is a new accepted read-only action over the immutable ledger, not a
// workspace read. In particular it never appears in document baseline evidence.
export async function readObservationPage(
  client: PoolClient,
  ctx: ToolContext,
  args: ReadRunObservationInput,
): Promise<ToolResult> {
  const metadata = await assertContextSourceAuthorized(client, ctx, args.source_invocation_id);
  const unsupported: ToolResult = {
    status: 'ok',
    result: { kind: 'operation_error', path: '', reason: 'unsupported_source' },
  };
  if (metadata.tool_id === 'feishu_docx_read') return unsupported;
  const observation = await readRunContextSource(client, ctx, args.source_invocation_id, 'full');
  if (observation.view !== 'full') throw contextSourceCorrupt();
  const accepted = observation.result;
  const tooLarge: ToolResult = {
    status: 'ok',
    result: { kind: 'operation_error', path: '', reason: 'range_too_large' },
  };
  if (accepted.status !== 'ok') return unsupported;
  const result = accepted.result;
  const identity = {
    kind: 'context_slice' as const,
    source_invocation_id: args.source_invocation_id,
    source_tool_id: metadata.tool_id,
    source_result_version: 1 as const,
    ...('workspace_id' in result && result.workspace_id
      ? { workspace_id: result.workspace_id }
      : {}),
    offset: args.offset,
  };
  let total: number;
  let makePage: (count: number) => ContextSliceResult;
  if (result.kind === 'read' && args.field === 'content') {
    const scalars = Array.from(result.content);
    total = scalars.length;
    makePage = (count) => ({
      ...identity,
      source_kind: 'read',
      field: 'content',
      unit: 'unicode_scalar',
      path: result.path,
      version: result.version,
      byte_length: result.byte_length,
      total,
      end: args.offset + count,
      has_more: args.offset + count < total,
      content: scalars.slice(args.offset, args.offset + count).join(''),
    });
  } else if (result.kind === 'search' && args.field === 'matches') {
    total = result.matches.length;
    makePage = (count) => ({
      ...identity,
      source_kind: 'search',
      field: 'matches',
      unit: 'items',
      total,
      end: args.offset + count,
      has_more: args.offset + count < total,
      items: result.matches.slice(args.offset, args.offset + count),
    });
  } else if (result.kind === 'list' && args.field === 'entries') {
    total = result.entries.length;
    makePage = (count) => ({
      ...identity,
      source_kind: 'list',
      field: 'entries',
      unit: 'items',
      total,
      end: args.offset + count,
      has_more: args.offset + count < total,
      items: result.entries.slice(args.offset, args.offset + count),
    });
  } else if ((result.kind === 'list' || result.kind === 'search') && args.field === 'failures') {
    total = result.failures.length;
    makePage = (count) => ({
      ...identity,
      source_kind: result.kind,
      field: 'failures',
      unit: 'items',
      total,
      end: args.offset + count,
      has_more: args.offset + count < total,
      items: result.failures.slice(args.offset, args.offset + count),
    });
  } else return unsupported;

  let low = 0;
  let high = Math.min(args.limit, Math.max(0, total - args.offset));
  while (low < high) {
    const count = low + Math.ceil((high - low) / 2);
    const page = { status: 'ok', result: makePage(count) };
    if (Buffer.byteLength(JSON.stringify(page), 'utf8') <= PAGE_BYTES) low = count;
    else high = count - 1;
  }
  if (low === 0 && args.offset < total) return tooLarge;
  const page = contextSliceResultSchema.parse(makePage(low));
  const acceptedPage: ToolResult = { status: 'ok', result: page };
  if (Buffer.byteLength(JSON.stringify(acceptedPage), 'utf8') > PAGE_BYTES) return tooLarge;
  await assertContextSourceAuthorized(client, ctx, args.source_invocation_id);
  return acceptedPage;
}
