/**
 * src/main/search/fusion.js — 多源论文跨源去重、元数据融合、前沿度评分与文献导出
 * 核心目标：
 *   1. 按 arXiv ID（含 10.48550/arxiv.* 映射）→ DOI → OpenAlex ID → 规范化标题跨源融合同一篇论文
 *   2. 用 OpenReview / Crossref / journal_ref 的正式发表载体升级 arXiv 预印本标签
 *   3. 合并开源代码仓库、GitHub Star、HF Upvotes、引用量、高影响力引用与引文列表
 *   4. 计算可解释的「前沿度 Frontier Score」与「年均引用增速」，解决新 SOTA 论文被老高引淹没的问题
 *   5. 导出标准 BibTeX 与 Markdown 文献综述矩阵
 */
'use strict';

const { cleanArxivId, cleanDoi, excerpt } = require('./connectors');

const VENUE_PRIORITY = {
  Oral: 6,
  Spotlight: 5,
  Journal: 4,
  Accepted: 4,
  Published: 4,
  Workshop: 3,
  'Under Review': 2,
  Preprint: 1,
  Rejected: 0,
  '': 0
};

const TOP_VENUE_RE = /\b(neurips|nips|iclr|icml|cvpr|iccv|eccv|acl|emnlp|naacl|corl|rss|icra|iros|siggraph|aaai|ijcai|colm|nature|science|tpami|pami|ijrr|jmlr|tmlr|t-?ro|ieee transactions)\b|neural information processing systems|international conference on learning representations|international conference on machine learning|computer vision and pattern recognition|international conference on robotics and automation|conference on robot learning|robotics:\s*science and systems|ieee robotics and automation letters/i;

function normalizeTitle(title) {
  return String(title == null ? '' : title)
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function paperArxivKey(p) {
  const direct = cleanArxivId(p && p.arxivId);
  if (direct) return direct;
  const fromDoi = cleanArxivId(p && p.doi);
  if (fromDoi) return fromDoi;
  return cleanArxivId((p && p.oaUrl) || (p && p.pdfUrl) || '');
}

function paperDoiKey(p) {
  const doi = cleanDoi(p && p.doi).toLowerCase();
  if (!doi) return '';
  // arXiv 自动分配的 DOI 已由 arxivId 覆盖，仍可作为辅键
  return doi;
}

function venueRank(p) {
  if (!p) return 0;
  const status = String(p.venueStatus || '');
  let base = VENUE_PRIORITY[status] || 0;
  if (!base && p.venue && !p.isPreprint) base = 3;
  if (TOP_VENUE_RE.test(String(p.venue || '')) && !p.isPreprint) base += 2;
  return base;
}

function pickBetterDate(a, b) {
  const sa = String(a || '').trim();
  const sb = String(b || '').trim();
  if (!sa) return sb;
  if (!sb) return sa;
  // 优先更完整的 YYYY-MM-DD；同等完整度保留非 -01-01 或更早正式日期
  if (sa.length !== sb.length) return sa.length > sb.length ? sa : sb;
  if (sa.endsWith('-01-01') && !sb.endsWith('-01-01')) return sb;
  if (sb.endsWith('-01-01') && !sa.endsWith('-01-01')) return sa;
  return sa;
}

function mergeTwoPapers(base, incoming) {
  const a = base;
  const b = incoming;

  // 1. 载体与录用状态：正式顶会/期刊永远覆盖 arXiv/HF 镜像
  const rankA = venueRank(a);
  const rankB = venueRank(b);
  if (rankB > rankA || (rankB === rankA && String(b.venue || '').length > String(a.venue || '').length && !b.isPreprint)) {
    a.venue = b.venue || a.venue;
    a.venueType = b.venueType || a.venueType;
    a.venueStatus = b.venueStatus || a.venueStatus;
    a.isPreprint = Boolean(b.isPreprint);
    if (b.workType && b.workType !== 'preprint') a.workType = b.workType;
  }

  // 2. 标识符补齐
  if (!a.openalexId && b.openalexId) a.openalexId = b.openalexId;
  if (!a.openreviewId && b.openreviewId) a.openreviewId = b.openreviewId;
  if (!a.s2PaperId && b.s2PaperId) a.s2PaperId = b.s2PaperId;
  if (!a.arxivId) a.arxivId = paperArxivKey(b);
  if (!a.doi && b.doi) a.doi = b.doi;
  else if (a.doi && /10\.48550\/arxiv\./i.test(a.doi) && b.doi && !/10\.48550\/arxiv\./i.test(b.doi)) {
    // 正式出版 DOI 优于 arXiv DOI
    a.doi = b.doi;
  }
  if (!a.citedByApiUrl && b.citedByApiUrl) a.citedByApiUrl = b.citedByApiUrl;

  // 3. 标题 / 作者 / 日期
  if ((!a.title || a.title === '（无标题）') && b.title) a.title = b.title;
  if ((!Array.isArray(a.authors) || !a.authors.length) && Array.isArray(b.authors) && b.authors.length) {
    a.authors = b.authors.slice();
  }
  a.publicationDate = pickBetterDate(a.publicationDate, b.publicationDate);
  a.published = a.publicationDate ? a.publicationDate.slice(0, 7) : (a.published || b.published || '');

  // 4. 引用量与口径（优先保留 OpenAlex 有值口径，否则取更高非零值并记录口径）
  const cA = Number(a.citedByCount) || 0;
  const cB = Number(b.citedByCount) || 0;
  if (b.citationSource === 'OpenAlex' && (cB > 0 || !a.citationSource)) {
    a.citedByCount = Math.max(cA, cB);
    a.citationSource = 'OpenAlex';
  } else if (cB > cA) {
    a.citedByCount = cB;
    a.citationSource = b.citationSource || a.citationSource;
  } else if (!a.citationSource && b.citationSource) {
    a.citationSource = b.citationSource;
  }
  a.influentialCitationCount = Math.max(Number(a.influentialCitationCount) || 0, Number(b.influentialCitationCount) || 0);

  // 5. 摘要与 TLDR（优先更完整的全文摘要）
  if (String(b.abstract || '').length > String(a.abstract || '').length) {
    a.abstract = b.abstract;
    if (b.abstractInvertedIndex) a.abstractInvertedIndex = b.abstractInvertedIndex;
  }
  if (!a.tldr && b.tldr) a.tldr = b.tldr;
  a.abstractExcerpt = excerpt(a.abstract || a.tldr || a.abstractExcerpt || b.abstractExcerpt || '', 160);

  // 6. 原文 / PDF / 代码 / 社区热度
  if (!a.oaUrl && b.oaUrl) a.oaUrl = b.oaUrl;
  else if (b.oaUrl && /openreview\.net|doi\.org/i.test(b.oaUrl) && /huggingface\.co/i.test(a.oaUrl)) {
    a.oaUrl = b.oaUrl;
  }
  if (!a.pdfUrl && b.pdfUrl) a.pdfUrl = b.pdfUrl;
  else if (b.pdfUrl && /arxiv\.org\/pdf|openreview\.net\/pdf/i.test(b.pdfUrl) && !/\.pdf(\?|$)|\/pdf\?/i.test(a.pdfUrl)) {
    a.pdfUrl = b.pdfUrl;
  }
  if (!a.codeUrl && b.codeUrl) a.codeUrl = b.codeUrl;
  if (!a.projectPage && b.projectPage) a.projectPage = b.projectPage;
  a.githubStars = Math.max(Number(a.githubStars) || 0, Number(b.githubStars) || 0);
  a.hfUpvotes = Math.max(Number(a.hfUpvotes) || 0, Number(b.hfUpvotes) || 0);

  // 7. 引文列表、关键词、来源、滚雪球记录
  const refs = new Set([...(Array.isArray(a.referencedWorks) ? a.referencedWorks : []), ...(Array.isArray(b.referencedWorks) ? b.referencedWorks : [])]);
  a.referencedWorks = Array.from(refs);
  const kws = new Set([...(Array.isArray(a.keywords) ? a.keywords : []), ...(Array.isArray(b.keywords) ? b.keywords : [])]);
  a.keywords = Array.from(kws).slice(0, 8);
  const srcs = new Set([...(Array.isArray(a.sources) ? a.sources : []), ...(Array.isArray(b.sources) ? b.sources : [])]);
  a.sources = Array.from(srcs);

  if (Array.isArray(b.snowballReasons) && b.snowballReasons.length) {
    const reasons = new Set([...(Array.isArray(a.snowballReasons) ? a.snowballReasons : []), ...b.snowballReasons]);
    a.snowballReasons = Array.from(reasons).slice(0, 6);
    if (!a.snowballRole && b.snowballRole) a.snowballRole = b.snowballRole;
  }

  return a;
}

/**
 * 跨源去重 + RRF 融合。
 * @param {Array<{source:string, queryIndex:number, queryTerm?:string, weight?:number, papers:object[]}>} batches
 */
function fusePapers(batches = []) {
  const entries = [];
  const byArxiv = new Map();
  const byDoi = new Map();
  const byOpenAlex = new Map();
  const byTitle = new Map();

  function registerKeys(entry) {
    const p = entry.paper;
    const ax = paperArxivKey(p);
    if (ax) { p.arxivId = p.arxivId || ax; byArxiv.set(ax, entry); }
    const doi = paperDoiKey(p);
    if (doi) byDoi.set(doi, entry);
    if (p.openalexId) byOpenAlex.set(p.openalexId.toUpperCase(), entry);
    const t = normalizeTitle(p.title);
    if (t && t.length >= 6) byTitle.set(t, entry);
  }

  function findMatchingEntries(p) {
    const matched = [];
    const pushUnique = (entry) => {
      if (entry && !matched.includes(entry)) matched.push(entry);
    };
    const ax = paperArxivKey(p);
    if (ax && byArxiv.has(ax)) pushUnique(byArxiv.get(ax));
    const doi = paperDoiKey(p);
    if (doi && byDoi.has(doi)) pushUnique(byDoi.get(doi));
    if (p.openalexId && byOpenAlex.has(p.openalexId.toUpperCase())) pushUnique(byOpenAlex.get(p.openalexId.toUpperCase()));
    const t = normalizeTitle(p.title);
    if (t && t.length >= 6 && byTitle.has(t)) pushUnique(byTitle.get(t));
    return matched;
  }

  function repointEntryKeys(oldEntry, targetEntry) {
    for (const map of [byArxiv, byDoi, byOpenAlex, byTitle]) {
      for (const [k, v] of map.entries()) {
        if (v === oldEntry) map.set(k, targetEntry);
      }
    }
  }

  let order = 0;
  for (const batch of (Array.isArray(batches) ? batches : [])) {
    const list = Array.isArray(batch && batch.papers) ? batch.papers : [];
    const source = String((batch && batch.source) || 'openalex');
    const qIdx = Number(batch && batch.queryIndex) || 0;
    const weight = Number(batch && batch.weight) || 1;
    list.forEach((rawPaper, rank) => {
      if (!rawPaper || !String(rawPaper.title || '').trim()) return;
      const cand = {
        ...rawPaper,
        sources: Array.isArray(rawPaper.sources) && rawPaper.sources.length ? rawPaper.sources.slice() : [source]
      };
      const matches = findMatchingEntries(cand);
      let entry = matches[0] || null;
      if (!entry) {
        entry = {
          paper: cand,
          rrfScore: 0,
          matchedQueries: new Set(),
          matchedBuckets: new Set(),
          order: order++
        };
        entries.push(entry);
      } else {
        // 传递合并：若当前候选同时命中两个先前分离的条目（如一篇仅 arXiv ID、一篇仅正式 DOI），合并为一条
        for (let m = 1; m < matches.length; m++) {
          const dup = matches[m];
          if (dup === entry || dup._merged) continue;
          mergeTwoPapers(entry.paper, dup.paper);
          entry.rrfScore += dup.rrfScore;
          dup.matchedQueries.forEach((q) => entry.matchedQueries.add(q));
          dup.matchedBuckets.forEach((b) => entry.matchedBuckets.add(b));
          dup._merged = true;
          repointEntryKeys(dup, entry);
        }
        mergeTwoPapers(entry.paper, cand);
      }
      registerKeys(entry);
      const bucketKey = `${source}:${qIdx}`;
      if (!entry.matchedBuckets.has(bucketKey)) {
        entry.matchedBuckets.add(bucketKey);
        entry.rrfScore += weight / (55 + rank + 1);
      }
      entry.matchedQueries.add(qIdx);
    });
  }

  return entries
    .filter((entry) => !entry._merged)
    .map((entry) => ({
      ...entry.paper,
      rrfScore: Number(entry.rrfScore.toFixed(6)),
      searchQueryMatchCount: entry.matchedQueries.size,
      sourceCount: Array.isArray(entry.paper.sources) ? entry.paper.sources.length : 1,
      _encounterOrder: entry.order
    }));
}

/**
 * 计算可解释的「前沿度评分 (0–100)」与「年均引用增速」。
 * 兼顾：多源/多策略相关度 + 时效归一化引用增速 + 顶会/期刊录用状态 + 开源/HF 社区热度 + 可选 AI RCS。
 */
function scoreFrontierPaper(paper, nowMs = Date.now()) {
  const p = paper || {};
  const cites = Math.max(0, Number(p.citedByCount) || 0);
  const infCites = Math.max(0, Number(p.influentialCitationCount) || 0);
  const dateMs = Date.parse(p.publicationDate || (p.published ? `${p.published}-01` : ''));
  const ageYears = !isNaN(dateMs)
    ? Math.max(0.15, (nowMs - dateMs) / (365.25 * 24 * 3600 * 1000))
    : 5;
  const citationVelocity = cites > 0 ? Number((cites / Math.max(0.35, ageYears)).toFixed(1)) : 0;

  // 1. 相关度与多源共识（0–34 分）
  const rrfNorm = Math.min(1, (Number(p.rrfScore) || 0) / 0.036);
  const consensusBonus = Math.min(9, Math.max(0, (Number(p.sourceCount) || 1) - 1) * 4.5)
    + Math.min(6, Math.max(0, (Number(p.searchQueryMatchCount) || 1) - 1) * 3);
  const relevancePart = rrfNorm * 22 + consensusBonus;

  // 2. 载体与评审权威度（0–24 分）
  let venuePart = 5;
  const status = String(p.venueStatus || '');
  const isTopVenue = TOP_VENUE_RE.test(String(p.venue || ''));
  if (status === 'Oral') venuePart = 24;
  else if (status === 'Spotlight') venuePart = 22;
  else if (!p.isPreprint && isTopVenue) venuePart = 20;
  else if (status === 'Journal' || status === 'Accepted' || status === 'Published') venuePart = 16;
  else if (status === 'Workshop') venuePart = 11;
  else if (status === 'Under Review') venuePart = 8;

  // 3. 时效与前沿新鲜度（0–18 分）
  let recencyPart = 2;
  if (ageYears <= 0.6) recencyPart = 18;
  else if (ageYears <= 1.5) recencyPart = 15;
  else if (ageYears <= 2.5) recencyPart = 12;
  else if (ageYears <= 4.0) recencyPart = 8;
  else if (ageYears <= 6.0) recencyPart = 4;

  // 4. 引用增速 + 高影响力引用（0–18 分）
  const velocityPart = Math.min(15, Math.log10(1 + citationVelocity) * 5.6);
  const influentialPart = Math.min(3, Math.log10(1 + infCites) * 1.5);

  // 5. 开源代码与社区前沿热度（0–10 分）
  let communityPart = 0;
  if (p.codeUrl) communityPart += 3.5;
  if (Number(p.githubStars) > 0) communityPart += Math.min(4, Math.log10(1 + Number(p.githubStars)) * 1.1);
  if (Number(p.hfUpvotes) > 0) communityPart += Math.min(4, Math.log10(1 + Number(p.hfUpvotes)) * 1.9);
  communityPart = Math.min(10, communityPart);

  // 6. 可选 AI RCS 相关性微调（-12 ~ +12）
  let rcsAdjust = 0;
  if (typeof p.rcsScore === 'number' && !isNaN(p.rcsScore)) {
    rcsAdjust = (p.rcsScore - 5) * 2.4;
  }

  // 7. 引文滚雪球多命中加成
  const snowballBonus = Array.isArray(p.snowballReasons) && p.snowballReasons.length
    ? Math.min(8, p.snowballReasons.length * 4)
    : 0;

  const rawScore = relevancePart + venuePart + recencyPart + velocityPart + influentialPart + communityPart + rcsAdjust + snowballBonus;
  const frontierScore = Math.max(1, Math.min(99, Math.round(rawScore)));

  const signals = [];
  if (status === 'Oral') signals.push('顶会 Oral');
  else if (status === 'Spotlight') signals.push('顶会 Spotlight');
  else if (!p.isPreprint && isTopVenue) signals.push('顶会/顶刊');
  if (ageYears <= 1.0 && (Number(p.hfUpvotes) >= 10 || Number(p.githubStars) >= 100 || citationVelocity >= 20)) {
    signals.push('高潜前沿');
  } else if (citationVelocity >= 100) {
    signals.push('高引增速');
  }
  if (Number(p.sourceCount) >= 2) signals.push(`${p.sourceCount} 源共识`);
  if (p.codeUrl) signals.push(Number(p.githubStars) > 0 ? `开源代码` : '含代码库');
  if (Array.isArray(p.snowballReasons) && p.snowballReasons.length) {
    signals.push(p.snowballRole === 'backward' ? '共同奠基' : '引文追踪');
  }

  return {
    ...p,
    citationVelocity,
    frontierScore,
    frontierSignals: signals.slice(0, 4)
  };
}

function yearOfPaper(p) {
  const s = String((p && (p.publicationDate || p.published)) || '');
  const m = s.match(/^(\d{4})/);
  return m ? Number(m[1]) : 0;
}

function filterAndSortPapers(papers, opts = {}) {
  const filters = opts.filters || opts || {};
  const yearFrom = Number(filters.yearFrom) || 0;
  const yearTo = Number(filters.yearTo) || 0;
  const minCitations = Number(filters.minCitations) || 0;
  const peerReviewedOnly = Boolean(filters.peerReviewedOnly);
  const hasCodeOnly = Boolean(filters.hasCodeOnly);
  const hasPdfOnly = Boolean(filters.hasPdfOnly);
  const hideDuplicates = Boolean(filters.hideDuplicates);
  const excludeRejected = filters.excludeRejected !== false;
  const sort = String(opts.sort || 'frontier');

  const scored = (Array.isArray(papers) ? papers : []).map((p) =>
    typeof p.frontierScore === 'number' ? p : scoreFrontierPaper(p, opts.nowMs)
  );

  const filtered = scored.filter((p) => {
    if (excludeRejected && p.venueStatus === 'Rejected') return false;
    const y = yearOfPaper(p);
    if (yearFrom >= 1900 && y > 0 && y < yearFrom) return false;
    if (yearTo >= 1900 && y > 0 && y > yearTo) return false;
    if (minCitations > 0 && (Number(p.citedByCount) || 0) < minCitations) return false;
    if (peerReviewedOnly && p.isPreprint) return false;
    if (hasCodeOnly && !p.codeUrl) return false;
    if (hasPdfOnly && !p.pdfUrl) return false;
    if (hideDuplicates && p.duplicateOf) return false;
    return true;
  });

  filtered.sort((a, b) => {
    if (sort === 'cited_by_count:desc') {
      return (Number(b.citedByCount) || 0) - (Number(a.citedByCount) || 0) || (b.frontierScore - a.frontierScore);
    }
    if (sort === 'publication_date:desc') {
      return String(b.publicationDate || '').localeCompare(String(a.publicationDate || '')) || (b.frontierScore - a.frontierScore);
    }
    if (sort === 'velocity') {
      return (Number(b.citationVelocity) || 0) - (Number(a.citationVelocity) || 0) || (b.frontierScore - a.frontierScore);
    }
    if (sort === 'relevance') {
      const rcsDiff = (typeof b.rcsScore === 'number' ? b.rcsScore : -1) - (typeof a.rcsScore === 'number' ? a.rcsScore : -1);
      if (typeof a.rcsScore === 'number' && typeof b.rcsScore === 'number' && rcsDiff !== 0) return rcsDiff;
      return (Number(b.rrfScore) || 0) - (Number(a.rrfScore) || 0) || (b.frontierScore - a.frontierScore);
    }
    // 默认 frontier：前沿综合分
    return (b.frontierScore - a.frontierScore) || (Number(b.rrfScore) || 0) - (Number(a.rrfScore) || 0);
  });

  return filtered;
}

/** 构造安全的 BibTeX 字符串（兼容 Zotero / Overleaf），转义 LaTeX 特殊字符。 */
function escapeBibText(text) {
  return String(text == null ? '' : text)
    .replace(/[{}]/g, '')
    .replace(/\\/g, '')
    .replace(/([%&#_$])/g, '\\$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeBibRaw(text) {
  return String(text == null ? '' : text)
    .replace(/[{}]/g, '')
    .replace(/\s+/g, '')
    .trim();
}

function extractAuthorSurname(rawAuthor) {
  const s = String(rawAuthor || '').trim();
  if (!s) return '';
  const base = s.includes(',') ? s.split(',')[0].trim() : s.split(/\s+/).pop();
  return String(base || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]/g, '')
    .toLowerCase();
}

function makeBibKey(paper, usedKeys) {
  const firstAuthor = Array.isArray(paper.authors) && paper.authors.length
    ? extractAuthorSurname(paper.authors[0])
    : 'paper';
  const year = yearOfPaper(paper) || 'nd';
  const titleWord = String(paper.title || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .find((w) => w.length >= 4 && !['with', 'from', 'that', 'this', 'using', 'towards', 'learning'].includes(w))
    || 'work';
  let key = `${firstAuthor || 'paper'}${year}${titleWord}`;
  let suffix = 2;
  while (usedKeys.has(key)) {
    key = `${firstAuthor || 'paper'}${year}${titleWord}${suffix++}`;
  }
  usedKeys.add(key);
  return key;
}

function exportBibtex(papers = []) {
  const list = Array.isArray(papers) ? papers : [];
  const usedKeys = new Set();
  return list.map((p) => {
    const key = makeBibKey(p, usedKeys);
    const isJournal = p.venueType === 'journal' || p.venueStatus === 'Journal';
    const isConf = !p.isPreprint && (p.venueType === 'conference' || ['Oral', 'Spotlight', 'Accepted', 'Workshop'].includes(p.venueStatus));
    const entryType = isJournal ? 'article' : (isConf ? 'inproceedings' : 'misc');
    const authors = (Array.isArray(p.authors) ? p.authors : []).filter((a) => a && a !== 'et al.').join(' and ');
    const year = yearOfPaper(p);
    const showHowPublished = entryType === 'misc' && p.venue && !/^(?:arXiv|Hugging Face Papers)/i.test(String(p.venue).trim());
    const fields = [
      `  title = {${escapeBibText(p.title || 'Untitled')}}`,
      authors ? `  author = {${escapeBibText(authors)}}` : '',
      year ? `  year = {${year}}` : '',
      isJournal && p.venue ? `  journal = {${escapeBibText(p.venue)}}` : '',
      isConf && p.venue ? `  booktitle = {${escapeBibText(p.venue)}}` : '',
      showHowPublished ? `  howpublished = {${escapeBibText(p.venue)}}` : '',
      p.doi ? `  doi = {${escapeBibRaw(p.doi)}}` : '',
      p.arxivId ? `  eprint = {${escapeBibRaw(p.arxivId)}}` : '',
      p.arxivId ? `  archivePrefix = {arXiv}` : '',
      (p.oaUrl || p.pdfUrl) ? `  url = {${escapeBibRaw(p.oaUrl || p.pdfUrl)}}` : ''
    ].filter(Boolean);
    return `@${entryType}{${key},\n${fields.join(',\n')}\n}`;
  }).join('\n\n');
}

function escapeMdCell(text) {
  return String(text == null ? '' : text).replace(/\|/g, '\\|').replace(/\r?\n+/g, ' ').trim();
}

function safeMdUrl(url) {
  return String(url == null ? '' : url)
    .trim()
    .replace(/\s+/g, '%20')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
    .replace(/\|/g, '%7C');
}

function exportMarkdownTable(papers = []) {
  const list = Array.isArray(papers) ? papers : [];
  const header = [
    '| # | 标题 | 年份 | 载体 / 状态 | 引用量 | 前沿分 | 来源 | 代码 / 原文 | 摘要要点 |',
    '|---|------|------|-------------|--------|--------|------|-------------|----------|'
  ];
  const rows = list.map((p, idx) => {
    const year = yearOfPaper(p) || '—';
    const venue = [p.venue || '—', p.venueStatus && p.venueStatus !== 'Accepted' ? `(${p.venueStatus})` : ''].filter(Boolean).join(' ');
    const cites = Number(p.citedByCount) || 0;
    const sources = (Array.isArray(p.sources) ? p.sources : ['openalex']).join(', ');
    const links = [
      p.oaUrl ? `[原文](${safeMdUrl(p.oaUrl)})` : '',
      p.pdfUrl ? `[PDF](${safeMdUrl(p.pdfUrl)})` : '',
      p.codeUrl ? `[Code](${safeMdUrl(p.codeUrl)})` : ''
    ].filter(Boolean).join(' · ') || '—';
    const note = p.rcsReason || p.tldr || p.abstractExcerpt || '—';
    return `| ${idx + 1} | ${escapeMdCell(p.title || '（无标题）')} | ${year} | ${escapeMdCell(venue)} | ${cites} | ${p.frontierScore || '—'} | ${escapeMdCell(sources)} | ${links} | ${escapeMdCell(note.slice(0, 120))} |`;
  });
  return [...header, ...rows].join('\n');
}

module.exports = {
  normalizeTitle,
  paperArxivKey,
  paperDoiKey,
  venueRank,
  mergeTwoPapers,
  fusePapers,
  scoreFrontierPaper,
  filterAndSortPapers,
  yearOfPaper,
  exportBibtex,
  exportMarkdownTable
};
