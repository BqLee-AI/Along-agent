// Identical Number accumulation is used by runtime, calibration and independent evaluation.
// Float32 storage does not imply float32 dot-product accumulation.
export function normalizeVector(vector: ArrayLike<number>): Float64Array {
  if (vector.length !== 512) throw new Error('ENCODING_DIMENSION');
  let norm2 = 0;
  for (let index = 0; index < vector.length; index++) {
    const value = vector[index]!;
    if (!Number.isFinite(value)) throw new Error('ENCODING_NONFINITE');
    norm2 += value * value;
  }
  if (!Number.isFinite(norm2) || norm2 <= 0) throw new Error('ENCODING_ZERO_VECTOR');
  const norm = Math.sqrt(norm2);
  const result = new Float64Array(512);
  for (let index = 0; index < 512; index++) result[index] = vector[index]! / norm;
  return result;
}
