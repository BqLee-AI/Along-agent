import type { PoolClient } from 'pg';
import { lockViewerAccess } from '../identity/public.js';

const feishuCallbackPath = '/api/v1/office/feishu/callback';

type Viewer = { ownerId: string; sessionId: string };

type Configuration = { appId: string; redirectUri: string; key: Buffer };

// Historical receipt compatibility only. This does not restore OAuth or use a user token.

export function loadFeishuConfiguration(): Configuration | null {
  const {
    FEISHU_APP_ID: appId,
    FEISHU_REDIRECT_URI: redirectUri,
    FEISHU_CREDENTIAL_KEY: encodedKey,
  } = process.env;
  if (!appId || !redirectUri || !encodedKey) return null;
  const key = Buffer.from(encodedKey, 'base64');
  if (key.length !== 32 || key.toString('base64') !== encodedKey) return null;
  const url = URL.parse(redirectUri);
  if (
    !url ||
    url.pathname !== feishuCallbackPath ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.origin !== (process.env.APP_ORIGIN ?? 'http://localhost:3000') ||
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
  )
    return null;
  return { appId, redirectUri, key };
}

export async function readActiveFeishuConnection(
  client: PoolClient,
  viewer: Viewer,
  app: Configuration,
  expectedId?: string,
) {
  if (!(await lockViewerAccess(client, viewer.ownerId, viewer.sessionId))) return null;
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM feishu_docx_connections
     WHERE owner_id=$1 AND session_id=$2 AND app_id=$3 AND redirect_uri=$4 AND phase='active'
       AND expires_at > clock_timestamp() AND ($5::uuid IS NULL OR id=$5) FOR SHARE`,
    [viewer.ownerId, viewer.sessionId, app.appId, app.redirectUri, expectedId ?? null],
  );
  return rows[0] ?? null;
}
