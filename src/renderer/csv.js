/* 科研台 — CSV / TSV 纯前端解析器（零依赖）
 * 与图表渲染共用同一解析结果（P1-1：表格预览与图表同源）。
 * 规则：BOM、引号包裹、"" 转义、字段内逗号/换行、CRLF/LF、空值、未闭合引号容错。
 * 对外：window.CSV = { parse, detectDelimiter, toNumber }
 */
(function (global) {
  'use strict';

  /** 去除开头的 UTF-8 BOM。 */
  function stripBom(text) {
    return String(text == null ? '' : text).replace(/^\uFEFF/, '');
  }

  /** 统计一行中引号之外的分隔符个数。 */
  function countOutsideQuotes(line, delim) {
    var quoted = false;
    var count = 0;
    for (var i = 0; i < line.length; i++) {
      var c = line.charAt(i);
      if (c === '"') {
        if (quoted && line.charAt(i + 1) === '"') { i++; continue; }
        quoted = !quoted;
      } else if (!quoted && c === delim) {
        count++;
      }
    }
    return count;
  }

  /**
   * 探测分隔符：逗号 / 制表符 / 分号。
   * 取前若干非空行中引号外出现次数最多者；平局时优先逗号。
   * @param {string} text 原始文本
   * @returns {string} ',' | '\t' | ';'
   */
  function detectDelimiter(text) {
    var s = stripBom(text);
    var lines = s.split(/\r?\n/).filter(function (l) { return l.length > 0; }).slice(0, 12);
    if (!lines.length) return ',';
    var counts = { ',': 0, '\t': 0, ';': 0 };
    var order = [',', '\t', ';'];
    lines.forEach(function (line) {
      order.forEach(function (d) { counts[d] += countOutsideQuotes(line, d); });
    });
    if (counts['\t'] > counts[','] && counts['\t'] > counts[';']) return '\t';
    if (counts[';'] > counts[','] && counts[';'] > counts['\t']) return ';';
    return ',';
  }

  /**
   * 归一化单个值为数字：去空白、千分位逗号、尾部百分号、支持科学计数法。
   * @param {*} v 原始单元格值
   * @returns {number|null} 数字；空值或非法值返回 null（Chart.js 会跳过 null）
   */
  function toNumber(v) {
    if (v == null) return null;
    var s = String(v).trim();
    if (!s) return null;
    if (s.charAt(s.length - 1) === '%') s = s.slice(0, -1).trim();
    s = s.replace(/,/g, '');
    if (!s) return null;
    if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(s)) return null;
    var n = Number(s);
    return Number.isFinite(n) ? n : null;
  }

  /** 统一的空结果：不抛异常，UI 走友好提示。 */
  function emptyResult(error) {
    return { headers: [], rows: [], numericColumns: [], textColumns: [], delim: ',', error: error || '' };
  }

  /**
   * 解析 CSV / TSV 文本。
   * @param {string} text 原始文本
   * @param {object} opts { delimiter?: string } 显式分隔符（可选，缺省自动探测）
   * @returns {{headers:string[], rows:string[][], numericColumns:{index:number,name:string}[],
   *            textColumns:{index:number,name:string}[], delim:string, error:string}}
   */
  function parse(text, opts) {
    opts = opts || {};
    var raw = stripBom(text);
    if (!String(raw).trim()) return emptyResult('文件为空，没有可解析的数据');

    var delim = opts.delimiter || detectDelimiter(raw);
    if (typeof delim !== 'string' || delim.length !== 1) delim = ',';

    var records = [];
    var row = [];
    var field = '';
    var inQuotes = false;
    var i = 0;
    var len = raw.length;

    while (i < len) {
      var c = raw.charAt(i);
      if (inQuotes) {
        if (c === '"') {
          if (raw.charAt(i + 1) === '"') { field += '"'; i += 2; continue; }
          inQuotes = false; i++; continue; // 未闭合引号：到文本末尾时容错收尾
        }
        field += c; i++; continue;
      }
      if (c === '"' && field === '') { inQuotes = true; i++; continue; }
      if (c === delim) { row.push(field); field = ''; i++; continue; }
      if (c === '\r' || c === '\n') {
        if (c === '\r' && raw.charAt(i + 1) === '\n') i++;
        row.push(field); records.push(row); row = []; field = ''; i++; continue;
      }
      field += c; i++;
    }
    if (inQuotes || field !== '' || row.length > 0) { row.push(field); records.push(row); }

    // 剔除完全空白行（保留单行单列的有效值）
    records = records.filter(function (r) {
      return r.length > 1 || String(r[0] || '').trim() !== '';
    });
    if (!records.length) return emptyResult('没有可解析的数据');

    var headers = records[0].map(function (h, idx) {
      var name = String(h == null ? '' : h).trim();
      return name || ('列' + (idx + 1));
    });
    var body = records.slice(1);
    if (!body.length) return emptyResult('只有表头，没有数据行');

    // 规整为表头宽度，保证表格预览与图表取列一致
    var rows = body.map(function (r) {
      return headers.map(function (_, idx) {
        return String(r[idx] == null ? '' : r[idx]);
      });
    });

    var numericColumns = [];
    var textColumns = [];
    headers.forEach(function (name, idx) {
      var nonEmpty = 0;
      var allNumeric = true;
      for (var r = 0; r < rows.length; r++) {
        var cell = rows[r][idx];
        if (String(cell).trim() === '') continue;
        nonEmpty++;
        if (toNumber(cell) == null) { allNumeric = false; break; }
      }
      if (nonEmpty > 0 && allNumeric) numericColumns.push({ index: idx, name: name });
      else textColumns.push({ index: idx, name: name });
    });

    return {
      headers: headers,
      rows: rows,
      numericColumns: numericColumns,
      textColumns: textColumns,
      delim: delim,
      error: ''
    };
  }

  global.CSV = { parse: parse, detectDelimiter: detectDelimiter, toNumber: toNumber };
})(window);
