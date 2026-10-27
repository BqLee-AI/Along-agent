import { randomUUID } from 'node:crypto';
import { APIError } from 'better-auth/api';
import type { Pool, PoolClient } from 'pg';
import type { AuthStatus } from '@along/contracts';
import { authInitializeSchema, authSignInSchema } from '@along/contracts';
import {
  HttpError,
  notReady,
  stateConflict,
  unauthorized,
  validationError,
} from '../../http/errors.js';
import { createAuth } from './better-auth.js';
import { deriveAuthEmail } from './crypto.js';
import { listHistoricalOwners as conversationOwners } from '../conversations/owner-history.js';
import { listHistoricalOwners as approvalOwners } from '../approvals/owner-history.js';
import { listHistoricalOwners as taskOwners } from '../tasks/owner-history.js';
import { listHistoricalOwners as notificationOwners } from '../notifications/owner-history.js';
import { listHistoricalOwners as toolOwners } from '../tools/owner-history.js';
import { getWorkspaceAccountStatus } from '../workspaces/service.js';

export interface AccountWorkspaceStatus {
  state: 'unconfigured' | 'loaded' | 'invalid' | 'unreadable';
  ownerIds: string[];
}
export interface AccountServiceOptions {
  secret?: string;
  origin?: string;
  workspaceStatus?: () => Promise<AccountWorkspaceStatus>;
}
export interface BoundAdministrator {
  userId: string;
  displayName: string;
}
export interface MaintenanceCandidate {
  selection: string;
  displayName: string;
  status: string;
  hasPassword: boolean;
  eligible: boolean;
}
export interface AccountSessionResult {
  cookies: string[];
}
interface UserRow {
  id: string;
  display_name: string;
  status: string;
  auth_email: string;
}
interface CredentialRow {
  id: string;
  user_id: string;
  account_id: string;
  password_hash: string | null;
}
export interface AccountService {
  status(actor?: { ownerId: string; sessionId: string | null } | null): Promise<AuthStatus>;
  initialize(input: {
    login_name: string;
    password: string;
    display_name: string;
  }): Promise<AccountSessionResult>;
  claim(
    userId: string,
    input: { login_name: string; password: string; confirmed: true },
  ): Promise<AccountSessionResult>;
  signIn(input: { login_name: string; password: string }): Promise<AccountSessionResult>;
  signOut(sessionId: string, userId: string, headers: Headers): Promise<AccountSessionResult>;
  getBoundAdministrator(): Promise<BoundAdministrator | null>;
  listMaintenanceCandidates(): Promise<MaintenanceCandidate[]>;
  bindLocal(input: {
    selection: string;
    confirmed: true;
    loginName: string;
    password: string;
    displayName?: string;
  }): Promise<{ bound: true }>;
}
export function createAccountService(
  pool: Pool,
  options: AccountServiceOptions = {},
): AccountService {
  const secret = options.secret ?? process.env.BETTER_AUTH_SECRET;
  const origin = options.origin ?? process.env.APP_ORIGIN ?? 'http://localhost:3000';
  const selections = new Map<string, string>();
  async function transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    let client: PoolClient | undefined;
    try {
      if (!secret) throw notReady('authentication unavailable');
      client = await pool.connect();
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(680068, 1)');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      if (client) {
        try {
          await client.query('ROLLBACK');
        } catch {
          /* Commit/connection outcome is unknown; never publish cookies. */
        }
      }
      if (error instanceof HttpError) throw error;
      throw notReady('account dependency unavailable; inspect account status before trying again');
    } finally {
      client?.release();
    }
  }
  async function binding(db: Pool | PoolClient): Promise<BoundAdministrator | null> {
    const { rows } = await db.query<{ userId: string; displayName: string }>(
      `SELECT u.id AS "userId",u.display_name AS "displayName" FROM installation_admin a JOIN users u ON u.id=a.user_id WHERE a.singleton=true`,
    );
    return rows[0] ?? null;
  }
  async function credentials(db: PoolClient, userId: string): Promise<CredentialRow[]> {
    const { rows } = await db.query<CredentialRow>(
      `SELECT id,user_id,account_id,password_hash FROM auth_accounts WHERE user_id=$1 ORDER BY id`,
      [userId],
    );
    return rows;
  }
  async function snapshot(db: PoolClient) {
    const workspace = await (options.workspaceStatus?.() ??
      Promise.resolve(getWorkspaceAccountStatus()));
    if (workspace.state === 'invalid' || workspace.state === 'unreadable')
      throw notReady('workspace registration must be inspected locally');
    const users = (
      await db.query<UserRow>(
        'SELECT id,display_name,status,auth_email FROM users ORDER BY created_at,id',
      )
    ).rows;
    const owners = new Set(workspace.ownerIds);
    for (const projection of [
      conversationOwners,
      approvalOwners,
      taskOwners,
      notificationOwners,
      toolOwners,
    ])
      for (const id of await projection(db)) owners.add(id);
    const userIds = new Set(users.map((user) => user.id));
    if ([...owners].some((id) => !userIds.has(id)))
      throw notReady('orphaned history requires local maintenance');
    return { workspace, users, hasHistory: owners.size > 0 };
  }
  function library(client: PoolClient) {
    const auth = createAuth(pool, { secret, origin, client });
    if (!auth) throw notReady('authentication unavailable');
    return auth;
  }
  async function login(
    client: PoolClient,
    email: string,
    password: string,
  ): Promise<AccountSessionResult> {
    try {
      const result = await library(client).api.signInEmail({
        body: { email, password },
        returnHeaders: true,
      });
      return { cookies: result.headers.getSetCookie() };
    } catch (error) {
      if (error instanceof APIError && error.status === 'UNAUTHORIZED') throw unauthorized();
      throw error;
    }
  }
  async function bind(
    client: PoolClient,
    userId: string,
    loginName: string,
    password: string,
    allowExisting: boolean,
  ) {
    const current = await binding(client);
    if (current)
      throw stateConflict('administrator already bound', { reason: 'ADMIN_ALREADY_BOUND' });
    await snapshot(client);
    const user = (
      await client.query<UserRow>(
        'SELECT id,display_name,status,auth_email FROM users WHERE id=$1 FOR UPDATE',
        [userId],
      )
    ).rows[0];
    if (!user || user.status !== 'active')
      throw stateConflict('local account maintenance required', {
        reason: 'LOCAL_MAINTENANCE_REQUIRED',
      });
    const accounts = await credentials(client, userId);
    if (accounts.length > 1)
      throw stateConflict('credential conflict', { reason: 'CREDENTIAL_CONFLICT' });
    const account = accounts[0];
    if (account && account.account_id !== userId && account.account_id !== `seed:${userId}`)
      throw stateConflict('credential conflict', { reason: 'CREDENTIAL_CONFLICT' });
    const auth = library(client);
    const context = await auth.$context;
    if (account?.password_hash) {
      if (!allowExisting || account.account_id !== userId)
        throw stateConflict('existing password cannot be replaced', {
          reason: 'CREDENTIAL_CONFLICT',
        });
      if (!(await context.password.verify({ hash: account.password_hash, password })))
        throw unauthorized();
    }
    const email = deriveAuthEmail(loginName, secret);
    if (
      (await client.query('SELECT 1 FROM users WHERE auth_email=$1 AND id<>$2', [email, userId]))
        .rowCount
    )
      throw stateConflict('login name unavailable', { reason: 'CREDENTIAL_CONFLICT' });
    if (!account?.password_hash) {
      const hash = await context.password.hash(password);
      if (account)
        await client.query(
          'UPDATE auth_accounts SET account_id=$1,password_hash=$2,updated_at=now() WHERE id=$3',
          [userId, hash, account.id],
        );
      else
        await client.query(
          "INSERT INTO auth_accounts(user_id,provider_id,account_id,password_hash) VALUES($1,'credential',$2,$3)",
          [userId, userId, hash],
        );
    }
    await client.query('UPDATE users SET auth_email=$1,updated_at=now() WHERE id=$2', [
      email,
      userId,
    ]);
    await client.query('INSERT INTO installation_admin(user_id) VALUES($1)', [userId]);
    return email;
  }
  async function initialize(input: { login_name: string; password: string; display_name: string }) {
    const parsed = authInitializeSchema.safeParse(input);
    if (!parsed.success) throw validationError('invalid account fields');
    return transaction(async (client) => {
      if (await binding(client))
        throw stateConflict('initialization closed', { reason: 'INITIALIZATION_CLOSED' });
      const facts = await snapshot(client);
      if (facts.users.length || facts.hasHistory || facts.workspace.state !== 'unconfigured')
        throw stateConflict('initialization closed', { reason: 'INITIALIZATION_CLOSED' });
      const auth = library(client);
      const context = await auth.$context;
      const data = parsed.data;
      const email = deriveAuthEmail(data.login_name, secret);
      const user = await context.adapter.create<{ id: string }>({
        model: 'user',
        data: {
          name: data.display_name,
          email,
          emailVerified: false,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      });
      await context.adapter.create({
        model: 'account',
        data: {
          userId: user.id,
          providerId: 'credential',
          accountId: user.id,
          password: await context.password.hash(data.password),
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      });
      const result = await login(client, email, data.password);
      await client.query('INSERT INTO installation_admin(user_id) VALUES($1)', [user.id]);
      return result;
    });
  }
  return {
    async status(actor) {
      return transaction(async (client) => {
        const admin = await binding(client);
        let state: AuthStatus['state'];
        if (admin) state = 'ready';
        else {
          const facts = await snapshot(client);
          state =
            facts.users.length || facts.hasHistory || facts.workspace.state !== 'unconfigured'
              ? 'legacy_claim_required'
              : 'setup_required';
        }
        const result: AuthStatus = { state };
        if (actor?.sessionId) {
          const user = (
            await client.query<UserRow>('SELECT id,status FROM users WHERE id=$1', [actor.ownerId])
          ).rows[0];
          const accounts = await credentials(client, actor.ownerId);
          result.can_claim =
            !admin &&
            user?.status === 'active' &&
            accounts.length <= 1 &&
            !accounts[0]?.password_hash &&
            (!accounts[0] ||
              accounts[0].account_id === actor.ownerId ||
              accounts[0].account_id === `seed:${actor.ownerId}`);
          result.workspace_state = (
            await (options.workspaceStatus?.() ?? Promise.resolve(getWorkspaceAccountStatus()))
          ).state;
        }
        return result;
      });
    },
    initialize,
    async claim(userId, input) {
      if (input.confirmed !== true) throw validationError('explicit confirmation required');
      const values = authSignInSchema.safeParse({
        login_name: input.login_name,
        password: input.password,
      });
      if (!values.success) throw validationError('invalid account fields');
      return transaction(async (client) => {
        const email = await bind(
          client,
          userId,
          values.data.login_name,
          values.data.password,
          false,
        );
        return login(client, email, values.data.password);
      });
    },
    async signIn(input) {
      const parsed = authSignInSchema.safeParse(input);
      if (!parsed.success) throw validationError('invalid account fields');
      return transaction(async (client) => {
        const admin = await binding(client);
        const email = deriveAuthEmail(parsed.data.login_name, secret);
        const user = (
          await client.query<UserRow>(
            'SELECT id,status,auth_email FROM users WHERE auth_email=$1',
            [email],
          )
        ).rows[0];
        const accounts = user ? await credentials(client, user.id) : [];
        if (
          !admin ||
          !user ||
          user.status !== 'active' ||
          admin.userId !== user.id ||
          accounts.length !== 1 ||
          accounts[0]?.account_id !== user.id ||
          !accounts[0]?.password_hash
        ) {
          const context = await library(client).$context;
          await context.password.hash(parsed.data.password);
          throw unauthorized();
        }
        return login(client, email, parsed.data.password);
      });
    },
    async signOut(sessionId, userId, headers) {
      // Confirm a real PG commit before asking the library to publish clear cookies.
      await transaction(async (client) => {
        const result = await client.query(
          'UPDATE sessions SET revoked_at=COALESCE(revoked_at,now()) WHERE id=$1 AND user_id=$2 RETURNING id',
          [sessionId, userId],
        );
        if (!result.rowCount) throw unauthorized();
      });
      try {
        const auth = createAuth(pool, { secret, origin });
        if (!auth) throw notReady();
        const result = await auth.api.signOut({ headers, returnHeaders: true });
        return { cookies: result.headers.getSetCookie() };
      } catch {
        throw notReady('session revoked; cookie cleanup unavailable');
      }
    },
    async getBoundAdministrator() {
      return transaction((client) => binding(client));
    },
    async listMaintenanceCandidates() {
      return transaction(async (client) => {
        const { users } = await snapshot(client);
        selections.clear();
        const candidates: MaintenanceCandidate[] = [];
        for (const user of users) {
          const accounts = await credentials(client, user.id);
          const selection = randomUUID();
          selections.set(selection, user.id);
          candidates.push({
            selection,
            displayName: user.display_name,
            status: user.status,
            hasPassword: !!accounts[0]?.password_hash,
            eligible:
              user.status === 'active' &&
              accounts.length <= 1 &&
              (!accounts[0] ||
                accounts[0].account_id === user.id ||
                (!accounts[0].password_hash && accounts[0].account_id === `seed:${user.id}`)),
          });
        }
        return candidates;
      });
    },
    async bindLocal(input) {
      if (input.confirmed !== true) throw validationError('explicit confirmation required');
      const userId = selections.get(input.selection);
      if (!userId) throw validationError('select an account from current candidates');
      const values = authSignInSchema.safeParse({
        login_name: input.loginName,
        password: input.password,
      });
      if (!values.success) throw validationError('invalid account fields');
      await transaction((client) =>
        bind(client, userId, values.data.login_name, values.data.password, true),
      );
      selections.clear();
      return { bound: true };
    },
  };
}
