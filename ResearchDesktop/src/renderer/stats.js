/* Pure-JS statistics & structured result parser for Experiment module (M1/M4). */
(function (root) {
  'use strict';

  function toNumericArray(input) {
    return (Array.isArray(input) ? input : [])
      .map((v) => Number(v))
      .filter((n) => Number.isFinite(n));
  }

  function erf(x) {
    const sign = x < 0 ? -1 : 1;
    const ax = Math.abs(x);
    const t = 1 / (1 + 0.3275911 * ax);
    const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-ax * ax);
    return sign * y;
  }

  function normalTwoTailedP(z) {
    const az = Math.abs(Number(z) || 0);
    return Math.max(0, Math.min(1, 1 - erf(az / Math.SQRT2)));
  }

  function logGamma(z) {
    const p = [
      676.5203681218851, -1259.1392167224028, 771.32342877765313,
      -176.61502916214059, 12.507343278686905, -0.13857109526572012,
      9.9843695780195716e-6, 1.5056327351493116e-7
    ];
    if (z < 0.5) return Math.log(Math.PI) - Math.log(Math.sin(Math.PI * z)) - logGamma(1 - z);
    let x = 0.99999999999980993;
    const z1 = z - 1;
    for (let i = 0; i < p.length; i++) x += p[i] / (z1 + i + 1);
    const t = z1 + p.length - 0.5;
    return 0.5 * Math.log(2 * Math.PI) + (z1 + 0.5) * Math.log(t) - t + Math.log(x);
  }

  function betacf(a, b, x) {
    const maxIter = 100;
    const eps = 3e-7;
    const qab = a + b;
    const qap = a + 1;
    const qam = a - 1;
    let c = 1;
    let d = 1 - (qab * x) / qap;
    if (Math.abs(d) < 1e-30) d = 1e-30;
    d = 1 / d;
    let h = d;
    for (let m = 1; m <= maxIter; m++) {
      const m2 = 2 * m;
      let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
      d = 1 + aa * d;
      if (Math.abs(d) < 1e-30) d = 1e-30;
      c = 1 + aa / c;
      if (Math.abs(c) < 1e-30) c = 1e-30;
      d = 1 / d;
      h *= d * c;
      aa = -((a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
      d = 1 + aa * d;
      if (Math.abs(d) < 1e-30) d = 1e-30;
      c = 1 + aa / c;
      if (Math.abs(c) < 1e-30) c = 1e-30;
      d = 1 / d;
      const del = d * c;
      h *= del;
      if (Math.abs(del - 1) < eps) break;
    }
    return h;
  }

  function regIncompleteBeta(a, b, x) {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    const bt = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
    if (x < (a + 1) / (a + b + 2)) return (bt * betacf(a, b, x)) / a;
    return 1 - (bt * betacf(b, a, 1 - x)) / b;
  }

  function tCrit95(df) {
    if (df <= 1) return 12.706;
    if (df === 2) return 4.303;
    if (df === 3) return 3.182;
    if (df === 4) return 2.776;
    if (df === 5) return 2.571;
    if (df <= 10) return 2.228;
    if (df <= 20) return 2.086;
    if (df <= 30) return 2.042;
    return 1.96;
  }

  /** Google Research rliable 风格四分位均值（IQM）：去掉最低/最高 25% 极端种子后取均值，抗异常值更稳健。 */
  function iqm(values) {
    const nums = toNumericArray(values).sort((a, b) => a - b);
    const n = nums.length;
    if (!n) return null;
    if (n < 4) return nums.reduce((acc, v) => acc + v, 0) / n;
    const lo = Math.floor(n * 0.25);
    const hi = Math.ceil(n * 0.75);
    const slice = nums.slice(lo, hi);
    return slice.reduce((acc, v) => acc + v, 0) / slice.length;
  }

  /** TensorBoard / W&B 风格偏差修正指数移动平均（EMA Smoothing），weight ∈ [0, 0.98]。 */
  function emaSmooth(values, weight = 0.6) {
    const arr = Array.isArray(values) ? values : [];
    const w = Math.max(0, Math.min(0.98, Number(weight) || 0));
    if (w === 0) return arr.slice();
    let last = 0;
    let count = 0;
    return arr.map((raw) => {
      const v = raw === null || raw === undefined || raw === '' ? NaN : Number(raw);
      if (!Number.isFinite(v)) return null;
      last = last * w + (1 - w) * v;
      count++;
      const debias = 1 - Math.pow(w, count);
      return Number((last / debias).toFixed(6));
    });
  }

  function summarize(values) {
    const nums = toNumericArray(values);
    const n = nums.length;
    if (!n) {
      return { n: 0, mean: null, std: null, sem: null, median: null, iqm: null, min: null, max: null, ci95: null, lowNWarning: true };
    }
    const sorted = nums.slice().sort((a, b) => a - b);
    const mean = nums.reduce((acc, v) => acc + v, 0) / n;
    const variance = n > 1 ? nums.reduce((acc, v) => acc + (v - mean) * (v - mean), 0) / (n - 1) : 0;
    const std = Math.sqrt(variance);
    const sem = std / Math.sqrt(n);
    const mid = Math.floor(n / 2);
    const median = n % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    const margin = n > 1 ? tCrit95(n - 1) * sem : 0;
    return {
      n,
      mean,
      std,
      sem,
      median,
      iqm: iqm(nums),
      min: sorted[0],
      max: sorted[n - 1],
      ci95: [mean - margin, mean + margin],
      lowNWarning: n < 3
    };
  }

  function welchTTest(groupA, groupB) {
    const a = toNumericArray(groupA);
    const b = toNumericArray(groupB);
    if (a.length < 2 || b.length < 2) {
      return { ok: false, t: null, df: null, pValue: null, significant: false, meanDiff: null, reason: '样本量不足（每组至少 2 个观测）' };
    }
    const sa = summarize(a);
    const sb = summarize(b);
    const va = (sa.std * sa.std) / a.length;
    const vb = (sb.std * sb.std) / b.length;
    const se2 = va + vb;
    if (se2 === 0) {
      const same = sa.mean === sb.mean;
      return { ok: true, t: same ? 0 : Infinity, df: a.length + b.length - 2, pValue: same ? 1 : 0, significant: !same, meanDiff: sa.mean - sb.mean };
    }
    const t = (sa.mean - sb.mean) / Math.sqrt(se2);
    const df = (se2 * se2) / ((va * va) / (a.length - 1) + (vb * vb) / (b.length - 1));
    const x = df / (df + t * t);
    const pValue = Math.max(0, Math.min(1, regIncompleteBeta(df / 2, 0.5, x)));
    return {
      ok: true,
      t,
      df,
      pValue,
      significant: pValue < 0.05,
      meanDiff: sa.mean - sb.mean
    };
  }

  function mannWhitneyU(groupA, groupB) {
    const a = toNumericArray(groupA);
    const b = toNumericArray(groupB);
    if (!a.length || !b.length) {
      return { ok: false, u: null, z: null, pValue: null, significant: false, reason: '样本为空' };
    }
    const combined = a.map((v) => ({ v, g: 0 })).concat(b.map((v) => ({ v, g: 1 })));
    combined.sort((x, y) => x.v - y.v);
    let rankSumA = 0;
    let i = 0;
    while (i < combined.length) {
      let j = i + 1;
      while (j < combined.length && combined[j].v === combined[i].v) j++;
      const avgRank = (i + 1 + j) / 2;
      for (let k = i; k < j; k++) {
        if (combined[k].g === 0) rankSumA += avgRank;
      }
      i = j;
    }
    const na = a.length;
    const nb = b.length;
    const uA = rankSumA - (na * (na + 1)) / 2;
    const uB = na * nb - uA;
    const u = Math.min(uA, uB);
    const mu = (na * nb) / 2;
    const sigma = Math.sqrt((na * nb * (na + nb + 1)) / 12);
    const z = sigma > 0 ? (u - mu) / sigma : 0;
    const pValue = normalTwoTailedP(z);
    return { ok: true, u, z, pValue, significant: pValue < 0.05 };
  }

  function cohensD(groupA, groupB) {
    const a = toNumericArray(groupA);
    const b = toNumericArray(groupB);
    if (a.length < 2 || b.length < 2) {
      return { ok: false, d: null, magnitude: 'unknown', reason: '样本量不足' };
    }
    const sa = summarize(a);
    const sb = summarize(b);
    const pooledVar = (((a.length - 1) * sa.std * sa.std) + ((b.length - 1) * sb.std * sb.std)) / (a.length + b.length - 2);
    const pooledStd = Math.sqrt(pooledVar);
    if (pooledStd === 0) return { ok: true, d: 0, magnitude: 'negligible' };
    const d = (sa.mean - sb.mean) / pooledStd;
    const absD = Math.abs(d);
    const magnitude = absD < 0.2 ? 'negligible' : absD < 0.5 ? 'small' : absD < 0.8 ? 'medium' : 'large';
    return { ok: true, d, magnitude };
  }

  function splitDelimitedLine(line, sep) {
    const out = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = !inQuotes;
      } else if (ch === sep && !inQuotes) {
        out.push(cur.trim());
        cur = '';
      } else {
        cur += ch;
      }
    }
    out.push(cur.trim());
    return out;
  }

  function parseStructuredData(filename, content) {
    const fname = String(filename || '');
    const raw = String(content == null ? '' : content).trim();
    const ext = fname.includes('.') ? fname.slice(fname.lastIndexOf('.')).toLowerCase() : '';
    if (!raw) return { ok: true, format: ext.replace(/^\./, '') || 'empty', rows: [], columns: [], metrics: {}, warnings: [] };

    if (ext === '.json' || (ext === '' && (raw.startsWith('{') || raw.startsWith('[')))) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          const rows = parsed.filter((r) => r && typeof r === 'object');
          const cols = Array.from(new Set(rows.reduce((acc, r) => acc.concat(Object.keys(r)), [])));
          return { ok: true, format: 'json', rows, columns: cols, metrics: {}, warnings: [] };
        }
        if (parsed && typeof parsed === 'object') {
          const metrics = {};
          for (const [k, v] of Object.entries(parsed)) {
            if (typeof v === 'number' && Number.isFinite(v)) metrics[k] = v;
          }
          return { ok: true, format: 'json', rows: [parsed], columns: Object.keys(parsed), metrics, warnings: [] };
        }
      } catch (e) {
        return { ok: false, format: 'json', rows: [], columns: [], metrics: {}, warnings: [e.message || 'JSON 解析失败'] };
      }
    }

    if (ext === '.jsonl') {
      const rows = [];
      const warnings = [];
      const colSet = new Set();
      raw.split(/\r?\n/).forEach((line, idx) => {
        const t = line.trim();
        if (!t) return;
        try {
          const obj = JSON.parse(t);
          if (obj && typeof obj === 'object') {
            rows.push(obj);
            Object.keys(obj).forEach((k) => colSet.add(k));
          }
        } catch (_) {
          warnings.push(`第 ${idx + 1} 行 JSONL 无法解析`);
        }
      });
      return { ok: true, format: 'jsonl', rows, columns: Array.from(colSet), metrics: {}, warnings };
    }

    if (ext === '.log' || ext === '.txt') {
      const rows = [];
      const metrics = {};
      const lines = raw.split(/\r?\n/);
      const kvRe = /([A-Za-z_][A-Za-z0-9_./-]{0,31})\s*[:=]\s*(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?%?)/gi;
      for (const line of lines) {
        let m;
        const row = {};
        while ((m = kvRe.exec(line))) {
          const val = Number(m[2].replace(/%$/, ''));
          if (Number.isFinite(val)) {
            row[m[1]] = val;
            metrics[m[1]] = val;
          }
        }
        if (Object.keys(row).length) rows.push(row);
      }
      return { ok: true, format: 'log', rows, columns: Object.keys(metrics), metrics, warnings: [] };
    }

    // CSV / TSV
    const sep = ext === '.tsv' ? '\t' : ',';
    const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (!lines.length) return { ok: true, format: 'csv', rows: [], columns: [], metrics: {}, warnings: [] };
    const columns = splitDelimitedLine(lines[0], sep);
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
      const cells = splitDelimitedLine(lines[i], sep);
      const row = {};
      columns.forEach((col, idx) => {
        const rawCell = cells[idx] !== undefined ? cells[idx] : '';
        const num = Number(rawCell);
        row[col] = rawCell !== '' && Number.isFinite(num) ? num : rawCell;
      });
      rows.push(row);
    }
    return { ok: true, format: ext === '.tsv' ? 'tsv' : 'csv', rows, columns, metrics: {}, warnings: [] };
  }

  const Stats = {
    summarize,
    iqm,
    emaSmooth,
    welchTTest,
    mannWhitneyU,
    cohensD,
    parseStructuredData
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Stats;
  }
  if (root) {
    root.Stats = Stats;
  }
})(typeof window !== 'undefined' ? window : globalThis);
