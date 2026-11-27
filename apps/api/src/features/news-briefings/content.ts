const chinaNewsFeed = 'https://www.chinanews.com.cn/rss/scroll-news.xml';
const cctvSearch = 'https://search.cctv.com/search.php';
const day = 24 * 60 * 60 * 1_000;
const maxResponseBytes = 512 * 1_024;
const maxSummaryLength = 160;

type Section = 'topic' | 'local';
type Source = { name: string; url: string };
type Item = { section: Section; summary: string; sources: Source[] };
type News = { coverage: 'complete' | 'partial' | 'failed'; items: Item[] };
type Article = { title: string; excerpt: string; time: number; source: Source };
type SearchPage = { articles: Article[]; next: boolean };

const entities: Readonly<Record<string, string>> = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  nbsp: ' ',
  quot: '"',
};

function decodeEntities(text: string) {
  return text.replace(
    /&(#x[0-9a-f]{1,6}|#\d{1,7}|amp|apos|gt|lt|nbsp|quot);/gi,
    (entity, key: string) => {
      const lower = key.toLowerCase();
      if (lower[0] !== '#') return entities[lower] ?? entity;
      const code = lower[1] === 'x' ? Number.parseInt(lower.slice(2), 16) : Number(lower.slice(1));
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
        ? String.fromCodePoint(code)
        : '';
    },
  );
}

function plainText(raw: string, limit: number) {
  const text = decodeEntities(raw.slice(0, 4_096).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1'))
    .replace(/<\s*(script|style)\b[^>]*>[\s\S]*?<\/\s*\1\s*>/gi, '')
    .replace(/<[^>]*>/g, '')
    .replace(/(?:https?:\/\/|www\.)[^\s<>「」《》。！？；，,]+/gi, '')
    .replace(/[\p{Bidi_Control}\u200b\ufeff]/gu, '')
    .replace(/[\s\p{Cc}]+/gu, ' ')
    .replace(/ +([。！？；，])/g, '$1')
    .trim();
  return Array.from(text).slice(0, limit).join('');
}

function articleUrl(raw: string, publisher: 'chinanews' | 'cctv') {
  const value = decodeEntities(raw.trim());
  if (value.length > 350 || !/^https?:\/\//i.test(value)) return;
  const url = URL.parse(value);
  if (!url || url.username || url.password || url.port) return;
  if (publisher === 'chinanews') {
    if (
      url.hostname !== 'www.chinanews.com.cn' ||
      !/^\/(?:[a-z]+\/)+\d{4}\/\d{2}-\d{2}\/(?:news)?\d+\.shtml$/.test(url.pathname)
    )
      return;
  } else if (
    !/^[a-z0-9-]+\.cctv\.com$/.test(url.hostname) ||
    !/^\/\d{4}\/\d{2}\/\d{2}\/ARTI[a-zA-Z0-9]+\.shtml$/.test(url.pathname)
  ) {
    return;
  }
  // These publishers identify the article in the path. Tracking and fragments do not change it.
  url.search = '';
  url.hash = '';
  return url.href;
}

function readChinaNews(xml: string): Article[] {
  const channel = /<rss\b[^>]*>\s*<channel\b[^>]*>([\s\S]*?)<\/channel>\s*<\/rss>\s*$/.exec(
    xml,
  )?.[1];
  if (channel === undefined || !/<title>中新网即时新闻<\/title>/.test(channel)) {
    throw new Error('Unrecognized China News feed');
  }
  const articles: Article[] = [];
  let count = 0;
  for (const [, item = ''] of channel.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    if (++count > 60) throw new Error('Unexpected size of China News feed');
    const title = plainText(/<title>([\s\S]*?)<\/title>/.exec(item)?.[1] ?? '', 220);
    const excerpt = plainText(/<description>([\s\S]*?)<\/description>/.exec(item)?.[1] ?? '', 450);
    const time = Date.parse(/<pubDate>([^<]+)<\/pubDate>/.exec(item)?.[1] ?? '');
    const url = articleUrl(/<link>([^<]+)<\/link>/.exec(item)?.[1] ?? '', 'chinanews');
    if (url && title && Number.isFinite(time))
      articles.push({ title, excerpt, time, source: { name: '中国新闻网', url } });
  }
  return articles;
}

function cctvUrl(term: string, page: number) {
  const url = new URL(cctvSearch);
  url.search = new URLSearchParams({
    qtext: term,
    page: String(page),
    type: 'web',
    sort: 'date',
    datepid: '1',
    channel: '',
    vtime: '-1',
    is_search: '1',
  }).toString();
  return url;
}

// The website exposes dated article results. Its ifsearch.php endpoint returns video results.
function readCctv(html: string): SearchPage {
  if (!/<\/html>\s*$/i.test(html)) throw new Error('Incomplete CCTV search response');
  const rows = html.split(/<a\s+id="web_content_\d+"\s/).slice(1);
  if (rows.length > 20) throw new Error('Unexpected size of CCTV search page');
  if (!rows.length && !/<h3 class="tit">抱歉，没有找到[^<]*相关网页结果<\/h3>/.test(html)) {
    throw new Error('Unrecognized CCTV search response');
  }
  const articles: Article[] = [];
  for (const row of rows) {
    const end = row.indexOf('</li>');
    const body = row.slice(0, end === -1 ? 6_000 : Math.min(end, 6_000));
    const anchor = /^\s*href="([^"<>]{1,2000})"[^>]*>([\s\S]*?)<\/a>/.exec(body);
    if (!anchor?.[1]?.startsWith('link_p.php?')) continue;
    const link = new URLSearchParams(decodeEntities(anchor[1].slice('link_p.php?'.length))).get(
      'targetpage',
    );
    const url = link && articleUrl(link, 'cctv');
    const title = plainText(anchor[2] ?? '', 220);
    const excerpt = plainText(/<p class="bre">([\s\S]*?)<\/p>/.exec(body)?.[1] ?? '', 450);
    const stamp = /<span class="tim">\s*发布时间[：:]\s*(\d{4}-\d\d-\d\d)\s+(\d\d:\d\d:\d\d)/.exec(
      body,
    );
    const time = stamp ? Date.parse(`${stamp[1]}T${stamp[2]}+08:00`) : NaN;
    if (url && title && Number.isFinite(time))
      articles.push({ title, excerpt, time, source: { name: '央视网', url } });
  }
  return { articles, next: rows.length >= 10 };
}

async function fetchText(fetcher: typeof fetch, url: string | URL, signal: AbortSignal) {
  const response = await fetcher(url, { redirect: 'error', credentials: 'omit', signal });
  if (
    !response.ok ||
    !response.body ||
    Number(response.headers.get('content-length')) > maxResponseBytes
  ) {
    await response.body?.cancel();
    throw new Error('News source request failed');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let size = 0;
  let text = '';
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return text + decoder.decode();
      size += chunk.value.byteLength;
      if (size > maxResponseBytes) throw new Error('News source response exceeded byte limit');
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

function preference(value: string) {
  return value
    .slice(0, 80)
    .normalize('NFKC')
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .trim()
    .slice(0, 80);
}

function matchKey(text: string) {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function mentions(text: string, term: string) {
  if (!term) return false;
  // ASCII acronyms such as AI must not match inside ordinary words.
  if (/^[a-z0-9]+$/i.test(term))
    return new RegExp(`(?:^|[^a-z0-9])${term}(?![a-z0-9])`, 'i').test(text);
  return matchKey(text).includes(term);
}

function headlineKey(title: string) {
  return matchKey(
    title
      .replace(
        /^(?:(?:【[^】]{1,10}】|（[^）]{1,10}）|(?:央视网|央视新闻|中国新闻网|中新网|新华社|新华网|人民日报|快讯|最新消息|最新)\s*[：:丨|])\s*)+/,
        '',
      )
      .replace(
        /\s*[丨|｜—-]\s*(?:央视网|央视新闻|中国新闻网|中新网|新华社|新华网|人民日报)\s*$/,
        '',
      ),
  );
}

function bigrams(text: string) {
  const result = new Set<string>();
  for (let i = 1; i < text.length; i++) result.add(text.slice(i - 1, i + 1));
  return result;
}

function sameHeadline(a: string, b: string, aPairs: Set<string>, bPairs: Set<string>) {
  if (a === b) return true;
  if (Math.min(a.length, b.length) < 10) return false;
  if (
    Math.min(a.length, b.length) >= 0.72 * Math.max(a.length, b.length) &&
    (a.includes(b) || b.includes(a))
  )
    return true;
  let overlap = 0;
  for (const pair of aPairs) if (bPairs.has(pair)) overlap++;
  return 2 * overlap >= 0.84 * (aPairs.size + bPairs.size);
}

function summarize({ title, excerpt }: Article) {
  const lead = excerpt.split(/(?<=[。！？!?])/u, 1)[0]?.trim();
  const text =
    lead && !matchKey(lead).includes(matchKey(title))
      ? `${title}${/[。！？!?]$/.test(title) ? '' : '。'}${lead}`
      : lead || title;
  const characters = Array.from(text);
  return characters.length > maxSummaryLength
    ? `${characters.slice(0, maxSummaryLength - 1).join('')}…`
    : text;
}

export async function collectNews(
  input: { topics: string[]; region: string | null; cutoff: Date },
  fetcher: typeof fetch = fetch,
): Promise<News> {
  const cutoff = input.cutoff.getTime();
  if (!Number.isFinite(cutoff)) return { coverage: 'failed', items: [] };
  const start = cutoff - day;
  const topics = [...new Set(input.topics.slice(0, 12).map(preference).filter(matchKey))];
  const region = preference(input.region ?? '').replace(/(?<=\p{Script=Han}{2})[市省]$/u, '');
  const regionKey = matchKey(region);
  const topicKeys = new Set(topics.map(matchKey));
  if (topicKeys.has('ai') || topicKeys.has('人工智能')) {
    topicKeys.add('ai');
    topicKeys.add('人工智能');
  }
  const searchTopics = topics.map((term) => (matchKey(term) === 'ai' ? '人工智能' : term));
  const terms = [...new Set([...searchTopics, ...(regionKey ? [region] : [])])];
  if (!terms.length) return { coverage: 'complete', items: [] };

  const signal = AbortSignal.timeout(15_000);
  const articles: Article[] = [];
  let completed = 0;
  let incomplete = false;
  const rss = (async () => {
    try {
      articles.push(...readChinaNews(await fetchText(fetcher, chinaNewsFeed, signal)));
      completed++;
    } catch {
      incomplete = true;
    }
  })();
  async function search(term: string) {
    try {
      for (let page = 1; page <= 3; page++) {
        const found = readCctv(await fetchText(fetcher, cctvUrl(term, page), signal));
        articles.push(...found.articles);
        if (page === 1) completed++;
        if (!found.next || found.articles.some(({ time }) => time < start)) return;
      }
    } catch {
      // Earlier pages remain useful when a later page fails.
    }
    incomplete = true;
  }
  for (let index = 0; index < terms.length && !signal.aborted; index += 4) {
    await Promise.all(terms.slice(index, index + 4).map(search));
  }
  await rss;
  const coverage =
    completed === 0
      ? 'failed'
      : incomplete || completed < terms.length + 1
        ? 'partial'
        : 'complete';

  const groups: { key: string; pairs: Set<string>; item: Item }[] = [];
  const byUrl = new Map<string, Item>();
  const topicTerms = [...topicKeys];
  articles.sort((a, b) => b.time - a.time || a.source.url.localeCompare(b.source.url));
  for (const article of articles) {
    if (article.time < start || article.time >= cutoff) continue;
    const { title, excerpt, source } = article;
    const local = mentions(title, regionKey);
    const topic = topicTerms.some((term) => mentions(title, term) || mentions(excerpt, term));
    if (!local && !topic) continue;
    // Use the publisher path to deduplicate HTTP and HTTPS references without rewriting their URLs.
    const urlKey = source.url.replace(/^https?:/, '');
    const duplicate = byUrl.get(urlKey);
    if (duplicate) {
      if (local) duplicate.section = 'local';
      continue;
    }
    const key = headlineKey(title);
    if (!key) continue;
    const pairs = bigrams(key);
    let item = groups.find((group) => sameHeadline(key, group.key, pairs, group.pairs))?.item;
    if (!item) {
      item = { section: local ? 'local' : 'topic', summary: summarize(article), sources: [] };
      groups.push({ key, pairs, item });
    }
    byUrl.set(urlKey, item);
    if (local) item.section = 'local';
    if (item.sources.length < 3) item.sources.push(source);
  }
  const topicItems: Item[] = [];
  const localItems: Item[] = [];
  for (const { item } of groups) {
    const section = item.section === 'topic' ? topicItems : localItems;
    if (section.length < 3) section.push(item);
  }
  return { coverage, items: [...topicItems, ...localItems] };
}
