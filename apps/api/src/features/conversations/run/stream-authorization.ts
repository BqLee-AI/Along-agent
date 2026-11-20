import type { Pool } from 'pg';
import type { ThreadEvent } from '@along/stream-protocol';
import { withTransaction } from '../../../db/transaction.js';
import { forbidden } from '../../../platform/errors.js';
import { isActiveOwner, lockViewerAccess } from '../../identity/public.js';
import { privateDisclosureAccess, releasePrivateDisclosure } from './private-disclosure.js';

// The sender holds the same user lock that serializes account deactivation
// until the writer has handed off the event. Already handed-off bytes cannot
// be recalled; a deactivation that commits first prevents new disclosure.
export async function writeAuthorizedEvent(
  pool: Pool,
  ownerId: string,
  write: (event: ThreadEvent) => Promise<boolean>,
  event: ThreadEvent,
  sessionId?: string | null,
): Promise<boolean> {
  return withTransaction(pool, async (client) => {
    if (sessionId === undefined) {
      if (!(await isActiveOwner(client, ownerId, { lock: 'share' })))
        throw forbidden('owner authorization revoked');
    } else if (!(await lockViewerAccess(client, ownerId, sessionId))) {
      throw forbidden('session authorization revoked');
    }
    if (sessionId) {
      const access = await privateDisclosureAccess(client, ownerId, sessionId, event);
      if (access === 'withhold') return true;
      if (access === 'allowed') {
        const open = await write(event);
        if (open) await releasePrivateDisclosure(client, event);
        return open;
      }
    }
    return write(event);
  });
}
