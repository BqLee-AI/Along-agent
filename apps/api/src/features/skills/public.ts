import { createHash, randomUUID } from 'node:crypto';
import type { SkillDetail, SkillInput, SkillMetadata, SkillSelection } from '@along/contracts';
import type { Pool, PoolClient } from 'pg';
import { withTransaction } from '../../db/transaction.js';
import {
  decodeCursor,
  encodeCursor,
  forbidden,
  isUuid,
  notFound,
  stateConflict,
  validationError,
} from '../../platform/errors.js';
import { lockViewerAccess, type Actor } from '../identity/public.js';

type Queryable = Pick<PoolClient, 'query'>;
type SkillRow = { id: string; current_revision: number; disabled_at: Date | null };
type MetadataRow = Omit<SkillMetadata, 'disabled_at'> & { disabled_at: Date | null };
type DetailRow = MetadataRow & { body: string };

const currentRevision = `FROM personal_skills s JOIN personal_skill_revisions r
  ON r.skill_id=s.id AND r.revision=s.current_revision`;
const metadataFields = 's.id, r.revision, r.name, r.description, s.disabled_at';

function view<T extends MetadataRow>(row: T) {
  return { ...row, disabled_at: row.disabled_at?.toISOString() ?? null };
}

function unavailable(row: SkillRow) {
  return stateConflict('skill is disabled', {
    reason: 'SKILL_DISABLED',
    current_revision: row.current_revision,
  });
}

function requireCurrent(row: SkillRow, revision: number) {
  if (row.disabled_at) throw unavailable(row);
  if (row.current_revision !== revision)
    throw stateConflict('skill revision changed', {
      reason: 'SKILL_REVISION_CHANGED',
      current_revision: row.current_revision,
    });
}

async function lockSkill(client: Queryable, ownerId: string, id: string, write = false) {
  const { rows } = await client.query<SkillRow>(
    `SELECT id, current_revision, disabled_at FROM personal_skills
     WHERE owner_id=$1 AND id=$2 FOR ${write ? 'UPDATE' : 'SHARE'}`,
    [ownerId, id],
  );
  if (!rows[0]) throw notFound('skill not found');
  return rows[0];
}

// Call with the Bot lock already held. The skill lock lives through the caller's commit.
export async function lockAdmittedSkill(
  client: Queryable,
  ownerId: string,
  selection: SkillSelection,
): Promise<Pick<SkillDetail, 'id' | 'revision' | 'name' | 'body'>> {
  const row = await lockSkill(client, ownerId, selection.id);
  requireCurrent(row, selection.revision);
  const { rows } = await client.query<{ name: string; body: string }>(
    'SELECT name, body FROM personal_skill_revisions WHERE skill_id=$1 AND revision=$2',
    [row.id, row.current_revision],
  );
  return { id: row.id, revision: row.current_revision, ...rows[0]! };
}

// Edits do not revoke a Run's frozen version; disabling does.
export async function assertSkillActive(client: Queryable, ownerId: string, id: string) {
  const row = await lockSkill(client, ownerId, id);
  if (row.disabled_at) throw unavailable(row);
}

export async function validateAssignedSkills(
  client: Queryable,
  ownerId: string,
  ids: readonly string[],
  previousIds: readonly string[] = [],
) {
  if (ids.length === 0) return;
  const { rows } = await client.query<SkillRow>(
    `SELECT id, current_revision, disabled_at FROM personal_skills
     WHERE owner_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR SHARE`,
    [ownerId, ids],
  );
  const unique = new Set(ids.map((id) => id.toLowerCase()));
  if (rows.length !== unique.size) throw notFound('skill not found');
  const previous = new Set(previousIds.map((id) => id.toLowerCase()));
  for (const row of rows) if (row.disabled_at && !previous.has(row.id)) throw unavailable(row);
}

export async function listAssignedSkills(
  client: Queryable,
  ownerId: string,
  ids: readonly string[],
): Promise<SkillMetadata[]> {
  if (ids.length === 0) return [];
  const { rows } = await client.query<MetadataRow>(
    `SELECT ${metadataFields} ${currentRevision}
     WHERE s.owner_id=$1 AND s.disabled_at IS NULL AND s.id=ANY($2::uuid[])
     ORDER BY array_position($2::uuid[], s.id)`,
    [ownerId, ids],
  );
  return rows.map(view);
}

export async function listPersonalSkills(
  db: Queryable,
  ownerId: string,
  query: Record<string, string | string[] | undefined>,
): Promise<{ items: SkillMetadata[]; next_cursor: string | null }> {
  const { limit: rawLimit, cursor: rawCursor } = query;
  if (
    Object.keys(query).some((key) => key !== 'limit' && key !== 'cursor') ||
    (rawLimit !== undefined &&
      (typeof rawLimit !== 'string' || !/^[1-9][0-9]{0,2}$/.test(rawLimit)))
  )
    throw validationError('invalid skill list query');
  const limit = rawLimit === undefined ? 50 : Number(rawLimit);
  if (limit > 100) throw validationError('invalid skill limit');
  let cursorId: string | null = null;
  if (rawCursor !== undefined) {
    const decoded =
      typeof rawCursor === 'string' && rawCursor.length <= 256 && decodeCursor(rawCursor);
    if (
      !decoded ||
      decoded.owner_id !== ownerId ||
      typeof decoded.id !== 'string' ||
      !isUuid(decoded.id) ||
      encodeCursor({ owner_id: ownerId, id: decoded.id }) !== rawCursor
    )
      throw validationError('invalid skill cursor');
    cursorId = decoded.id;
  }
  const { rows } = await db.query<MetadataRow>(
    `SELECT ${metadataFields} ${currentRevision}
     WHERE s.owner_id=$1 AND ($2::uuid IS NULL OR s.id>$2) ORDER BY s.id LIMIT $3`,
    [ownerId, cursorId, limit + 1],
  );
  const more = rows.length > limit;
  if (more) rows.pop();
  return {
    items: rows.map(view),
    next_cursor: more ? encodeCursor({ owner_id: ownerId, id: rows[rows.length - 1]!.id }) : null,
  };
}

export async function getPersonalSkill(
  db: Queryable,
  ownerId: string,
  id: string,
): Promise<SkillDetail> {
  const { rows } = await db.query<DetailRow>(
    `SELECT ${metadataFields}, r.body ${currentRevision} WHERE s.owner_id=$1 AND s.id=$2`,
    [ownerId, id],
  );
  if (!rows[0]) throw notFound('skill not found');
  return view(rows[0]);
}

async function writeSkill<T>(pool: Pool, actor: Actor, apply: (client: PoolClient) => Promise<T>) {
  return withTransaction(pool, async (client) => {
    if (!(await lockViewerAccess(client, actor.ownerId, actor.sessionId)))
      throw forbidden('owner authorization revoked');
    return apply(client);
  });
}

async function insertRevision(client: Queryable, id: string, revision: number, input: SkillInput) {
  await client.query(
    `INSERT INTO personal_skill_revisions (skill_id, revision, name, description, body)
     VALUES ($1,$2,$3,$4,$5)`,
    [id, revision, input.name, input.description, input.body],
  );
}

export async function createPersonalSkill(
  pool: Pool,
  actor: Actor,
  key: string,
  input: SkillInput,
  rawFile?: string,
): Promise<SkillDetail> {
  const ownerId = actor.ownerId;
  const hash = (
    rawFile === undefined
      ? createHash('sha256').update(JSON.stringify([input.name, input.description, input.body]))
      : createHash('sha256').update('file\0').update(rawFile)
  ).digest('hex');
  return writeSkill(pool, actor, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `personal-skill:${ownerId}:${key}`,
    ]);
    const { rows } = await client.query<SkillDetail & { request_hash: string }>(
      `SELECT r.skill_id AS id, r.revision, r.name, r.description, r.body,
              NULL AS disabled_at, q.request_hash
       FROM personal_skill_requests q JOIN personal_skill_revisions r
         ON r.skill_id=q.skill_id AND r.revision=1
       WHERE q.owner_id=$1 AND q.idempotency_key=$2`,
      [ownerId, key],
    );
    const replay = rows[0];
    if (replay) {
      const { request_hash, ...skill } = replay;
      if (request_hash !== hash)
        throw stateConflict('idempotency key reused for a different skill');
      return skill;
    }
    const id = randomUUID();
    await client.query('INSERT INTO personal_skills (id,owner_id) VALUES ($1,$2)', [id, ownerId]);
    await insertRevision(client, id, 1, input);
    await client.query(
      `INSERT INTO personal_skill_requests (owner_id,idempotency_key,request_hash,skill_id)
       VALUES ($1,$2,$3,$4)`,
      [ownerId, key, hash, id],
    );
    return { ...input, id, revision: 1, disabled_at: null };
  });
}

export async function updatePersonalSkill(
  pool: Pool,
  actor: Actor,
  id: string,
  expectedRevision: number,
  input: SkillInput,
): Promise<SkillDetail> {
  return writeSkill(pool, actor, async (client) => {
    const row = await lockSkill(client, actor.ownerId, id, true);
    requireCurrent(row, expectedRevision);
    const revision = row.current_revision + 1;
    await insertRevision(client, id, revision, input);
    await client.query('UPDATE personal_skills SET current_revision=$2 WHERE id=$1', [
      id,
      revision,
    ]);
    return { ...input, id: row.id, revision, disabled_at: null };
  });
}

export async function disablePersonalSkill(
  pool: Pool,
  actor: Actor,
  id: string,
  expectedRevision: number,
): Promise<SkillDetail> {
  return writeSkill(pool, actor, async (client) => {
    const row = await lockSkill(client, actor.ownerId, id, true);
    requireCurrent(row, expectedRevision);
    await client.query(
      `UPDATE personal_skills SET disabled_at=clock_timestamp()
       WHERE id=$1 AND current_revision=$2 AND disabled_at IS NULL`,
      [id, expectedRevision],
    );
    return getPersonalSkill(client, actor.ownerId, id);
  });
}
