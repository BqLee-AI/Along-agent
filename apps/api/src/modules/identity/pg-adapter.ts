import type { Pool } from "pg";
import { hashSessionToken } from "./crypto.js";

// Custom pg adapter for Better Auth (issue #27): raw `pg`, no Kysely/Drizzle.
// The factory wrapper pre-transforms logical names to DB names, so this
// layer receives DB table/column names. Token hashing happens here: the
// library passes the raw token to findOne({field:"token"}); we hash before
// comparing with sessions.token_hash (plaintext never persists).

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

function assertTable(model: string): void {
  if (!(model in COLUMNS)) throw new Error(`pg-adapter: unknown table ${model}`);
}

function assertColumns(model: string, row: Record<string, unknown>): void {
  const allowed = COLUMNS[model];
  if (!allowed) throw new Error(`pg-adapter: unknown table ${model}`);
  for (const key of Object.keys(row)) {
    if (!allowed[key]) {
      throw new Error(`pg-adapter: unknown column ${model}.${key}`);
    }
  }
}

function secretOf(): string {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) throw new Error("BETTER_AUTH_SECRET is required");
  return secret;
}

// Map library-facing values to DB values. The factory wrapper pre-transforms
// logical names to DB names, so session token values arrive under the
// `token_hash` key (plaintext from the cookie); hash them before compare.
// Accept the logical `token` key too for direct callers.
export function mapValue(model: string, field: string, value: unknown): { field: string; value: unknown } {
  if (model === "sessions" && (field === "token" || field === "token_hash")) {
    return { field: "token_hash", value: hashSessionToken(String(value), secretOf()) };
  }
  return { field, value };
}

// Translate where clauses to parameterized SQL. Supports eq/ne/in/lt/lte/
// gt/gte + IS NULL via {value: null}. Returns {sql, params} with 1-based
// placeholders starting at `offset`.
export function translateWhere(
  model: string,
  where: WhereClause[] | undefined,
  offset = 1,
): { sql: string; params: unknown[] } {
  if (!where || where.length === 0) return { sql: "TRUE", params: [] };
  const parts: string[] = [];
  const params: unknown[] = [];
  let i = offset;
  for (const w of where) {
    const allowed = COLUMNS[model];
    if (!allowed) throw new Error(`pg-adapter: unknown table ${model}`);
    const mapped = mapValue(model, w.field, w.value);
    if (!allowed[mapped.field]) {
      throw new Error(`pg-adapter: unknown column ${model}.${mapped.field}`);
    }
    const op = (w.operator ?? "eq").toLowerCase();
    const connector = parts.length === 0 ? "" : `${(w.connector ?? "AND").toUpperCase()} `;
    if (mapped.value === null) {
      parts.push(`${connector}"${mapped.field}" IS ${op === "ne" ? "NOT " : ""}NULL`);
      continue;
    }
    if (op === "in") {
      if (!Array.isArray(mapped.value)) throw new Error("pg-adapter: IN needs an array");
      const holders = mapped.value.map(() => `$${i++}`);
      parts.push(`${connector}"${mapped.field}" IN (${holders.join(",")})`);
      params.push(...(mapped.value as unknown[]));
      continue;
    }
    const sqlOp =
      op === "eq" ? "=" : op === "ne" ? "<>" : op === "lt" ? "<" : op === "lte" ? "<=" : op === "gt" ? ">" : op === "gte" ? ">=" : null;
    if (!sqlOp) throw new Error(`pg-adapter: unsupported operator ${w.operator}`);
    parts.push(`${connector}"${mapped.field}" ${sqlOp} $${i++}`);
    params.push(mapped.value);
  }
  return { sql: parts.join(" "), params };
}

function toJson(v: unknown): unknown {
  if (v !== null && typeof v === "object") return JSON.stringify(v);
  return v;
}

export interface PgAdapterOptions {
  pool: Pool;
}

export function createPgAdapter({ pool }: PgAdapterOptions) {
  return {
    async create<T extends Record<string, unknown>>({ model, data }: { model: string; data: T }): Promise<T> {
      assertTable(model);
      assertColumns(model, data);
      const row: Record<string, unknown> = { ...data };
      // Hash raw session tokens on the way in (arrive under `token_hash`
      // key as plaintext after wrapper pre-transform; see mapValue).
      if (model === "sessions" && typeof row.token_hash === "string") {
        row.token_hash = hashSessionToken(row.token_hash, secretOf());
      } else if (model === "sessions" && typeof row.token === "string") {
        row.token_hash = hashSessionToken(row.token, secretOf());
        delete row.token;
      }
      if (row.client_info !== undefined) row.client_info = toJson(row.client_info);
      if (row.metadata !== undefined) row.metadata = toJson(row.metadata);
      const keys = Object.keys(row);
      const holders = keys.map((_, idx) => `$${idx + 1}`);
      const { rows } = await pool.query(
        `INSERT INTO "${model}" (${keys.map((k) => `"${k}"`).join(",")}) VALUES (${holders.join(",")}) RETURNING *`,
        keys.map((k) => row[k]),
      );
      return (rows[0] ?? null) as T;
    },

    async findOne<T>({ model, where }: { model: string; where?: WhereClause[] }): Promise<T | null> {
      assertTable(model);
      const { sql, params } = translateWhere(model, where);
      const { rows } = await pool.query(`SELECT * FROM "${model}" WHERE ${sql} LIMIT 1`, params);
      return (rows[0] ?? null) as T | null;
    },

    async findMany<T>({ model, where, limit }: { model: string; where?: WhereClause[]; limit?: number }): Promise<T[]> {
      assertTable(model);
      const { sql, params } = translateWhere(model, where);
      const lim = Math.min(Math.max(limit ?? 100, 1), 500);
      const { rows } = await pool.query(
        `SELECT * FROM "${model}" WHERE ${sql} LIMIT $${params.length + 1}`,
        [...params, lim],
      );
      return rows as T[];
    },

    async update<T>({ model, where, update }: { model: string; where?: WhereClause[]; update: T }): Promise<T | null> {
      assertTable(model);
      assertColumns(model, update as Record<string, unknown>);
      const row: Record<string, unknown> = { ...(update as Record<string, unknown>) };
      if (model === "sessions" && typeof row.token_hash === "string") {
        row.token_hash = hashSessionToken(row.token_hash, secretOf());
      } else if (model === "sessions" && typeof row.token === "string") {
        row.token_hash = hashSessionToken(row.token, secretOf());
        delete row.token;
      }
      if (row.client_info !== undefined) row.client_info = toJson(row.client_info);
      if (row.metadata !== undefined) row.metadata = toJson(row.metadata);
      // Soft-revoke sessions: delete becomes revoked_at=now.
      if (model === "sessions" && Object.keys(row).length === 0) {
        const { sql, params } = translateWhere(model, where);
        const { rows } = await pool.query(
          `UPDATE "sessions" SET revoked_at = now(), expires_at = now() WHERE ${sql} RETURNING *`,
          params,
        );
        return (rows[0] ?? null) as T | null;
      }
      const keys = Object.keys(row);
      if (keys.length === 0) return null;
      const { sql, params } = translateWhere(model, where, keys.length + 1);
      const sets = keys.map((k, idx) => `"${k}" = $${idx + 1}`);
      const { rows } = await pool.query(
        `UPDATE "${model}" SET ${sets.join(",")} WHERE ${sql} RETURNING *`,
        [...keys.map((k) => row[k]), ...params],
      );
      return (rows[0] ?? null) as T | null;
    },

    async updateMany({ model, where, update }: { model: string; where?: WhereClause[]; update: Record<string, unknown> }): Promise<number> {
      assertTable(model);
      assertColumns(model, update);
      const row: Record<string, unknown> = { ...update };
      if (model === "sessions" && typeof row.token_hash === "string") {
        row.token_hash = hashSessionToken(row.token_hash, secretOf());
      } else if (model === "sessions" && typeof row.token === "string") {
        row.token_hash = hashSessionToken(row.token, secretOf());
        delete row.token;
      }
      if (row.client_info !== undefined) row.client_info = toJson(row.client_info);
      if (row.metadata !== undefined) row.metadata = toJson(row.metadata);
      const keys = Object.keys(row);
      if (keys.length === 0) return 0;
      const { sql, params } = translateWhere(model, where, keys.length + 1);
      const sets = keys.map((k, idx) => `"${k}" = $${idx + 1}`);
      const { rowCount } = await pool.query(
        `UPDATE "${model}" SET ${sets.join(",")} WHERE ${sql}`,
        [...keys.map((k) => row[k]), ...params],
      );
      return rowCount ?? 0;
    },

    async delete({ model, where }: { model: string; where?: WhereClause[] }) {
      assertTable(model);
      // Users: soft-delete via status (users_no_delete trigger backstop).
      if (model === "users") {
        const { sql, params } = translateWhere(model, where);
        await pool.query(
          `UPDATE "users" SET status = 'deleted_requested', updated_at = now() WHERE ${sql}`,
          params,
        );
        return;
      }
      // Sessions: soft-revoke, never hard-delete.
      if (model === "sessions") {
        const { sql, params } = translateWhere(model, where);
        await pool.query(
          `UPDATE "sessions" SET revoked_at = now(), expires_at = now() WHERE ${sql}`,
          params,
        );
        return;
      }
      const { sql, params } = translateWhere(model, where);
      await pool.query(`DELETE FROM "${model}" WHERE ${sql}`, params);
    },

    async deleteMany({ model, where }: { model: string; where?: WhereClause[] }): Promise<number> {
      assertTable(model);
      if (model === "users") {
        const { sql, params } = translateWhere(model, where);
        const { rowCount } = await pool.query(
          `UPDATE "users" SET status = 'deleted_requested', updated_at = now() WHERE ${sql}`,
          params,
        );
        return rowCount ?? 0;
      }
      if (model === "sessions") {
        const { sql, params } = translateWhere(model, where);
        const { rowCount } = await pool.query(
          `UPDATE "sessions" SET revoked_at = now(), expires_at = now() WHERE ${sql}`,
          params,
        );
        return rowCount ?? 0;
      }
      const { sql, params } = translateWhere(model, where);
      const { rowCount } = await pool.query(`DELETE FROM "${model}" WHERE ${sql}`, params);
      return rowCount ?? 0;
    },

    async count({ model, where }: { model: string; where?: WhereClause[] }) {
      assertTable(model);
      const { sql, params } = translateWhere(model, where);
      const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM "${model}" WHERE ${sql}`,
        params,
      );
      return rows[0]?.n ?? 0;
    },
  };
}
