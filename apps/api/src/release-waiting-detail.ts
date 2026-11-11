import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { createPool } from './db/pool.js';

const id = z
  .string()
  .uuid()
  .parse(JSON.parse(readFileSync(0, 'utf8')).runId);
const pool = createPool();
if (!pool) throw new Error('DATABASE_REQUIRED');
try {
  const result = await pool.query(
    `SELECT r.id AS "runId", r.conversation_id AS "conversationId", u.display_name AS "owner",
            r.waiting_checkpoint_id AS "checkpoint", r.waiting_invocation_id AS "invocation",
            m.content AS "originalMessage", r.waiting_approval_id AS "approvalId",
            COALESCE(a.state, d.state) AS "approvalState", a.original_text AS "reminderText",
            a.wall_time AS "wallTime", a.timezone_id AS "timezone", d.relative_path AS "documentPath",
            d.preview AS "documentPreview"
       FROM agent_runs r
       LEFT JOIN users u ON u.id=r.owner_id
       LEFT JOIN messages m ON m.id=r.input_message_id AND m.owner_id=r.owner_id
       LEFT JOIN approvals a ON a.id=r.waiting_approval_id AND a.owner_id=r.owner_id
       LEFT JOIN document_approvals d ON d.id=r.waiting_approval_id AND d.owner_id=r.owner_id
       WHERE r.id=$1 AND r.status='suspended_approval'`,
    [id],
  );
  if (result.rowCount !== 1) throw new Error('WAITING_NOT_FOUND');
  console.log(JSON.stringify(result.rows[0]));
} finally {
  await pool.end();
}
