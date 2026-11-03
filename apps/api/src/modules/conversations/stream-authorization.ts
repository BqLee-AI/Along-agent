import type { Pool } from 'pg';
import type { ThreadEvent } from '@along/stream-protocol';
import { withTransaction } from '../../db/transaction.js';
import { forbidden } from '../../http/errors.js';
import { isActiveOwner } from '../identity/preferences.js';
import type { EventWriter } from './contracts.js';

// The sender holds the same user lock that serializes account deactivation
// until the writer has handed off the event. Already handed-off bytes cannot
// be recalled; a deactivation that commits first prevents new disclosure.
export async function writeAuthorizedEvent(
  pool: Pool,
  ownerId: string,
  write: EventWriter,
  event: ThreadEvent,
): Promise<boolean> {
  return withTransaction(pool, async (client) => {
    if (!(await isActiveOwner(client, ownerId, { lock: 'share' })))
      throw forbidden('owner authorization revoked');
    return write(event);
  });
}
