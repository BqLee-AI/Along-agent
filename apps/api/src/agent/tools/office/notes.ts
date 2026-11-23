import { stateConflict } from '../../../platform/errors.js';
import { OfficeReadNotesResultSchema } from '@along/contracts';
import type { OfficeFrozenInput } from '../../../features/native-office/public.js';

export type OfficeWireSource = { display_name: string; version: string };

export function officeSource(input: OfficeFrozenInput): OfficeWireSource {
  // The wire has a UTF-8 byte budget smaller than some accepted filenames.
  // Preserve a scalar-aligned display prefix, without changing the version.
  let display = input.filename;
  if (Buffer.byteLength(display) > 512) {
    const bytes = Buffer.from(display);
    let end = 509;
    while ((bytes[end]! & 0xc0) === 0x80) end--;
    display = `${bytes.toString('utf8', 0, end)}…`;
  }
  return { display_name: display, version: input.sha256 };
}

export function pageOfficeNotes(input: OfficeFrozenInput & { bytes: Buffer }, offset: number) {
  const { bytes } = input;
  const splitsScalarOrCrLf = (position: number) =>
    position < bytes.length &&
    ((bytes[position]! & 0xc0) === 0x80 ||
      (bytes[position] === 0x0a && position > 0 && bytes[position - 1] === 0x0d));
  if (
    !Number.isInteger(offset) ||
    offset < 0 ||
    offset >= bytes.length ||
    splitsScalarOrCrLf(offset)
  )
    throw stateConflict('invalid office notes offset');
  let end = Math.min(offset + 4096, bytes.length);
  while (splitsScalarOrCrLf(end)) end--;

  // A line delimiter belongs to the line it terminates. CRLF counts once;
  // a final delimiter does not create a phantom empty source line.
  let startLine = 1;
  let endLine = 1;
  let totalLines = 1;
  for (let index = 0; index < bytes.length - 1; index++) {
    if (bytes[index] !== 0x0a && (bytes[index] !== 0x0d || bytes[index + 1] === 0x0a)) continue;
    if (index < offset) startLine++;
    if (index < end - 1) endLine++;
    totalLines++;
  }
  return OfficeReadNotesResultSchema.parse({
    kind: 'office_read_notes',
    source: officeSource(input),
    offset,
    start_line: startLine,
    end_line: endLine,
    total_lines: totalLines,
    content: bytes.toString('utf8', offset, end),
    next_offset: end < bytes.length ? end : null,
  });
}
