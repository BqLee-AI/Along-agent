import type { Pool, PoolClient } from 'pg';
import { hashSessionToken } from './crypto.js';

const COLUMNS: Record<string, Record<string, true>> = {
  users: {
    id: true,
    display_name: true,
    primary_email_hash: true,
    auth_subject: true,
    auth_provider: true,
    timezone_id: true,
    status: true,
    created_at: true,
    updated_at: true,
    metadata: true,
    auth_email: true,
    email_verified: true,
  },
  sessions: {
    id: true,
    user_id: true,
    token_hash: true,
    created_at: true,
    expires_at: true,
    revoked_at: true,
    last_seen_at: true,
    client_info: true,
    ip_address: true,
    user_agent: true,
  },
  auth_accounts: {
    id: true,
    user_id: true,
    provider_id: true,
    account_id: true,
    password_hash: true,
    created_at: true,
    updated_at: true,
  },
};
export interface WhereClause {
  field: string;
  value: unknown;
  operator?: string;
  connector?: string;
}
function columns(model: string, fields: readonly string[] = []): void {
  const allowed = COLUMNS[model];
  if (!allowed) throw new Error(`pg-adapter: unknown table ${model}`);
  for (const field of fields)
    if (!allowed[field]) throw new Error(`pg-adapter: unknown column ${model}.${field}`);
}
function secretOf(): string {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) throw new Error('BETTER_AUTH_SECRET is required');
  return secret;
}
export function mapValue(
  model: string,
  field: string,
  value: unknown,
  secret?: string,
): { field: string; value: unknown } {
  if (model === 'sessions' && (field === 'token' || field === 'token_hash')) {
    return { field: 'token_hash', value: hashSessionToken(String(value), secret ?? secretOf()) };
  }
  return { field, value };
}
export function translateWhere(
  model: string,
  where: WhereClause[] | undefined,
  offset = 1,
  secret?: string,
): { sql: string; params: unknown[] } {
  columns(model);
  const params: unknown[] = [];
  const parts = (where ?? []).map((clause, index) => {
    const { field, value } = mapValue(model, clause.field, clause.value, secret);
    columns(model, [field]);
    const connector = (clause.connector ?? 'AND').toUpperCase();
    if (connector !== 'AND' && connector !== 'OR') throw new Error('pg-adapter: invalid connector');
    const prefix = index ? `${connector} ` : '';
    const op = clause.operator ?? 'eq';
    if (value === null) return `${prefix}"${field}" IS ${op === 'ne' ? 'NOT ' : ''}NULL`;
    if (op === 'in' || op === 'not_in') {
      if (!Array.isArray(value)) throw new Error('pg-adapter: IN needs an array');
      if (!value.length) return `${prefix}${op === 'in' ? 'FALSE' : 'TRUE'}`;
      const holders = value.map((v) => {
        params.push(v);
        return `$${offset + params.length - 1}`;
      });
      return `${prefix}"${field}" ${op === 'in' ? 'IN' : 'NOT IN'} (${holders.join(',')})`;
    }
    const sqlOp = (
      { eq: '=', ne: '<>', lt: '<', lte: '<=', gt: '>', gte: '>=' } as Record<string, string>
    )[op];
    if (!sqlOp) throw new Error(`pg-adapter: unsupported operator ${op}`);
    params.push(value);
    return `${prefix}"${field}" ${sqlOp} $${offset + params.length - 1}`;
  });
  return { sql: parts.join(' ') || 'TRUE', params };
}
export interface PgAdapterOptions {
  pool: Pool | PoolClient;
  secret?: string;
}
export function createPgAdapter({ pool, secret = secretOf() }: PgAdapterOptions) {
  function input(model: string, data: Record<string, unknown>) {
    columns(model, Object.keys(data));
    return Object.fromEntries(
      Object.entries(data).map(([field, value]) => {
        const mapped = mapValue(model, field, value, secret);
        return [
          mapped.field,
          (field === 'metadata' || field === 'client_info') && value !== null
            ? JSON.stringify(value)
            : mapped.value,
        ];
      }),
    );
  }
  // Only a raw token supplied in this call can cross back into Better Auth.
  // ID-only reads deliberately omit token; a persisted HMAC is never a token.
  function output<T>(
    model: string,
    row: Record<string, unknown> | undefined,
    raw?: unknown,
  ): T | null {
    if (!row) return null;
    if (model !== 'sessions') return row as T;
    return { ...row, token_hash: typeof raw === 'string' ? raw : undefined } as T;
  }
  const rawWhere = (where?: WhereClause[]) =>
    where?.find((w) => w.field === 'token_hash' || w.field === 'token')?.value;
  async function updateRows(
    model: string,
    where: WhereClause[] | undefined,
    update: Record<string, unknown>,
  ) {
    const row = input(model, update);
    const keys = Object.keys(row);
    if (!keys.length) return [];
    const { sql, params } = translateWhere(model, where, keys.length + 1, secret);
    return (
      await pool.query(
        `UPDATE "${model}" SET ${keys.map((k, i) => `"${k}"=$${i + 1}`).join(',')} WHERE ${sql} RETURNING *`,
        [...keys.map((k) => row[k]), ...params],
      )
    ).rows;
  }
  async function remove(model: string, where?: WhereClause[]) {
    columns(model);
    const { sql, params } = translateWhere(model, where, 1, secret);
    const query =
      model === 'sessions'
        ? `UPDATE sessions SET revoked_at=COALESCE(revoked_at,now()) WHERE ${sql}`
        : model === 'users'
          ? `UPDATE users SET status='deleted_requested',updated_at=now() WHERE ${sql}`
          : `DELETE FROM "${model}" WHERE ${sql}`;
    return (await pool.query(query, params)).rowCount ?? 0;
  }
  return {
    async create<T extends Record<string, unknown>>({
      model,
      data,
    }: {
      model: string;
      data: T;
    }): Promise<T> {
      const row = input(model, data);
      const keys = Object.keys(row);
      const { rows } = await pool.query(
        `INSERT INTO "${model}" (${keys.map((k) => `"${k}"`).join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`,
        keys.map((k) => row[k]),
      );
      return output<T>(model, rows[0], data.token_hash) as T;
    },
    async findOne<T>({
      model,
      where,
    }: {
      model: string;
      where?: WhereClause[];
    }): Promise<T | null> {
      const { sql, params } = translateWhere(model, where, 1, secret);
      const { rows } = await pool.query(
        `SELECT * FROM "${model}" WHERE (${sql})${model === 'sessions' ? ' AND revoked_at IS NULL' : ''} LIMIT 1`,
        params,
      );
      return output<T>(model, rows[0], rawWhere(where));
    },
    async findMany<T>({
      model,
      where,
      limit,
      offset,
      sortBy,
    }: {
      model: string;
      where?: WhereClause[];
      limit?: number;
      offset?: number;
      sortBy?: { field: string; direction: 'asc' | 'desc' };
    }): Promise<T[]> {
      const { sql, params } = translateWhere(model, where, 1, secret);
      if (sortBy) columns(model, [sortBy.field]);
      const order = sortBy
        ? ` ORDER BY "${sortBy.field}" ${sortBy.direction === 'desc' ? 'DESC' : 'ASC'}`
        : '';
      const { rows } = await pool.query(
        `SELECT * FROM "${model}" WHERE (${sql})${model === 'sessions' ? ' AND revoked_at IS NULL' : ''}${order} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit ?? 100, offset ?? 0],
      );
      return rows.map((row) => output<T>(model, row, rawWhere(where)) as T);
    },
    async update<T>({
      model,
      where,
      update,
    }: {
      model: string;
      where?: WhereClause[];
      update: T;
    }): Promise<T | null> {
      const rows = await updateRows(model, where, update as Record<string, unknown>);
      return output<T>(
        model,
        rows[0],
        (update as Record<string, unknown>).token_hash ?? rawWhere(where),
      );
    },
    async updateMany({
      model,
      where,
      update,
    }: {
      model: string;
      where?: WhereClause[];
      update: Record<string, unknown>;
    }): Promise<number> {
      return (await updateRows(model, where, update)).length;
    },
    async delete({ model, where }: { model: string; where?: WhereClause[] }) {
      await remove(model, where);
    },
    async deleteMany({ model, where }: { model: string; where?: WhereClause[] }): Promise<number> {
      return remove(model, where);
    },
    async count({ model, where }: { model: string; where?: WhereClause[] }) {
      const { sql, params } = translateWhere(model, where, 1, secret);
      return (
        (await pool.query(`SELECT count(*)::int AS n FROM "${model}" WHERE ${sql}`, params)).rows[0]
          ?.n ?? 0
      );
    },
  };
}
