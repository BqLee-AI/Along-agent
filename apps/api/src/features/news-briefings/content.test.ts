import { expect, test } from 'bun:test';
import { collectNews } from './content.js';

const cutoff = new Date('2026-11-27T00:00:00Z');
const latest = 'Fri, 27 Nov 2026 07:30:00 +0800';
const chinaLink = 'https://www.chinanews.com.cn/cj/2026/11-27/123456.shtml';
const cctvLink = 'https://local.cctv.com/2026/11/27/ARTITest123.shtml';
const emptySearch = '<html><h3 class="tit">抱歉，没有找到“关注词”的相关网页结果</h3></html>';

function rss(...items: string[]) {
  return `<rss version="2.0"><channel><title>中新网即时新闻</title>${items.join('')}</channel></rss>`;
}

function entry(title: string, excerpt: string, url = chinaLink, time = latest) {
  return `<item><title>${title}</title><description>${excerpt}</description><link>${url}</link><pubDate>${time}</pubDate></item>`;
}

function cctvExcerpt(title: string, excerpt: string, date: string, url: string, index = 0) {
  return `<li><a  id="web_content_${index}" href="link_p.php?targetpage=${encodeURIComponent(url)}&point=web_normal">${title}</a>
    <p class="bre">${excerpt}</p><span class="tim">发布时间：${date}</span></li>`;
}

function responses(serve: (url: URL, init?: RequestInit) => Response | Promise<Response>) {
  return (async (request, init) => serve(new URL(String(request)), init)) as typeof fetch;
}

test('uses only fixed feeds and a publisher search, filtering the cutoff and retaining original citations for one syndicated story', async () => {
  const requested = new Set<string>();
  const result = await collectNews(
    { topics: ['ＡＩ'], region: '杭州市', cutoff },
    responses((url, init) => {
      expect(init).toMatchObject({ redirect: 'error', credentials: 'omit' });
      requested.add(url.href);
      if (url.hostname === 'www.chinanews.com.cn')
        return new Response(
          rss(
            entry(
              '中新网：杭州发布人工智能产业三年行动计划！',
              '<![CDATA[<b>杭州公布三年计划。</b> 后续安排另行公布。]]>',
              `${chinaLink}?from=feed#top`,
            ),
            entry('杭州发布人工智能产业三年行动计划', '重复稿件。', chinaLink),
            entry(
              '人工智能研究团队公布新成果',
              '新成果发表于最新一期刊物。',
              'https://www.chinanews.com.cn/cj/2026/11-26/123457.shtml',
              'Thu, 26 Nov 2026 08:00:00 +0800',
            ),
            entry(
              '杭州发布人工智能项目征集公告',
              '截稿后报道。',
              'https://www.chinanews.com.cn/cj/2026/11-27/123458.shtml',
              'Fri, 27 Nov 2026 08:00:00 +0800',
            ),
            entry(
              '杭州人工智能产业举办创新大会',
              '旧稿。',
              'https://www.chinanews.com.cn/cj/2026/11-26/123459.shtml',
              'Thu, 26 Nov 2026 07:59:59 +0800',
            ),
            entry(
              '人工智能实验室完成新项目',
              '恶意链接。',
              'https://www.chinanews.com.cn@127.0.0.1/cj/2026/11-27/123456.shtml',
            ),
            entry(
              'Rail infrastructure news',
              'Unrelated transport report.',
              'https://www.chinanews.com.cn/cj/2026/11-27/123460.shtml',
            ),
          ),
        );
      expect(url.origin + url.pathname).toBe('https://search.cctv.com/search.php');
      if (url.searchParams.get('qtext') !== '杭州') return new Response(emptySearch);
      return new Response(`<html>${cctvExcerpt('杭州发布人工智能产业三年行动计划，推动产业发展', '<font>杭州</font>公布新一轮行动计划。', '2026-11-27 07:20:00', cctvLink)}
      ${cctvExcerpt('外地博物馆发布考古研究', '报道提到一位杭州人，并非杭州本地事件。', '2026-11-27 07:05:00', 'https://news.cctv.com/2026/11/27/ARTIOther123.shtml')}</html>`);
    }),
  );
  expect(requested.size).toBe(3);
  expect(result.coverage).toBe('complete');
  expect(result.items.map(({ section }) => section)).toEqual(['topic', 'local']);
  expect(result.items[1]?.summary).toContain('杭州公布三年计划。');
  expect(result.items[1]?.sources).toEqual([
    { name: '中国新闻网', url: chinaLink },
    { name: '央视网', url: cctvLink },
  ]);
});

test('distinguishes a valid empty search from malformed, redirected, oversized, and unavailable sources', async () => {
  const input = { topics: [], region: '杭州', cutoff };
  expect(
    await collectNews(
      input,
      responses((url) => new Response(url.hostname === 'search.cctv.com' ? emptySearch : rss())),
    ),
  ).toEqual({ coverage: 'complete', items: [] });
  const oversized = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(512 * 1024 + 1));
        controller.close();
      },
    }),
  );
  expect(
    await collectNews(
      input,
      responses((url) => (url.hostname === 'search.cctv.com' ? oversized : new Response(rss()))),
    ),
  ).toEqual({ coverage: 'partial', items: [] });
  expect(
    await collectNews(
      input,
      responses((url) =>
        url.hostname === 'search.cctv.com'
          ? new Response('<html>Access denied</html>')
          : Response.redirect('https://example.com/other-feed'),
      ),
    ),
  ).toEqual({ coverage: 'failed', items: [] });
  expect(
    await collectNews(
      input,
      responses(() => {
        throw new Error('upstream unreachable');
      }),
    ),
  ).toEqual({ coverage: 'failed', items: [] });
});

test('bounds preference queries, keeps unexpected text in the query parameter and removes unsafe excerpt links', async () => {
  const requests: URL[] = [];
  const topics = [
    'AI &page=99&url=https://example.com/ignored',
    ...Array.from({ length: 20 }, (_, index) => `主题${index}`),
  ];
  const result = await collectNews(
    { topics, region: '杭州'.repeat(80), cutoff },
    responses((url) => {
      requests.push(url);
      return new Response(url.hostname === 'search.cctv.com' ? emptySearch : rss());
    }),
  );
  expect(result).toEqual({ coverage: 'complete', items: [] });
  expect(requests).toHaveLength(14);
  expect(
    requests
      .filter((url) => url.hostname === 'search.cctv.com')
      .every(
        (url) =>
          url.searchParams.get('page') === '1' &&
          !url.searchParams.has('url') &&
          (url.searchParams.get('qtext')?.length ?? 0) <= 80,
      ),
  ).toBe(true);
  expect(requests.some((url) => url.searchParams.get('qtext') === topics[0])).toBe(true);

  const output = await collectNews(
    { topics: ['人工智能'], region: null, cutoff },
    responses(
      (url) =>
        new Response(
          url.hostname === 'search.cctv.com'
            ? emptySearch
            : rss(
                entry(
                  '人工智能发布会',
                  '研究人员公布新成果 https://example.com/injected。&lt;script&gt;插入内容&lt;/script&gt;',
                ),
              ),
        ),
    ),
  );
  expect(output.items).toEqual([
    {
      section: 'topic',
      summary: '人工智能发布会。研究人员公布新成果。',
      sources: [{ name: '中国新闻网', url: chinaLink }],
    },
  ]);
});

test('keeps stories from a successful search page when a later page fails', async () => {
  const pages: string[] = [];
  const result = await collectNews(
    { topics: [], region: '杭州', cutoff },
    responses((url) => {
      if (url.hostname === 'www.chinanews.com.cn') return new Response(rss());
      const page = url.searchParams.get('page')!;
      pages.push(page);
      if (page !== '1') return new Response(null, { status: 503 });
      const rows = Array.from({ length: 10 }, (_, index) =>
        cctvExcerpt(
          index === 0 ? '杭州新增社区图书馆' : `其他城市报道${index}`,
          '新闻正文。',
          '2026-11-27 07:30:00',
          `https://local.cctv.com/2026/11/27/ARTITest${index}.shtml`,
          index,
        ),
      );
      return new Response(`<html>${rows.join('')}</html>`);
    }),
  );
  expect(pages).toEqual(['1', '2']);
  expect(result).toEqual({
    coverage: 'partial',
    items: [
      {
        section: 'local',
        summary: '杭州新增社区图书馆。新闻正文。',
        sources: [{ name: '央视网', url: 'https://local.cctv.com/2026/11/27/ARTITest0.shtml' }],
      },
    ],
  });
});
