import {
  SKILL_FILE_MAX_BYTES,
  SkillImportPreviewSchema,
  type SkillImportPreview,
} from '@along/contracts';
import { parseDocument } from 'yaml';
import type { z } from 'zod';
import { ApplicationError } from '../../platform/errors.js';

export function invalidSkill(message: string, issues?: z.ZodIssue[]) {
  const fields: Record<string, string> = Object.create(null);
  for (const issue of issues ?? []) {
    const path = issue.path.join('.');
    if (path) fields[path] ??= issue.message;
  }
  return new ApplicationError(422, 'VALIDATION_ERROR', message, { fields });
}

export function parseSkillFields<S extends z.ZodTypeAny>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) throw invalidSkill('invalid skill fields', result.error.issues);
  return result.data;
}

export async function readSkillFile(request: Request): Promise<string> {
  if (Number(request.headers.get('content-length')) > SKILL_FILE_MAX_BYTES)
    throw invalidSkill('SKILL.md must be at most 64 KiB');
  if (!request.body) throw invalidSkill('SKILL.md is required');
  const reader = request.body.getReader();
  // Keep the BOM until parsing so create can compare the raw file content on replay.
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  let bytes = 0;
  let content = '';
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > SKILL_FILE_MAX_BYTES) throw invalidSkill('SKILL.md must be at most 64 KiB');
      content += decoder.decode(chunk.value, { stream: true });
    }
    content += decoder.decode();
    if (!content) throw invalidSkill('SKILL.md is required');
    return content;
  } catch (error) {
    if (error instanceof ApplicationError) throw error;
    throw invalidSkill('SKILL.md must be valid UTF-8');
  } finally {
    reader.releaseLock();
  }
}

export function parseSkillFile(content: string): SkillImportPreview {
  const opening = /^\uFEFF?---[ \t]*\r?\n/.exec(content);
  if (!opening) throw invalidSkill('SKILL.md must start with YAML frontmatter');
  const close = /^---[ \t]*(?:\r?\n|$)/gm;
  close.lastIndex = opening[0].length;
  const closing = close.exec(content);
  if (!closing) throw invalidSkill('SKILL.md frontmatter is not closed');
  let value: unknown;
  try {
    const doc = parseDocument(content.slice(opening[0].length, closing.index), {
      schema: 'core',
      uniqueKeys: true,
    });
    if (doc.errors.length || doc.warnings.length) throw new Error('invalid YAML');
    value = doc.toJS({ maxAliasCount: 0, mapAsMap: true });
  } catch {
    throw invalidSkill('SKILL.md frontmatter must be valid YAML without duplicate keys or aliases');
  }
  if (!(value instanceof Map) || [...value.keys()].some((key) => typeof key !== 'string'))
    throw invalidSkill('SKILL.md frontmatter must be a mapping with text keys');
  const extras: Record<string, unknown> = {};
  for (const key of ['license', 'compatibility', 'metadata', 'allowed-tools']) {
    if (value.has(key)) extras[key] = value.get(key);
  }
  if (extras.metadata instanceof Map) {
    if ([...extras.metadata.keys()].some((key) => typeof key !== 'string'))
      throw invalidSkill('SKILL.md metadata keys must be text');
    extras.metadata = Object.fromEntries(extras.metadata);
  }
  return parseSkillFields(SkillImportPreviewSchema, {
    name: value.get('name'),
    description: value.get('description'),
    body: content.slice(closing.index + closing[0].length),
    extras,
  });
}
