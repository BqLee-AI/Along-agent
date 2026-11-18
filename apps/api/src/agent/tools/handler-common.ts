import type { ToolPayload, ToolResult } from './contracts.js';

export const workspaceDenied = (): ToolResult => ({
  status: 'denied',
  error: { code: 'TOOL_FORBIDDEN', message: '当前工作区或文档动作未获授权。' },
});

export interface ToolExecution {
  payload: ToolPayload;
  errorCode: string | null;
}
