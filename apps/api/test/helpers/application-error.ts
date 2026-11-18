import { httpStatusForError } from '@along/contracts';
import { expect } from 'bun:test';
import { ApplicationError } from '../../src/platform/errors.js';

interface ApplicationErrorEvidence {
  status: number;
  code: number;
  errorCode: string;
  details: unknown;
  message: string;
}

export function applicationErrorEvidence(error: unknown): ApplicationErrorEvidence {
  if (!(error instanceof ApplicationError)) throw error;
  return {
    status: httpStatusForError(error.code),
    code: error.code,
    errorCode: error.errorCode,
    details: error.details,
    message: error.message,
  };
}

export async function expectApplicationRejection(
  operation: Promise<unknown>,
  expected: Partial<ApplicationErrorEvidence>,
): Promise<void> {
  const evidence = await operation.then(() => {
    throw new Error('Expected operation to reject with ApplicationError');
  }, applicationErrorEvidence);
  expect(evidence).toMatchObject(expected);
}
