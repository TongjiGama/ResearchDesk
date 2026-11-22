/* 科研台 — Chart.js 适配器（唯一封装层）
 * 对外 6 个公开方法签名固定：render / renderSimple / refreshTheme / destroy / destroyAll / exportPng。
 * 所有颜色取自 CSS 变量（双主题）；实例注册表统一在 DOM 重建与主题切换时管理。
 * 若 window.Chart 因故不可用，内部降级为 canvas 2D 手绘，保证签名与调用点零改动。
 */
(function (global) {
  'use strict';

  var instances = new Map();

  /** 读取 body 上的 CSS 变量（跟随主题实时变化）。 */
  function cssVar(name, fallback) {
    try {
      var v = getComputedStyle(document.body).getPropertyValue(name).trim();
      return v || fallback;
    } catch (e) { return fallback; }
  }

  /** 当前主题调色板；序列色板固定 5 色。 */
  function palette() {
    return {
      text: cssVar('--text', '#1f2733'),
      text2: cssVar('--text-2', '#5a6472'),
      grid: cssVar('--border-strong', '#cdd3da'),
      surface: cssVar('--surface', '#ffffff'),
      accent: cssVar('--accent', '#2b5f9e'),
      series: [
        cssVar('--accent', '#2b5f9e'),
        cssVar('--green', '#1d9e75'),
        cssVar('--purple', '#6b5bb5'),
        cssVar('--amber', '#b8860b'),
        cssVar('--red', '#c0392b')
      ]
    };
  }

  /** 给任意 CSS 颜色加透明度（兼容 #rgb / #rrggbb / rgb() / rgba()）。 */
  function withAlpha(color, alpha) {
    var c = String(color || '').trim();
    var m3 = c.match(/^#([0-9a-f]{3})$/i);
    if (m3) {
      var h3 = m3[1];
      return 'rgba(' + parseInt(h3.charAt(0) + h3.charAt(0), 16) + ',' +
        parseInt(h3.charAt(1) + h3.charAt(1), 16) + ',' +
        parseInt(h3.charAt(2) + h3.charAt(2), 16) + ',' + alpha + ')';
    }
    var m6 = c.match(/^#([0-9a-f]{6})$/i);
    if (m6) {
      var h6 = m6[1];
      return 'rgba(' + parseInt(h6.slice(0, 2), 16) + ',' +
        parseInt(h6.slice(2, 4), 16) + ',' +
        parseInt(h6.slice(4, 6), 16) + ',' + alpha + ')';
    }
    var mr = c.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i);
    if (mr) return 'rgba(' + mr[1] + ',' + mr[2] + ',' + mr[3] + ',' + alpha + ')';
    return c;
  }

  /**
   * 写回数据集配色。colorIndex 非空表示该序列取自主题色板，主题切换时按索引重取色；
   * 为空表示调用方显式指定颜色（如统计面板的自定义色），重绘时保留原色。
   */
  function setDatasetColor(ds, color, isBar, colorIndex) {
    ds._baseColor = color;
    if (typeof colorIndex === 'number') ds._colorIndex = colorIndex;
    ds.borderColor = color;
    ds.backgroundColor = isBar ? withAlpha(color, 0.62) : withAlpha(color, 0.14);
  }

  /**
   * 判断显式传入的颜色是否来自当前主题色板（统计面板常见写法）。
   * 返回色板索引 => refreshTheme 换主题时按索引重取色；
   * 返回 null => 真正的自定义色，按设计约定保持不变。
   */
  function paletteColorIndex(color, pal) {
    if (!color) return null;
    var target = String(color).trim().toLowerCase();
    for (var i = 0; i < pal.series.length; i++) {
      if (String(pal.series[i]).trim().toLowerCase() === target) return i;
    }
    return null;
  }

  /** 解析 series 的色板索引：显式 colorIndex > 显式 palette 色 > 按序取色板。 */
  function seriesColorIndex(s, i, pal) {
    if (typeof s.colorIndex === 'number') return s.colorIndex;
    return s.color ? paletteColorIndex(s.color, pal) : (i % pal.series.length);
  }

  function buildLegend(pal) {
    return {
      display: true,
      position: 'top',
      labels: { color: pal.text2, usePointStyle: true, boxWidth: 8, padding: 14, font: { size: 11 } }
    };
  }

  function buildTooltip(pal) {
    return {
      backgroundColor: withAlpha(pal.text, 0.92),
      titleColor: pal.surface,
      bodyColor: pal.surface,
      borderColor: withAlpha(pal.grid, 0.8),
      borderWidth: 1,
      padding: 10,
      cornerRadius: 6
    };
  }

  /** 笛卡尔坐标系配置（折线 / 柱状 / 多轴）。 */
  function buildScales(pal, kind, hasY1) {
    var isBar = kind === 'bar';
    var tickFont = { size: 11 };
    var scales = {
      x: {
        ticks: { color: pal.text2, font: tickFont, maxRotation: 40, minRotation: 0 },
        grid: { color: withAlpha(pal.grid, 0.3), drawOnChartArea: false },
        border: { color: pal.grid }
      },
      y: {
        position: 'left',
        ticks: { color: pal.text2, font: tickFont },
        grid: { color: withAlpha(pal.grid, 0.3) },
        border: { color: pal.grid },
        suggestedMin: isBar ? 0 : undefined
      }
    };
    if (hasY1) {
      scales.y1 = {
        position: 'right',
        ticks: { color: pal.text2, font: tickFont },
        grid: { drawOnChartArea: false },
        border: { color: pal.grid }
      };
    }
    return scales;
  }

  /** 极坐标（环图 / 饼图）配置。 */
  function buildCircularConfig(pal, labels, series, kind) {
    var indexes = series.map(function (s, i) { return seriesColorIndex(s, i, pal); });
    var colors = series.map(function (s, i) {
      var idx = indexes[i];
      return typeof idx === 'number' ? pal.series[idx % pal.series.length] : s.color;
    });
    var ds = {
      data: series.map(function (s) { return s.data; }),
      backgroundColor: colors,
      borderColor: pal.grid,
      borderWidth: 2,
      hoverOffset: 6
    };
    ds._baseColor = null;
    ds._colorIndexes = indexes;
    var options = {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: buildLegend(pal), tooltip: buildTooltip(pal) }
    };
    if (kind === 'doughnut') options.cutout = '62%';
    return { type: kind === 'pie' ? 'pie' : 'doughnut', data: { labels: labels, datasets: [ds] }, options: options };
  }

  /** 创建 Chart.js 实例；库缺失时降级为 canvas 2D 手绘实例。 */
  function createChart(canvas, config) {
    if (typeof global.Chart === 'function') {
      try { return new global.Chart(canvas, config); } catch (e) { console.error('Charts.create', e); }
    }
    return fallbackChart(canvas, config);
  }

  /** 极简 canvas 2D 降级实现（仅在 Chart.js 未加载时启用，公开接口一致）。 */
  function fallbackChart(canvas, config) {
    var ctx = canvas && canvas.getContext ? canvas.getContext('2d') : null;
    var self = {
      config: { type: config.type },
      data: config.data,
      options: config.options,
      canvas: canvas,
      destroy: function () { self._destroyed = true; },
      update: function () { draw(); },
      toBase64Image: function () {
        try { return canvas.toDataURL('image/png', 1); } catch (e) { return ''; }
      }
    };
    function draw() {
      if (!ctx || self._destroyed || !canvas) return;
      var dpr = global.devicePixelRatio || 1;
      var w = canvas.clientWidth || 480;
      var h = canvas.clientHeight || 240;
      canvas.width = Math.max(1, Math.round(w * dpr));
      canvas.height = Math.max(1, Math.round(h * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      var pal = palette();
      var datasets = self.data.datasets || [];
      var labels = self.data.labels || [];
      var type = self.config.type;
      var padL = 38, padR = 12, padT = 12, padB = 30;
      var cw = Math.max(10, w - padL - padR);
      var ch = Math.max(10, h - padT - padB);
      var all = [];
      datasets.forEach(function (ds) { (ds.data || []).forEach(function (v) { if (v != null && isFinite(v)) all.push(Number(v)); }); });
      var max = all.length ? Math.max.apply(null, all) : 1;
      if (max <= 0) max = 1;
      ctx.strokeStyle = withAlpha(pal.grid, 0.35);
      ctx.fillStyle = pal.text2;
      ctx.font = '11px sans-serif';
      ctx.lineWidth = 1;
      for (var g = 0; g <= 4; g++) {
        var gy = padT + ch * g / 4;
        ctx.beginPath(); ctx.moveTo(padL, gy); ctx.lineTo(padL + cw, gy); ctx.stroke();
        ctx.fillText(String(Math.round(max * (4 - g) / 4)), 4, gy + 4);
      }
      var n = labels.length || (datasets[0] && datasets[0].data ? datasets[0].data.length : 0);
      if (!n) return;
      var step = cw / n;
      datasets.forEach(function (ds, di) {
        var color = (ds._baseColor || pal.series[di % pal.series.length]);
        ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 2;
        if (type === 'line') {
          ctx.beginPath();
          (ds.data || []).forEach(function (v, i) {
            if (v == null || !isFinite(v)) return;
            var x = padL + step * (i + 0.5);
            var y = padT + ch - (Number(v) / max) * ch;
            if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
          });
          ctx.stroke();
        } else {
          var bw = Math.max(2, step * 0.7 / (datasets.length || 1));
          (ds.data || []).forEach(function (v, i) {
            if (v == null || !isFinite(v)) return;
            var x = padL + step * i + step * 0.15 + di * bw;
            var bh = (Number(v) / max) * ch;
            ctx.globalAlpha = 0.7;
            ctx.fillRect(x, padT + ch - bh, bw, bh);
            ctx.globalAlpha = 1;
          });
        }
      });
      ctx.fillStyle = pal.text2;
      labels.forEach(function (label, i) {
        if (n > 12 && i % Math.ceil(n / 12) !== 0) return;
        var txt = String(label).length > 8 ? String(label).slice(0, 7) + '…' : String(label);
        ctx.fillText(txt, padL + step * i + 2, h - 10);
      });
    }
    draw();
    return self;
  }

  /**
   * 由 CSV 解析结果 + 图表配置渲染折线 / 柱状图。
   * @param {string} key 注册表键，重复键会先销毁旧实例
   * @param {HTMLCanvasElement} canvas 画布
   * @param {object} parsed CSV.parse 结果
   * @param {object} cfg {type:'line'|'bar', xKey, yKeys:string[], yAxes:{}}
   */
  function render(key, canvas, parsed, cfg) {
    destroy(key);
    if (!canvas) return null;
    var p = parsed || { headers: [], rows: [], numericColumns: [] };
    var conf = cfg || {};
    var headers = p.headers || [];
    var rows = p.rows || [];
    var pal = palette();

    var xKey = conf.xKey && headers.indexOf(conf.xKey) >= 0 ? conf.xKey : (headers[0] || '');
    var xIdx = Math.max(0, headers.indexOf(xKey));
    var nums = p.numericColumns || [];
    var yKeys = Array.isArray(conf.yKeys) ? conf.yKeys.filter(function (k) { return headers.indexOf(k) >= 0; }) : [];
    if (!yKeys.length && nums.length) yKeys = [nums[0].name];
    if (!yKeys.length) yKeys = headers.slice(1, 3);

    var type = conf.type === 'bar' ? 'bar' : 'line';
    var yAxes = conf.yAxes || {};
    var labels = rows.map(function (r) { return String(r[xIdx] == null ? '' : r[xIdx]); });
    var datasets = yKeys.map(function (k, i) {
      var idx = headers.indexOf(k);
      var color = pal.series[i % pal.series.length];
      var ds = {
        label: k,
        data: rows.map(function (r) {
          var v = global.CSV ? global.CSV.toNumber(r[idx]) : Number(String(r[idx] == null ? '' : r[idx]).replace(/[,%]/g, ''));
          return (v == null || !isFinite(v)) ? null : v;
        }),
        borderWidth: 2,
        pointRadius: type === 'line' ? 2.5 : 0,
        pointHoverRadius: 5,
        tension: 0.25,
        fill: false,
        yAxisID: yAxes[k] === 'y1' ? 'y1' : 'y'
      };
      setDatasetColor(ds, color, type === 'bar', i % pal.series.length);
      return ds;
    });
    var hasY1 = datasets.some(function (d) { return d.yAxisID === 'y1'; });
    var config = {
      type: type,
      data: { labels: labels, datasets: datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: { legend: buildLegend(pal), tooltip: buildTooltip(pal) },
        scales: buildScales(pal, type, hasY1)
      }
    };
    var chart = createChart(canvas, config);
    instances.set(key, { chart: chart, config: config, parsed: p, cfg: conf, kind: type, canvas: canvas });
    return chart;
  }

  /**
   * 渲染统计面板用的简化图表。
   * @param {string} key 注册表键
   * @param {HTMLCanvasElement} canvas 画布
   * @param {string[]} labels 横轴 / 分类标签
   * @param {{label:string,data:number[],color?:string}[]} series 序列
   * @param {string} kind 'bar' | 'line' | 'doughnut' | 'pie'
   */
  function renderSimple(key, canvas, labels, series, kind) {
    destroy(key);
    if (!canvas) return null;
    var type = kind || 'bar';
    var pal = palette();
    var list = Array.isArray(series) ? series : [];
    var names = Array.isArray(labels) ? labels : [];
    var config;
    if (type === 'doughnut' || type === 'pie') {
      config = buildCircularConfig(pal, names, list, type);
    } else {
      var datasets = list.map(function (s, i) {
        var idx = seriesColorIndex(s, i, pal);
        var color = typeof idx === 'number' ? pal.series[idx % pal.series.length] : s.color;
        var ds = {
          label: s.label || ('序列 ' + (i + 1)),
          data: (s.data || []).map(function (v) { return v == null ? null : Number(v); }),
          borderWidth: 2,
          pointRadius: type === 'line' ? 2.5 : 0,
          pointHoverRadius: 5,
          tension: 0.25,
          fill: false
        };
        setDatasetColor(ds, color, type === 'bar', idx);
        return ds;
      });
      config = {
        type: type === 'line' ? 'line' : 'bar',
        data: { labels: names, datasets: datasets },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: { mode: 'index', intersect: false },
          plugins: { legend: buildLegend(pal), tooltip: buildTooltip(pal) },
          scales: buildScales(pal, type, false)
        }
      };
    }
    var chart = createChart(canvas, config);
    instances.set(key, { chart: chart, config: config, labels: names, series: list, kind: type, canvas: canvas });
    return chart;
  }

  /** 主题切换后：重取 CSS 变量，改写颜色字段并无动画更新所有实例。 */
  function refreshTheme() {
    var pal = palette();
    instances.forEach(function (rec) {
      var chart = rec.chart;
      if (!chart || !chart.options) return;
      var opts = chart.options;
      if (opts.scales) {
        Object.keys(opts.scales).forEach(function (k) {
          var sc = opts.scales[k];
          if (sc.ticks) sc.ticks.color = pal.text2;
          if (sc.grid && Object.prototype.hasOwnProperty.call(sc.grid, 'color')) sc.grid.color = withAlpha(pal.grid, 0.3);
          if (sc.border) sc.border.color = pal.grid;
        });
      }
      if (opts.plugins && opts.plugins.legend && opts.plugins.legend.labels) {
        opts.plugins.legend.labels.color = pal.text2;
      }
      if (opts.plugins && opts.plugins.tooltip) {
        var tip = opts.plugins.tooltip;
        tip.backgroundColor = withAlpha(pal.text, 0.92);
        tip.titleColor = pal.surface;
        tip.bodyColor = pal.surface;
        tip.borderColor = withAlpha(pal.grid, 0.8);
      }
      var dsList = (chart.data && chart.data.datasets) || [];
      var circular = rec.kind === 'doughnut' || rec.kind === 'pie';
      dsList.forEach(function (ds, i) {
        if (circular) {
          ds.borderColor = pal.grid;
          var colors = rec.series || [];
          var indexes = ds._colorIndexes || [];
          ds.backgroundColor = colors.map(function (s, j) {
            var idx = indexes[j];
            return typeof idx === 'number'
              ? pal.series[idx % pal.series.length]
              : ((s && s.color) || pal.series[j % pal.series.length]);
          });
        } else {
          var color = (typeof ds._colorIndex === 'number')
            ? pal.series[ds._colorIndex % pal.series.length]
            : (ds._baseColor || pal.series[i % pal.series.length]);
          setDatasetColor(ds, color, rec.kind === 'bar', ds._colorIndex);
        }
      });
      try { chart.update('none'); } catch (e) { /* 降级实例无需动画参数 */ }
    });
  }

  function destroy(key) {
    var rec = instances.get(key);
    if (rec && rec.chart && typeof rec.chart.destroy === 'function') {
      try { rec.chart.destroy(); } catch (e) { /* 忽略已销毁实例 */ }
    }
    instances.delete(key);
  }

  function destroyAll() {
    Array.from(instances.keys()).forEach(destroy);
  }

  /** 导出 PNG dataURL；失败返回空串。 */
  function exportPng(key) {
    var rec = instances.get(key);
    if (!rec || !rec.chart || typeof rec.chart.toBase64Image !== 'function') return '';
    try { return rec.chart.toBase64Image('image/png', 1); } catch (e) { return ''; }
  }

  global.Charts = {
    palette: palette,
    render: render,
    renderSimple: renderSimple,
    refreshTheme: refreshTheme,
    destroy: destroy,
    destroyAll: destroyAll,
    exportPng: exportPng
  };
})(window);
