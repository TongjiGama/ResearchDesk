/* 科研台 — 论文关系脉络（原生 SVG，无依赖，双主题 currentColor）
 * 暴露 window.Timeline = {render, layout, zoom, pan, reset, focus, setFilter, setEdgeFilter, setLayout, highlightPath, destroy}
 * 支持发表时间、确定性关系网络与核心骨干 DAG（backbone）三种布局；支持最短演化路径高亮。
 */
(function (global) {
  'use strict';

  var NS = 'http://www.w3.org/2000/svg';
  var PAD_X = 78;
  var LANE_H = 58;
  var MIN_GAP = 118;
  var TOP_Y = 64;
  var DIRECT_VIAS = { references: 1, referenced_works: 1, cites: 1, notes: 1 };

  var state = {
    container: null,
    graph: null,
    opts: {},
    svg: null,
    viewport: null,
    laid: null,
    scale: 1,
    tx: 0,
    ty: 0,
    focusKey: '',
    hoverKey: '',
    pathNodes: null,
    pathEdges: null,
    filter: null,
    edgeFilter: null,
    layoutMode: 'timeline',
    listeners: []
  };

  function el(name, attrs, text) {
    var node = document.createElementNS(NS, name);
    Object.keys(attrs || {}).forEach(function (k) { node.setAttribute(k, String(attrs[k])); });
    if (text != null) node.textContent = String(text);
    return node;
  }

  function timeOf(node) {
    var s = String(node.pubDate || node.year || '');
    var m = s.match(/^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/);
    if (!m) return NaN;
    return Date.UTC(Number(m[1]), Number(m[2] || 1) - 1, Number(m[3] || 1));
  }

  function yearOf(node) {
    var y = Number(node && node.year) || Number(String((node && node.pubDate) || '').slice(0, 4)) || 0;
    return y > 1900 ? y : 9999;
  }

  /** 核心骨干 DAG 分层布局（belinghy/paper-lineage 思路）：按拓扑秩从左到右分层，剪枝冗余耦合边。 */
  function backboneLayout(nodes, edges) {
    var byKey = new Map(nodes.map(function (n) { return [n.key, n]; }));
    var adj = new Map();
    var indeg = new Map();
    var outDirect = new Map();
    var inDirect = new Map();
    nodes.forEach(function (n) {
      adj.set(n.key, []);
      indeg.set(n.key, 0);
      outDirect.set(n.key, 0);
      inDirect.set(n.key, 0);
    });

    var seen = new Set();
    edges.forEach(function (edge) {
      if (!DIRECT_VIAS[edge.via]) return;
      if (!byKey.has(edge.from) || !byKey.has(edge.to) || edge.from === edge.to) return;
      // 演进方向：被引用前作(to) -> 引用后作(from)
      var older = byKey.get(edge.to);
      var newer = byKey.get(edge.from);
      var evoFrom = older.key, evoTo = newer.key;
      if (yearOf(older) > yearOf(newer) && yearOf(older) < 9999 && yearOf(newer) < 9999) {
        evoFrom = newer.key; evoTo = older.key;
      }
      var sig = evoFrom + '->' + evoTo;
      var rev = evoTo + '->' + evoFrom;
      if (seen.has(sig) || seen.has(rev)) return;
      seen.add(sig);
      adj.get(evoFrom).push(evoTo);
      indeg.set(evoTo, (indeg.get(evoTo) || 0) + 1);
      outDirect.set(evoFrom, (outDirect.get(evoFrom) || 0) + 1);
      inDirect.set(evoTo, (inDirect.get(evoTo) || 0) + 1);
    });

    var rank = new Map();
    var queue = nodes.filter(function (n) { return (indeg.get(n.key) || 0) === 0; })
      .sort(function (a, b) { return yearOf(a) - yearOf(b) || (Number(b.citedByCount) || 0) - (Number(a.citedByCount) || 0); });
    queue.forEach(function (n) { rank.set(n.key, 0); });
    var processed = new Set();
    while (queue.length) {
      var cur = queue.shift();
      processed.add(cur.key);
      var curRank = rank.get(cur.key) || 0;
      (adj.get(cur.key) || []).forEach(function (nextKey) {
        rank.set(nextKey, Math.max(rank.get(nextKey) || 0, curRank + 1));
        var rem = (indeg.get(nextKey) || 1) - 1;
        indeg.set(nextKey, rem);
        if (rem === 0) queue.push(byKey.get(nextKey));
      });
    }

    var datedYears = nodes.map(yearOf).filter(function (y) { return y < 9999; }).sort(function (a, b) { return a - b; });
    var minY = datedYears.length ? datedYears[0] : 2020;
    var maxY = datedYears.length ? datedYears[datedYears.length - 1] : minY;
    var spanY = Math.max(1, maxY - minY);
    var maxTopo = Math.max(1, Math.max.apply(null, [0].concat(Array.from(rank.values()))), 2);

    nodes.forEach(function (n) {
      var deg = (inDirect.get(n.key) || 0) + (outDirect.get(n.key) || 0);
      if (typeof n.backboneRank === 'number' && Number.isFinite(n.backboneRank)) {
        rank.set(n.key, n.backboneRank);
      } else if (!processed.has(n.key) || deg === 0) {
        var y = yearOf(n);
        var bucket = y < 9999 ? Math.round(((y - minY) / spanY) * Math.min(4, maxTopo)) : Math.min(4, maxTopo);
        rank.set(n.key, bucket);
      }
    });

    var columns = new Map();
    nodes.forEach(function (n) {
      var r = rank.get(n.key) || 0;
      if (!columns.has(r)) columns.set(r, []);
      columns.get(r).push(n);
    });
    var sortedRanks = Array.from(columns.keys()).sort(function (a, b) { return a - b; });
    var colGap = 178;
    var rowGap = 62;
    var maxColLen = 1;
    sortedRanks.forEach(function (r) {
      var list = columns.get(r);
      list.sort(function (a, b) {
        var degA = (outDirect.get(a.key) || 0) + (inDirect.get(a.key) || 0);
        var degB = (outDirect.get(b.key) || 0) + (inDirect.get(b.key) || 0);
        return degB - degA || (Number(b.citedByCount) || 0) - (Number(a.citedByCount) || 0) || yearOf(a) - yearOf(b);
      });
      if (list.length > maxColLen) maxColLen = list.length;
    });

    var width = Math.max(920, PAD_X * 2 + Math.max(1, sortedRanks.length - 1) * colGap + 180);
    var height = Math.max(340, TOP_Y + maxColLen * rowGap + 44);
    var positioned = [];
    var rankHeaders = [];

    sortedRanks.forEach(function (r, colIdx) {
      var list = columns.get(r);
      var x = PAD_X + colIdx * colGap + 12;
      var startY = TOP_Y + ((maxColLen - list.length) * rowGap) / 2 + 12;
      var yrs = list.map(yearOf).filter(function (y) { return y < 9999; });
      var hdrLabel = colIdx === 0 ? '奠基层 L' + r : (colIdx === sortedRanks.length - 1 ? '前沿层 L' + r : '演进层 L' + r);
      if (yrs.length) {
        var lo = Math.min.apply(null, yrs), hi = Math.max.apply(null, yrs);
        hdrLabel += ' (' + (lo === hi ? lo : lo + '-' + hi) + ')';
      }
      rankHeaders.push({ x: x, label: hdrLabel });
      list.forEach(function (n, rowIdx) {
        var citedBy = outDirect.get(n.key) || 0;
        var cites = inDirect.get(n.key) || 0;
        var role = n.backboneRole || (citedBy >= 2 && cites === 0 ? 'foundation'
          : (citedBy >= 1 && cites >= 1 ? 'bridge' : (cites >= 1 ? 'frontier' : 'isolated')));
        positioned.push(Object.assign({}, n, {
          x: x,
          y: startY + rowIdx * rowGap,
          backboneRank: r,
          backboneRole: role
        }));
      });
    });

    return {
      nodes: positioned,
      edges: edges,
      width: width,
      height: height,
      lanes: sortedRanks.length,
      rankHeaders: rankHeaders
    };
  }

  /** 时间→x 映射 + 贪心分道避让。无日期节点置于末端「日期未知」列。 */
  function layout(graph, mode) {
    var g = graph || { nodes: [], edges: [] };
    var nodes = (g.nodes || []).slice();
    if (mode === 'network') return networkLayout(nodes, (g.edges || []).slice());
    if (mode === 'backbone') return backboneLayout(nodes, (g.edges || []).slice());
    var width = Math.max(920, nodes.length * MIN_GAP + PAD_X * 2);
    var dated = [], undated = [];
    nodes.forEach(function (n) {
      var t = timeOf(n);
      (isNaN(t) ? undated : dated).push({ node: n, t: t });
    });
    dated.sort(function (a, b) { return a.t - b.t; });
    var min = dated.length ? dated[0].t : Date.now();
    var max = dated.length ? dated[dated.length - 1].t : min + 1;
    var span = max - min || 1;
    var ordered = dated.map(function (d) {
      return Object.assign({}, d.node, { x: PAD_X + (d.t - min) / span * (width - PAD_X * 2 - 110) });
    });
    undated.forEach(function (d) {
      ordered.push(Object.assign({}, d.node, { x: width - PAD_X - 70 }));
    });

    var lanes = [];
    ordered.forEach(function (n) {
      var target = -1;
      for (var i = 0; i < lanes.length; i++) {
        if (n.x - lanes[i] >= MIN_GAP) { target = i; break; }
      }
      if (target < 0) { target = lanes.length; lanes.push(-Infinity); }
      lanes[target] = n.x;
      n.y = TOP_Y + target * LANE_H;
      n.lane = target;
    });
    var height = Math.max(260, TOP_Y + Math.max(1, lanes.length) * LANE_H + 60);
    return { nodes: ordered, edges: (g.edges || []).slice(), width: width, height: height, lanes: lanes.length };
  }

  function networkLayout(nodes, edges) {
    var count = nodes.length;
    var width = Math.max(920, Math.min(1800, Math.sqrt(count) * 145 + 320));
    var height = Math.max(540, Math.min(1100, Math.sqrt(count) * 88 + 280));
    var cx = width / 2, cy = height / 2;
    var radius = Math.min(width, height) * 0.34;
    var positions = nodes.map(function (_, i) {
      var angle = i * 2.399963229728653;
      var distance = radius * Math.sqrt((i + 0.5) / Math.max(1, count));
      return { x: cx + Math.cos(angle) * distance, y: cy + Math.sin(angle) * distance };
    });

    if (count > 1 && count <= 220) {
      var nodeIndex = new Map(nodes.map(function (node, i) { return [node.key, i]; }));
      var pairWeights = new Map();
      edges.forEach(function (edge) {
        var a = nodeIndex.get(edge.from), b = nodeIndex.get(edge.to);
        if (a == null || b == null || a === b) return;
        var first = Math.min(a, b), second = Math.max(a, b);
        var key = first + ':' + second;
        var strength = Math.min(1.5, Math.max(0.35, Math.log1p(Number(edge.weight) || 1)));
        pairWeights.set(key, Math.max(pairWeights.get(key) || 0, strength));
      });
      var links = Array.from(pairWeights, function (entry) {
        var parts = entry[0].split(':');
        return { a: Number(parts[0]), b: Number(parts[1]), strength: entry[1] };
      });
      for (var step = 0; step < 55; step++) {
        var fx = new Float64Array(count), fy = new Float64Array(count);
        for (var i = 0; i < count; i++) {
          for (var j = i + 1; j < count; j++) {
            var dx = positions[i].x - positions[j].x;
            var dy = positions[i].y - positions[j].y;
            var distanceSq = Math.max(64, dx * dx + dy * dy);
            var force = 5200 / distanceSq;
            fx[i] += dx * force; fy[i] += dy * force;
            fx[j] -= dx * force; fy[j] -= dy * force;
          }
        }
        links.forEach(function (link) {
          var dx = positions[link.b].x - positions[link.a].x;
          var dy = positions[link.b].y - positions[link.a].y;
          var distance = Math.max(1, Math.sqrt(dx * dx + dy * dy));
          var force = (distance - 145) * 0.012 * link.strength;
          var xForce = dx / distance * force, yForce = dy / distance * force;
          fx[link.a] += xForce; fy[link.a] += yForce;
          fx[link.b] -= xForce; fy[link.b] -= yForce;
        });
        for (var k = 0; k < count; k++) {
          fx[k] += (cx - positions[k].x) * 0.0015;
          fy[k] += (cy - positions[k].y) * 0.0015;
          var magnitude = Math.sqrt(fx[k] * fx[k] + fy[k] * fy[k]) || 1;
          var scale = Math.min(8, magnitude) / magnitude;
          positions[k].x = Math.max(36, Math.min(width - 36, positions[k].x + fx[k] * scale));
          positions[k].y = Math.max(48, Math.min(height - 36, positions[k].y + fy[k] * scale));
        }
      }
    }

    return {
      nodes: nodes.map(function (node, i) { return Object.assign({}, node, positions[i]); }),
      edges: edges, width: width, height: height, lanes: 0
    };
  }

  function applyTransform() {
    if (!state.viewport) return;
    state.viewport.setAttribute('transform',
      'translate(' + state.tx + ',' + state.ty + ') scale(' + state.scale + ')');
  }

  function listen(target, type, fn, options) {
    target.addEventListener(type, fn, options);
    state.listeners.push({ target: target, type: type, fn: fn, options: options });
  }

  function neighborsOf(key) {
    var set = new Set([key]);
    (state.laid.edges || []).forEach(function (e) {
      if (e.from === key) set.add(e.to);
      if (e.to === key) set.add(e.from);
    });
    return set;
  }

  function edgeMatchesPath(edge, pairSet) {
    if (!pairSet || !edge) return false;
    var a = edge.from + '\u0000' + edge.to;
    var b = edge.to + '\u0000' + edge.from;
    return pairSet.has(a) || pairSet.has(b);
  }

  function updateEmphasis() {
    if (!state.svg || !state.laid) return;
    var hasPath = !!(state.pathNodes && state.pathNodes.size);
    var active = state.hoverKey || state.focusKey || '';
    var near = active ? neighborsOf(active) : null;
    Array.prototype.forEach.call(state.svg.querySelectorAll('[data-nodekey]'), function (g) {
      var k = g.getAttribute('data-nodekey');
      var onPath = hasPath && state.pathNodes.has(k);
      g.classList.toggle('is-path-node', onPath);
      if (hasPath && !active) {
        g.classList.toggle('is-dim', !onPath);
        g.classList.toggle('is-focus', false);
      } else {
        g.classList.toggle('is-dim', !!near && !near.has(k) && !onPath);
        g.classList.toggle('is-focus', !!active && k === active);
      }
    });
    Array.prototype.forEach.call(state.svg.querySelectorAll('[data-edgeindex]'), function (p) {
      var i = Number(p.getAttribute('data-edgeindex'));
      var e = state.laid.edges[i];
      var onPath = hasPath && edgeMatchesPath(e, state.pathEdges);
      p.classList.toggle('is-path-edge', onPath);
      if (hasPath && !active) {
        p.classList.toggle('is-dim', !onPath);
        p.classList.toggle('is-hot', onPath);
      } else {
        var on = !!near && near.has(e.from) && near.has(e.to) && (e.from === active || e.to === active);
        p.classList.toggle('is-dim', !!near && !on && !onPath);
        p.classList.toggle('is-hot', on || onPath);
      }
    });
  }

  function edgePath(a, b, offset) {
    var dx = Math.max(30, Math.abs(b.x - a.x) * 0.45);
    var bend = Number(offset) || 0;
    return 'M ' + a.x + ',' + a.y + ' C ' + (a.x + dx) + ',' + (a.y + bend) +
      ' ' + (b.x - dx) + ',' + (b.y + bend) + ' ' + b.x + ',' + b.y;
  }

  function edgeDescription(edge, byKey) {
    var count = Number(edge.sharedReferenceCount || edge.coCitedByCount || edge.sharedAuthorCount || 0);
    if (edge.via === 'coupling') return '共同参考文献 · ' + count + ' 篇';
    if (edge.via === 'cocitation') return '共同被引 · ' + count + ' 篇';
    if (edge.via === 'coauthor') return '共同作者 · ' + (edge.sharedAuthors || []).join(', ');
    if (edge.via === 'notes') return '笔记中的显式论文引用';
    var from = byKey.get(edge.from), to = byKey.get(edge.to);
    return '直接引用：' + (from ? from.label : edge.from) + ' → ' + (to ? to.label : edge.to);
  }

  function paint() {
    if (!state.container || !state.svg) return;
    var graph = state.graph || { nodes: [], edges: [] };
    var filteredNodes = state.filter ? (graph.nodes || []).filter(state.filter) : (graph.nodes || []).slice();
    var visibleKeys = new Set(filteredNodes.map(function (node) { return node.key; }));
    var filteredEdges = (graph.edges || []).filter(function (edge) {
      return visibleKeys.has(edge.from) && visibleKeys.has(edge.to) &&
        (!state.edgeFilter || state.edgeFilter(edge));
    });
    // backbone 模式始终对低信噪比推导边剪枝，只保留直接引文 + 孤立节点最强桥接边
    if (state.layoutMode === 'backbone') {
      var directList = filteredEdges.filter(function (e) { return !!DIRECT_VIAS[e.via]; });
      var connectedByDirect = new Set();
      directList.forEach(function (e) { connectedByDirect.add(e.from); connectedByDirect.add(e.to); });
      var bridgeCount = new Map();
      var bridges = filteredEdges
        .filter(function (e) { return !DIRECT_VIAS[e.via]; })
        .sort(function (a, b) { return (Number(b.weight) || 0) - (Number(a.weight) || 0); })
        .filter(function (e) {
          if (connectedByDirect.has(e.from) && connectedByDirect.has(e.to)) return false;
          if ((bridgeCount.get(e.from) || 0) >= 1 && (bridgeCount.get(e.to) || 0) >= 1) return false;
          bridgeCount.set(e.from, (bridgeCount.get(e.from) || 0) + 1);
          bridgeCount.set(e.to, (bridgeCount.get(e.to) || 0) + 1);
          return true;
        });
      filteredEdges = directList.concat(bridges);
    }
    var layoutEdges = (graph.edges || []).filter(function (edge) {
      return visibleKeys.has(edge.from) && visibleKeys.has(edge.to);
    });
    state.laid = layout({ nodes: filteredNodes, edges: layoutEdges }, state.layoutMode);
    state.laid.edges = filteredEdges;
    var L = state.laid;
    var keySet = new Set(L.nodes.map(function (n) { return n.key; }));
    var byKey = new Map(L.nodes.map(function (n) { return [n.key, n]; }));

    var containerH = state.container && state.container.clientHeight ? state.container.clientHeight : 0;
    var targetH = containerH > 320 ? Math.max(containerH - 36, Math.min(720, L.height)) : Math.min(560, L.height);
    state.svg.setAttribute('viewBox', '0 0 ' + L.width + ' ' + L.height);
    state.svg.setAttribute('width', '100%');
    state.svg.setAttribute('height', Math.round(targetH) + 'px');
    while (state.viewport.firstChild) state.viewport.removeChild(state.viewport.firstChild);

    if (state.layoutMode === 'timeline') {
      var years = [];
      L.nodes.forEach(function (n) {
        if (n.year && years.indexOf(n.year) < 0) years.push(n.year);
      });
      years.sort();
      state.viewport.appendChild(el('line', { x1: PAD_X, y1: 28, x2: L.width - PAD_X, y2: 28, class: 'timeline-axis' }));
      years.forEach(function (y) {
        var sample = L.nodes.find(function (n) { return n.year === y; });
        if (!sample) return;
        state.viewport.appendChild(el('line', { x1: sample.x, y1: 24, x2: sample.x, y2: 34, class: 'timeline-tick' }));
        state.viewport.appendChild(el('text', { x: sample.x, y: 18, class: 'timeline-year-label', 'text-anchor': 'middle' }, String(y)));
      });
    } else if (state.layoutMode === 'backbone' && Array.isArray(L.rankHeaders)) {
      state.viewport.appendChild(el('line', { x1: PAD_X, y1: 28, x2: L.width - PAD_X, y2: 28, class: 'timeline-axis' }));
      L.rankHeaders.forEach(function (hdr) {
        state.viewport.appendChild(el('line', { x1: hdr.x, y1: 36, x2: hdr.x, y2: L.height - 20, class: 'timeline-backbone-guide' }));
        state.viewport.appendChild(el('text', { x: hdr.x, y: 18, class: 'timeline-year-label', 'text-anchor': 'middle' }, hdr.label));
      });
    }

    var pairCounts = new Map();
    L.edges.forEach(function (edge) {
      var pair = [edge.from, edge.to].sort().join('\u0000');
      pairCounts.set(pair, (pairCounts.get(pair) || 0) + 1);
    });
    var pairOffsets = new Map();
    var edgeLayer = el('g', { class: 'timeline-edges' });
    L.edges.forEach(function (e, i) {
      if (!keySet.has(e.from) || !keySet.has(e.to)) return;
      var a = byKey.get(e.from), b = byKey.get(e.to);
      var pair = [e.from, e.to].sort().join('\u0000');
      var pairIndex = pairOffsets.get(pair) || 0;
      pairOffsets.set(pair, pairIndex + 1);
      var parallelCount = pairCounts.get(pair) || 1;
      var offset = (pairIndex - (parallelCount - 1) / 2) * 10;
      var edgeClass = 'timeline-edge via-' + String(e.via || '').replace(/[^a-z0-9_-]/gi, '');
      var path = el('path', {
        d: edgePath(a, b, offset),
        class: edgeClass,
        'data-edgeindex': i,
        'stroke-width': Math.min(3, 1 + Math.log1p(Number(e.weight) || 1) * 0.45)
      });
      if (e.directed !== false) path.setAttribute('marker-end', 'url(#tlArrow)');
      path.appendChild(el('title', {}, edgeDescription(e, byKey)));
      edgeLayer.appendChild(path);
    });
    state.viewport.appendChild(edgeLayer);

    // 节点：圆点 + 简称 + 年份 + 评级色环；已入库实线 / 仅检索虚线
    var nodeLayer = el('g', { class: 'timeline-nodes' });
    L.nodes.forEach(function (n) {
      var roleCls = n.backboneRole ? ' role-' + String(n.backboneRole).replace(/[^a-z0-9_-]/gi, '') : '';
      var g = el('g', {
        class: 'timeline-node ' + (n.source === 'local' ? 'is-local' : 'is-search') + roleCls,
        'data-nodekey': n.key,
        transform: 'translate(' + n.x + ',' + n.y + ')',
        tabindex: '0',
        role: 'button',
        'aria-label': n.label
      });
      var rating = String(n.rating || '').toUpperCase();
      var ringClass = 'rating-ring' + (['S', 'A', 'B', 'C'].indexOf(rating) >= 0 ? ' ' + rating : '');
      var nodeRadius = Math.min(14, 6 + Math.log10(Math.max(0, Number(n.citedByCount) || 0) + 1) * 2);
      var labelX = nodeRadius + 5;
      g.appendChild(el('circle', { r: nodeRadius, class: 'node-ring ' + ringClass }));
      g.appendChild(el('circle', { r: nodeRadius * 0.38, class: 'node-dot' }));
      var label = String(n.label || '').slice(0, 18);
      g.appendChild(el('text', { x: labelX, y: -3, class: 'timeline-node-label' }, label));
      g.appendChild(el('text', { x: labelX, y: 11, class: 'timeline-node-meta' },
        (n.year ? String(n.year) : '日期未知') + (n.citedByCount ? ' · ' + Number(n.citedByCount).toLocaleString('en-US') + ' 次' : '')));
      var authorNote = Array.isArray(n.authors) && n.authors.length ? ' · ' + n.authors.slice(0, 4).join(', ') : '';
      var title = el('title', {}, n.label + authorNote + ' · 引用量 ' +
        Number(n.citedByCount || 0).toLocaleString('en-US') +
        (rating ? ' · 评级 ' + rating + '（辅助判断、非学术定论）' : ''));
      g.appendChild(title);
      listen(g, 'mouseenter', function () { state.hoverKey = n.key; updateEmphasis(); });
      listen(g, 'mouseleave', function () { state.hoverKey = ''; updateEmphasis(); });
      listen(g, 'focus', function () { state.hoverKey = n.key; updateEmphasis(); });
      listen(g, 'blur', function () { state.hoverKey = ''; updateEmphasis(); });
      listen(g, 'click', function (ev) {
        ev.stopPropagation();
        if (state.opts.nodeClick) state.opts.nodeClick(n);
      });
      listen(g, 'keydown', function (ev) {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          if (state.opts.nodeClick) state.opts.nodeClick(n);
        }
      });
      nodeLayer.appendChild(g);
    });
    state.viewport.appendChild(nodeLayer);
    if (state.laid.nodes.length === 0) {
      var empty = el('text', { x: L.width / 2, y: L.height / 2, 'text-anchor': 'middle', class: 'timeline-empty' },
        '当前筛选下没有论文节点');
      state.viewport.appendChild(empty);
    }
    applyTransform();
    updateEmphasis();
  }

  /** 渲染到容器；opts: {nodeClick, layout}。 */
  function render(container, graph, opts) {
    destroy();
    state.container = container || null;
    state.graph = graph || { nodes: [], edges: [] };
    state.opts = opts || {};
    state.scale = 1; state.tx = 0; state.ty = 0; state.focusKey = ''; state.hoverKey = '';
    state.pathNodes = null; state.pathEdges = null;
    state.filter = null; state.edgeFilter = null;
    state.layoutMode = state.opts.layout === 'network' ? 'network'
      : state.opts.layout === 'backbone' ? 'backbone' : 'timeline';

    var wrap = document.createElement('div');
    wrap.className = 'timeline-wrap';
    wrap.innerHTML = '<div class="timeline-hint">滚轮缩放 · 拖拽平移 · 悬停高亮一跳关系 · 点击节点查看详情</div>';
    state.svg = el('svg', { class: 'timeline-svg', xmlns: NS, viewBox: '0 0 920 300', preserveAspectRatio: 'xMidYMin meet' });
    var defs = el('defs', {});
    var marker = el('marker', {
      id: 'tlArrow', viewBox: '0 0 10 10', refX: '9', refY: '5',
      markerWidth: '6', markerHeight: '6', orient: 'auto-start-reverse'
    });
    marker.appendChild(el('path', { d: 'M 0 0 L 10 5 L 0 10 z', class: 'timeline-arrow' }));
    defs.appendChild(marker);
    state.svg.appendChild(defs);
    state.viewport = el('g', { class: 'timeline-viewport' });
    state.svg.appendChild(state.viewport);
    wrap.appendChild(state.svg);
    (state.container || document.body).appendChild(wrap);

    listen(state.svg, 'wheel', function (ev) {
      ev.preventDefault();
      zoom(ev.deltaY > 0 ? -0.12 : 0.12);
    }, { passive: false });
    var dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
    listen(state.svg, 'mousedown', function (ev) {
      if (ev.target.closest && ev.target.closest('.timeline-node')) return;
      dragging = true; sx = ev.clientX; sy = ev.clientY; ox = state.tx; oy = state.ty;
      state.svg.classList.add('is-dragging');
    });
    listen(window, 'mousemove', function (ev) {
      if (!dragging) return;
      var dx = ev.clientX - sx, dy = ev.clientY - sy;
      state.tx = ox + dx; state.ty = oy + dy;
      applyTransform();
    });
    listen(window, 'mouseup', function () {
      if (!dragging) return;
      dragging = false;
      if (state.svg) state.svg.classList.remove('is-dragging');
    });
    paint();
    return state.laid;
  }

  function zoom(delta) {
    state.scale = Math.max(0.4, Math.min(2.6, state.scale + Number(delta || 0)));
    applyTransform();
    return state.scale;
  }
  function pan(dx, dy) {
    state.tx += Number(dx || 0); state.ty += Number(dy || 0);
    applyTransform();
  }
  function reset() {
    state.scale = 1; state.tx = 0; state.ty = 0; state.focusKey = ''; state.hoverKey = '';
    state.pathNodes = null; state.pathEdges = null;
    state.filter = null; state.edgeFilter = null;
    paint();
  }
  /** 一跳聚焦：只强调目标及直接引用/被引邻居（P1-2）。传空串清除。 */
  function focus(key) {
    state.focusKey = String(key || '');
    updateEmphasis();
  }
  /** 高亮最短演化路径（nodeKeys: string[], edges?: [{from,to}]）。传 null/空数组清除。 */
  function highlightPath(nodeKeys, edges) {
    if (!Array.isArray(nodeKeys) || !nodeKeys.length) {
      state.pathNodes = null;
      state.pathEdges = null;
    } else {
      state.pathNodes = new Set(nodeKeys.map(String));
      var pairSet = new Set();
      if (Array.isArray(edges) && edges.length) {
        edges.forEach(function (e) {
          if (e && e.from && e.to) pairSet.add(String(e.from) + '\u0000' + String(e.to));
        });
      } else {
        for (var i = 1; i < nodeKeys.length; i++) {
          pairSet.add(String(nodeKeys[i - 1]) + '\u0000' + String(nodeKeys[i]));
        }
      }
      state.pathEdges = pairSet;
    }
    updateEmphasis();
  }
  /** 按节点谓词筛选并重排（P1-2 时间/入库状态筛选）。 */
  function setFilter(fn) {
    state.filter = typeof fn === 'function' ? fn : null;
    paint();
  }
  function setEdgeFilter(fn) {
    state.edgeFilter = typeof fn === 'function' ? fn : null;
    paint();
  }
  function setLayout(mode) {
    state.layoutMode = mode === 'network' ? 'network'
      : mode === 'backbone' ? 'backbone' : 'timeline';
    paint();
  }
  function destroy() {
    state.listeners.forEach(function (x) {
      try { x.target.removeEventListener(x.type, x.fn, x.options); } catch (_) {}
    });
    state.listeners = [];
    if (state.container) state.container.innerHTML = '';
    state.container = null; state.svg = null; state.viewport = null; state.laid = null;
    state.filter = null; state.edgeFilter = null; state.focusKey = ''; state.hoverKey = '';
    state.pathNodes = null; state.pathEdges = null;
  }

  global.Timeline = {
    render: render, layout: layout, zoom: zoom, pan: pan,
    reset: reset, focus: focus, setFilter: setFilter, setEdgeFilter: setEdgeFilter,
    setLayout: setLayout, highlightPath: highlightPath, destroy: destroy
  };
})(window);
