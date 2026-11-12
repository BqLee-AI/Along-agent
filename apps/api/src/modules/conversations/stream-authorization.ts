import type { Pool } from 'pg';
import type { ThreadEvent } from '@along/stream-protocol';
import { withTransaction } from '../../db/transaction.js';
import { forbidden } from '../../http/errors.js';
import { isActiveOwner } from '../identity/preferences.js';
import { lockViewerAccess } from '../identity/stream-access.js';
import type { EventWriter } from './contracts.js';

// The sender holds the same user lock that serializes account deactivation
// until the writer has handed off the event. Already handed-off bytes cannot
// be recalled; a deactivation that commits first prevents new disclosure.
export async function writeAuthorizedEvent(
  pool: Pool,
  ownerId: string,
  write: EventWriter,
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
    return write(event);
  });
}
