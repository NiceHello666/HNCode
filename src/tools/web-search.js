// WebSearch tool — Tavily's keyless search endpoint.
//
// WHY NOT THE PREVIOUS BACKEND
// ----------------------------
// puri.li/api/search answered, but it is a small crawler index, not a search engine: every hit reported
// `source: "crawled"`. Measured, `GitHub Actions` returned 677 documents and answered well, while
// `doutula 表情包` returned 6 — none about doutula — because that site is not in the index at all. A query
// with no real match still returned a full page of the documents that merely shared a word with it, and
// those were directory farms and unrelated pages.
//
// Tavily's keyless mode answers the same query with fabiaoqing.com, github.com/sunimp/doutula and
// huaban.com — pages that are actually about the site. That is the difference worth the change.
//
// WHY NOT A SCRAPED SEARCH PAGE
// -----------------------------
// This started as a Bing HTML scraper. It worked until the page still returned 200 with the query echoed
// in `<title>` but contained no results — the two or three `b_algo` blocks it did have were
// `translate.google.cn` and similar chrome. A scraper that returns junk does not look broken to the model:
// the results arrive in the normal shape, so they get used and cited.

const ENDPOINT = 'https://api.tavily.com/search';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

/**
 * How much of a result's text is worth showing.
 *
 * The API returns the page's opening text — often several hundred characters of navigation and boilerplate
 * before anything useful. Eight results of that size spend a few thousand tokens of context on text the
 * model reads once and discards. A couple of sentences are enough to judge whether the page is about the
 * query, and that judgement is the only thing the snippet is for.
 */
const SNIPPET_MAX = 200;

/**
 * A result's text, shortened and stripped of decoding damage.
 *
 * "MOJIBAKE" is upstream: a page served as UTF-8 and decoded as Latin-1 comes back with its smart quotes
 * as `鈥` and its Chinese as `鍦熻眴`. That is the crawler's bug, not this tool's, but the damage ends up in
 * the model's context, where it looks like the page is about something else. Any snippet carrying this
 * much of it is dropped rather than shown, because a result whose text cannot be read is not a result.
 */
function cleanSnippet(raw) {
  const text = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim();
  // A run of two or more of these characters is the signature of a UTF-8 page read as Latin-1. One could
  // be a legitimate transliteration; a run cannot.
  const damaged = (text.match(/[\u00c0-\u00ff]{2,}/g) || []).length;
  if (damaged >= 3) return '';
  return text.length > SNIPPET_MAX ? text.slice(0, SNIPPET_MAX - 1).trimEnd() + '…' : text;
}

/**
 * The API's payload, as a list of results.
 *
 * Tolerant on purpose: this is a third-party service with no published schema, so a missing or renamed
 * field must degrade to "fewer results" rather than throw. An entry without a URL is dropped, because a
 * result the model cannot open is not usable.
 */
export function parseSearchResults(json, limit = 8) {
  const list = json && Array.isArray(json.results) ? json.results : [];
  const out = [];
  for (const r of list) {
    if (!r || typeof r.url !== 'string' || !r.url) continue;
    const snippet = cleanSnippet(r.content || r.description || r.snippet || '');
    // A result whose text cannot be read is not a result: the model has nothing to judge it by.
    if (!snippet && r.content) continue;
    out.push({
      title: cleanSnippet(String(r.title || r.url)) || r.url,
      url: r.url,
      snippet,
    });
    if (out.length >= limit) break;
  }
  return out;
}

export const spec = {
  name: 'WebSearch',
  description: [
    'Search the web. Results are title/URL/snippet; snippets are summaries, so fetch a promising URL with',
    'FetchURL. Cite sources.',
    '',
    'Use FEW words: two or three that name the thing. Adding generic terms ("下载", "热门", "官网",',
    '"tutorial") does not narrow the search — it matches more unrelated pages, because those are the words',
    'junk pages stuff into their titles.',
  ].join('\n'),
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query. Two or three words that name the thing.' },
    },
    required: ['query'],
  },
  async execute(args, ctx) {
    const query = String(args.query || '').trim();
    if (!query) return 'Error: query must not be empty.';
    const signal = (ctx && ctx.signal) || undefined;

    // SEVERAL KEYS, TRIED IN ORDER.
    //
    // One key has one monthly quota, and when it runs out the tool has nothing left to say but "search is
    // broken". A list makes the quota additive: the second key is simply tried when the first is refused, and
    // the answer is the same either way. Empty entries are skipped so a trailing newline in the editor is not
    // an "empty key" attempt.
    const keys = parseKeys(ctx && (ctx.webSearchApiKey || (ctx.cfg && ctx.cfg.webSearchApiKey)));

    // Keyless is the fallback only when NO key is configured at all — it is rate-limited per IP, so it is worth
    // trying exactly when there is no account to spend instead.
    const attempts = keys.length ? keys.map((k) => ({ key: k })) : [{ key: '' }];

    let lastFailure = '';
    for (let i = 0; i < attempts.length; i++) {
      const { key } = attempts[i];
      try {
        const headers = {
          'Content-Type': 'application/json',
          'User-Agent': UA,
          Accept: 'application/json',
        };
        if (key) headers.Authorization = `Bearer ${key}`;
        else headers['X-Tavily-Access-Mode'] = 'keyless';
        const res = await fetch(ENDPOINT, {
          method: 'POST',
          headers,
          // `search_depth: 'basic'` COSTS ONE CREDIT; the default is `advanced`, which costs two per request.
          // A snippet is all this tool shows, so the deeper crawl buys nothing — it was doubling the price of
          // every search for content that gets truncated to a sentence or two anyway.
          body: JSON.stringify({ query, max_results: 8, search_depth: 'basic' }),
          signal,
        });
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          lastFailure = `${res.status} ${res.statusText}${body ? ' ' + body.slice(0, 160) : ''}`;
          // Move to the next key. A 4xx from THIS key is the reason to try another — 429 is the monthly quota
          // and 401 is a typo — while a 5xx is the service, and the next key would hit the same wall. Only
          // stop early when there IS no next key.
          if (i + 1 < attempts.length) continue;
          break;
        }
        return await renderResults(res, query);
      } catch (e) {
        if (e && e.name === 'AbortError') return `Error searching "${query}": interrupted`;
        lastFailure = e.message || String(e);
        if (i + 1 < attempts.length) continue;
        break;
      }
    }

    // Every key failed, or the only key did. Say which mode was in play: in keyless that is the IP limit and
    // the fix is a key, with a key it is the key.
    const mode = keys.length
      ? `${keys.length} configured API key${keys.length === 1 ? '' : 's'}`
      : 'keyless mode (rate-limited per IP — set web_search_api_key to lift it)';
    return `Error: search failed with ${mode}: ${lastFailure}`;
  },
};

/**
 * The keys in a configured value, one per line.
 *
 * `web_search_api_key` holds a LIST: one key per line, because that is what a multi-line editor gives and what
 * a user pasting several keys already has. A single-line value is a list of one, so an existing config keeps
 * working unchanged.
 *
 * @param {string|string[]} raw
 * @returns {string[]}
 */
export function parseKeys(raw) {
  if (Array.isArray(raw)) return raw.map((x) => String(x).trim()).filter(Boolean);
  return String(raw == null ? '' : raw)
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean);
}

/**
 * Turn a successful response into the text the model reads.
 *
 * @param {Response} res
 * @param {string} query
 * @returns {Promise<string>}
 */
async function renderResults(res, query) {
  // The endpoint answers with JSON. If it ever does not, say so rather than parsing a page.
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); }
  catch { return `Error: search returned a non-JSON response (${text.length} bytes) for "${query}".`; }

  const results = parseSearchResults(json, 8);
  if (!results.length) {
    // A genuine empty result set, NOT an error. A broken page must not look like a successful search.
    return `No search results found for: ${query}`;
  }
  // The API also returns a written `answer` for some queries. It is its own summary, so it is labelled as
  // such — the model should cite the sources, not this paragraph.
  const answer = typeof json.answer === 'string' && json.answer.trim()
    ? `Summary (from the search API, not a source):\n${json.answer.trim()}\n\n`
    : '';
  // NO CREDIT COUNT. The docs show a `usage.credits` field in their example response, but the live endpoint
  // does not send one — measured on both `basic` and `advanced` depth, `json.usage` is undefined.
  return answer + results
    .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
    .join('\n\n');
}

