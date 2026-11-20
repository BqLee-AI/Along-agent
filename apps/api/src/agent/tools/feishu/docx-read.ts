import { httpStatusForError } from '@along/contracts';
import type { Pool, PoolClient } from 'pg';
import { withTransaction } from '../../../db/transaction.js';
import { lockViewerAccess } from '../../../features/identity/public.js';
import {
  loadFeishuBotDocxConfiguration,
  matchFeishuBotDocxGrant,
  readFeishuBotDocx,
  readFeishuBotObservationKey,
} from '../../../features/office-connectors/public.js';
import { ApplicationError, forbidden } from '../../../platform/errors.js';
import type { InvocationInput, ToolContext, ToolResult } from '../contracts.js';
import { executeReadOnlyInvocation } from '../invocations/invocations.js';
import { TOOL_INPUT_SCHEMAS } from '../schemas.js';

const denied: ToolResult = {
  status: 'denied',
  error: { code: 'TOOL_FORBIDDEN', message: '没有当前飞书连接或文档访问权限。' },
};

export async function invokeFeishuDocxRead(pool: Pool, ctx: ToolContext, input: InvocationInput) {
  const grant = ctx.feishuDocx;
  if (!grant || !('kind' in grant) || ctx.authorizationRevision !== 'delegation/1')
    throw forbidden();
  const viewer = { ownerId: ctx.ownerId, sessionId: grant.sessionId };
  const botGrant = grant;
  async function authorized(client: PoolClient) {
    const config = loadFeishuBotDocxConfiguration();
    return (
      !!config &&
      !!readFeishuBotObservationKey(config) &&
      !!(await lockViewerAccess(client, viewer.ownerId, viewer.sessionId)) &&
      !!(await matchFeishuBotDocxGrant(client, config, viewer, botGrant))
    );
  }
  return executeReadOnlyInvocation(
    pool,
    ctx,
    input,
    async (frozen) => {
      if (!TOOL_INPUT_SCHEMAS.feishu_docx_read.safeParse(input.args).success)
        return {
          status: 'denied',
          error: { code: 'TOOL_INPUT_INVALID', message: '飞书文档读取不接收参数。' },
        };
      const config = loadFeishuBotDocxConfiguration();
      const scope = frozen.feishuDocx;
      if (!config || !scope || !('kind' in scope)) return denied;
      const read = await readFeishuBotDocx({
        config,
        url: scope.url,
        signal: frozen.signal ?? AbortSignal.timeout(10_000),
        authorized: () => withTransaction(pool, authorized),
      });
      if (read.status === 'error') {
        if (read.reason === 'local_denied') return denied;
        if (read.reason === 'permission_denied')
          return {
            status: 'denied',
            error: {
              code: 'FEISHU_DOCX_PERMISSION_DENIED',
              message: '飞书拒绝了机器人读取此文档。',
            },
          };
        return {
          status: 'failed',
          error: { code: 'FEISHU_DOCX_READ_FAILED', message: `飞书文档未读到：${read.reason}。` },
        };
      }
      const result: ToolResult = {
        status: 'ok',
        result: {
          kind: 'feishu_docx_read',
          source: {
            type: 'feishu_docx',
            url: read.source.url,
            title: read.source.title,
            identity: 'bot',
          },
          revision: read.revision,
          fetched_at: read.fetched_at,
          content_hash: read.content_hash,
          representation: read.representation,
          completeness: read.completeness,
          content: read.content,
        },
      };
      if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 240_000)
        return {
          status: 'failed',
          error: { code: 'FEISHU_DOCX_READ_FAILED', message: '飞书文档未读到：range_too_large。' },
        };
      return result;
    },
    async (client, result) => {
      if (result.status === 'ok' && !(await authorized(client))) return denied;
    },
  ).catch((error: unknown) => {
    if (error instanceof ApplicationError && httpStatusForError(error.code) === 403)
      return { ...denied, invocationId: input.invocationId, replayed: false };
    throw error;
  });
}
