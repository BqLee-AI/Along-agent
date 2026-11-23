import type { RunRow } from '../../features/conversations/public.js';
import {
  DELEGATION_TOOL_IDS,
  DELEGATION_WORKSPACE_READ_TOOL_IDS,
  DELEGATION_WORKSPACE_WRITE_TOOL_IDS,
  DELEGATION_WORKSPACE_CREATE_TOOL_IDS,
  HARNESS_BASE_TOOL_IDS,
  R3_MEMORY_TOOL_IDS,
  R3_MEMORY_SOURCE_TOOL_ID,
  TOOL_IDS,
} from '../tools/contracts.js';

const delegationTools: readonly string[] = [
  ...DELEGATION_TOOL_IDS,
  ...DELEGATION_WORKSPACE_READ_TOOL_IDS,
  ...DELEGATION_WORKSPACE_WRITE_TOOL_IDS,
  ...DELEGATION_WORKSPACE_CREATE_TOOL_IDS,
];

export function supportsFrozenTools(run: RunRow): boolean {
  const frozen = run.frozen_context;
  if (!frozen) return false;
  // User-identity Feishu grants are historical evidence only, not a restore capability.
  if (frozen.feishuDocx && !('kind' in frozen.feishuDocx)) return false;
  if (Object.hasOwn(frozen, 'officeMaterials')) {
    const materials = frozen.officeMaterials;
    if (
      !Array.isArray(materials) ||
      !materials.length ||
      run.execution !== 'harness' ||
      frozen.authorization_revision !== 'delegation/1' ||
      frozen.execution_lifecycle !== 'server-owned' ||
      frozen.execution_profile !== 'compact-memory/1' ||
      !frozen.officeSessionId ||
      frozen.feishuDocx ||
      frozen.workspaceGrant ||
      frozen.workspaceGrants?.length
    )
      return false;
    return run.tools_allowlist.every((name) => {
      if (name === 'office_read_notes') return materials.some((item) => item?.role === 'notes');
      if (name === 'office_analyze_tasks') return materials.some((item) => item?.role === 'tasks');
      return (
        name === 'office_create_artifacts' ||
        name === 'get_user_prefs' ||
        name === 'create_reminder'
      );
    });
  }
  const supported: readonly string[] = frozen.authorization_revision
    ? delegationTools
    : frozen.workspaceGrant
      ? TOOL_IDS
      : HARNESS_BASE_TOOL_IDS;
  return run.tools_allowlist.every(
    (name) =>
      (name === 'feishu_docx_read' && !!frozen.authorization_revision && !!frozen.feishuDocx) ||
      supported.includes(name) ||
      ((frozen.execution_profile === 'pause-memory/1' ||
        frozen.execution_profile === 'compact-memory/1') &&
        (R3_MEMORY_TOOL_IDS as readonly string[]).includes(name)) ||
      (frozen.execution_profile === 'compact-memory/1' && name === R3_MEMORY_SOURCE_TOOL_ID),
  );
}
