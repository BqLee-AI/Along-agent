import { expect, it } from 'bun:test';
import {
  createSkill,
  disableSkill,
  previewSkillImport,
  readSkill,
  readSkills,
  skillFieldErrors,
  updateSkill,
} from '../src/features/skills/model/skill';
import { createBrowserApi } from '../src/shared/http/eden';

const id = '11111111-1111-4111-8111-111111111111';
const key = '22222222-2222-4222-8222-222222222222';
const input = {
  name: 'weekly-report',
  description: 'Organize this week’s notes',
  body: 'Use conclusions and evidence.',
};
const metadata = {
  id,
  name: input.name,
  description: input.description,
  revision: 1,
  disabled_at: null,
};
const detail = { ...metadata, body: input.body };
const me = { user: { id, display_name: 'Owner' }, csrf_token: 'csrf', confirmed_timezone: null };
const ok = (data: unknown) => Response.json({ code: 0, data, msg: 'ok', request_id: 'web-skill' });
const failure = (status: number, code: string, details: unknown) =>
  Response.json(
    {
      code: status,
      msg: 'rejected',
      request_id: 'web-skill',
      error: { code, message: 'rejected', request_id: 'web-skill', details },
    },
    { status },
  );

it('previews the original file bytes without saving, and creates only the confirmed text fields with a key', async () => {
  const calls: string[] = [];
  const client = createBrowserApi(async (request, init) => {
    calls.push(`${init?.method} ${request}`);
    if (request === '/api/v1/me') return ok(me);
    if (request !== '/api/v1/skills' || init?.method !== 'POST')
      throw new Error('unexpected request');
    const headers = new Headers(init.headers);
    expect(headers.get('x-csrf-token')).toBe('csrf');
    expect(headers.get('idempotency-key')).toBe(key);
    expect(JSON.parse(String(init.body))).toEqual(input);
    return ok(detail);
  });
  const raw = new Uint8Array([239, 187, 191, 45, 45, 45]); // Preserve a UTF-8 BOM.
  const preview = (async (request, init) => {
    calls.push(`${init?.method} ${request}`);
    const headers = new Headers(init?.headers);
    expect(headers.get('x-csrf-token')).toBe('csrf');
    expect(headers.get('content-type')).toBe('text/markdown');
    expect(headers.get('idempotency-key')).toBeNull();
    const body = init?.body;
    if (!(body instanceof Blob)) throw new Error('preview did not send a Blob');
    expect(new Uint8Array(await body.arrayBuffer())).toEqual(raw);
    return ok({ ...input, extras: { 'allowed-tools': 'workspace_write' } });
  }) as typeof fetch;
  const signal = new AbortController().signal;
  const { extras, ...reviewed } = await previewSkillImport(
    new Blob([raw]),
    signal,
    client,
    preview,
  );
  expect(extras).toEqual({ 'allowed-tools': 'workspace_write' });
  expect(calls).toEqual(['GET /api/v1/me', 'POST /api/v1/skills/actions/preview-import']);
  await expect(createSkill(reviewed, key, signal, client)).resolves.toEqual(detail);
  expect(calls).toEqual([
    'GET /api/v1/me',
    'POST /api/v1/skills/actions/preview-import',
    'GET /api/v1/me',
    'POST /api/v1/skills',
  ]);
});

it('reads the skill cursor and detail, surfaces field errors, and submits the exact seen revision', async () => {
  const cursor = '+opaque/=';
  const disabledAt = '2026-11-26T12:00:00.000Z';
  const client = createBrowserApi(async (request, init) => {
    const url = new URL(String(request), 'http://web.test');
    if (url.pathname === '/api/v1/me') return ok(me);
    if (url.pathname === '/api/v1/skills') {
      expect(url.searchParams.get('cursor')).toBe(cursor);
      return ok({ items: [metadata], next_cursor: null });
    }
    if (url.pathname === `/api/v1/skills/${id}`) {
      if (init?.method === 'GET') return ok(detail);
      expect(init?.method).toBe('PATCH');
      const patch = JSON.parse(String(init?.body));
      expect(patch).toEqual({ ...input, body: patch.body, expected_revision: 1 });
      if (!patch.body)
        return failure(422, 'VALIDATION_ERROR', { fields: { body: 'Body is required' } });
      return failure(409, 'STATE_CONFLICT', {
        reason: 'SKILL_REVISION_CHANGED',
        current_revision: 2,
      });
    }
    if (url.pathname === `/api/v1/skills/${id}/actions/disable`) {
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toEqual({ expected_revision: 2 });
      expect(new Headers(init?.headers).get('x-csrf-token')).toBe('csrf');
      return ok({ ...detail, revision: 2, disabled_at: disabledAt });
    }
    throw new Error(`unexpected request: ${url}`);
  });
  const signal = new AbortController().signal;
  const page = await readSkills(cursor, signal, client);
  expect(page).toEqual({ items: [metadata], nextCursor: null });
  await expect(readSkill(id, signal, client)).resolves.toEqual(detail);
  await expect(
    updateSkill(id, 1, { ...input, body: '' }, signal, client).catch(skillFieldErrors),
  ).resolves.toEqual({ body: 'Body is required' });
  await expect(updateSkill(id, 1, input, signal, client)).rejects.toMatchObject({
    status: 409,
    details: { current_revision: 2 },
  });
  await expect(disableSkill(id, 2, signal, client)).resolves.toMatchObject({
    revision: 2,
    disabled_at: disabledAt,
  });
});
