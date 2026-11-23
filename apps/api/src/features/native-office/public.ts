export { readOfficeObservationKey } from './private/observation-key.js';
export {
  assertOfficeInputs,
  assertOfficeSources,
  consumeOfficeAttachments,
  continueOfficeAttachments,
  createOfficeStorage,
  readOfficeAttachment,
  writeOfficeDelivery,
  prepareOfficeAttachments,
} from './storage/public.js';
export type {
  OfficeArtifactWrite,
  OfficeExecution,
  OfficeFrozenInput,
  OfficeRole,
} from './storage/public.js';
export * from './analysis/index.js';
