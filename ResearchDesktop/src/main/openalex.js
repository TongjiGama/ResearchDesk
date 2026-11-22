/**
 * openalex.js — 多源论文检索引擎与内嵌 GitHub 检索 Skill 编排服务（仅在主进程发起 Web 请求）
 * 保留既有 OpenAlex 接口与单测契约：search / citedBy / refreshCitations / normalizeWork / restoreAbstract / excerpt / workIdOf / isPreprint
 * 增量提供：多源联邦检索（OpenAlex / arXiv / OpenReview / Hugging Face Papers / Crossref / Semantic Scholar）、
 *          内嵌与可导入 GitHub 检索 Skills、双向引文滚雪球（snowball）、今日前沿雷达（dailyFrontier）、
 *          开放获取 PDF 下载（downloadPaperPdf）及 BibTeX / Markdown 综述矩阵导出（exportResults）。
 * 依赖方向：openalex → {store, ai, search/*}，无反向依赖。
 */
'use strict';

const store = require('./store');
const ai = require('./ai');
const skills = require('./search/skills');
const connectors = require('./search/connectors');
const fusion = require('./search/fusion');

const API_BASE = connectors.OPENALEX_BASE;
const TIMEOUT_MS = 12000;
const RETRY_MS = 800;
const SELECT_FIELDS = connectors.OPENALEX_SELECT_FIELDS;
const MAX_PDF_BYTES = 40 * 1024 * 1024;

const workIdOf = connectors.workIdOf;
const restoreAbstract = connectors.restoreAbstract;
const excerpt = connectors.excerpt;
const isPreprint = connectors.isPreprint;
const normalizeWork = connectors.normalizeOpenAlexWork;

/** 错误文案映射：断网 / 限流 / 其他状态均给友好提示，且标明本地数据未受影响。 */
function friendlyError(e, status) {
  if (status === 429) return 'OpenAlex 请求过于频繁，请稍后重试（可在设置填 personal key 提额）';
  if (e && (e.name === 'AbortError' || /timeout/i.test(e.message || ''))) {
    return '连接 OpenAlex 超时，本地数据未受影响';
  }
  if (e && /fetch failed|ENOTFOUND|ECONNREFUSED|network/i.test(e.message || '')) {
    return '无法连接 OpenAlex，本地数据未受影响';
  }
  if (status) return `检索失败：${status}，本地数据未受影响`;
  return `检索失败：${(e && e.message) || '未知错误'}，本地数据未受影响`;
}

function friendlySourceError(source, e) {
  const label = connectors.SOURCE_LABELS[source] || source;
  const status = Number(e && e.status) || 0;
  if (status === 429) return `${label} 限流（429），已跳过${source === 'semanticscholar' ? '（可在设置填 API Key 提额）' : ''}`;
  if (e && (e.name === 'AbortError' || /timeout/i.test(e.message || ''))) return `${label} 响应超时，已降级跳过`;
  if (e && /fetch failed|ENOTFOUND|ECONNREFUSED|network/i.test(e.message || '')) return `无法连接 ${label}，已降级跳过`;
  if (status) return `${label} 返回 HTTP ${status}，已降级跳过`;
  return `${label} 暂不可用：${(e && e.message) || '未知错误'}`;
}

/** 带超时 + 一次重试的 GET JSON（OpenAlex 兼容入口）。抛出的 Error.message 已是友好文案。 */
async function request(url, apiKey = '') {
  const target = apiKey ? `${url}${url.includes('?') ? '&' : '?'}api_key=${encodeURIComponent(apiKey)}` : url;
  let lastErr = null;
  let lastStatus = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const resp = await fetch(target, {
        headers: { Accept: 'application/json', 'User-Agent': 'research-workbench-v3/1.0' },
        signal: ctrl.signal
      });
      clearTimeout(timer);
      if (!resp.ok) {
        lastStatus = resp.status;
        lastErr = new Error('HTTP ' + resp.status);
        if ((resp.status === 429 || resp.status >= 500) && attempt === 0) {
          await new Promise((r) => setTimeout(r, RETRY_MS));
          continue;
        }
        throw friendlyError(lastErr, resp.status);
      }
      return await resp.json();
    } catch (e) {
      clearTimeout(timer);
      if (e instanceof Error && e.message.includes('本地数据未受影响')) {
        throw e;
      }
      lastErr = e;
      if (attempt === 0 && (e.name === 'AbortError' || /fetch failed|ENOTFOUND|ECONNREFUSED|network/i.test(e.message || ''))) {
        await new Promise((r) => setTimeout(r, RETRY_MS));
        continue;
      }
      throw new Error(friendlyError(e, lastStatus));
    }
  }
  throw new Error(friendlyError(lastErr, lastStatus));
}

/** 去重标记：命中本地库时回填 duplicateOf / matchedBy，渲染层灰显。 */
function markDuplicates(ws, list) {
  for (const cand of list) {
    try {
      const hit = store.findDuplicate(ws, cand);
      if (hit) { cand.duplicateOf = hit.duplicateOf; cand.matchedBy = hit.matchedBy; }
    } catch (_) { /* 去重失败不阻塞检索展示 */ }
  }
  return list;
}

/** 收集当前工作区种子论文（必引优先 + 近期论文），供术语校准与引文滚雪球使用。 */
function collectWorkspaceSeeds(ws) {
  if (!ws) return { titles: [], openalexSeeds: [] };
  try {
    const items = store.listItems(ws, 'papers') || [];
    const sorted = items.slice().sort((a, b) => {
      const starDiff = (b.starred ? 1 : 0) - (a.starred ? 1 : 0);
      if (starDiff !== 0) return starDiff;
      return String(b.publicationDate || b.published || '').localeCompare(String(a.publicationDate || a.published || ''));
    });
    const titles = sorted
      .slice(0, 10)
      .map((it) => String(it.shortName || it.title || '').trim())
      .filter(Boolean);
    const openalexSeeds = sorted
      .map((it) => ({
        id: it.id,
        title: String(it.title || it.shortName || it.id),
        shortName: String(it.shortName || ''),
        openalexId: workIdOf((it.externalIds && it.externalIds.openalex) || it.openalexId),
        arxivId: connectors.cleanArxivId(it.arxivId || (it.externalIds && it.externalIds.doi) || ''),
        doi: connectors.cleanDoi(it.doi || (it.externalIds && it.externalIds.doi) || ''),
        referencedWorks: Array.isArray(it.references) ? it.references.map(workIdOf).filter(Boolean) : [],
        starred: Boolean(it.starred)
      }))
      .filter((it) => it.openalexId || it.arxivId || it.doi);
    return { titles, openalexSeeds };
  } catch (_) {
    return { titles: [], openalexSeeds: [] };
  }
}

function titleTokenSet(text) {
  return new Set(
    fusion.normalizeTitle(text || '')
      .split(' ')
      .filter((t) => t.length >= 2)
  );
}

function titleOverlapRatio(a, b) {
  const sa = titleTokenSet(a);
  const sb = titleTokenSet(b);
  if (!sa.size || !sb.size) return 0;
  let common = 0;
  for (const t of sa) if (sb.has(t)) common++;
  return common / Math.max(sa.size, sb.size);
}

function seedMatchesQueryTerms(seed, queries) {
  const hay = fusion.normalizeTitle(`${seed.title || ''} ${seed.shortName || ''}`);
  if (!hay) return false;
  const hayTokens = new Set(hay.split(' ').filter((t) => t.length >= 2));
  for (const q of (Array.isArray(queries) ? queries : [])) {
    const tokens = fusion.normalizeTitle((q && q.term) || q || '').split(' ').filter((t) => t.length >= 3);
    if (tokens.some((t) => hayTokens.has(t))) return true;
  }
  return false;
}

async function fetchArxivWorkById(arxivId) {
  const cleanAx = connectors.cleanArxivId(arxivId);
  if (!cleanAx) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const url = `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(cleanAx)}`;
    const resp = await fetch(url, {
      headers: { Accept: 'application/atom+xml, application/xml, text/xml', 'User-Agent': 'research-workbench/4.0' },
      signal: ctrl.signal
    });
    clearTimeout(timer);
    if (!resp || !resp.ok) return null;
    const xml = await resp.text();
    const list = connectors.parseArxivAtom(xml);
    return list[0] || null;
  } catch (_) {
    clearTimeout(timer);
    return null;
  }
}

function mergeResolvedWorkOutput(seed, norm) {
  const s = seed || {};
  const n = norm || {};
  return {
    ...s,
    openalexId: n.openalexId || workIdOf(s.openalexId) || '',
    referencedWorks: Array.isArray(n.referencedWorks) && n.referencedWorks.length
      ? n.referencedWorks
      : (Array.isArray(s.referencedWorks) ? s.referencedWorks : []),
    title: s.title || n.title || '',
    authors: Array.isArray(s.authors) && s.authors.length ? s.authors : (Array.isArray(n.authors) ? n.authors : []),
    abstract: s.abstract || n.abstract || '',
    abstractExcerpt: s.abstractExcerpt || n.abstractExcerpt || '',
    publicationDate: s.publicationDate || n.publicationDate || '',
    published: s.published || n.published || '',
    venue: s.venue || n.venue || '',
    venueType: s.venueType || n.venueType || '',
    venueStatus: s.venueStatus || n.venueStatus || '',
    isPreprint: s.isPreprint !== undefined ? s.isPreprint : Boolean(n.isPreprint),
    citedByCount: Number(s.citedByCount) || Number(n.citedByCount) || 0,
    citedByApiUrl: s.citedByApiUrl || n.citedByApiUrl || '',
    oaUrl: s.oaUrl || n.oaUrl || '',
    pdfUrl: s.pdfUrl || n.pdfUrl || '',
    doi: s.doi || n.doi || '',
    arxivId: s.arxivId || n.arxivId || '',
    codeUrl: s.codeUrl || n.codeUrl || '',
    resolvedWork: n
  };
}

/** 精确解析单篇候选论文对应的 OpenAlex 作品（绝不把无关的 hits[0] 误当目标）。 */
async function resolveOpenAlexWork(seed, apiKey = '') {
  const s = seed || {};
  const existingOid = workIdOf(s.openalexId);
  if (existingOid) {
    const out = { ...s, openalexId: existingOid };
    const needDetail = s.forceFetch ||
      !Array.isArray(out.referencedWorks) || !out.referencedWorks.length ||
      !out.title ||
      !Array.isArray(out.authors) || !out.authors.length ||
      !out.abstract ||
      !out.publicationDate;
    if (needDetail) {
      try {
        const detail = await request(`${API_BASE}/works/${existingOid}?select=${SELECT_FIELDS}`, apiKey);
        const norm = normalizeWork(detail);
        return mergeResolvedWorkOutput(out, norm);
      } catch (_) { /* 缺后向引文仍可跑前向 */ }
    }
    return out;
  }

  // 1. 精确 DOI 过滤查询（正式 DOI 或 arXiv 自动分配 DOI）
  const doiCandidates = [];
  const cleanDoi = connectors.cleanDoi(s.doi || '');
  const cleanAx = connectors.cleanArxivId(s.arxivId || cleanDoi);
  if (cleanDoi) doiCandidates.push(cleanDoi);
  if (cleanAx) {
    const axDoi = `10.48550/arxiv.${cleanAx}`;
    if (!doiCandidates.some((d) => d.toLowerCase() === axDoi.toLowerCase())) doiCandidates.push(axDoi);
  }
  for (const d of doiCandidates) {
    try {
      const hit = await connectors.lookupOpenAlexByDoi(d, apiKey);
      if (hit && hit.openalexId) {
        return mergeResolvedWorkOutput(s, hit);
      }
    } catch (_) { /* 继续尝试标题精确匹配 */ }
  }

  // 1.5 arXiv Atom 回退：通过 arXiv ID 取回完整标题/作者/摘要后，尝试反查 OpenAlex
  let arxivHit = null;
  if (cleanAx && s.allowArxivFallback !== false) {
    arxivHit = await fetchArxivWorkById(cleanAx);
  }

  // 2. 按标题检索并严格校验（必须命中 arxivId / DOI / 规范化标题一致或高词项重合，绝不盲取 hits[0]）
  const titleQuery = String(s.title || (arxivHit && arxivHit.title) || '').trim();
  if (titleQuery) {
    try {
      const hits = await connectors.searchOpenAlex(titleQuery, { perPage: 5, apiKey });
      const normSeedTitle = fusion.normalizeTitle(titleQuery);
      const matched = hits.find((h) =>
        (cleanAx && h.arxivId === cleanAx) ||
        (cleanDoi && h.doi && h.doi.toLowerCase() === cleanDoi.toLowerCase()) ||
        (normSeedTitle && fusion.normalizeTitle(h.title) === normSeedTitle) ||
        (normSeedTitle && titleOverlapRatio(titleQuery, h.title) >= 0.85)
      );
      if (matched && matched.openalexId) {
        const mergedNorm = arxivHit
          ? {
              ...arxivHit,
              ...matched,
              abstract: matched.abstract || arxivHit.abstract || '',
              abstractExcerpt: matched.abstractExcerpt || arxivHit.abstractExcerpt || '',
              authors: (matched.authors && matched.authors.length) ? matched.authors : (arxivHit.authors || []),
              pdfUrl: matched.pdfUrl || arxivHit.pdfUrl || '',
              oaUrl: matched.oaUrl || arxivHit.oaUrl || '',
              arxivId: matched.arxivId || arxivHit.arxivId || cleanAx,
              codeUrl: matched.codeUrl || arxivHit.codeUrl || ''
            }
          : matched;
        return mergeResolvedWorkOutput(s, mergedNorm);
      }
    } catch (_) { /* OpenAlex 不可达时保留 arXiv 回退 */ }
  }

  if (arxivHit) {
    return mergeResolvedWorkOutput(s, arxivHit);
  }

  return null;
}

function isPlaceholderPaperTitle(fm) {
  const t = String((fm && fm.title) || '').trim();
  const sn = String((fm && fm.shortName) || '').trim();
  if (!t) return true;
  if (sn && t === sn) return true;
  return false;
}

function paperNeedsHydration(fm, force = false) {
  if (force) return true;
  const f = fm || {};
  const hasOa = Boolean(workIdOf((f.externalIds && f.externalIds.openalex) || f.openalexId));
  const hasAuthors = Array.isArray(f.authors) && f.authors.length > 0;
  const hasRefs = Array.isArray(f.references) && f.references.length > 0;
  const hasAbs = Boolean(String(f.abstract || '').trim());
  const hasDate = Boolean(String(f.publicationDate || f.published || '').trim());
  if (hasOa && hasAuthors && (hasRefs || f.metadataHydratedAt) && hasAbs && hasDate) {
    return false;
  }
  return Boolean(
    hasOa ||
    connectors.cleanArxivId(f.arxivId || (f.externalIds && f.externalIds.doi) || '') ||
    connectors.cleanDoi(f.doi || (f.externalIds && f.externalIds.doi) || '') ||
    String(f.title || '').trim()
  );
}

/** 非破坏性补全单篇本地论文元数据（不覆盖用户手写笔记、评分、状态与 shortName）。 */
async function hydratePaperMetadata(paperItem, opts = {}) {
  const item = paperItem || {};
  const id = String(item.id || '').trim();
  const fm = item.frontmatter && typeof item.frontmatter === 'object' ? item.frontmatter : item;
  const apiKey = String(opts.apiKey || (store.getConfig().openalex || {}).apiKey || '');
  const force = Boolean(opts.force);

  if (!paperNeedsHydration(fm, force)) {
    return {
      ok: true,
      id,
      updated: false,
      skipped: true,
      openalexId: workIdOf((fm.externalIds && fm.externalIds.openalex) || fm.openalexId),
      referenceCount: Array.isArray(fm.references) ? fm.references.length : 0,
      frontmatter: { ...fm },
      resolvedFrom: 'skipped'
    };
  }

  const existingOid = workIdOf((fm.externalIds && fm.externalIds.openalex) || fm.openalexId);
  const existingDoi = connectors.cleanDoi(fm.doi || (fm.externalIds && fm.externalIds.doi) || '');
  const existingAx = connectors.cleanArxivId(fm.arxivId || existingDoi);

  let resolved = null;
  let resolvedFrom = 'none';
  if (opts.preloadedWork && opts.preloadedWork.openalexId) {
    resolved = mergeResolvedWorkOutput({
      openalexId: existingOid,
      doi: existingDoi,
      arxivId: existingAx,
      title: isPlaceholderPaperTitle(fm) ? '' : fm.title
    }, opts.preloadedWork);
    resolvedFrom = 'batch';
  } else {
    resolved = await resolveOpenAlexWork({
      openalexId: existingOid,
      doi: existingDoi,
      arxivId: existingAx,
      title: isPlaceholderPaperTitle(fm) ? '' : String(fm.title || ''),
      forceFetch: force,
      allowArxivFallback: opts.allowArxivFallback !== false
    }, apiKey);
    if (resolved && resolved.resolvedWork) {
      resolvedFrom = resolved.openalexId ? 'openalex' : 'arxiv';
    } else if (resolved && resolved.openalexId) {
      resolvedFrom = 'openalex';
    }
  }

  if (!resolved) {
    return {
      ok: true,
      id,
      updated: false,
      skipped: true,
      openalexId: existingOid,
      referenceCount: Array.isArray(fm.references) ? fm.references.length : 0,
      frontmatter: { ...fm },
      resolvedFrom: 'not-found'
    };
  }

  const work = resolved.resolvedWork || resolved;
  const stamp = new Date().toISOString().slice(0, 10);
  const nextFm = { ...fm };

  // 仅当原标题为空或仅等于 shortName 占位符时升级完整标题
  if (work.title && work.title !== '（无标题）' && (isPlaceholderPaperTitle(fm) || !String(fm.title || '').trim())) {
    nextFm.title = String(work.title).trim();
  }
  if ((!Array.isArray(nextFm.authors) || !nextFm.authors.length) && Array.isArray(work.authors) && work.authors.length) {
    nextFm.authors = work.authors.slice();
  }
  if (!String(nextFm.abstract || '').trim() && String(work.abstract || '').trim()) {
    nextFm.abstract = String(work.abstract).trim().slice(0, 12000);
  }
  if (!String(nextFm.publicationDate || '').trim() && work.publicationDate) {
    nextFm.publicationDate = String(work.publicationDate);
  }
  if (!String(nextFm.published || '').trim() && (work.published || work.publicationDate)) {
    nextFm.published = String(work.published || String(work.publicationDate).slice(0, 7));
  }
  if (!String(nextFm.arxivId || '').trim() && work.arxivId) {
    nextFm.arxivId = String(work.arxivId);
  }
  const prevExt = (nextFm.externalIds && typeof nextFm.externalIds === 'object') ? { ...nextFm.externalIds } : {};
  if (!prevExt.openalex && (work.openalexId || resolved.openalexId)) {
    prevExt.openalex = work.openalexId || resolved.openalexId;
  }
  if (!prevExt.doi && work.doi) {
    prevExt.doi = work.doi;
  }
  if (prevExt.openalex || prevExt.doi) {
    nextFm.externalIds = prevExt;
  }
  if ((!Array.isArray(nextFm.references) || !nextFm.references.length) && Array.isArray(work.referencedWorks) && work.referencedWorks.length) {
    nextFm.references = work.referencedWorks.slice();
  }
  if (!String(nextFm.venue || '').trim() && work.venue) {
    nextFm.venue = String(work.venue);
  }
  if (!String(nextFm.venueType || '').trim() && work.venueType) {
    nextFm.venueType = String(work.venueType);
  }
  if (!String(nextFm.venueStatus || '').trim() && work.venueStatus) {
    nextFm.venueStatus = String(work.venueStatus);
  }
  if (nextFm.isPreprint === undefined && work.isPreprint !== undefined) {
    nextFm.isPreprint = Boolean(work.isPreprint);
  }
  if (!(Number(nextFm.citedByCount) > 0) && Number(work.citedByCount) > 0) {
    nextFm.citedByCount = Number(work.citedByCount);
    nextFm.citationFetchedAt = stamp;
  }
  if (!String(nextFm.citedByApiUrl || '').trim() && work.citedByApiUrl) {
    nextFm.citedByApiUrl = String(work.citedByApiUrl);
  }
  if (!String(nextFm.oaUrl || '').trim() && work.oaUrl) {
    nextFm.oaUrl = String(work.oaUrl);
  }
  if (!String(nextFm.pdfUrl || '').trim() && work.pdfUrl) {
    nextFm.pdfUrl = String(work.pdfUrl);
  }
  if (!String(nextFm.codeUrl || '').trim() && work.codeUrl) {
    nextFm.codeUrl = String(work.codeUrl);
  }
  if (!String(nextFm.summary || '').trim() && String(work.abstractExcerpt || '').trim()) {
    nextFm.summary = String(work.abstractExcerpt).trim();
    if (!nextFm.summarySource) nextFm.summarySource = 'excerpt';
  }

  nextFm.metadataHydratedAt = stamp;
  nextFm.updatedAt = stamp;

  return {
    ok: true,
    id,
    updated: true,
    skipped: false,
    openalexId: (nextFm.externalIds && nextFm.externalIds.openalex) || '',
    referenceCount: Array.isArray(nextFm.references) ? nextFm.references.length : 0,
    frontmatter: nextFm,
    resolvedFrom
  };
}

/** 批量补全工作区论文元数据与参考文献（先批量 fetchOpenAlexWorksByIds，再并发补全剩余条目）。 */
async function hydrateWorkspacePapers(ws, paperIds = null, opts = {}) {
  const targetWs = String(ws || store.getConfig().currentWorkspace || '').trim();
  if (!targetWs) {
    return { ok: false, updatedCount: 0, skippedCount: 0, errors: [{ id: '', error: '缺少工作区' }], papers: [] };
  }
  const apiKey = String(opts.apiKey || (store.getConfig().openalex || {}).apiKey || '');
  const force = Boolean(opts.force);
  const allPapers = store.listItems(targetWs, 'papers') || [];
  const filterSet = Array.isArray(paperIds) && paperIds.length
    ? new Set(paperIds.map((x) => String(x || '').trim()).filter(Boolean))
    : null;
  const targets = filterSet ? allPapers.filter((p) => filterSet.has(p.id)) : allPapers;

  const preloadedMap = new Map();
  const knownOids = [];
  for (const p of targets) {
    if (!paperNeedsHydration(p, force)) continue;
    const oid = workIdOf((p.externalIds && p.externalIds.openalex) || p.openalexId);
    if (oid) knownOids.push(oid);
  }
  if (knownOids.length) {
    try {
      const batchWorks = await connectors.fetchOpenAlexWorksByIds(knownOids, apiKey);
      for (const w of batchWorks) {
        if (w && w.openalexId) preloadedMap.set(w.openalexId, w);
      }
    } catch (_) { /* 批量失败时自动退回单条解析 */ }
  }

  const concurrency = Math.max(1, Math.min(5, Number(opts.concurrency) || 3));
  const results = new Array(targets.length);
  let cursor = 0;

  async function worker() {
    while (cursor < targets.length) {
      const idx = cursor++;
      const summaryItem = targets[idx];
      try {
        const fullItem = store.getItem(targetWs, 'papers', summaryItem.id);
        if (!fullItem) {
          results[idx] = { id: summaryItem.id, updated: false, skipped: true };
          continue;
        }
        const fm = fullItem.frontmatter || {};
        const oid = workIdOf((fm.externalIds && fm.externalIds.openalex) || fm.openalexId);
        const preloadedWork = oid ? preloadedMap.get(oid) : null;
        const res = await hydratePaperMetadata(fullItem, { apiKey, preloadedWork, force, allowArxivFallback: opts.allowArxivFallback });
        if (res.updated) {
          store.saveItem(targetWs, 'papers', fullItem.id, {
            frontmatter: res.frontmatter,
            body: fullItem.body || ''
          });
        }
        results[idx] = {
          id: fullItem.id,
          updated: res.updated,
          skipped: res.skipped,
          openalexId: res.openalexId,
          referenceCount: res.referenceCount,
          resolvedFrom: res.resolvedFrom
        };
      } catch (e) {
        results[idx] = {
          id: summaryItem.id,
          updated: false,
          skipped: false,
          error: (e && e.message) || String(e)
        };
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, targets.length)) }, () => worker()));

  let updatedCount = 0;
  let skippedCount = 0;
  const errors = [];
  const papers = [];
  for (const r of results) {
    if (!r) continue;
    if (r.error) errors.push({ id: r.id, error: r.error });
    else if (r.updated) updatedCount++;
    else skippedCount++;
    papers.push(r);
  }

  return { ok: true, updatedCount, skippedCount, errors, papers };
}

/** 经典 OpenAlex 单源检索路径（保持与既有单测 A8–A14 100% 行为一致）。 */
async function legacyOpenAlexSearch(opts = {}) {
  const ws = String(opts.ws || store.getConfig().currentWorkspace || '');
  const query = String(opts.query || '').trim();
  if (!query) throw new Error('请输入检索提示词');
  const perPage = Math.max(1, Math.min(50, Number(opts.perPage) || 10));
  const sort = String(opts.sort || 'relevance');
  const apiKey = String(opts.apiKey || (store.getConfig().openalex || {}).apiKey || '');

  let effectiveQuery = query;
  if (opts.useAiStrategy !== false) {
    const api = store.getConfig().api || {};
    if (api.apiKey) {
      let seeds = [];
      try {
        seeds = store.listItems(ws, 'papers')
          .slice(0, 8)
          .map((it) => String(it.shortName || it.title || '').trim())
          .filter(Boolean);
      } catch (_) { seeds = []; }
      effectiveQuery = await ai.searchStrategy(query, seeds) || query;
    }
  }

  const queries = Array.from(new Map([query, effectiveQuery]
    .map((term) => [term.trim().toLowerCase().replace(/\s+/g, ' '), term.trim()])
    .filter(([key]) => !!key)).values());
  const fetchQuery = async (term) => {
    const params = new URLSearchParams({
      search: term,
      'per-page': String(perPage),
      select: SELECT_FIELDS
    });
    if (sort === 'cited_by_count:desc' || sort === 'publication_date:desc') params.set('sort', sort);
    const data = await request(`${API_BASE}/works?${params.toString()}`, apiKey);
    return Array.isArray(data && data.results) ? data.results : [];
  };
  const outcomes = await Promise.allSettled(queries.map(fetchQuery));
  const failures = outcomes
    .filter((outcome) => outcome.status === 'rejected')
    .map((outcome) => (outcome.reason && outcome.reason.message) || String(outcome.reason));
  const merged = new Map();
  let encounterOrder = 0;
  outcomes.forEach((outcome, queryIndex) => {
    if (outcome.status !== 'fulfilled') return;
    outcome.value
      .filter((work) => work && String(work.title || '').trim() && !/dataset|institution/i.test(String(work.type || '')))
      .forEach((work, rank) => {
        const paper = normalizeWork(work);
        if (!paper.openalexId) return;
        const doi = String(paper.doi || '').trim().toLowerCase().replace(/^https?:\/\/doi\.org\//i, '');
        const title = String(paper.title || '').toLowerCase().replace(/\s+/g, ' ').trim();
        const key = doi ? `doi:${doi}` : (paper.openalexId ? `openalex:${paper.openalexId}` : `title:${title}`);
        let entry = merged.get(key);
        if (!entry) {
          entry = { paper, score: 0, matchedQueries: new Set(), order: encounterOrder };
          merged.set(key, entry);
        }
        entry.score += 1 / (60 + rank + 1);
        entry.matchedQueries.add(queryIndex);
        encounterOrder++;
      });
  });
  const ranked = Array.from(merged.values()).sort((a, b) => b.score - a.score || a.order - b.order);
  if (!ranked.length && failures.length) {
    throw new Error(`检索式执行失败或没有可用结果：${failures.join('；')}`);
  }
  const papers = ranked.slice(0, perPage).map((entry) => ({
    ...entry.paper,
    searchQueryMatchCount: entry.matchedQueries.size,
    ...(failures.length ? { searchWarnings: failures } : {})
  }));
  return markDuplicates(ws, papers);
}

/**
 * 增强多源 + 内嵌 GitHub Skill 论文检索管线。
 * @param {object} opts
 * @returns {Promise<{papers: object[], meta: object}>}
 */
async function discover(opts = {}) {
  const startedAt = Date.now();
  const cfg = store.getConfig() || {};
  const ws = String(opts.ws || cfg.currentWorkspace || '');
  const query = String(opts.query || '').trim();
  if (!query) throw new Error('请输入检索提示词');

  const skill = skills.getSearchSkill(opts.skillId || 'paper-search-pro')
    || skills.listSearchSkills({ includeContent: true })[0]
    || {
      id: 'paper-search-pro',
      name: 'Paper Search Pro',
      defaultSources: ['openalex', 'arxiv', 'openreview', 'huggingface'],
      defaultSort: 'frontier',
      maxQueries: 3,
      enableSnowball: false,
      enableRcsScreening: false,
      excludeRejected: true,
      content: ''
    };

  const perPage = Math.max(5, Math.min(50, Number(opts.perPage) || 20));
  const sort = String(opts.sort || skill.defaultSort || 'frontier');
  const oaApiKey = String(opts.apiKey || (cfg.openalex || {}).apiKey || '');
  const s2ApiKey = String(opts.s2ApiKey || (cfg.search || {}).semanticScholarApiKey || '');
  const useWorkspaceSeeds = opts.useWorkspaceSeeds !== false;
  const rawSources = Array.isArray(opts.sources) && opts.sources.length
    ? opts.sources
    : (Array.isArray(skill.defaultSources) && skill.defaultSources.length ? skill.defaultSources : ['openalex']);
  const sourcesUsed = Array.from(new Set(
    rawSources.map((s) => String(s || '').trim().toLowerCase()).filter((s) => skills.ALL_SOURCES.includes(s))
  ));
  if (!sourcesUsed.length) sourcesUsed.push('openalex');

  const filters = {
    excludeRejected: skill.excludeRejected !== false,
    ...(opts.filters && typeof opts.filters === 'object' ? opts.filters : {})
  };
  if (!opts.filters && Number(skill.recentYears) > 0 && !filters.yearFrom) {
    filters.yearFrom = new Date().getUTCFullYear() - Number(skill.recentYears) + 1;
  }
  const seeds = useWorkspaceSeeds ? collectWorkspaceSeeds(ws) : { titles: [], openalexSeeds: [] };

  // STEP 1: Skill 驱动的多角度查询规划
  let plan = ai.fallbackSearchPlan(query, skill.maxQueries || 3);
  if (opts.useAiStrategy !== false) {
    plan = await ai.planSearchQueries({
      query,
      localSeeds: seeds.titles,
      skillContent: skill.content || '',
      skillName: skill.name || skill.id,
      maxQueries: skill.maxQueries || 3
    });
  }

  // 合并原始查询 + AI 规划查询（去重），优先保证中文/中英混合问题也有英文检索词
  const hasCjk = /[\u4e00-\u9fa5]/.test(query);
  const plannedList = Array.isArray(plan.queries) ? plan.queries.slice() : [];
  const queryMap = new Map();
  if (!hasCjk || !plan.usedAi) {
    queryMap.set(query.toLowerCase().replace(/\s+/g, ' '), { term: query, angle: '原始问题' });
  }
  for (const item of plannedList) {
    const term = String((item && item.term) || '').trim();
    const key = term.toLowerCase().replace(/\s+/g, ' ');
    if (term && !queryMap.has(key)) queryMap.set(key, { term, angle: item.angle || 'Skill 扩展' });
  }
  if (!queryMap.size) queryMap.set(query.toLowerCase(), { term: query, angle: '原始问题' });
  const executedQueries = Array.from(queryMap.values()).slice(0, Math.max(2, skill.maxQueries || 3));
  const englishFirstQueries = executedQueries.filter((q) => !/[\u4e00-\u9fa5]/.test(q.term));
  let externalQueries = englishFirstQueries;
  if (!externalQueries.length && hasCjk) {
    const asciiTerms = (query.match(/[A-Za-z][A-Za-z0-9_-]{1,}/g) || []).slice(0, 6).join(' ');
    externalQueries = asciiTerms ? [{ term: asciiTerms, angle: '英文术语提取' }] : executedQueries;
  }
  if (!externalQueries.length) externalQueries = executedQueries;

  // STEP 2: 跨源并发检索（arXiv 多查询串行错峰避免 429，其余源并行）
  const tasks = [];
  const sourceLimit = Math.min(30, Math.max(12, Math.ceil(perPage * 0.9)));
  const sourceStats = new Map(sourcesUsed.map((s) => [s, {
    source: s,
    label: connectors.SOURCE_LABELS[s] || s,
    ok: false,
    count: 0,
    latencyMs: 0,
    error: ''
  }]));

  const batches = [];
  const warnings = [];
  let totalRaw = 0;

  const recordOutcome = (source, queryIndex, queryTerm, papers, latencyMs) => {
    const stat = sourceStats.get(source);
    const list = Array.isArray(papers) ? papers : [];
    stat.ok = true;
    stat.count += list.length;
    stat.latencyMs = Math.max(stat.latencyMs, latencyMs || 0);
    totalRaw += list.length;
    const weight = source === 'openalex' ? 1.15
      : source === 'openreview' ? 1.1
        : source === 'huggingface' ? 1.05
          : 1.0;
    batches.push({ source, queryIndex, queryTerm, weight, papers: list });
  };

  const recordError = (source, err) => {
    const stat = sourceStats.get(source);
    const msg = friendlySourceError(source, err);
    if (!stat.error) stat.error = msg;
    if (!warnings.includes(msg)) warnings.push(msg);
  };

  sourcesUsed.forEach((source) => {
    if (source === 'arxiv') {
      // arXiv 限流严格：同一源内多查询串行执行（query 0 相关性优先便于跨源融合，query 1 按提交时间兜底最新预印本）
      const arxivQs = externalQueries.slice(0, 2);
      tasks.push(async () => {
        for (let qIdx = 0; qIdx < arxivQs.length; qIdx++) {
          if (qIdx > 0) await new Promise((r) => setTimeout(r, 350));
          const qObj = arxivQs[qIdx];
          const t0 = Date.now();
          try {
            const arxivSortBy = sort === 'publication_date:desc'
              ? 'submittedDate'
              : (qIdx === 0 ? 'relevance' : 'submittedDate');
            const list = await connectors.searchSource('arxiv', qObj.term, {
              perPage: sourceLimit,
              sort,
              arxivSortBy,
              arxivCategories: plan.arxivCategories || []
            });
            recordOutcome('arxiv', qIdx, qObj.term, list, Date.now() - t0);
          } catch (err) {
            recordError('arxiv', err);
          }
        }
      });
      return;
    }

    let qsForSource = externalQueries.slice(0, 1);
    if (source === 'openalex') qsForSource = executedQueries.slice(0, 3);
    else if (source === 'openreview' || source === 'huggingface' || source === 'crossref') qsForSource = externalQueries.slice(0, 2);
    else if (source === 'semanticscholar') qsForSource = externalQueries.slice(0, 1);

    qsForSource.forEach((qObj, qIdx) => {
      tasks.push(async () => {
        const t0 = Date.now();
        try {
          const list = await connectors.searchSource(source, qObj.term, {
            perPage: sourceLimit,
            sort,
            apiKey: oaApiKey,
            s2ApiKey,
            yearFrom: filters.yearFrom,
            yearTo: filters.yearTo,
            minCitations: filters.minCitations,
            hasPdfOnly: filters.hasPdfOnly,
            excludeRejected: filters.excludeRejected
          });
          recordOutcome(source, qIdx, qObj.term, list, Date.now() - t0);
        } catch (err) {
          recordError(source, err);
        }
      });
    });
  });

  await Promise.allSettled(tasks.map((run) => run()));

  // STEP 3: 引文滚雪球扩展（当启用 citation-snowball Skill 或显式开启时）
  const enableSnowball = opts.enableSnowball !== undefined ? Boolean(opts.enableSnowball) : Boolean(skill.enableSnowball);
  const snowballSeeds = [];
  if (enableSnowball) {
    // 按 rrfScore 降序选取最相关 OpenAlex 种子，避免按随机返回序挑到弱相关论文
    const prelimFused = fusion.fusePapers(batches)
      .sort((a, b) => (Number(b.rrfScore) || 0) - (Number(a.rrfScore) || 0));
    const oaHits = prelimFused.filter((p) => p.openalexId).slice(0, 2);
    // 仅当工作区必引论文与本次查询有主题词重合时才作为额外种子，防止跨主题串味
    const relevantWsCandidates = seeds.openalexSeeds
      .filter((s) => s.starred && seedMatchesQueryTerms(s, executedQueries))
      .slice(0, 1);
    const resolvedWsSeeds = [];
    for (const wsSeed of relevantWsCandidates) {
      if (wsSeed.openalexId) {
        resolvedWsSeeds.push(wsSeed);
      } else {
        try {
          const hit = await resolveOpenAlexWork(wsSeed, oaApiKey);
          if (hit && hit.openalexId) resolvedWsSeeds.push(hit);
        } catch (_) { /* 无法解析则跳过 */ }
      }
    }
    const chosenSeeds = [];
    const seenSeedIds = new Set();
    for (const s of [...oaHits, ...resolvedWsSeeds]) {
      if (s && s.openalexId && !seenSeedIds.has(s.openalexId)) {
        seenSeedIds.add(s.openalexId);
        chosenSeeds.push(s);
      }
    }
    if (chosenSeeds.length) {
      const snowRes = await runSnowballForSeeds(chosenSeeds, {
        direction: skill.snowballDirection || 'both',
        apiKey: oaApiKey,
        perSeed: 12
      });
      chosenSeeds.forEach((s) => snowballSeeds.push({ openalexId: s.openalexId, title: s.title }));
      snowRes.batches.forEach((b) => {
        totalRaw += b.papers.length;
        batches.push(b);
      });
      snowRes.warnings.forEach((w) => {
        if (!warnings.includes(w)) warnings.push(w);
      });
    }
  }

  // STEP 4: 跨源去重、载体升级与元数据融合
  let fused = fusion.fusePapers(batches);
  if (!fused.length && warnings.length) {
    throw new Error(`所有检索源均未返回可用结果：${warnings.join('；')}`);
  }

  // STEP 5: 标记本地重复项
  markDuplicates(ws, fused);

  // STEP 6: 过滤、计算前沿度并排序
  let ranked = fusion.filterAndSortPapers(fused, { filters, sort });

  // STEP 7: 可选 AI 相关性筛选（paper-search-pro RCS 0–10）
  const enableAiScreening = opts.enableAiScreening !== undefined
    ? Boolean(opts.enableAiScreening)
    : Boolean(skill.enableRcsScreening && opts.allowAutoScreening);
  let rcsApplied = false;
  if (enableAiScreening && ranked.length && (cfg.api && cfg.api.apiKey)) {
    const topSlice = ranked.slice(0, 15);
    const rcsList = await ai.screenPapersRelevance({
      query,
      papers: topSlice,
      localSeeds: seeds.titles,
      skillContent: skill.content || ''
    });
    if (rcsList.length) {
      rcsApplied = true;
      rcsList.forEach((item) => {
        const p = topSlice[item.idx];
        if (!p) return;
        p.rcsScore = item.rcs;
        p.rcsReason = item.why;
        const rescored = fusion.scoreFrontierPaper(p);
        p.frontierScore = rescored.frontierScore;
        p.frontierSignals = rescored.frontierSignals;
      });
      ranked = fusion.filterAndSortPapers(ranked, { filters, sort });
    }
  }

  const finalPapers = ranked.slice(0, perPage).map((paper) => {
    const clean = { ...paper };
    delete clean._encounterOrder;
    if (warnings.length) clean.searchWarnings = warnings;
    return clean;
  });

  const meta = {
    query,
    skill: {
      id: skill.id,
      name: skill.name,
      badge: skill.badge,
      githubRepo: skill.githubRepo,
      version: skill.version
    },
    plan: {
      usedAi: Boolean(plan.usedAi),
      intent: plan.intent,
      framework: plan.framework,
      queries: executedQueries,
      booleanQuery: plan.booleanQuery,
      arxivCategories: plan.arxivCategories || []
    },
    sourcesUsed,
    sourceDiagnostics: Array.from(sourceStats.values()),
    warnings,
    totalRaw,
    totalFused: fused.length,
    totalFiltered: ranked.length,
    rcsApplied,
    snowballSeeds,
    elapsedMs: Date.now() - startedAt
  };

  return { papers: finalPapers, meta };
}

/** 针对若干种子论文执行双向引文滚雪球（Forward citedBy + Backward 共同参考文献）。 */
async function runSnowballForSeeds(seeds, { direction = 'both', apiKey = '', perSeed = 15 } = {}) {
  const batches = [];
  const warnings = [];
  const doForward = direction === 'forward' || direction === 'both';
  const doBackward = direction === 'backward' || direction === 'both';

  // Forward: 谁引用了种子（按最新发表优先，专门挖前沿后续改进！）
  if (doForward) {
    const forwardJobs = seeds.map(async (seed) => {
      const params = new URLSearchParams({
        filter: `cites:${seed.openalexId}`,
        'per-page': String(perSeed),
        sort: 'publication_date:desc',
        select: SELECT_FIELDS
      });
      const url = `${API_BASE}/works?${params.toString()}${apiKey ? `&api_key=${encodeURIComponent(apiKey)}` : ''}`;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 10000);
      let resp;
      try {
        resp = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'research-workbench/4.0' }, signal: ctrl.signal });
      } finally {
        clearTimeout(timer);
      }
      if (!resp.ok) {
        const err = new Error(`HTTP ${resp.status}`);
        err.status = resp.status;
        throw err;
      }
      const data = await resp.json();
      const results = Array.isArray(data && data.results) ? data.results : [];
      return results
        .filter((w) => w && String(w.title || '').trim() && !/dataset|institution/i.test(String(w.type || '')))
        .map(normalizeWork)
        .filter((p) => p.openalexId)
        .map((p) => ({
          ...p,
          snowballRole: 'forward',
          snowballReasons: [`引用了「${String(seed.title || seed.openalexId).slice(0, 36)}」`]
        }));
    });
    const settled = await Promise.allSettled(forwardJobs);
    settled.forEach((res, i) => {
      if (res.status === 'fulfilled' && res.value.length) {
        batches.push({ source: 'openalex', queryIndex: 100 + i, weight: 0.95, papers: res.value });
      } else if (res.status === 'rejected') {
        const msg = friendlySourceError('openalex', res.reason);
        if (!warnings.includes(msg)) warnings.push(msg);
      }
    });
  }

  // Backward: 种子引用的关键参考文献（多篇种子共同引用优先）
  if (doBackward) {
    const refFreq = new Map();
    const refOwners = new Map();
    seeds.forEach((seed) => {
      const refs = Array.isArray(seed.referencedWorks) ? seed.referencedWorks : [];
      for (const r of refs.slice(0, 40)) {
        const wid = workIdOf(r);
        if (!wid) continue;
        refFreq.set(wid, (refFreq.get(wid) || 0) + 1);
        if (!refOwners.has(wid)) refOwners.set(wid, []);
        refOwners.get(wid).push(String(seed.title || seed.openalexId).slice(0, 30));
      }
    });
    const topRefIds = Array.from(refFreq.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 18)
      .map(([wid]) => wid);
    if (topRefIds.length) {
      const backPapers = await connectors.fetchOpenAlexWorksByIds(topRefIds, apiKey);
      const tagged = backPapers.map((p) => {
        const owners = refOwners.get(p.openalexId) || [];
        return {
          ...p,
          snowballRole: 'backward',
          snowballReasons: [owners.length > 1 ? `被 ${owners.length} 篇种子共同引用` : `「${owners[0] || '种子论文'}」的基础参考文献`]
        };
      });
      if (tagged.length) {
        batches.push({ source: 'openalex', queryIndex: 200, weight: 0.85, papers: tagged });
      }
    }
  }

  return { batches, warnings };
}

/**
 * 统一 search 入口：
 * - 无增强参数时走既有 OpenAlex 路径（返回 NormalizedPaper[]），保障全部历史单测兼容
 * - 传入 skillId / sources / filters / returnMeta / multiSource 时走完整多源 Skill 管线
 */
async function search(opts = {}) {
  const isEnhanced = Boolean(
    opts && (opts.skillId || opts.sources || opts.multiSource || opts.filters || opts.returnMeta || opts.enableSnowball || opts.enableAiScreening)
  );
  if (!isEnhanced) {
    return legacyOpenAlexSearch(opts);
  }
  const result = await discover(opts);
  return opts.returnMeta ? result : result.papers;
}

/** 单篇论文 1-Click 双向引文追踪（Snowball）：按精确 DOI / arXiv DOI / 标题严格解析，绝不误匹配无关论文。 */
async function snowball(paperOrId, opts = {}) {
  const startedAt = Date.now();
  const cfg = store.getConfig() || {};
  const ws = String(opts.ws || cfg.currentWorkspace || '');
  const apiKey = String(opts.apiKey || (cfg.openalex || {}).apiKey || '');
  const direction = ['forward', 'backward', 'both'].includes(opts.direction) ? opts.direction : 'both';
  const perPage = Math.max(5, Math.min(40, Number(opts.perPage) || 20));

  const rawSeed = typeof paperOrId === 'string'
    ? { openalexId: workIdOf(paperOrId), title: '', referencedWorks: [] }
    : { ...(paperOrId || {}) };

  if (!workIdOf(rawSeed.openalexId) && !rawSeed.doi && !rawSeed.arxivId && !rawSeed.title) {
    throw new Error('该论文缺少 OpenAlex ID / 标题，无法执行引文追踪');
  }

  const seed = await resolveOpenAlexWork(rawSeed, apiKey);
  if (!seed || !seed.openalexId) {
    throw new Error('暂未在 OpenAlex 引文库中索引到这篇新论文（刚发布的预印本可能尚未建立引文记录）');
  }

  const snowRes = await runSnowballForSeeds([seed], { direction, apiKey, perSeed: Math.min(25, perPage) });
  const fused = fusion.fusePapers(snowRes.batches).filter((p) => p.openalexId !== seed.openalexId);
  markDuplicates(ws, fused);
  const ranked = fusion.filterAndSortPapers(fused, { sort: opts.sort || 'frontier' }).slice(0, perPage);
  const cleanPapers = ranked.map((p) => { const c = { ...p }; delete c._encounterOrder; return c; });

  return {
    seed: { openalexId: seed.openalexId, title: seed.title || seed.openalexId },
    papers: cleanPapers,
    meta: {
      query: `引文追踪：${seed.title || seed.openalexId}`,
      skill: { id: 'citation-snowball', name: 'Citation Snowball · 引文滚雪球追踪', badge: '引文溯源' },
      plan: {
        usedAi: false,
        intent: `围绕「${String(seed.title || seed.openalexId).slice(0, 40)}」执行前向引用与后向奠基追踪`,
        framework: 'Snowball',
        queries: [{ term: `cites:${seed.openalexId}`, angle: '前向引文' }, { term: `references(${(seed.referencedWorks || []).length})`, angle: '后向奠基' }],
        booleanQuery: ''
      },
      sourcesUsed: ['openalex'],
      sourceDiagnostics: [{
        source: 'openalex',
        label: 'OpenAlex 引文网',
        ok: snowRes.warnings.length === 0 || cleanPapers.length > 0,
        count: cleanPapers.length,
        latencyMs: Date.now() - startedAt,
        error: snowRes.warnings[0] || ''
      }],
      warnings: snowRes.warnings,
      totalRaw: cleanPapers.length,
      totalFused: cleanPapers.length,
      totalFiltered: cleanPapers.length,
      snowballSeeds: [{ openalexId: seed.openalexId, title: seed.title }],
      elapsedMs: Date.now() - startedAt
    }
  };
}

/** 今日前沿论文雷达（Hugging Face Daily Papers，无需输入关键词即可发现当日最热 AI/机器人论文）。 */
async function dailyFrontier(opts = {}) {
  const startedAt = Date.now();
  const cfg = store.getConfig() || {};
  const ws = String(opts.ws || cfg.currentWorkspace || '');
  const limit = Math.max(10, Math.min(50, Number(opts.limit) || 25));
  const filterText = String(opts.query || '').trim().toLowerCase();

  const daily = await connectors.fetchHuggingFaceDaily({ limit });
  const fused = fusion.fusePapers([{ source: 'huggingface', queryIndex: 0, weight: 1.1, papers: daily }]);
  markDuplicates(ws, fused);
  let ranked = fusion.filterAndSortPapers(fused, { sort: 'frontier' });
  let filterFallback = false;
  if (filterText) {
    const terms = filterText.split(/\s+/).filter(Boolean);
    const narrowed = ranked.filter((p) => {
      const hay = `${p.title} ${p.abstract} ${(p.keywords || []).join(' ')}`.toLowerCase();
      return terms.some((t) => hay.includes(t));
    });
    if (narrowed.length) {
      ranked = narrowed;
    } else {
      filterFallback = true;
    }
  }
  const cleanPapers = ranked.slice(0, limit).map((p) => { const c = { ...p }; delete c._encounterOrder; return c; });
  const queryLabel = !filterText
    ? '今日前沿论文（Hugging Face Daily Papers）'
    : (filterFallback ? `今日前沿（未命中「${filterText}」，已展示今日全部热门）` : `今日前沿（筛选：${filterText}）`);
  return {
    papers: cleanPapers,
    meta: {
      query: queryLabel,
      filterFallback,
      skill: { id: 'frontier-sota-radar', name: 'Frontier SOTA Radar · 今日前沿雷达', badge: '前沿追踪' },
      plan: {
        usedAi: false,
        intent: filterFallback
          ? `今日精选未包含「${filterText}」，已回退展示当日全部热门前沿论文`
          : '实时拉取 Hugging Face 社区精选前沿论文与开源代码热度',
        framework: 'Frontier',
        queries: [{ term: 'Hugging Face Daily Papers', angle: filterFallback ? '全部热门' : '今日精选' }],
        booleanQuery: ''
      },
      sourcesUsed: ['huggingface'],
      sourceDiagnostics: [{ source: 'huggingface', label: 'HF Daily Papers', ok: true, count: cleanPapers.length, latencyMs: Date.now() - startedAt, error: '' }],
      warnings: filterFallback ? [`今日精选未命中「${filterText}」，已展示当日全部热门论文`] : [],
      totalRaw: daily.length,
      totalFused: fused.length,
      totalFiltered: cleanPapers.length,
      elapsedMs: Date.now() - startedAt
    }
  };
}

/** 判定主机名是否指向回环/内网/链路本地地址（同时防御 IPv6 方括号、mapped IPv4、整数 IP 混淆）。 */
function isPrivateOrLocalHost(rawHostname) {
  const host = String(rawHostname || '').toLowerCase().replace(/^\[|\]$/g, '').trim();
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return true;
  if (host === '::' || host === '::1' || host === '0:0:0:0:0:0:0:1' || host === '0.0.0.0') return true;
  if (/^\d+$/.test(host) || /^0x[0-9a-f]+$/i.test(host)) return true; // 整数 / 十六进制 IP 混淆
  // IPv4-mapped IPv6（如 ::ffff:127.0.0.1 或 ::ffff:7f00:1）
  if (host.startsWith('::ffff:')) {
    const tail = host.slice(7);
    if (/^\d+\.\d+\.\d+\.\d+$/.test(tail)) return isPrivateOrLocalHost(tail);
    return true;
  }
  // IPv6 链路本地 (fe80::/10) 与唯一本地地址 (fc00::/7)
  if (/^(?:fe[89ab][0-9a-f]|f[cd][0-9a-f]{2}):/i.test(host)) return true;
  // IPv4 私有、回环、链路本地、CGNAT、0.0.0.0/8
  if (/^(?:0|10|127)\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^169\.254\./.test(host)) return true;
  if (/^172\.(?:1[6-9]|2\d|3[01])\./.test(host)) return true;
  if (/^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host)) return true;
  return false;
}

/** 安全下载开放获取 PDF（如 arXiv / OpenReview PDF）到本地工作区 pdfs/。 */
function validatePdfUrl(rawUrl) {
  let parsed;
  try { parsed = new URL(String(rawUrl || '').trim()); } catch (_) { throw new Error('无效的 PDF 链接'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('PDF 链接协议不受支持');
  if (isPrivateOrLocalHost(parsed.hostname)) {
    throw new Error('不允许下载内网地址');
  }
  return parsed.toString();
}

async function downloadPaperPdf(ws, paper = {}) {
  let currentUrl = validatePdfUrl(paper.pdfUrl || (paper.arxivId ? `https://arxiv.org/pdf/${paper.arxivId}.pdf` : ''));
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 18000);
  try {
    let resp = null;
    for (let hop = 0; hop <= 5; hop++) {
      resp = await fetch(currentUrl, {
        headers: { Accept: 'application/pdf, */*', 'User-Agent': 'research-workbench/4.0' },
        redirect: 'manual',
        signal: ctrl.signal
      });
      if (resp.status >= 300 && resp.status < 400 && resp.headers && resp.headers.get('location')) {
        if (hop === 5) throw new Error('PDF 重定向次数过多');
        const nextUrl = new URL(resp.headers.get('location'), currentUrl).toString();
        currentUrl = validatePdfUrl(nextUrl);
        continue;
      }
      break;
    }
    clearTimeout(timer);
    if (!resp || !resp.ok) throw new Error(`PDF 下载失败（HTTP ${(resp && resp.status) || 'ERR'}）`);
    if (resp.url) validatePdfUrl(resp.url);
    const contentLen = Number((resp.headers && resp.headers.get && resp.headers.get('content-length')) || 0);
    if (contentLen > MAX_PDF_BYTES) throw new Error('PDF 文件超过 40MB 上限');
    const arrBuf = await resp.arrayBuffer();
    if (arrBuf.byteLength > MAX_PDF_BYTES) throw new Error('PDF 文件超过 40MB 上限');
    const buf = Buffer.from(arrBuf);
    const shortHint = String(paper.title || paper.arxivId || 'paper').split(/[:：]/)[0].trim().slice(0, 48);
    const hint = paper.arxivId ? `${shortHint}_arXiv-${paper.arxivId}` : shortHint;
    return store.saveDownloadedPdf(ws, hint, buf);
  } catch (e) {
    clearTimeout(timer);
    if (e && e.name === 'AbortError') throw new Error('PDF 下载超时');
    throw e;
  }
}

/** 导出检索结果为 BibTeX 或 Markdown 综述矩阵。 */
function exportResults(papers = [], format = 'bibtex') {
  const list = Array.isArray(papers) ? papers : [];
  if (!list.length) throw new Error('没有可导出的论文');
  if (format === 'markdown') return fusion.exportMarkdownTable(list);
  return fusion.exportBibtex(list);
}

/** 谁引用了它（按需联网，默认脉络图不逐节点调用）。 */
async function citedBy(openalexId, opts = {}) {
  const id = workIdOf(openalexId);
  if (!id) throw new Error('缺少 OpenAlex ID');
  const perPage = Math.max(1, Math.min(50, Number(opts.perPage) || 50));
  const apiKey = String(opts.apiKey || (store.getConfig().openalex || {}).apiKey || '');
  const params = new URLSearchParams({
    filter: `cites:${id}`,
    'per-page': String(perPage),
    select: SELECT_FIELDS
  });
  const data = await request(`${API_BASE}/works?${params.toString()}`, apiKey);
  const results = Array.isArray(data && data.results) ? data.results : [];
  return results
    .filter((w) => w && String(w.title || '').trim() && !/dataset|institution/i.test(String(w.type || '')))
    .map(normalizeWork)
    .filter((p) => p.openalexId)
    .slice(0, perPage);
}

/**
 * P1-4：按已入库论文的 externalIds.openalex 重抓引用量。
 * 单条失败不影响其它条目，失败项带 error 字段由渲染层提示并保留旧值。
 */
async function refreshCitations(ws, ids = []) {
  const apiKey = String((store.getConfig().openalex || {}).apiKey || '');
  const targets = [];
  for (const id of (Array.isArray(ids) ? ids : [])) {
    const item = store.getItem(ws, 'papers', id);
    if (!item) continue;
    const fm = item.frontmatter || {};
    const oid = workIdOf((fm.externalIds || {}).openalex || fm.openalexId);
    if (oid) targets.push({ id, oid });
  }
  const out = [];
  for (const t of targets) {
    try {
      const data = await request(`${API_BASE}/works/${t.oid}?select=id,cited_by_count`, apiKey);
      out.push({
        id: t.id,
        citedByCount: Number(data && data.cited_by_count) || 0,
        citationFetchedAt: new Date().toISOString().slice(0, 10)
      });
    } catch (e) {
      out.push({ id: t.id, error: (e && e.message) || String(e) });
    }
  }
  return out;
}

module.exports = {
  // 既有核心 API（保持完全兼容）
  search, citedBy, refreshCitations,
  normalizeWork, restoreAbstract, excerpt, workIdOf, isPreprint,
  // 增强多源检索 / 前沿发现 / 引文滚雪球 / PDF 下载 / 导出 / 元数据补全
  discover, snowball, dailyFrontier, downloadPaperPdf, exportResults,
  resolveOpenAlexWork, hydratePaperMetadata, hydrateWorkspacePapers,
  // 内嵌与自定义 GitHub 检索 Skills 管理
  listSearchSkills: skills.listSearchSkills,
  getSearchSkill: skills.getSearchSkill,
  discoverGithubSkillFiles: skills.discoverGithubSkillFiles,
  importSearchSkillFromUrl: skills.importSearchSkillFromUrl,
  importSearchSkillFromFile: skills.importSearchSkillFromFile,
  saveSearchSkill: skills.saveSearchSkill,
  deleteSearchSkill: skills.deleteSearchSkill
};
