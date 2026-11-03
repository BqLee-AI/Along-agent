import { randomBytes } from 'node:crypto';
import {
  parseIdentityKeyring,
  type IdentityKeyring,
} from '../../src/modules/identity/email-security.js';

export function identityKeyfileFixture() {
  return {
    version: 1,
    lookup: { id: 'lookup1', key: randomBytes(32).toString('base64') },
    challenge: { active: 'challenge1', keys: { challenge1: randomBytes(32).toString('base64') } },
    encryption: {
      active: 'encryption1',
      keys: { encryption1: randomBytes(32).toString('base64') },
    },
    rateLimit: { id: 'rate1', key: randomBytes(32).toString('base64') },
  };
}
export function identityKeysFixture(): IdentityKeyring {
  return parseIdentityKeyring(identityKeyfileFixture());
}
