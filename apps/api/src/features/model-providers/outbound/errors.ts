import { ApplicationError } from '../../../platform/errors.js';
import { OutboundError } from './outbound.js';
export function externalFailure(error: unknown): never {
  if (!(error instanceof OutboundError)) throw error;
  const codes = {
    invalid_endpoint: [400, 'MODEL_ENDPOINT_INVALID'],
    blocked_address: [403, 'MODEL_ENDPOINT_BLOCKED'],
    timeout: [504, 'MODEL_PROVIDER_TIMEOUT'],
    connection: [502, 'MODEL_PROVIDER_CONNECTION'],
    authentication: [502, 'MODEL_PROVIDER_AUTHENTICATION'],
    unsupported: [502, 'MODEL_PROVIDER_UNSUPPORTED'],
    incompatible: [502, 'MODEL_PROVIDER_INCOMPATIBLE'],
  } as const;
  const [status, code] = codes[error.category];
  throw new ApplicationError(status, code, 'model provider request failed');
}
