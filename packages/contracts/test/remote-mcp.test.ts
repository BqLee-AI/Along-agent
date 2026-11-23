import { expect, test } from 'bun:test';
import {
  HarnessToolPayloadSchema,
  LearnDocsSearchPayloadSchema,
  type LearnDocsSearchPayload,
} from '../src/index.js';

const url = 'https://learn.microsoft.com/en-us/azure/';
const item = { title: 'Azure 数据库', url, content: 'Public search excerpt.' };
const payload: LearnDocsSearchPayload = {
  kind: 'learn_docs_search',
  query: 'Azure database backups',
  fetched_at: '2026-11-23T10:20:30.123Z',
  representation: 'search_excerpts',
  items: [item],
};

test('accepts immutable Learn search excerpts and an empty search', () => {
  expect(HarnessToolPayloadSchema.parse(payload)).toEqual(payload);
  expect(LearnDocsSearchPayloadSchema.parse({ ...payload, items: [] }).items).toEqual([]);
  for (const source of ['HTTPS://LEARN.MICROSOFT.COM:0443/?a=b#c', `${url}?name=@azure`]) {
    expect(
      LearnDocsSearchPayloadSchema.parse({ ...payload, items: [{ ...item, url: source }] }),
    ).toEqual({ ...payload, items: [{ ...item, url: source }] });
  }
});

test('round-trips the exact nonblank Learn query up to 500 Unicode code points', () => {
  for (const query of [' \tAzure 数据库，cafe\u0301\u00a0\n', '😀'.repeat(498) + ' \n']) {
    const disclosed = { ...payload, query };
    const decoded = JSON.parse(JSON.stringify(disclosed));
    expect(HarnessToolPayloadSchema.parse(decoded)).toEqual(disclosed);
  }
});

test('rejects wrong kinds, extra fields, invalid queries and invalid UTC timestamps', () => {
  for (const disclosed of [
    { ...payload, kind: 'microsoft_docs_search' },
    { ...payload, representation: 'full_text' },
    { ...payload, endpoint: url },
    { ...payload, items: [{ ...item, full_text: 'extra' }] },
    { ...payload, query: '' },
    { ...payload, query: ' \t\n\u00a0\u3000\ufeff' },
    { ...payload, query: 'x'.repeat(500) + '\n' },
    { ...payload, query: '😀'.repeat(501) },
    { ...payload, query: 'query\uD800' },
    { ...payload, query: '\uDC00query' },
    { ...payload, fetched_at: '2026-02-29T10:20:30.123Z' },
    { ...payload, fetched_at: '2026-11-23T10:20:30Z' },
    { ...payload, fetched_at: '2026-11-23T10:20:30.123+00:00' },
    { ...payload, fetched_at: '2026-11-23T10:20:30.123Z\n' },
  ]) {
    expect(HarnessToolPayloadSchema.safeParse(disclosed).success).toBe(false);
  }
});

test('rejects non-official or ambiguous source authorities', () => {
  for (const source of [
    'http://learn.microsoft.com/',
    'https://learn.microsoft.com.evil.test/',
    'https://learn.microsoft.com@evil.test/',
    'https://user:pass@learn.microsoft.com/',
    'https://@learn.microsoft.com/',
    'https://learn.microsoft.com:444/',
    'https://learn.microsoft.com\\evil.test/',
    'https://learn.micro\tsoft.com/',
  ]) {
    expect(
      LearnDocsSearchPayloadSchema.safeParse({ ...payload, items: [{ ...item, url: source }] })
        .success,
    ).toBe(false);
  }
});

test('counts decoded UTF-8 bytes per field and compact JSON bytes across the result', () => {
  const boundary = {
    title: 'é'.repeat(256),
    url: url + 'é'.repeat(Math.floor((2048 - url.length) / 2)) + 'x'.repeat(url.length % 2),
    content: '😀'.repeat(1024),
  };
  const atFieldLimits = { ...payload, items: [boundary] };
  expect(LearnDocsSearchPayloadSchema.safeParse(atFieldLimits).success).toBe(true);
  for (const field of ['title', 'url', 'content'] as const) {
    expect(
      LearnDocsSearchPayloadSchema.safeParse({
        ...payload,
        items: [{ ...boundary, [field]: boundary[field] + 'x' }],
      }).success,
    ).toBe(false);
  }
  expect(
    LearnDocsSearchPayloadSchema.safeParse({ ...payload, items: Array(11).fill(item) }).success,
  ).toBe(false);
  const items = Array.from({ length: 10 }, (_, i) => ({
    ...boundary,
    content: i === 9 ? '' : '"'.repeat(2100),
  }));
  const total = { ...payload, items };
  items[9]!.content = 'x'.repeat(65536 - Buffer.byteLength(JSON.stringify(total)));
  expect(Buffer.byteLength(JSON.stringify(total))).toBe(65536);
  expect(LearnDocsSearchPayloadSchema.safeParse(total).success).toBe(true);
  items[9]!.content += 'x';
  expect(LearnDocsSearchPayloadSchema.safeParse(total).success).toBe(false);
});
