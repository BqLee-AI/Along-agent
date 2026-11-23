export function readOfficeObservationKey(env: NodeJS.ProcessEnv = process.env): Buffer | null {
  const encoded = env.ALONG_OFFICE_OBSERVATION_KEY;
  if (encoded?.length !== 44) return null;
  const key = Buffer.from(encoded, 'base64');
  return key.length === 32 && key.toString('base64') === encoded ? key : null;
}
