/**
 * src/main/services/lineage-service.js — 论文脉络核心分析服务（M2）
 * 融合以下 GitHub 开源研究方法（均以纯 JS clean-room 实现并支持离线确定性降级）：
 *   - LocalCitationNetwork: 排序本地库未展开引文 -> 发现缺失奠基文献（Top Cited）与后续跟进文献（Top Citing）
 *   - inciteful-xyz: 两篇论文之间的最短演化路径 BFS 发现（有向引文优先，必要时回退桥接关系）
 *   - belinghy/paper-lineage: 核心骨干 DAG 抽取（去环、分层拓扑秩、低信噪比耦合边剪枝、节点角色识别）
 *   - unumbrela/PaperWeave + NeuraLiying/research-weave-skill + K-Dense literature-review + OpenScholar:
 *     Skill 驱动的学术谱系综合、六列对比矩阵、渐进阅读队列与严格 [paperId] 引用核验
 */
'use strict';

const store = require('../store');
const ai = require('../ai');
const openalex = require('../openalex');
const connectors = require('../search/connectors');
const skills = require('../search/skills');

const DIRECT_VIAS = new Set(['references', 'referenced_works', 'cites', 'notes']);
const ALLOWED_ROLES = new Set(['foundation', 'bridge', 'branch', 'frontier', 'survey', 'focus', 'isolated']);
const ALLOWED_EDGE_TYPES = new Set(['builds_on', 'extends', 'contrasts', 'replaces', 'evaluates', 'chronological', 'cites']);

async function hydrateWorkspacePapers(ws, paperIds = null, opts = {}) {
  const targetWs = String(ws || (store.getConfig() || {}).currentWorkspace || '').trim();
  if (!targetWs) {
    return { ok: false, updatedCount: 0, skippedCount: 0, errors: [{ id: '', error: '未指定工作区' }], papers: [], fallbackUsed: true };
  }
  try {
    const res = await openalex.hydrateWorkspacePapers(targetWs, paperIds, opts);
    return { ...res, fallbackUsed: false };
  } catch (e) {
    return {
      ok: false,
      updatedCount: 0,
      skippedCount: 0,
      errors: [{ id: '', error: (e && e.message) || String(e) }],
      papers: [],
      error: (e && e.message) || String(e),
      fallbackUsed: true
    };
  }
}

/**
 * LocalCitationNetwork 思路：
 * 1) Top Cited：从本地库论文未展开的 `references`（W...）中按被本地引用频次排序，批量拉取缺失奠基文献。
 * 2) Top Citing：对本地代表性高引/必引论文按需查询 citedBy，汇总同时引用多篇本地论文的前沿后续工作。
 */
async function discoverMissingKeyPapers(ws, opts = {}) {
  const targetWs = String(ws || (store.getConfig() || {}).currentWorkspace || '').trim();
  const staged = Array.isArray(opts.staged) ? opts.staged : [];
  const limit = Math.max(3, Math.min(20, Number(opts.limit) || 10));
  const includeCiting = opts.includeCiting !== false;
  const cfg = store.getConfig() || {};
  const apiKey = String(opts.apiKey || (cfg.openalex || {}).apiKey || '');

  const graph = opts.graph || store.getCitationGraph(targetWs, staged);
  const rawTopCited = (graph && graph.missingSeeds && Array.isArray(graph.missingSeeds.topCited))
    ? graph.missingSeeds.topCited
    : [];
  const warnings = [];
  let fallbackUsed = false;

  // 1. Top Cited 缺失奠基文献
  const topIds = rawTopCited.slice(0, limit).map((item) => item.openalexId).filter(Boolean);
  const rankMap = new Map(rawTopCited.map((item) => [item.openalexId, item]));
  let topCited = [];

  if (topIds.length && opts.offline !== true) {
    try {
      const works = await connectors.fetchOpenAlexWorksByIds(topIds, apiKey);
      const byId = new Map((works || []).map((w) => [String(w.openalexId || '').toUpperCase(), w]));
      for (const wid of topIds) {
        const meta = rankMap.get(wid);
        const w = byId.get(String(wid).toUpperCase());
        if (w) {
          topCited.push({
            ...w,
            seedRole: 'top_cited',
            citedByLocalCount: meta ? meta.citedByLocalCount : 1,
            citingPaperIds: meta ? meta.citingPaperIds : [],
            citingPaperLabels: meta ? meta.citingPaperLabels : [],
            reason: `被本地库 ${meta ? meta.citedByLocalCount : 1} 篇论文共同引用${meta && meta.citingPaperLabels.length ? `（如 ${meta.citingPaperLabels.slice(0, 2).join('、')}）` : ''}`
          });
        } else if (meta) {
          topCited.push({
            openalexId: wid,
            title: `OpenAlex 文献 ${wid}`,
            seedRole: 'top_cited',
            citedByLocalCount: meta.citedByLocalCount,
            citingPaperIds: meta.citingPaperIds,
            citingPaperLabels: meta.citingPaperLabels,
            reason: `被本地库 ${meta.citedByLocalCount} 篇论文引用（元数据暂未返回）`
          });
        }
      }
      if (!works || !works.length) fallbackUsed = true;
    } catch (e) {
      fallbackUsed = true;
      warnings.push('拉取缺失奠基文献元数据失败，已显示本地引用频次索引：' + ((e && e.message) || String(e)));
    }
  }

  if (!topCited.length && rawTopCited.length) {
    fallbackUsed = true;
    topCited = rawTopCited.slice(0, limit).map((meta) => ({
      openalexId: meta.openalexId,
      title: `缺失奠基文献 (${meta.openalexId})`,
      oaUrl: `https://openalex.org/${meta.openalexId}`,
      seedRole: 'top_cited',
      citedByLocalCount: meta.citedByLocalCount,
      citingPaperIds: meta.citingPaperIds,
      citingPaperLabels: meta.citingPaperLabels,
      reason: `被本地库 ${meta.citedByLocalCount} 篇论文共同引用`
    }));
  }

  // 2. Top Citing 缺失前沿后续文献（仅对已有 OpenAlex ID 的代表性本地节点查询）
  let topCiting = [];
  if (includeCiting && opts.offline !== true) {
    const localWithOa = (graph.nodes || [])
      .filter((n) => n.source === 'local' && n.openalexId)
      .sort((a, b) => (Number(b.citedByCount) || 0) - (Number(a.citedByCount) || 0))
      .slice(0, 4);
    const localOaSet = new Set((graph.nodes || []).map((n) => String(n.openalexId || '').toUpperCase()).filter(Boolean));
    const citingAgg = new Map();

    const jobs = localWithOa.map(async (seed) => {
      const citers = await openalex.citedBy(seed.openalexId, { perPage: 20, apiKey });
      return { seed, citers };
    });
    const settled = await Promise.allSettled(jobs);
    settled.forEach((res) => {
      if (res.status !== 'fulfilled') {
        warnings.push('部分前向引用查询失败');
        return;
      }
      const { seed, citers } = res.value;
      for (const c of (citers || [])) {
        const oid = String(c.openalexId || '').toUpperCase();
        if (!oid || localOaSet.has(oid)) continue;
        let rec = citingAgg.get(oid);
        if (!rec) {
          rec = { paper: c, citedLocalIds: [], citedLocalLabels: [] };
          citingAgg.set(oid, rec);
        }
        if (!rec.citedLocalIds.includes(seed.id)) {
          rec.citedLocalIds.push(seed.id);
          rec.citedLocalLabels.push(seed.label);
        }
      }
    });

    topCiting = Array.from(citingAgg.values())
      .sort((a, b) =>
        b.citedLocalIds.length - a.citedLocalIds.length ||
        (Number(b.paper.citedByCount) || 0) - (Number(a.paper.citedByCount) || 0) ||
        String(b.paper.publicationDate || '').localeCompare(String(a.paper.publicationDate || ''))
      )
      .slice(0, limit)
      .map((rec) => ({
        ...rec.paper,
        seedRole: 'top_citing',
        citingLocalCount: rec.citedLocalIds.length,
        citedLocalIds: rec.citedLocalIds,
        citedLocalLabels: rec.citedLocalLabels,
        reason: rec.citedLocalIds.length > 1
          ? `同时引用本地 ${rec.citedLocalIds.length} 篇论文（${rec.citedLocalLabels.slice(0, 2).join('、')}）`
          : `引用了「${rec.citedLocalLabels[0] || ''}」的后续工作`
      }));
  }

  return {
    ok: true,
    topCited,
    topCiting,
    totalUnresolved: (graph && graph.stats && graph.stats.unresolvedEdgeCount) || 0,
    warnings: Array.from(new Set(warnings)),
    fallbackUsed
  };
}

/**
 * inciteful-xyz 思路：在两篇论文之间寻找最短演化路径。
 * - 先在有向引文子图（含正向引用与反向时间演进边）上做 BFS，得到纯引文演化链；
 * - 若有向引文不可达且 allowUndirected !== false，回退到全关系图（含耦合/共被引/共作者/笔记链接）。
 */
function findShortestEvolutionPath(graph, sourceKey, targetKey, opts = {}) {
  const g = graph || { nodes: [], edges: [] };
  const nodes = Array.isArray(g.nodes) ? g.nodes : [];
  const edges = Array.isArray(g.edges) ? g.edges : [];
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  const src = String(sourceKey || '').trim();
  const dst = String(targetKey || '').trim();

  if (!src || !dst || !byKey.has(src) || !byKey.has(dst)) {
    return { found: false, mode: 'none', hops: 0, nodeKeys: [], nodes: [], edges: [], explanation: '请选择两篇有效的论文节点' };
  }
  if (src === dst) {
    return {
      found: true,
      mode: 'self',
      hops: 0,
      nodeKeys: [src],
      nodes: [byKey.get(src)],
      edges: [],
      explanation: `起点与终点为同一篇论文「${byKey.get(src).label}」`
    };
  }

  function runBfs(allowedEdges, traverseBothDirs) {
    const adj = new Map();
    for (const edge of allowedEdges) {
      if (!byKey.has(edge.from) || !byKey.has(edge.to) || edge.from === edge.to) continue;
      if (!adj.has(edge.from)) adj.set(edge.from, []);
      adj.get(edge.from).push({ next: edge.to, edge, dir: 'forward' });
      if (traverseBothDirs || edge.directed === false) {
        if (!adj.has(edge.to)) adj.set(edge.to, []);
        adj.get(edge.to).push({ next: edge.from, edge, dir: 'reverse' });
      }
    }

    const queue = [src];
    const visited = new Set([src]);
    const parent = new Map();

    while (queue.length) {
      const cur = queue.shift();
      if (cur === dst) break;
      const neighbors = (adj.get(cur) || []).slice().sort((a, b) => (Number(b.edge.weight) || 1) - (Number(a.edge.weight) || 1));
      for (const step of neighbors) {
        if (visited.has(step.next)) continue;
        visited.add(step.next);
        parent.set(step.next, { prev: cur, edge: step.edge, dir: step.dir });
        queue.push(step.next);
      }
    }

    if (!visited.has(dst)) return null;
    const nodeKeys = [];
    const pathEdges = [];
    let cur = dst;
    while (cur !== src) {
      nodeKeys.push(cur);
      const step = parent.get(cur);
      if (!step) break;
      pathEdges.push({ ...step.edge, traverseDir: step.dir });
      cur = step.prev;
    }
    nodeKeys.push(src);
    nodeKeys.reverse();
    pathEdges.reverse();
    return { nodeKeys, pathEdges };
  }

  const directEdges = edges.filter((e) => DIRECT_VIAS.has(e.via));
  // 1) 严格顺向（引用链：新论文 -> 旧论文）
  let hit = runBfs(directEdges, false);
  let mode = 'directed_citation';
  // 2) 反向演进（从早期基础 -> 后续新论文，在引用图里即沿逆向边走）
  if (!hit) {
    const reversedDirect = directEdges.map((e) => ({ ...e, _origFrom: e.from, _origTo: e.to, from: e.to, to: e.from }));
    const revHit = runBfs(reversedDirect, false);
    if (revHit) {
      hit = {
        nodeKeys: revHit.nodeKeys,
        pathEdges: revHit.pathEdges.map((e) => ({ ...e, from: e._origFrom, to: e._origTo, traverseDir: 'evolution' }))
      };
      mode = 'evolution_citation';
    }
  }
  // 3) 双向直接引文连接（经共同祖先或共同后代）
  if (!hit) {
    hit = runBfs(directEdges, true);
    mode = 'bidirectional_citation';
  }
  // 4) 允许推导关系桥接（共同参考文献 / 共同被引 / 共同作者）
  if (!hit && opts.allowUndirected !== false) {
    hit = runBfs(edges, true);
    mode = 'bridge_inferred';
  }

  if (!hit) {
    return {
      found: false,
      mode: 'unreachable',
      hops: 0,
      nodeKeys: [],
      nodes: [],
      edges: [],
      explanation: `「${byKey.get(src).label}」与「${byKey.get(dst).label}」当前图中尚无连通路径（建议先补全元数据或展开缺失核心文献）`
    };
  }

  const pathNodes = hit.nodeKeys.map((k) => byKey.get(k)).filter(Boolean);
  const modeLabel = mode === 'evolution_citation' ? '沿演进方向（早期奠基 -> 后续继承）'
    : mode === 'directed_citation' ? '沿直接引用链'
      : mode === 'bidirectional_citation' ? '经共同引文枢纽'
        : '经共同参考文献/共作者桥接';
  const chainText = pathNodes.map((n) => n.label).join(' -> ');

  return {
    found: true,
    mode,
    hops: hit.pathEdges.length,
    nodeKeys: hit.nodeKeys,
    nodes: pathNodes,
    edges: hit.pathEdges,
    explanation: `${modeLabel}（${hit.pathEdges.length} 跳）：${chainText}`
  };
}

/**
 * belinghy/paper-lineage 思路：核心骨干 DAG 抽取。
 * - 边方向统一转化为「演进方向：前作(older/cited) -> 后作(newer/citing)」；
 * - 确定性打破极少数互引环，保证 DAG 拓扑层级合法；
 * - 对低信噪比 coupling 边做剪枝，仅为无直接引文边的孤立节点保留最强 Top-K 桥接边；
 * - 为每个节点分配结构角色（foundation / bridge / frontier / survey / isolated）与拓扑层 rank。
 */
function extractBackbone(graph, opts = {}) {
  const g = graph || { nodes: [], edges: [] };
  const rawNodes = Array.isArray(g.nodes) ? g.nodes : [];
  const rawEdges = Array.isArray(g.edges) ? g.edges : [];
  const maxCouplingPerNode = Math.max(0, Math.min(4, Number(opts.maxCouplingPerNode !== undefined ? opts.maxCouplingPerNode : 1)));
  const byKey = new Map(rawNodes.map((n) => [n.key, n]));

  const yearOf = (n) => {
    const y = Number(n && n.year) || Number(String((n && n.pubDate) || '').slice(0, 4)) || 0;
    return y > 1900 ? y : 9999;
  };

  // 1) 保留所有直接引文边，并在演进 DAG 上以「被引用者(前作) -> 引用者(后作)」计算拓扑深度
  const directEdges = [];
  const seenDirect = new Set();
  const inDirect = new Map();
  const outDirect = new Map();
  rawNodes.forEach((n) => { inDirect.set(n.key, 0); outDirect.set(n.key, 0); });

  for (const edge of rawEdges) {
    if (!DIRECT_VIAS.has(edge.via)) continue;
    if (!byKey.has(edge.from) || !byKey.has(edge.to) || edge.from === edge.to) continue;
    // 在 store.getCitationGraph 中，from 是引用者，to 是被引用者
    const older = byKey.get(edge.to);
    const newer = byKey.get(edge.from);
    // 防互引环：若 older 明显晚于 newer，则保留时间顺向（不反向创建环）
    let evoFrom = older.key;
    let evoTo = newer.key;
    if (yearOf(older) > yearOf(newer) && yearOf(older) !== 9999 && yearOf(newer) !== 9999) {
      evoFrom = newer.key;
      evoTo = older.key;
    }
    const sig = `${evoFrom}->${evoTo}`;
    const revSig = `${evoTo}->${evoFrom}`;
    if (seenDirect.has(sig) || seenDirect.has(revSig)) continue;
    seenDirect.add(sig);
    directEdges.push({
      ...edge,
      evoFrom,
      evoTo,
      isBackbone: true
    });
    outDirect.set(evoFrom, (outDirect.get(evoFrom) || 0) + 1);
    inDirect.set(evoTo, (inDirect.get(evoTo) || 0) + 1);
  }

  // 2) 对无直接引文边的孤立节点，保留少量最强推导关系边作为桥接（大幅降低毛线球噪声）
  const keptBridges = [];
  if (maxCouplingPerNode > 0) {
    const hasDirect = new Set();
    directEdges.forEach((e) => { hasDirect.add(e.evoFrom); hasDirect.add(e.evoTo); });
    const inferred = rawEdges
      .filter((e) => !DIRECT_VIAS.has(e.via) && byKey.has(e.from) && byKey.has(e.to) && e.from !== e.to)
      .slice()
      .sort((a, b) => (Number(b.weight) || 0) - (Number(a.weight) || 0));
    const bridgeCount = new Map();
    for (const edge of inferred) {
      const aIsolated = !hasDirect.has(edge.from);
      const bIsolated = !hasDirect.has(edge.to);
      if (!aIsolated && !bIsolated) continue;
      if ((bridgeCount.get(edge.from) || 0) >= maxCouplingPerNode && (bridgeCount.get(edge.to) || 0) >= maxCouplingPerNode) continue;
      bridgeCount.set(edge.from, (bridgeCount.get(edge.from) || 0) + 1);
      bridgeCount.set(edge.to, (bridgeCount.get(edge.to) || 0) + 1);
      keptBridges.push({ ...edge, isBackbone: false });
    }
  }

  // 3) Kahn 拓扑分层计算 rank（若仍存在等年份环，按年份+被引数确定性破环）
  const adj = new Map();
  const indeg = new Map();
  rawNodes.forEach((n) => { adj.set(n.key, []); indeg.set(n.key, 0); });
  directEdges.forEach((e) => {
    adj.get(e.evoFrom).push(e.evoTo);
    indeg.set(e.evoTo, (indeg.get(e.evoTo) || 0) + 1);
  });

  const rank = new Map();
  const queue = rawNodes
    .filter((n) => (indeg.get(n.key) || 0) === 0)
    .sort((a, b) => yearOf(a) - yearOf(b) || (Number(b.citedByCount) || 0) - (Number(a.citedByCount) || 0));
  queue.forEach((n) => rank.set(n.key, 0));

  const processed = new Set();
  while (queue.length) {
    const cur = queue.shift();
    processed.add(cur.key);
    const curRank = rank.get(cur.key) || 0;
    for (const nextKey of (adj.get(cur.key) || [])) {
      rank.set(nextKey, Math.max(rank.get(nextKey) || 0, curRank + 1));
      const rem = (indeg.get(nextKey) || 1) - 1;
      indeg.set(nextKey, rem);
      if (rem === 0) queue.push(byKey.get(nextKey));
    }
  }

  // 剩余环内节点或无直接边节点按年份区间分桶赋 rank
  const datedYears = rawNodes.map(yearOf).filter((y) => y < 9999).sort((a, b) => a - b);
  const minY = datedYears.length ? datedYears[0] : 2020;
  const maxY = datedYears.length ? datedYears[datedYears.length - 1] : minY;
  const spanY = Math.max(1, maxY - minY);
  const maxTopoRank = Math.max(1, ...Array.from(rank.values()), 2);

  for (const n of rawNodes) {
    const deg = (inDirect.get(n.key) || 0) + (outDirect.get(n.key) || 0);
    if (!processed.has(n.key) || deg === 0) {
      const y = yearOf(n);
      const bucket = y < 9999
        ? Math.round(((y - minY) / spanY) * Math.min(4, maxTopoRank))
        : Math.min(4, maxTopoRank);
      rank.set(n.key, bucket);
    }
  }

  const maxRank = Math.max(0, ...Array.from(rank.values()));
  const backboneNodes = rawNodes.map((n) => {
    const citedByOthers = outDirect.get(n.key) || 0; // 被图内其他论文引用的次数（演进出度）
    const citesOthers = inDirect.get(n.key) || 0;    // 引用图内其他论文的次数（演进入度）
    const r = rank.get(n.key) || 0;
    let role = 'branch';
    if (/survey|review|benchmark|overview/i.test(String(n.label || n.title || ''))) {
      role = 'survey';
    } else if (citedByOthers === 0 && citesOthers === 0) {
      role = 'isolated';
    } else if (citedByOthers >= 2 && citesOthers === 0) {
      role = 'foundation';
    } else if (citedByOthers >= 1 && citesOthers >= 1) {
      role = 'bridge';
    } else if (citesOthers >= 1 && citedByOthers === 0) {
      role = 'frontier';
    } else if (r === 0 && citedByOthers > 0) {
      role = 'foundation';
    } else if (r === maxRank) {
      role = 'frontier';
    }
    return {
      ...n,
      backboneRank: r,
      backboneRole: role,
      localCitedByCount: citedByOthers,
      localCitesCount: citesOthers
    };
  });

  const backboneEdges = directEdges.concat(keptBridges);
  return {
    nodes: backboneNodes,
    edges: backboneEdges,
    ranks: maxRank + 1,
    stats: {
      nodeCount: backboneNodes.length,
      directEdgeCount: directEdges.length,
      bridgeEdgeCount: keptBridges.length,
      prunedEdgeCount: Math.max(0, rawEdges.length - backboneEdges.length)
    }
  };
}

function summarizeText(text, maxLen = 180) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  return s.length <= maxLen ? s : s.slice(0, maxLen).trim() + '...';
}

function extractFieldFromAbstract(text, patterns, fallback) {
  const src = String(text || '');
  for (const re of patterns) {
    const m = src.match(re);
    if (m && m[0]) return summarizeText(m[0], 110);
  }
  return fallback;
}

function buildOfflineLineage({ papers, graph, focusIds, skillId, topic }) {
  const focusSet = new Set((Array.isArray(focusIds) ? focusIds : []).map(String));
  const sorted = papers.slice().sort((a, b) => {
    const da = String((a && (a.publicationDate || a.published || a.year)) || '9999');
    const db = String((b && (b.publicationDate || b.published || b.year)) || '9999');
    return da.localeCompare(db) || (Number(b.citedByCount) || 0) - (Number(a.citedByCount) || 0);
  });

  // 构造用于骨干抽取的图
  const miniGraph = graph || {
    nodes: sorted.map((p, idx) => ({
      key: 'local:' + String(p.id || `paper-${idx + 1}`),
      id: String(p.id || `paper-${idx + 1}`),
      label: String(p.shortName || p.title || p.id || `paper-${idx + 1}`),
      openalexId: String((p.externalIds && p.externalIds.openalex) || p.openalexId || ''),
      pubDate: String(p.publicationDate || p.published || ''),
      year: Number(String(p.publicationDate || p.published || p.year || '').slice(0, 4)) || 0,
      citedByCount: Number(p.citedByCount) || 0
    })),
    edges: []
  };

  // 若未传 graph 但论文自带 references，则离线补建内部引文边
  if (!graph && sorted.length > 1) {
    const byOa = new Map();
    miniGraph.nodes.forEach((n) => { if (n.openalexId) byOa.set(n.openalexId.toUpperCase(), n); });
    sorted.forEach((p, idx) => {
      const fromKey = miniGraph.nodes[idx].key;
      const refs = Array.isArray(p.references) ? p.references : (Array.isArray(p.referencedWorks) ? p.referencedWorks : []);
      refs.forEach((r) => {
        const m = String(r || '').match(/W\d+$/i);
        const target = m && byOa.get(m[0].toUpperCase());
        if (target && target.key !== fromKey) {
          miniGraph.edges.push({ from: fromKey, to: target.key, via: 'references', directed: true, weight: 1 });
        }
      });
    });
  }

  const backbone = extractBackbone(miniGraph);
  const backboneById = new Map(backbone.nodes.map((n) => [String(n.id), n]));
  const idByKey = new Map(backbone.nodes.map((n) => [n.key, String(n.id)]));

  const nodes = sorted.map((p, idx) => {
    const id = String(p.id || `paper-${idx + 1}`);
    const bn = backboneById.get(id);
    const yearStr = String(p.publicationDate || p.published || p.year || '').slice(0, 4);
    const era = /^\d{4}$/.test(yearStr) ? yearStr : 'unknown';
    let role = bn ? bn.backboneRole : (idx === 0 ? 'foundation' : (idx === sorted.length - 1 ? 'frontier' : 'branch'));
    if (focusSet.has(id)) role = 'focus';
    if (role === 'isolated') role = idx === 0 ? 'foundation' : (idx === sorted.length - 1 ? 'frontier' : 'branch');
    const branch = String(p.venue || (Array.isArray(p.tags) && p.tags[0]) || '主线演进').slice(0, 32);
    const keyContribution = summarizeText(p.summary || p.tldr || p.abstract || p.title || id, 120);
    return { id, title: String(p.title || p.shortName || id), role, era, branch, keyContribution };
  });

  const edges = [];
  const seenEdge = new Set();
  for (const e of backbone.edges) {
    if (!e.isBackbone) continue;
    const srcId = idByKey.get(e.evoFrom);
    const dstId = idByKey.get(e.evoTo);
    if (!srcId || !dstId || srcId === dstId) continue;
    const sig = `${srcId}->${dstId}`;
    if (seenEdge.has(sig)) continue;
    seenEdge.add(sig);
    edges.push({
      source: srcId,
      target: dstId,
      type: 'builds_on',
      rationale: `有向引文支撑：[${dstId}] 直接引用了前作 [${srcId}]`
    });
  }
  if (!edges.length && nodes.length > 1) {
    for (let i = 1; i < nodes.length; i++) {
      edges.push({
        source: nodes[i - 1].id,
        target: nodes[i].id,
        type: 'chronological',
        rationale: `按发表时序衔接（${nodes[i - 1].era} -> ${nodes[i].era}；建议联网补全引文获得精确继承边）`
      });
    }
  }

  const matrix = sorted.map((p, idx) => {
    const id = String(p.id || `paper-${idx + 1}`);
    const abs = String(p.abstract || p.summary || p.tldr || '');
    return {
      id,
      title: String(p.title || p.shortName || id),
      year: String(p.publicationDate || p.published || p.year || '').slice(0, 4) || '未知',
      task: topic || extractFieldFromAbstract(abs, [/manipulation|navigation|control|planning|reasoning|robotics|embodied|vision-language-action/i], '核心研究任务（摘要未明示）'),
      method: summarizeText(p.summary || p.tldr || abs, 130) || '待补充核心方法（建议提取 PDF 或生成笔记）',
      assumption: extractFieldFromAbstract(abs, [/assum[^.。;；]+/i, /rel(?:y|ies) on[^.。;；]+/i, /pretrain[^.。;；]+/i], '依赖大规模预训练表征或标准演示数据（待精读核实）'),
      dataset: extractFieldFromAbstract(abs, [/(?:LIBERO|CALVIN|RLBench|BridgeData|OXE|Open X-Embodiment|SimplerEnv|Meta-World|RoboTwin|ImageNet|DROID)[^,.。;；]{0,30}/i], '摘要未明示基准'),
      metric: extractFieldFromAbstract(abs, [/(?:success rate|accuracy|MSE|F1|throughput|latency|Hz|SR)[^,.。;；]{0,28}/i], '任务成功率 / 泛化指标'),
      limitation: extractFieldFromAbstract(abs, [/(?:limit|bottleneck|challenge|struggle|fail|expensive|costly|slow)[^.。;；]{0,80}/i], '需核验泛化边界、计算开销与长视野稳定性')
    };
  });

  const rolePriority = { foundation: 1, survey: 2, bridge: 3, focus: 3, branch: 4, frontier: 5 };
  const readingQueue = nodes
    .slice()
    .sort((a, b) => (rolePriority[a.role] || 4) - (rolePriority[b.role] || 4) || String(a.era).localeCompare(String(b.era)))
    .slice(0, Math.min(8, nodes.length))
    .map((n, idx) => ({
      id: n.id,
      priority: idx + 1,
      stage: n.role === 'foundation' || n.role === 'survey' ? '1. 奠基概念' : n.role === 'bridge' ? '2. 承前启后' : '3. 前沿突破',
      reason: `[${n.id}]（${n.era} / ${n.role}）：${summarizeText(n.keyContribution, 64) || '脉络关键节点'}`
    }));

  const eras = Array.from(new Set(nodes.map((n) => n.era).filter((e) => e !== 'unknown'))).sort();
  const frontierIds = nodes.filter((n) => n.role === 'frontier' || n.role === 'focus').slice(0, 3).map((n) => n.id);
  const foundationIds = nodes.filter((n) => n.role === 'foundation' || n.role === 'bridge').slice(0, 3).map((n) => n.id);
  const anchorIds = Array.from(new Set(foundationIds.concat(frontierIds))).slice(0, 4);
  const fallbackAnchor = nodes.slice(0, Math.min(3, nodes.length)).map((n) => n.id);
  const gapRefs = anchorIds.length ? anchorIds : fallbackAnchor;

  const researchGaps = sorted.length ? [
    {
      title: `${topic ? topic + '：' : ''}隐式表征与长视野泛化的可控平衡`,
      gap: `当前文献从 ${eras[0] || '早期基线'} 演进至 ${eras[eras.length - 1] || '最新前沿'}，在效率与跨场景泛化之间仍缺少统一的可解释验证框架。`,
      evidencePaperIds: gapRefs,
      whyUnresolved: '已有工作分别优化感知表征或动作解码，缺少针对核心机制的单变量对照消融与失败边界界定。',
      suggestedDirection: '围绕现有最高频引用的基线构造受控单一变量改动，并引入多随机种子与分布外任务验证。'
    },
    ...(nodes.length >= 2 ? [{
      title: `${topic ? topic + '：' : ''}评估协议一致性与计算代价边界`,
      gap: '不同分支采用异构数据集与评价口径，难以直接判断性能增益源于模型机制还是数据规模/算力差异。',
      evidencePaperIds: nodes.slice(-Math.min(3, nodes.length)).map((n) => n.id),
      whyUnresolved: '跨文献对比矩阵中多项数据集与算力预算未对齐，存在显著混杂变量。',
      suggestedDirection: '在同一基准与同等算力预算下建立公平基线对照，并记录显存、延迟与失败样本台账。'
    }] : [])
  ] : [];

  const directCount = edges.filter((e) => e.type === 'builds_on').length;
  const narrative = sorted.length
    ? `基于 ${sorted.length} 篇本地论文（跨度 ${eras.length ? `${eras[0]}–${eras[eras.length - 1]}` : '待补全年份'}）完成离线结构化脉络梳理${topic ? `（主题：${topic}）` : ''}：识别出 ${directCount} 条直接引文演进边、${readingQueue.length} 篇渐进精读队列及 ${researchGaps.length} 项待攻克研究缺口。配置大模型 API Key 后可进一步激活深度五维证据冲突分析。`
    : '当前工作区暂无可用论文，请先导入或检索论文后再合成脉络。';

  const markdown = formatLineageMarkdown({ topic, narrative, eras, nodes, edges, matrix, readingQueue, researchGaps });
  return {
    ok: true,
    skillId: String(skillId || 'research-genealogy'),
    lineage: { narrative, eras, nodes, edges, matrix, readingQueue, researchGaps },
    markdown,
    citationsVerified: true,
    unverifiedRefs: [],
    fallbackUsed: true
  };
}

function formatLineageMarkdown({ topic, narrative, eras, nodes, edges, matrix, readingQueue, researchGaps }) {
  const lines = [
    `# 论文脉络综述${topic ? `：${topic}` : ''}`,
    '',
    narrative,
    ''
  ];
  if (eras && eras.length) {
    lines.push(`**演进跨度**：${eras.join(' -> ')}`, '');
  }
  if (edges && edges.length) {
    lines.push('## 核心演进关系');
    edges.slice(0, 12).forEach((e) => {
      lines.push(`- [${e.source}] --(${e.type})--> [${e.target}]：${e.rationale}`);
    });
    lines.push('');
  }
  if (readingQueue && readingQueue.length) {
    lines.push('## 推荐阅读队列');
    readingQueue.forEach((r) => {
      lines.push(`${r.priority}. [${r.id}]${r.stage ? `（${r.stage}）` : ''}：${r.reason}`);
    });
    lines.push('');
  }
  if (matrix && matrix.length) {
    lines.push('## 文献对比矩阵');
    lines.push('| 论文 ID | 年份 | 核心方法 | 核心假设 | 基准数据集 | 局限性 |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    matrix.slice(0, 15).forEach((m) => {
      const cell = (v) => String(v || '-').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').slice(0, 80);
      lines.push(`| ${cell(m.id)} | ${cell(m.year)} | ${cell(m.method)} | ${cell(m.assumption)} | ${cell(m.dataset)} | ${cell(m.limitation)} |`);
    });
    lines.push('');
  }
  if (researchGaps && researchGaps.length) {
    lines.push('## 识别到的研究缺口（可一键送入 Idea）');
    researchGaps.forEach((g, idx) => {
      const refs = Array.isArray(g.evidencePaperIds) && g.evidencePaperIds.length
        ? g.evidencePaperIds.map((id) => `[${id}]`).join(' ')
        : '';
      lines.push(`${idx + 1}. **${g.title}** ${refs}`);
      lines.push(`   - 缺口：${g.gap}`);
      if (g.suggestedDirection) lines.push(`   - 建议切入点：${g.suggestedDirection}`);
    });
  }
  return lines.join('\n');
}

/**
 * OpenScholar 风格引用核验：
 * 校验 AI 返回的所有 paperId（nodes / edges / readingQueue / researchGaps.evidencePaperIds / 正文 [id]），
 * 自动过滤编造的幻觉 ID，并返回 citationsVerified 标志与 unverifiedRefs 列表。
 */
function verifyAndSanitizeLineage(parsed, validPaperIds, fallbackData) {
  const validSet = new Set(validPaperIds.map(String));
  const unverifiedRefs = [];
  const recordBad = (id) => {
    const s = String(id || '').trim();
    if (s && !validSet.has(s) && !unverifiedRefs.includes(s)) unverifiedRefs.push(s);
  };

  const nodes = (Array.isArray(parsed.nodes) ? parsed.nodes : [])
    .filter((n) => {
      const id = String((n && n.id) || '').trim();
      if (!validSet.has(id)) { recordBad(id); return false; }
      return true;
    })
    .map((n) => ({
      id: String(n.id),
      role: ALLOWED_ROLES.has(String(n.role || '')) ? String(n.role) : 'branch',
      era: String(n.era || 'unknown').slice(0, 24),
      branch: String(n.branch || 'main').slice(0, 48),
      keyContribution: String(n.keyContribution || '').slice(0, 200)
    }));

  const edges = (Array.isArray(parsed.edges) ? parsed.edges : [])
    .filter((e) => {
      const s = String((e && e.source) || '').trim();
      const t = String((e && e.target) || '').trim();
      if (!validSet.has(s)) { recordBad(s); return false; }
      if (!validSet.has(t)) { recordBad(t); return false; }
      return s !== t;
    })
    .map((e) => ({
      source: String(e.source),
      target: String(e.target),
      type: ALLOWED_EDGE_TYPES.has(String(e.type || '')) ? String(e.type) : 'builds_on',
      rationale: String(e.rationale || '').slice(0, 220)
    }));

  const matrix = (Array.isArray(parsed.matrix) ? parsed.matrix : [])
    .filter((m) => {
      const id = String((m && m.id) || '').trim();
      if (!validSet.has(id)) { recordBad(id); return false; }
      return true;
    })
    .map((m) => ({
      id: String(m.id),
      title: String(m.title || m.id),
      year: String(m.year || ''),
      task: String(m.task || '摘要未明示'),
      method: String(m.method || '摘要未明示'),
      assumption: String(m.assumption || '摘要未明示'),
      dataset: String(m.dataset || '摘要未明示'),
      metric: String(m.metric || '摘要未明示'),
      limitation: String(m.limitation || '摘要未明示')
    }));

  const readingQueue = (Array.isArray(parsed.readingQueue) ? parsed.readingQueue : [])
    .filter((r) => {
      const id = String((r && r.id) || '').trim();
      if (!validSet.has(id)) { recordBad(id); return false; }
      return true;
    })
    .map((r, idx) => ({
      id: String(r.id),
      priority: Number(r.priority) || (idx + 1),
      stage: String(r.stage || ''),
      reason: String(r.reason || '').slice(0, 160)
    }));

  const researchGaps = (Array.isArray(parsed.researchGaps) ? parsed.researchGaps : [])
    .map((g) => {
      const rawRefs = Array.isArray(g && g.evidencePaperIds) ? g.evidencePaperIds : [];
      const cleanRefs = [];
      for (const ref of rawRefs) {
        const sid = String(ref || '').trim();
        if (validSet.has(sid)) {
          if (!cleanRefs.includes(sid)) cleanRefs.push(sid);
        } else {
          recordBad(sid);
        }
      }
      return {
        title: String((g && g.title) || '待验证研究缺口').slice(0, 100),
        gap: String((g && g.gap) || '').slice(0, 320),
        evidencePaperIds: cleanRefs,
        whyUnresolved: String((g && g.whyUnresolved) || '').slice(0, 240),
        suggestedDirection: String((g && g.suggestedDirection) || '').slice(0, 240)
      };
    })
    .filter((g) => g.gap);

  // 检查 narrative 里的 [id] 引用
  const narrative = String(parsed.narrative || fallbackData.lineage.narrative || '').trim();
  const bracketRe = /\[([A-Za-z0-9_.\-\u4e00-\u9fa5]{2,64})\]/g;
  let bm;
  while ((bm = bracketRe.exec(narrative))) {
    const token = bm[1];
    if (!validSet.has(token) && !/^\d+$/.test(token)) recordBad(token);
  }

  const finalNodes = nodes.length ? nodes : fallbackData.lineage.nodes;
  const finalEdges = edges.length ? edges : fallbackData.lineage.edges;
  const finalMatrix = matrix.length ? matrix : fallbackData.lineage.matrix;
  const finalQueue = readingQueue.length ? readingQueue : fallbackData.lineage.readingQueue;
  const finalGaps = researchGaps.length ? researchGaps : fallbackData.lineage.researchGaps;
  const eras = Array.isArray(parsed.eras) && parsed.eras.length
    ? parsed.eras.map((e) => String(e || '').trim()).filter(Boolean)
    : fallbackData.lineage.eras;

  return {
    lineage: {
      narrative,
      eras,
      nodes: finalNodes,
      edges: finalEdges,
      matrix: finalMatrix,
      readingQueue: finalQueue,
      researchGaps: finalGaps
    },
    citationsVerified: unverifiedRefs.length === 0,
    unverifiedRefs
  };
}

/**
 * 论文脉络 AI 综合入口（PaperWeave + research-weave-skill + OpenScholar 引用核验）。
 * 未配置 API Key 或网络失败时自动确定性降级至离线结构化脉络。
 */
async function synthesizeLineage({ ws = '', papers = [], graph = null, focusIds = [], skillId = 'research-genealogy', topic = '' } = {}) {
  let list = Array.isArray(papers) && papers.length ? papers : [];
  const targetWs = String(ws || '').trim();
  if (!list.length && targetWs) {
    try {
      const items = store.listItems(targetWs, 'papers');
      list = items.map((it) => {
        const full = store.getItem(targetWs, 'papers', it.id);
        return {
          ...it,
          ...((full && full.frontmatter) || {}),
          id: it.id,
          _bodyExcerpt: full && full.body ? String(full.body).slice(0, 500) : ''
        };
      });
    } catch (_) {
      list = [];
    }
  }

  const resolvedSkill = skills.getSkill(skillId || 'research-genealogy', 'lineage')
    || skills.listSkills('lineage', { includeContent: true })[0]
    || { id: skillId || 'research-genealogy', name: 'Research Genealogy', content: '' };

  const offline = buildOfflineLineage({ papers: list, graph, focusIds, skillId: resolvedSkill.id, topic });
  if (!list.length) return offline;

  const cfg = store.getConfig() || {};
  if (!(cfg.api && cfg.api.apiKey)) return offline;

  const sliced = list.slice(0, 18);
  const validIds = sliced.map((p, idx) => String((p && p.id) || `paper-${idx + 1}`));
  const digest = sliced.map((p, idx) => {
    const id = validIds[idx];
    const year = String(p.publicationDate || p.published || p.year || '').slice(0, 4) || '未知';
    const evidence = summarizeText(p.abstract || p.summary || p.tldr || p._bodyExcerpt || '', 260);
    return `[${id}] 标题: ${String(p.title || p.shortName || id).slice(0, 140)} | 年份: ${year} | 载体: ${p.venue || '未知'} | 引用: ${Number(p.citedByCount) || 0} | 摘要/笔记: ${evidence || '资料有限'}`;
  }).join('\n');

  const edgeDigest = offline.lineage.edges.slice(0, 15)
    .map((e) => `[${e.source}] -> [${e.target}] (${e.type})`)
    .join('; ');

  const sys = '你是严谨的科研文献谱系分析与系统综述专家。严格立足给定论文证据，绝不编造输入之外的 paperId 或实验数字。只输出合法 JSON。';
  const prompt = `${resolvedSkill.content ? `## 执行技能规范（${resolvedSkill.name}）\n${String(resolvedSkill.content).slice(0, 2600)}\n\n` : ''}## 课题方向
${topic || '未指定（请从输入文献归纳）'}

## 输入论文列表（合法 paperId 仅限方括号内编号）
${digest}

## 已有引文结构线索
${edgeDigest || '（暂无直接引文边）'}
${Array.isArray(focusIds) && focusIds.length ? `\n## 用户聚焦论文\n${focusIds.join(', ')}\n` : ''}

请严格输出以下 JSON 结构（所有 id/source/target/evidencePaperIds 必须严格来自输入论文列表）：
{
  "narrative": "150-320字中文演进叙事，引用论文一律用 [paperId] 标注",
  "eras": ["2023", "2024", "2025"],
  "nodes": [{"id":"paperId","role":"foundation|bridge|branch|frontier|survey|focus","era":"2024","branch":"技术分支名","keyContribution":"一句话核心贡献"}],
  "edges": [{"source":"olderPaperId","target":"newerPaperId","type":"builds_on|extends|contrasts|replaces|evaluates","rationale":"演进理由"}],
  "matrix": [{"id":"paperId","title":"标题","year":"2024","task":"任务","method":"核心方法","assumption":"核心假设","dataset":"基准数据集","metric":"指标","limitation":"局限性"}],
  "readingQueue": [{"id":"paperId","priority":1,"stage":"1. 奠基概念","reason":"阅读关注点"}],
  "researchGaps": [{"title":"缺口标题","gap":"具体研究缺口描述","evidencePaperIds":["paperId"],"whyUnresolved":"为何现有工作尚未解决","suggestedDirection":"建议研究切入点"}]
}`;

  try {
    const raw = await ai.callLLM(
      [{ role: 'system', content: sys }, { role: 'user', content: prompt }],
      { temperature: 0.2, maxTokens: 2200, timeoutMs: 30000 }
    );
    const parsed = ai.extractJsonBlock(raw);
    if (!parsed || typeof parsed !== 'object') return offline;
    const verified = verifyAndSanitizeLineage(parsed, validIds, offline);
    const markdown = formatLineageMarkdown({ topic, ...verified.lineage });
    return {
      ok: true,
      skillId: resolvedSkill.id,
      lineage: verified.lineage,
      markdown,
      citationsVerified: verified.citationsVerified,
      unverifiedRefs: verified.unverifiedRefs,
      fallbackUsed: false
    };
  } catch (_) {
    return offline;
  }
}

module.exports = {
  hydrateWorkspacePapers,
  discoverMissingKeyPapers,
  findShortestEvolutionPath,
  extractBackbone,
  synthesizeLineage
};
