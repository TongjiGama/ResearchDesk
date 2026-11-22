/**
 * src/main/search/connectors.js — 多源学术检索连接器（全部在主进程发起 HTTP 请求）
 * 支持源：
 *   - openalex        (L1 主库：宽覆盖、引用量、referenced_works 引文图)
 *   - arxiv           (L2 新鲜度哨兵：最新预印本、直连 PDF、分类、journal_ref)
 *   - openreview      (L2 AI 顶会录用校对：ICLR/NeurIPS/ICML/CoRL Oral/Spotlight/Poster，过滤拒稿)
 *   - huggingface     (L2 前沿社区与代码信号：HF Upvotes、GitHub Stars、AI 摘要、每日精选)
 *   - crossref        (L3 正式出版物 DOI 与期刊/会议载体核验)
 *   - semanticscholar (L3 可选增强：高影响力引用数 Influential Citations 与 TLDR，429 优雅降级)
 */
'use strict';

const OPENALEX_BASE = 'https://api.openalex.org';
const ARXIV_BASE = 'https://export.arxiv.org/api/query';
const OPENREVIEW_BASE = 'https://api2.openreview.net/notes/search';
const HF_SEARCH_BASE = 'https://huggingface.co/api/papers/search';
const HF_DAILY_BASE = 'https://huggingface.co/api/daily_papers';
const CROSSREF_BASE = 'https://api.crossref.org/works';
const S2_BASE = 'https://api.semanticscholar.org/graph/v1/paper/search';

const DEFAULT_TIMEOUT_MS = 11000;
const RETRY_MS = 650;
const USER_AGENT = 'research-workbench/4.0 (local academic workbench; mailto:research-workbench@local)';

const OPENALEX_SELECT_FIELDS = [
  'id', 'title', 'publication_date', 'cited_by_count', 'primary_location',
  'authorships', 'referenced_works', 'abstract_inverted_index', 'doi', 'ids', 'type'
].join(',');

const SOURCE_LABELS = {
  openalex: 'OpenAlex',
  arxiv: 'arXiv',
  openreview: 'OpenReview',
  huggingface: 'HF Papers',
  crossref: 'Crossref',
  semanticscholar: 'Semantic Scholar'
};

function workIdOf(value) {
  const s = String(value == null ? '' : value).trim();
  if (!s) return '';
  const m = s.match(/W\d+$/i);
  return m ? m[0].toUpperCase() : '';
}

function isValidArxivDigits(id) {
  const m = String(id || '').match(/^(\d{2})(\d{2})\.\d{4,5}$/);
  if (!m) return false;
  const mm = Number(m[2]);
  return mm >= 1 && mm <= 12;
}

function cleanArxivId(value) {
  const s = String(value == null ? '' : value).trim();
  if (!s) return '';
  const bare = s.match(/^(\d{4}\.\d{4,5})(?:v\d+)?$/i);
  if (bare && isValidArxivDigits(bare[1])) return bare[1];
  const prefixed = s.match(/arxiv(?:\.org)?[-_./:]*(?:abs\/|pdf\/)?(\d{4}\.\d{4,5})(?:v\d+)?/i);
  if (prefixed && isValidArxivDigits(prefixed[1])) return prefixed[1];
  return '';
}

function cleanDoi(value) {
  return String(value == null ? '' : value)
    .trim()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')
    .replace(/^doi:\s*/i, '')
    .trim();
}

function restoreAbstract(inv) {
  if (!inv || typeof inv !== 'object' || Array.isArray(inv)) return '';
  const pairs = [];
  for (const [word, positions] of Object.entries(inv)) {
    (Array.isArray(positions) ? positions : []).forEach((p) => pairs.push([Number(p) || 0, String(word)]));
  }
  if (!pairs.length) return '';
  pairs.sort((a, b) => a[0] - b[0]);
  return pairs.map((x) => x[1]).join(' ')
    .replace(/\s+([.,;:!?])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function excerpt(text, n = 160) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  const limit = Math.max(20, Number(n) || 160);
  if (s.length <= limit) return s;
  const head = s.slice(0, limit);
  const cuts = [head.lastIndexOf('。'), head.lastIndexOf('.'), head.lastIndexOf('；'),
    head.lastIndexOf(';'), head.lastIndexOf('，'), head.lastIndexOf(',')];
  const cut = Math.max.apply(null, cuts);
  return (cut >= Math.floor(limit * 0.55) ? head.slice(0, cut + 1) : head).trim() + '…';
}

function decodeXmlEntities(str) {
  return String(str || '')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
      try { return String.fromCodePoint(parseInt(hex, 16)); } catch (_) { return ''; }
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      try { return String.fromCodePoint(parseInt(dec, 10)); } catch (_) { return ''; }
    })
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function stripTags(str) {
  return decodeXmlEntities(String(str || '').replace(/<[^>]+>/g, ' '))
    .replace(/\s+([.,;:!?])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractCodeUrlFromText(text) {
  const src = String(text || '');
  const m = src.match(/https?:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/i);
  if (!m) return '';
  return m[0].replace(/[.,;:)\]}'"]+$/, '');
}

function normalizeArxivFromOpenAlex(w) {
  const ids = (w && w.ids) || {};
  const loc = (w && w.primary_location) || {};
  const direct = cleanArxivId(ids.arxiv);
  if (direct) return direct;
  for (const cand of [loc.id, loc.landing_page_url, loc.pdf_url, w && w.doi]) {
    const hit = cleanArxivId(cand);
    if (hit) return hit;
  }
  return '';
}

function isPreprint(w) {
  const loc = (w && w.primary_location) || {};
  const src = loc.source || {};
  const srcId = String(src.id || '');
  const raw = String(loc.raw_source_name || '');
  return /S4306400194/i.test(srcId) ||
    loc.version === 'submittedVersion' ||
    /arxiv|biorxiv|medrxiv|preprint/i.test(raw) ||
    /arxiv/i.test(String(src.display_name || ''));
}

function normalizeOpenAlexWork(w) {
  const work = w || {};
  const openalexId = workIdOf(work.id);
  const authorsSrc = Array.isArray(work.authorships) ? work.authorships : [];
  const names = authorsSrc
    .map((a) => a && a.author && a.author.display_name)
    .filter((v) => typeof v === 'string' && v.trim())
    .slice(0, 8);
  if (authorsSrc.length > 8 && names.length) names.push('et al.');
  const source = ((work.primary_location || {}).source) || {};
  const dates = String(work.publication_date || '');
  const inv = work.abstract_inverted_index || null;
  const abstract = restoreAbstract(inv);
  const doiRaw = cleanDoi(work.doi || (work.ids && work.ids.doi) || '');
  const refsSrc = Array.isArray(work.referenced_works) ? work.referenced_works : [];
  const referencedWorks = Array.from(new Set(refsSrc.map(workIdOf).filter(Boolean)));
  const loc = work.primary_location || {};
  const arxivId = normalizeArxivFromOpenAlex(work);
  const preprint = isPreprint(work);
  const venue = String(source.display_name || '');
  const venueType = String(source.type || '');
  return {
    openalexId,
    title: String(work.title || '').trim() || '（无标题）',
    authors: names,
    publicationDate: dates,
    published: dates.slice(0, 7),
    citedByCount: Number(work.cited_by_count) || 0,
    citationSource: 'OpenAlex',
    influentialCitationCount: 0,
    venue,
    venueType,
    venueStatus: preprint ? 'Preprint' : (venueType === 'journal' ? 'Journal' : (venue ? 'Accepted' : '')),
    isPreprint: preprint,
    abstractInvertedIndex: inv,
    abstract,
    abstractExcerpt: excerpt(abstract, 160),
    doi: doiRaw,
    arxivId,
    referencedWorks,
    citedByApiUrl: String(work.cited_by_api_url || (openalexId ? `${OPENALEX_BASE}/works?filter=cites:${openalexId}` : '')),
    oaUrl: String(loc.landing_page_url || ''),
    pdfUrl: String(loc.pdf_url || (arxivId ? `https://arxiv.org/pdf/${arxivId}.pdf` : '')),
    codeUrl: extractCodeUrlFromText(abstract),
    githubStars: 0,
    hfUpvotes: 0,
    tldr: '',
    keywords: [],
    workType: String(work.type || ''),
    sources: ['openalex'],
    duplicateOf: ''
  };
}

async function fetchWithTimeout(url, { headers = {}, timeoutMs = DEFAULT_TIMEOUT_MS, retries = 1, retryOn429 = true } = {}) {
  let lastErr = null;
  let lastStatus = 0;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const resp = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, ...headers },
        signal: ctrl.signal
      });
      clearTimeout(timer);
      if (!resp.ok) {
        lastStatus = resp.status;
        lastErr = new Error('HTTP ' + resp.status);
        const shouldRetry = attempt < retries && (resp.status >= 500 || (resp.status === 429 && retryOn429));
        if (shouldRetry) {
          await new Promise((r) => setTimeout(r, RETRY_MS));
          continue;
        }
        const err = new Error(`HTTP ${resp.status}`);
        err.status = resp.status;
        throw err;
      }
      return resp;
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      const isNetwork = e && (e.name === 'AbortError' || /fetch failed|ENOTFOUND|ECONNREFUSED|network/i.test(e.message || ''));
      if (attempt < retries && isNetwork) {
        await new Promise((r) => setTimeout(r, RETRY_MS));
        continue;
      }
      throw e;
    }
  }
  throw lastErr || new Error(`HTTP ${lastStatus || 'ERR'}`);
}

/** 1. OpenAlex Connector */
async function searchOpenAlex(query, opts = {}) {
  const perPage = Math.max(1, Math.min(50, Number(opts.perPage) || 15));
  const params = new URLSearchParams({
    search: String(query || '').trim(),
    'per-page': String(perPage),
    select: OPENALEX_SELECT_FIELDS
  });
  const filterParts = [];
  if (Number(opts.yearFrom) >= 1900) filterParts.push(`from_publication_date:${Number(opts.yearFrom)}-01-01`);
  if (Number(opts.yearTo) >= 1900) filterParts.push(`to_publication_date:${Number(opts.yearTo)}-12-31`);
  if (Number(opts.minCitations) > 0) filterParts.push(`cited_by_count:>${Number(opts.minCitations) - 1}`);
  if (opts.hasPdfOnly) filterParts.push('open_access.is_oa:true');
  if (filterParts.length) params.set('filter', filterParts.join(','));
  if (opts.sort === 'cited_by_count:desc' || opts.sort === 'publication_date:desc') {
    params.set('sort', opts.sort);
  }
  const apiKey = String(opts.apiKey || '').trim();
  const url = `${OPENALEX_BASE}/works?${params.toString()}${apiKey ? `&api_key=${encodeURIComponent(apiKey)}` : ''}`;
  const resp = await fetchWithTimeout(url, { headers: { Accept: 'application/json' }, timeoutMs: opts.timeoutMs || 12000 });
  const data = await resp.json();
  const results = Array.isArray(data && data.results) ? data.results : [];
  return results
    .filter((w) => w && String(w.title || '').trim() && !/dataset|institution/i.test(String(w.type || '')))
    .map(normalizeOpenAlexWork)
    .filter((p) => p.openalexId);
}

async function fetchOpenAlexWorksByIds(ids = [], apiKey = '') {
  const cleanIds = Array.from(new Set((Array.isArray(ids) ? ids : []).map(workIdOf).filter(Boolean))).slice(0, 50);
  if (!cleanIds.length) return [];
  const chunks = [];
  for (let i = 0; i < cleanIds.length; i += 25) chunks.push(cleanIds.slice(i, i + 25));
  const out = [];
  for (const chunk of chunks) {
    const params = new URLSearchParams({
      filter: `openalex:${chunk.join('|')}`,
      'per-page': String(chunk.length),
      select: OPENALEX_SELECT_FIELDS
    });
    const url = `${OPENALEX_BASE}/works?${params.toString()}${apiKey ? `&api_key=${encodeURIComponent(apiKey)}` : ''}`;
    try {
      const resp = await fetchWithTimeout(url, { headers: { Accept: 'application/json' }, timeoutMs: 10000, retries: 1 });
      const data = await resp.json();
      const results = Array.isArray(data && data.results) ? data.results : [];
      results
        .filter((w) => w && String(w.title || '').trim() && !/dataset|institution/i.test(String(w.type || '')))
        .map(normalizeOpenAlexWork)
        .filter((p) => p.openalexId)
        .forEach((p) => out.push(p));
    } catch (_) {
      // 单批失败忽略，不影响其他批次
    }
  }
  return out;
}

async function lookupOpenAlexByDoi(doi, apiKey = '') {
  const clean = cleanDoi(doi);
  if (!clean) return null;
  const params = new URLSearchParams({
    filter: `doi:https://doi.org/${clean}`,
    'per-page': '3',
    select: OPENALEX_SELECT_FIELDS
  });
  const url = `${OPENALEX_BASE}/works?${params.toString()}${apiKey ? `&api_key=${encodeURIComponent(apiKey)}` : ''}`;
  const resp = await fetchWithTimeout(url, { headers: { Accept: 'application/json' }, timeoutMs: 10000, retries: 1 });
  const data = await resp.json();
  const results = Array.isArray(data && data.results) ? data.results : [];
  const list = results
    .filter((w) => w && String(w.title || '').trim() && !/dataset|institution/i.test(String(w.type || '')))
    .map(normalizeOpenAlexWork)
    .filter((p) => p.openalexId);
  return list[0] || null;
}

const ARXIV_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'onto', 'about',
  'over', 'under', 'using', 'via', 'how', 'what', 'why', 'does', 'can', 'are',
  'not', 'but', 'our', 'their', 'its', 'between', 'through', 'towards', 'toward'
]);

/** 2. arXiv Atom XML Parser & Connector */
function buildArxivSearchQuery(rawQuery, categories = []) {
  const cleaned = String(rawQuery || '')
    .replace(/[()[\]{}"':;,?!\\/]+/g, ' ')
    .replace(/\b(?:AND|OR|ANDNOT)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const seen = new Set();
  const allTokens = cleaned.split(' ').filter((t) => {
    const low = t.toLowerCase();
    if (t.length < 2 || ARXIV_STOPWORDS.has(low) || seen.has(low)) return false;
    seen.add(low);
    return true;
  });
  const asciiTokens = allTokens.filter((t) => !/[\u4e00-\u9fa5]/.test(t));
  const tokens = (asciiTokens.length ? asciiTokens : allTokens).slice(0, 7);
  const core = tokens.length
    ? tokens.map((t) => `all:${t}`).join(' AND ')
    : `all:${cleaned || 'machine learning'}`;
  const validCats = (Array.isArray(categories) ? categories : [])
    .map((c) => String(c || '').trim())
    .filter((c) => /^[a-z\-]+(?:\.[A-Za-z\-]+)?$/.test(c))
    .slice(0, 4);
  if (!validCats.length) return core;
  return `(${core}) AND (${validCats.map((c) => `cat:${c}`).join(' OR ')})`;
}

function parseArxivAtom(xml) {
  const src = String(xml || '');
  if (!src.includes('<entry>')) return [];
  const entries = src.match(/<entry>[\s\S]*?<\/entry>/g) || [];
  const out = [];
  for (const block of entries) {
    const pick = (tag) => {
      const m = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i'));
      return m ? decodeXmlEntities(m[1]).replace(/\s+/g, ' ').trim() : '';
    };
    const idRaw = pick('id');
    const arxivId = cleanArxivId(idRaw);
    const title = pick('title');
    if (!title) continue;
    const abstract = pick('summary');
    const publishedRaw = pick('published');
    const publicationDate = publishedRaw ? publishedRaw.slice(0, 10) : '';
    const authorBlocks = block.match(/<author>[\s\S]*?<\/author>/gi) || [];
    const authors = authorBlocks.map((ab) => {
      const m = ab.match(/<name>([\s\S]*?)<\/name>/i);
      return m ? decodeXmlEntities(m[1]).replace(/\s+/g, ' ').trim() : '';
    }).filter(Boolean);
    const displayAuthors = authors.slice(0, 8);
    if (authors.length > 8) displayAuthors.push('et al.');
    const doi = cleanDoi(pick('arxiv:doi'));
    const journalRef = pick('arxiv:journal_ref');
    const catMatches = block.match(/<category\s+[^>]*term="([^"]+)"/gi) || [];
    const categories = Array.from(new Set(catMatches.map((tag) => {
      const m = tag.match(/term="([^"]+)"/i);
      return m ? m[1] : '';
    }).filter(Boolean)));
    const pdfMatch = block.match(/<link[^>]*title="pdf"[^>]*href="([^"]+)"/i)
      || block.match(/<link[^>]*href="([^"]+)"[^>]*title="pdf"/i);
    const pdfUrl = pdfMatch ? pdfMatch[1].replace(/^http:\/\//i, 'https://') : (arxivId ? `https://arxiv.org/pdf/${arxivId}.pdf` : '');
    const oaUrl = arxivId ? `https://arxiv.org/abs/${arxivId}` : idRaw.replace(/^http:\/\//i, 'https://');
    const hasFormalRef = Boolean(journalRef && !/^\s*(?:arxiv|preprint|submitted|under review)/i.test(journalRef));

    out.push({
      openalexId: '',
      title,
      authors: displayAuthors,
      publicationDate,
      published: publicationDate.slice(0, 7),
      citedByCount: 0,
      citationSource: '',
      influentialCitationCount: 0,
      venue: hasFormalRef ? journalRef.slice(0, 100) : 'arXiv',
      venueType: hasFormalRef ? 'conference' : 'repository',
      venueStatus: hasFormalRef ? 'Published' : 'Preprint',
      isPreprint: !hasFormalRef,
      abstract,
      abstractExcerpt: excerpt(abstract, 160),
      doi,
      arxivId,
      referencedWorks: [],
      citedByApiUrl: '',
      oaUrl,
      pdfUrl,
      codeUrl: extractCodeUrlFromText(abstract),
      githubStars: 0,
      hfUpvotes: 0,
      tldr: '',
      keywords: categories.slice(0, 5),
      workType: hasFormalRef ? 'article' : 'preprint',
      sources: ['arxiv'],
      duplicateOf: ''
    });
  }
  return out;
}

async function searchArxiv(query, opts = {}) {
  const maxResults = Math.max(1, Math.min(35, Number(opts.perPage) || 15));
  const sortBy = opts.arxivSortBy === 'submittedDate' || opts.arxivSortBy === 'relevance'
    ? opts.arxivSortBy
    : (opts.sort === 'publication_date:desc' ? 'submittedDate' : 'relevance');
  const searchQuery = buildArxivSearchQuery(query, opts.arxivCategories);
  const params = new URLSearchParams({
    search_query: searchQuery,
    start: '0',
    max_results: String(maxResults),
    sortBy,
    sortOrder: 'descending'
  });
  const resp = await fetchWithTimeout(`${ARXIV_BASE}?${params.toString()}`, {
    headers: { Accept: 'application/atom+xml, application/xml, text/xml' },
    timeoutMs: opts.timeoutMs || 11000
  });
  const xml = await resp.text();
  return parseArxivAtom(xml);
}

/** 3. OpenReview v2 Connector (ICLR / NeurIPS / ICML / CoRL / RSS acceptance status) */
function openReviewField(content, key) {
  if (!content || typeof content !== 'object') return undefined;
  const entry = content[key];
  if (entry && typeof entry === 'object' && Object.prototype.hasOwnProperty.call(entry, 'value')) {
    return entry.value;
  }
  return entry;
}

function classifyOpenReviewVenue(venue, venueid) {
  const combined = `${String(venue || '')} ${String(venueid || '')}`.trim();
  if (/rejected|withdrawn|desk[_\s-]*reject/i.test(combined)) {
    return { rejected: true, accepted: false, isPreprint: true, venueStatus: 'Rejected', venueType: 'repository' };
  }
  if (/workshop/i.test(combined)) {
    const isSub = /submission|under review/i.test(combined);
    return { rejected: false, accepted: !isSub, isPreprint: isSub, venueStatus: isSub ? 'Under Review' : 'Workshop', venueType: 'conference' };
  }
  if (/submitted to|conference submission|under review|\/submission\b/i.test(combined)) {
    return { rejected: false, accepted: false, isPreprint: true, venueStatus: 'Under Review', venueType: 'repository' };
  }
  if (/\boral\b/i.test(combined)) {
    return { rejected: false, accepted: true, isPreprint: false, venueStatus: 'Oral', venueType: 'conference' };
  }
  if (/\bspotlight\b|notable-top/i.test(combined)) {
    return { rejected: false, accepted: true, isPreprint: false, venueStatus: 'Spotlight', venueType: 'conference' };
  }
  if (/poster|accept|tmlr|published|iclr|neurips|icml|corl|rss|cvpr|eccv|iccv|icra|iros|colm|aaai|ijcai|acl|emnlp|naacl|siggraph|aistats|uai|colt|kdd|miccai/i.test(combined)) {
    return { rejected: false, accepted: true, isPreprint: false, venueStatus: 'Accepted', venueType: /tmlr|journal/i.test(combined) ? 'journal' : 'conference' };
  }
  return { rejected: false, accepted: false, isPreprint: true, venueStatus: 'Preprint', venueType: 'repository' };
}

function normalizeOpenReviewNote(note, { excludeRejected = true } = {}) {
  if (!note || typeof note !== 'object') return null;
  if (note.replyto) return null; // 跳过审稿评论，只保留论文主帖
  const content = note.content || {};
  const title = String(openReviewField(content, 'title') || '').replace(/\s+/g, ' ').trim();
  if (!title) return null;
  const venue = String(openReviewField(content, 'venue') || '').trim();
  const venueid = String(openReviewField(content, 'venueid') || '').trim();
  const cls = classifyOpenReviewVenue(venue, venueid);
  if (excludeRejected && cls.rejected) return null;

  const abstract = String(openReviewField(content, 'abstract') || '').replace(/\s+/g, ' ').trim();
  const tldr = String(openReviewField(content, 'TLDR') || openReviewField(content, 'TL;DR') || openReviewField(content, 'one-sentence_summary') || '').trim();
  const rawAuthors = openReviewField(content, 'authors');
  const authorsArr = Array.isArray(rawAuthors) ? rawAuthors.map((a) => String(a || '').trim()).filter(Boolean) : [];
  const authors = authorsArr.slice(0, 8);
  if (authorsArr.length > 8) authors.push('et al.');
  const ts = Number(note.pdate || note.cdate || note.tcdate || 0);
  const publicationDate = ts > 0 ? new Date(ts).toISOString().slice(0, 10) : '';
  const forumId = String(note.forum || note.id || '').trim();
  const rawPdf = String(openReviewField(content, 'pdf') || '').trim();
  const pdfUrl = rawPdf
    ? (rawPdf.startsWith('http') ? rawPdf : `https://openreview.net${rawPdf.startsWith('/') ? '' : '/'}${rawPdf}`)
    : (forumId ? `https://openreview.net/pdf?id=${encodeURIComponent(forumId)}` : '');
  const oaUrl = forumId ? `https://openreview.net/forum?id=${encodeURIComponent(forumId)}` : '';
  const bibtex = String(openReviewField(content, '_bibtex') || '');
  const codeField = [
    openReviewField(content, 'code'),
    openReviewField(content, 'github'),
    openReviewField(content, 'software'),
    openReviewField(content, 'supplementary_material')
  ].filter(Boolean).join(' ');
  const codeUrl = extractCodeUrlFromText(`${codeField} ${abstract} ${tldr}`);
  const arxivId = cleanArxivId(`${abstract} ${bibtex} ${String(openReviewField(content, 'html') || '')}`);
  const keywordsRaw = openReviewField(content, 'keywords');
  const keywords = Array.isArray(keywordsRaw) ? keywordsRaw.map((k) => String(k || '').trim()).filter(Boolean).slice(0, 6) : [];

  return {
    openalexId: '',
    openreviewId: forumId,
    title,
    authors,
    publicationDate,
    published: publicationDate.slice(0, 7),
    citedByCount: 0,
    citationSource: '',
    influentialCitationCount: 0,
    venue: venue || venueid.replace(/\//g, ' '),
    venueType: cls.venueType,
    venueStatus: cls.venueStatus,
    isPreprint: cls.isPreprint,
    abstract,
    abstractExcerpt: excerpt(abstract || tldr, 160),
    doi: '',
    arxivId,
    referencedWorks: [],
    citedByApiUrl: '',
    oaUrl,
    pdfUrl,
    codeUrl,
    githubStars: 0,
    hfUpvotes: 0,
    tldr,
    keywords,
    workType: cls.accepted ? 'article' : 'preprint',
    sources: ['openreview'],
    duplicateOf: ''
  };
}

async function searchOpenReview(query, opts = {}) {
  const limit = Math.max(1, Math.min(30, Number(opts.perPage) || 15));
  const params = new URLSearchParams({
    term: String(query || '').trim(),
    source: 'forum',
    limit: String(limit)
  });
  const resp = await fetchWithTimeout(`${OPENREVIEW_BASE}?${params.toString()}`, {
    headers: { Accept: 'application/json' },
    timeoutMs: opts.timeoutMs || 10000
  });
  const data = await resp.json();
  const notes = Array.isArray(data && data.notes) ? data.notes : [];
  return notes
    .map((n) => normalizeOpenReviewNote(n, { excludeRejected: opts.excludeRejected !== false }))
    .filter(Boolean);
}

/** 4. Hugging Face Papers Connector (Search + Daily Frontier Papers) */
function normalizeHfPaperItem(entry) {
  const item = entry || {};
  const p = item.paper && typeof item.paper === 'object' ? item.paper : item;
  const title = String(p.title || item.title || '').replace(/\s+/g, ' ').trim();
  if (!title) return null;
  const arxivId = cleanArxivId(p.id || item.id || '');
  const authorsSrc = Array.isArray(p.authors) ? p.authors : [];
  const names = authorsSrc.map((a) => String((a && a.name) || a || '').trim()).filter(Boolean);
  const authors = names.slice(0, 8);
  if (names.length > 8) authors.push('et al.');
  const publishedRaw = String(p.publishedAt || item.publishedAt || '');
  const publicationDate = publishedRaw ? publishedRaw.slice(0, 10) : '';
  const abstract = String(p.summary || item.summary || '').replace(/\s+/g, ' ').trim();
  const tldr = String(p.ai_summary || '').replace(/\s+/g, ' ').trim();
  const codeUrl = String(p.githubRepo || '').trim() || extractCodeUrlFromText(abstract);
  const keywords = Array.isArray(p.ai_keywords) ? p.ai_keywords.map((k) => String(k || '').trim()).filter(Boolean).slice(0, 6) : [];

  return {
    openalexId: '',
    title,
    authors,
    publicationDate,
    published: publicationDate.slice(0, 7),
    citedByCount: 0,
    citationSource: '',
    influentialCitationCount: 0,
    venue: 'Hugging Face Papers (arXiv)',
    venueType: 'repository',
    venueStatus: 'Preprint',
    isPreprint: true,
    abstract,
    abstractExcerpt: excerpt(tldr || abstract, 160),
    doi: '',
    arxivId,
    referencedWorks: [],
    citedByApiUrl: '',
    oaUrl: arxivId ? `https://huggingface.co/papers/${arxivId}` : '',
    pdfUrl: arxivId ? `https://arxiv.org/pdf/${arxivId}.pdf` : '',
    codeUrl,
    githubStars: Number(p.githubStars) || 0,
    hfUpvotes: Number(p.upvotes) || 0,
    projectPage: String(p.projectPage || '').trim(),
    tldr,
    keywords,
    workType: 'preprint',
    sources: ['huggingface'],
    duplicateOf: ''
  };
}

async function searchHuggingFace(query, opts = {}) {
  const limit = Math.max(1, Math.min(35, Number(opts.perPage) || 15));
  const params = new URLSearchParams({ q: String(query || '').trim() });
  const resp = await fetchWithTimeout(`${HF_SEARCH_BASE}?${params.toString()}`, {
    headers: { Accept: 'application/json' },
    timeoutMs: opts.timeoutMs || 10000
  });
  const data = await resp.json();
  const list = Array.isArray(data) ? data : [];
  return list.map(normalizeHfPaperItem).filter(Boolean).slice(0, limit);
}

async function fetchHuggingFaceDaily(opts = {}) {
  const limit = Math.max(1, Math.min(60, Number(opts.limit) || 30));
  const resp = await fetchWithTimeout(`${HF_DAILY_BASE}?limit=${limit}`, {
    headers: { Accept: 'application/json' },
    timeoutMs: opts.timeoutMs || 10000
  });
  const data = await resp.json();
  const list = Array.isArray(data) ? data : [];
  return list.map(normalizeHfPaperItem).filter(Boolean).slice(0, limit);
}

/** 5. Crossref Connector */
function crossrefDate(item) {
  const candidates = [item.published, item['published-print'], item['published-online'], item.issued, item.created];
  for (const c of candidates) {
    const parts = c && Array.isArray(c['date-parts']) && c['date-parts'][0];
    if (Array.isArray(parts) && parts[0]) {
      const y = String(parts[0]).padStart(4, '0');
      const m = parts[1] ? String(parts[1]).padStart(2, '0') : '01';
      const d = parts[2] ? String(parts[2]).padStart(2, '0') : '01';
      return `${y}-${m}-${d}`;
    }
  }
  return '';
}

function normalizeCrossrefItem(item) {
  if (!item || typeof item !== 'object') return null;
  const type = String(item.type || '').toLowerCase();
  if (/dataset|component|peer-review|grant|standard|book-part/.test(type)) return null;
  const titleArr = Array.isArray(item.title) ? item.title : (item.title ? [item.title] : []);
  const title = stripTags(titleArr[0] || '');
  if (!title) return null;
  const container = Array.isArray(item['container-title']) ? item['container-title'][0] : (item['container-title'] || '');
  const venue = stripTags(container || '');
  const doi = cleanDoi(item.DOI || '');
  const arxivId = cleanArxivId(doi);
  const authorsSrc = Array.isArray(item.author) ? item.author : [];
  const names = authorsSrc.map((a) => [a && a.given, a && a.family].filter(Boolean).join(' ').trim()).filter(Boolean);
  const authors = names.slice(0, 8);
  if (names.length > 8) authors.push('et al.');
  const publicationDate = crossrefDate(item);
  const abstract = stripTags(item.abstract || '');
  const isJournal = /journal/.test(type);
  const isConf = /proceedings|conference/.test(type);
  const preprint = /posted-content/.test(type) || /arxiv|biorxiv|medrxiv/i.test(venue);
  const links = Array.isArray(item.link) ? item.link : [];
  const pdfLink = links.find((l) => l && /pdf/i.test(String(l['content-type'] || l.URL || '')));

  return {
    openalexId: '',
    title,
    authors,
    publicationDate,
    published: publicationDate.slice(0, 7),
    citedByCount: Number(item['is-referenced-by-count']) || 0,
    citationSource: 'Crossref',
    influentialCitationCount: 0,
    venue,
    venueType: isJournal ? 'journal' : (isConf ? 'conference' : (preprint ? 'repository' : '')),
    venueStatus: preprint ? 'Preprint' : (isJournal ? 'Journal' : (isConf ? 'Accepted' : 'Published')),
    isPreprint: preprint,
    abstract,
    abstractExcerpt: excerpt(abstract, 160),
    doi,
    arxivId,
    referencedWorks: [],
    citedByApiUrl: '',
    oaUrl: String(item.URL || (doi ? `https://doi.org/${doi}` : '')),
    pdfUrl: pdfLink ? String(pdfLink.URL || '') : '',
    codeUrl: extractCodeUrlFromText(abstract),
    githubStars: 0,
    hfUpvotes: 0,
    tldr: '',
    keywords: [],
    workType: type || 'article',
    sources: ['crossref'],
    duplicateOf: ''
  };
}

async function searchCrossref(query, opts = {}) {
  const rows = Math.max(1, Math.min(30, Number(opts.perPage) || 12));
  const params = new URLSearchParams({
    query: String(query || '').trim(),
    rows: String(rows)
  });
  const filters = [];
  if (Number(opts.yearFrom) >= 1900) filters.push(`from-pub-date:${Number(opts.yearFrom)}-01-01`);
  if (Number(opts.yearTo) >= 1900) filters.push(`until-pub-date:${Number(opts.yearTo)}-12-31`);
  if (filters.length) params.set('filter', filters.join(','));
  if (opts.sort === 'cited_by_count:desc') {
    params.set('sort', 'is-referenced-by-count');
    params.set('order', 'desc');
  } else if (opts.sort === 'publication_date:desc') {
    params.set('sort', 'published');
    params.set('order', 'desc');
  }
  const resp = await fetchWithTimeout(`${CROSSREF_BASE}?${params.toString()}`, {
    headers: { Accept: 'application/json' },
    timeoutMs: opts.timeoutMs || 10000
  });
  const data = await resp.json();
  const items = Array.isArray(data && data.message && data.message.items) ? data.message.items : [];
  return items.map(normalizeCrossrefItem).filter(Boolean);
}

/** 6. Semantic Scholar Connector (Optional L3; 429 fails fast without retrying) */
function normalizeSemanticScholarItem(item) {
  if (!item || typeof item !== 'object') return null;
  const title = String(item.title || '').replace(/\s+/g, ' ').trim();
  if (!title) return null;
  const ext = item.externalIds || {};
  const doi = cleanDoi(ext.DOI || '');
  const arxivId = cleanArxivId(ext.ArXiv || doi);
  const authorsSrc = Array.isArray(item.authors) ? item.authors : [];
  const names = authorsSrc.map((a) => String((a && a.name) || '').trim()).filter(Boolean);
  const authors = names.slice(0, 8);
  if (names.length > 8) authors.push('et al.');
  const publicationDate = String(item.publicationDate || (item.year ? `${item.year}-01-01` : ''));
  const venue = String((item.publicationVenue && item.publicationVenue.name) || item.venue || '').trim();
  const pubType = String((item.publicationVenue && item.publicationVenue.type) || '').toLowerCase();
  const preprint = !venue || /arxiv|biorxiv|medrxiv|preprint/i.test(venue);
  const abstract = String(item.abstract || '').replace(/\s+/g, ' ').trim();
  const tldr = String((item.tldr && item.tldr.text) || '').trim();
  const pdfUrl = String((item.openAccessPdf && item.openAccessPdf.url) || (arxivId ? `https://arxiv.org/pdf/${arxivId}.pdf` : ''));

  return {
    openalexId: '',
    s2PaperId: String(item.paperId || ''),
    title,
    authors,
    publicationDate,
    published: publicationDate.slice(0, 7),
    citedByCount: Number(item.citationCount) || 0,
    citationSource: 'Semantic Scholar',
    influentialCitationCount: Number(item.influentialCitationCount) || 0,
    venue,
    venueType: pubType || (preprint ? 'repository' : 'conference'),
    venueStatus: preprint ? 'Preprint' : (pubType === 'journal' ? 'Journal' : 'Accepted'),
    isPreprint: preprint,
    abstract,
    abstractExcerpt: excerpt(tldr || abstract, 160),
    doi,
    arxivId,
    referencedWorks: [],
    citedByApiUrl: '',
    oaUrl: String(item.url || (arxivId ? `https://arxiv.org/abs/${arxivId}` : '')),
    pdfUrl,
    codeUrl: extractCodeUrlFromText(abstract),
    githubStars: 0,
    hfUpvotes: 0,
    tldr,
    keywords: [],
    workType: preprint ? 'preprint' : 'article',
    sources: ['semanticscholar'],
    duplicateOf: ''
  };
}

async function searchSemanticScholar(query, opts = {}) {
  const limit = Math.max(1, Math.min(25, Number(opts.perPage) || 12));
  const fields = [
    'paperId', 'title', 'year', 'citationCount', 'influentialCitationCount',
    'venue', 'publicationVenue', 'openAccessPdf', 'externalIds',
    'abstract', 'authors', 'publicationDate', 'tldr', 'url'
  ].join(',');
  const params = new URLSearchParams({
    query: String(query || '').trim(),
    limit: String(limit),
    fields
  });
  if (Number(opts.yearFrom) >= 1900 || Number(opts.yearTo) >= 1900) {
    const y1 = Number(opts.yearFrom) >= 1900 ? String(Number(opts.yearFrom)) : '';
    const y2 = Number(opts.yearTo) >= 1900 ? String(Number(opts.yearTo)) : '';
    params.set('year', `${y1}-${y2}`);
  }
  const headers = { Accept: 'application/json' };
  const s2Key = String(opts.s2ApiKey || '').trim();
  if (s2Key) headers['x-api-key'] = s2Key;
  const resp = await fetchWithTimeout(`${S2_BASE}?${params.toString()}`, {
    headers,
    timeoutMs: opts.timeoutMs || 8000,
    retries: s2Key ? 1 : 0,
    retryOn429: Boolean(s2Key)
  });
  const data = await resp.json();
  const list = Array.isArray(data && data.data) ? data.data : [];
  return list.map(normalizeSemanticScholarItem).filter(Boolean);
}

async function searchSource(source, query, opts = {}) {
  switch (source) {
    case 'openalex': return searchOpenAlex(query, opts);
    case 'arxiv': return searchArxiv(query, opts);
    case 'openreview': return searchOpenReview(query, opts);
    case 'huggingface': return searchHuggingFace(query, opts);
    case 'crossref': return searchCrossref(query, opts);
    case 'semanticscholar': return searchSemanticScholar(query, opts);
    default: throw new Error('未知检索源：' + source);
  }
}

module.exports = {
  SOURCE_LABELS,
  OPENALEX_BASE,
  OPENALEX_SELECT_FIELDS,
  workIdOf,
  cleanArxivId,
  cleanDoi,
  restoreAbstract,
  excerpt,
  isPreprint,
  stripTags,
  extractCodeUrlFromText,
  normalizeOpenAlexWork,
  normalizeArxivFromOpenAlex,
  parseArxivAtom,
  buildArxivSearchQuery,
  classifyOpenReviewVenue,
  normalizeOpenReviewNote,
  normalizeHfPaperItem,
  normalizeCrossrefItem,
  normalizeSemanticScholarItem,
  searchOpenAlex,
  lookupOpenAlexByDoi,
  fetchOpenAlexWorksByIds,
  searchArxiv,
  searchOpenReview,
  searchHuggingFace,
  fetchHuggingFaceDaily,
  searchCrossref,
  searchSemanticScholar,
  searchSource
};
