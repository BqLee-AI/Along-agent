import type { Pool, PoolClient } from 'pg';
import { httpStatusForError } from '@along/contracts';
import { searchMicrosoftLearn } from '../../../features/remote-mcp/public.js';
import { lockToolRunBinding } from '../../../features/conversations/public.js';
import { ApplicationError } from '../../../platform/errors.js';
import { withRunTransaction } from '../../runtime/run-ownership.js';
import type { InvocationInput, ToolContext, ToolResult } from '../contracts.js';
import { executeReadOnlyInvocation } from '../invocations/invocations.js';
import { TOOL_INPUT_SCHEMAS } from '../schemas.js';

const denied: ToolResult = {
  status: 'denied',
  error: { code: 'TOOL_FORBIDDEN', message: '没有当前 Microsoft Learn 查询资格。' },
};

export async function invokeLearnDocsSearch(pool: Pool, ctx: ToolContext, input: InvocationInput) {
  async function authorized(client: PoolClient) {
    return (
      ctx.authorizationRevision === 'delegation/1' &&
      !ctx.feishuDocx &&
      ctx.allowlist.includes('learn_docs_search') &&
      !ctx.signal?.aborted &&
      (await lockToolRunBinding(client, ctx)).canExecute
    );
  }
  return executeReadOnlyInvocation(
    pool,
    ctx,
    input,
    async (frozen) => {
      const parsed = TOOL_INPUT_SCHEMAS.learn_docs_search.safeParse(input.args);
      if (!parsed.success)
        return {
          status: 'denied',
          error: {
            code: 'TOOL_INPUT_INVALID',
            message: '需要有效的公开技术 query，不接受其他字段。',
          },
        };
      const result = await searchMicrosoftLearn({
        query: parsed.data.query,
        signal: frozen.signal,
        authorized: () => withRunTransaction(pool, ctx.ownership, authorized),
      });
      if (result.status === 'denied') return denied;
      if (result.status === 'failed')
        return {
          status: 'failed',
          error: { code: result.code, message: `Microsoft Learn 查询未完成：${result.code}。` },
        };
      return { status: 'ok', result: result.result };
    },
    async (client) => {
      if (!(await authorized(client))) return denied;
    },
    authorized,
  ).catch((error: unknown) => {
    if (error instanceof ApplicationError && httpStatusForError(error.code) === 403)
      return { ...denied, invocationId: input.invocationId, replayed: false };
    throw error;
  });
}
