import type { PoolClient } from 'pg';

export interface ReleaseApprovalDetail {
  approvalState: string | null;
  reminderText: string | null;
  wallTime: string | null;
  timezone: string | null;
  documentPath: string | null;
  documentPreview: string | null;
}

/** Read frozen materials, including legacy states, without consuming approval. */
export async function readReleaseApprovalDetail(
  client: PoolClient,
  ownerId: string,
  approvalId: string | null,
): Promise<ReleaseApprovalDetail> {
  const { rows } = await client.query<ReleaseApprovalDetail>(
    `SELECT COALESCE(a.state,d.state) AS "approvalState", a.original_text AS "reminderText",
            a.wall_time AS "wallTime", a.timezone_id AS "timezone", d.relative_path AS "documentPath",
            d.preview AS "documentPreview"
       FROM (SELECT $1::uuid AS owner_id, $2::uuid AS approval_id) selected
       LEFT JOIN approvals a ON a.id=selected.approval_id AND a.owner_id=selected.owner_id
       LEFT JOIN document_approvals d ON d.id=selected.approval_id AND d.owner_id=selected.owner_id`,
    [ownerId, approvalId],
  );
  return rows[0]!;
}
