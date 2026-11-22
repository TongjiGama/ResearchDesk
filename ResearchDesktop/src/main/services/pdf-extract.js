/**
 * src/main/services/pdf-extract.js — 纯 JS 有界 PDF 文本提取器
 * 职责：
 *   1. 在无第三方原生依赖的情况下，同步/异步提取 PDF 前 N 页的可读文本
 *   2. 严格限制文件体积、单流解压体积、页数与字符数，防止 OOM 或阻塞主进程
 *   3. 支持 /ObjStm 对象流解包、页面树 /Kids -> /Contents 顺序解析、/FlateDecode 解压、
 *      ToUnicode CMap / UTF-16BE / Latin-1 解码及 TeX 连字还原
 *   4. 仅当纯 JS 提取不足 200 字符且未禁用 CLI 回退时，安全尝试 pdftotext（吞掉 ENOENT/超时）
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

const DEFAULT_MAX_FILE_BYTES = 48 * 1024 * 1024;
const DEFAULT_MAX_STREAM_BYTES = 512 * 1024;
const DEFAULT_MAX_DECOMPRESSED_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_PAGES = 8;
const DEFAULT_MAX_CHARS = 12000;
const DEFAULT_CLI_TIMEOUT_MS = 3000;

const TEX_LIGATURES = {
  '\x02': 'fi',
  '\x03': 'fl',
  '\x0b': 'ff',
  '\x0c': 'fi',
  '\x0e': 'ffi',
  '\x0f': 'ffl'
};

function decodePdfLiteralString(raw) {
  const s = String(raw || '');
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch !== '\\') {
      out += TEX_LIGATURES[ch] || ch;
      continue;
    }
    i++;
    if (i >= s.length) break;
    const esc = s[i];
    if (esc === '\r') {
      if (s[i + 1] === '\n') i++;
      continue;
    }
    if (esc === '\n') continue;
    if (esc === 'n') { out += '\n'; continue; }
    if (esc === 'r') { out += '\r'; continue; }
    if (esc === 't') { out += '\t'; continue; }
    if (esc === 'b') { out += '\b'; continue; }
    if (esc === 'f') { out += '\f'; continue; }
    if (esc === '(' || esc === ')' || esc === '\\') { out += esc; continue; }
    if (esc >= '0' && esc <= '7') {
      let oct = esc;
      if (i + 1 < s.length && s[i + 1] >= '0' && s[i + 1] <= '7') {
        oct += s[++i];
        if (i + 1 < s.length && s[i + 1] >= '0' && s[i + 1] <= '7') {
          oct += s[++i];
        }
      }
      const code = parseInt(oct, 8);
      const mapped = String.fromCharCode(code);
      out += TEX_LIGATURES[mapped] || mapped;
      continue;
    }
    out += TEX_LIGATURES[esc] || esc;
  }
  return out;
}

function hexToUnicodeString(hex) {
  const clean = String(hex || '').replace(/[^0-9a-fA-F]/g, '');
  if (!clean) return '';
  if (clean.length === 4) {
    const code = parseInt(clean, 16);
    return code === 0 ? '' : String.fromCharCode(code);
  }
  let out = '';
  for (let i = 0; i + 3 < clean.length; i += 4) {
    const code = parseInt(clean.slice(i, i + 4), 16);
    if (code > 0) out += String.fromCharCode(code);
  }
  if (!out && clean.length === 2) {
    const code = parseInt(clean, 16);
    if (code > 0) out += String.fromCharCode(code);
  }
  return out;
}

function parseToUnicodeCMap(cmapText) {
  const src = String(cmapText || '');
  const map = new Map();
  let keyByteLengths = new Set();

  const bfCharRe = /beginbfchar([\s\S]*?)endbfchar/g;
  let m;
  while ((m = bfCharRe.exec(src))) {
    const body = m[1];
    const pairRe = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g;
    let pm;
    while ((pm = pairRe.exec(body))) {
      const k = pm[1].toUpperCase();
      const val = hexToUnicodeString(pm[2]);
      if (k && val) {
        map.set(k, val);
        keyByteLengths.add(k.length);
      }
    }
  }

  const bfRangeRe = /beginbfrange([\s\S]*?)endbfrange/g;
  while ((m = bfRangeRe.exec(src))) {
    const body = m[1];
    const lines = body.split(/\r?\n/);
    for (const line of lines) {
      const arrMatch = line.match(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*\[([\s\S]+?)\]/);
      if (arrMatch) {
        const start = parseInt(arrMatch[1], 16);
        const end = parseInt(arrMatch[2], 16);
        const hexLen = arrMatch[1].length;
        const targets = arrMatch[3].match(/<[0-9a-fA-F]+>/g) || [];
        const span = Math.min(end - start + 1, targets.length, 512);
        for (let i = 0; i < span; i++) {
          const codeHex = (start + i).toString(16).toUpperCase().padStart(hexLen, '0');
          const val = hexToUnicodeString(targets[i].slice(1, -1));
          if (val) {
            map.set(codeHex, val);
            keyByteLengths.add(hexLen);
          }
        }
        continue;
      }
      const rangeMatch = line.match(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/);
      if (rangeMatch) {
        const start = parseInt(rangeMatch[1], 16);
        const end = parseInt(rangeMatch[2], 16);
        let dst = parseInt(rangeMatch[3], 16);
        const hexLen = rangeMatch[1].length;
        const span = Math.min(end - start + 1, 512);
        for (let i = 0; i < span; i++) {
          const codeHex = (start + i).toString(16).toUpperCase().padStart(hexLen, '0');
          const val = (dst + i) > 0 ? String.fromCharCode(dst + i) : '';
          if (val) {
            map.set(codeHex, val);
            keyByteLengths.add(hexLen);
          }
        }
      }
    }
  }

  return {
    map,
    keyHexLengths: Array.from(keyByteLengths).sort((a, b) => b - a)
  };
}

function decodePdfHexString(rawHex, cmap = null) {
  const clean = String(rawHex || '').replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  if (!clean) return '';
  const padded = clean.length % 2 === 1 ? clean + '0' : clean;

  if (cmap && cmap.map && cmap.map.size > 0) {
    const lens = cmap.keyHexLengths && cmap.keyHexLengths.length ? cmap.keyHexLengths : [4, 2];
    let out = '';
    let matchedAny = false;
    let i = 0;
    while (i < padded.length) {
      let hit = false;
      for (const len of lens) {
        if (i + len <= padded.length) {
          const slice = padded.slice(i, i + len);
          if (cmap.map.has(slice)) {
            out += cmap.map.get(slice);
            i += len;
            hit = true;
            matchedAny = true;
            break;
          }
        }
      }
      if (!hit) {
        const step = (lens[lens.length - 1] === 4 && i + 4 <= padded.length) ? 4 : 2;
        const code = parseInt(padded.slice(i, i + step), 16);
        if (code >= 32 && code !== 127) out += String.fromCharCode(code);
        i += step;
      }
    }
    if (matchedAny) return out;
  }

  // UTF-16BE with BOM
  if (padded.startsWith('FEFF') && padded.length >= 6) {
    let out = '';
    for (let i = 4; i + 3 < padded.length; i += 4) {
      const code = parseInt(padded.slice(i, i + 4), 16);
      if (code > 0) out += String.fromCharCode(code);
    }
    return out;
  }

  // Heuristic UTF-16BE when high bytes are mostly 00
  if (padded.length >= 4 && padded.length % 4 === 0) {
    let zeroHigh = 0;
    const pairs = padded.length / 4;
    for (let i = 0; i < padded.length; i += 4) {
      if (padded[i] === '0' && padded[i + 1] === '0') zeroHigh++;
    }
    if (zeroHigh >= Math.ceil(pairs * 0.7)) {
      let out = '';
      for (let i = 0; i + 3 < padded.length; i += 4) {
        const code = parseInt(padded.slice(i, i + 4), 16);
        if (code >= 32 || code === 9 || code === 10) out += String.fromCharCode(code);
      }
      if (out) return out;
    }
  }

  let latin = '';
  for (let i = 0; i + 1 < padded.length; i += 2) {
    const code = parseInt(padded.slice(i, i + 2), 16);
    if (code >= 32 && code !== 127) {
      const ch = String.fromCharCode(code);
      latin += TEX_LIGATURES[ch] || ch;
    } else if (code === 2 || code === 3 || code === 11 || code === 12 || code === 14 || code === 15) {
      latin += TEX_LIGATURES[String.fromCharCode(code)] || '';
    }
  }
  return latin;
}

function skipWsAndComments(src, idx) {
  const len = src.length;
  while (idx < len) {
    const c = src.charCodeAt(idx);
    if (c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 0) {
      idx++;
    } else if (c === 37) { // % comment
      while (idx < len && src.charCodeAt(idx) !== 10 && src.charCodeAt(idx) !== 13) idx++;
    } else {
      break;
    }
  }
  return idx;
}

function readLiteralToken(src, startIdx) {
  let i = startIdx + 1;
  let depth = 1;
  let raw = '';
  const len = src.length;
  while (i < len && depth > 0) {
    const ch = src[i];
    if (ch === '\\') {
      if (i + 1 < len) {
        raw += ch + src[i + 1];
        i += 2;
      } else {
        i++;
      }
      continue;
    }
    if (ch === '(') {
      depth++;
      raw += ch;
    } else if (ch === ')') {
      depth--;
      if (depth > 0) raw += ch;
    } else {
      raw += ch;
    }
    i++;
  }
  return { raw, nextIdx: i };
}

function readHexToken(src, startIdx) {
  let i = startIdx + 1;
  let raw = '';
  const len = src.length;
  while (i < len && src[i] !== '>') {
    raw += src[i++];
  }
  if (i < len && src[i] === '>') i++;
  return { raw, nextIdx: i };
}

function extractTextFromContentStream(streamText, fontMaps = null) {
  const src = String(streamText || '');
  if (!src || !src.includes('BT')) return '';
  const out = [];
  let inText = false;
  let currentFont = '';
  const stack = [];
  let i = 0;
  const len = src.length;

  const getCMap = () => (fontMaps && currentFont && fontMaps.get(currentFont)) || null;

  const appendPiece = (txt) => {
    if (!txt) return;
    out.push(txt);
  };

  while (i < len) {
    i = skipWsAndComments(src, i);
    if (i >= len) break;
    const ch = src[i];

    if (ch === '(') {
      const tok = readLiteralToken(src, i);
      if (inText) stack.push({ type: 'literal', value: tok.raw });
      i = tok.nextIdx;
      continue;
    }

    if (ch === '<') {
      if (src[i + 1] === '<') {
        i += 2;
        continue;
      }
      const tok = readHexToken(src, i);
      if (inText) stack.push({ type: 'hex', value: tok.raw });
      i = tok.nextIdx;
      continue;
    }

    if (ch === '>' && src[i + 1] === '>') {
      i += 2;
      continue;
    }

    if (ch === '[') {
      if (!inText) { i++; continue; }
      i++;
      const arr = [];
      while (i < len) {
        i = skipWsAndComments(src, i);
        if (i >= len) break;
        if (src[i] === ']') { i++; break; }
        if (src[i] === '(') {
          const tok = readLiteralToken(src, i);
          arr.push({ type: 'literal', value: tok.raw });
          i = tok.nextIdx;
        } else if (src[i] === '<' && src[i + 1] !== '<') {
          const tok = readHexToken(src, i);
          arr.push({ type: 'hex', value: tok.raw });
          i = tok.nextIdx;
        } else {
          let numStr = '';
          while (i < len && !/[\s()<>[\]/%]/.test(src[i])) numStr += src[i++];
          const num = Number(numStr);
          if (Number.isFinite(num)) arr.push({ type: 'num', value: num });
        }
      }
      stack.push({ type: 'array', value: arr });
      continue;
    }

    if (ch === '/') {
      let name = '/';
      i++;
      while (i < len && !/[\s()<>[\]/%]/.test(src[i])) name += src[i++];
      if (inText) stack.push({ type: 'name', value: name });
      continue;
    }

    // Word / number / operator
    let word = '';
    while (i < len && !/[\s()<>[\]/%]/.test(src[i])) word += src[i++];
    if (!word) { i++; continue; }

    if (word === 'BT') {
      inText = true;
      stack.length = 0;
      continue;
    }
    if (word === 'ET') {
      if (inText && out.length && !out[out.length - 1].endsWith('\n')) out.push('\n');
      inText = false;
      stack.length = 0;
      continue;
    }
    if (!inText) continue;

    if (word === 'Tf') {
      const nameToken = stack.length >= 2 ? stack[stack.length - 2] : null;
      if (nameToken && nameToken.type === 'name') currentFont = nameToken.value;
      stack.length = 0;
    } else if (word === 'Tj') {
      const top = stack.pop();
      if (top) {
        const cmap = getCMap();
        if (top.type === 'literal') appendPiece(decodePdfLiteralString(top.value));
        else if (top.type === 'hex') appendPiece(decodePdfHexString(top.value, cmap));
      }
      stack.length = 0;
    } else if (word === 'TJ') {
      const top = stack.pop();
      if (top && top.type === 'array') {
        const cmap = getCMap();
        for (const item of top.value) {
          if (item.type === 'literal') appendPiece(decodePdfLiteralString(item.value));
          else if (item.type === 'hex') appendPiece(decodePdfHexString(item.value, cmap));
          else if (item.type === 'num' && item.value <= -120) appendPiece(' ');
        }
      }
      stack.length = 0;
    } else if (word === "'" || word === '"') {
      const top = stack.pop();
      out.push('\n');
      if (top) {
        const cmap = getCMap();
        if (top.type === 'literal') appendPiece(decodePdfLiteralString(top.value));
        else if (top.type === 'hex') appendPiece(decodePdfHexString(top.value, cmap));
      }
      stack.length = 0;
    } else if (word === 'T*') {
      out.push('\n');
      stack.length = 0;
    } else if (word === 'Td' || word === 'TD') {
      const dyTok = stack.length >= 1 ? stack[stack.length - 1] : null;
      const dxTok = stack.length >= 2 ? stack[stack.length - 2] : null;
      const dy = dyTok && dyTok.type === 'num' ? dyTok.value : 0;
      const dx = dxTok && dxTok.type === 'num' ? dxTok.value : 0;
      if (Math.abs(dy) >= 2) {
        out.push('\n');
      } else if (Math.abs(dx) >= 3 && out.length && !/[\s\n]$/.test(out[out.length - 1])) {
        out.push(' ');
      }
      stack.length = 0;
    } else if (word === 'Tm') {
      out.push(' ');
      stack.length = 0;
    } else {
      const num = Number(word);
      if (Number.isFinite(num)) {
        stack.push({ type: 'num', value: num });
      } else {
        stack.length = 0;
      }
    }
  }

  return out.join('');
}

function parseIndirectObjects(buf, latin, maxStreamBytes) {
  const objects = new Map();
  const objHeaderRe = /(?:^|[\r\n])\s*(\d+)\s+(\d+)\s+obj\b/g;
  let m;
  while ((m = objHeaderRe.exec(latin))) {
    const objNum = Number(m[1]);
    const bodyStart = m.index + m[0].length;
    const endObjIdx = latin.indexOf('endobj', bodyStart);
    if (endObjIdx < 0) continue;
    const rawBody = latin.slice(bodyStart, endObjIdx);
    const streamMatch = rawBody.match(/\bstream\r?\n/);
    if (streamMatch) {
      const dict = rawBody.slice(0, streamMatch.index).trim();
      const absStreamStart = bodyStart + streamMatch.index + streamMatch[0].length;
      const endStreamRel = rawBody.indexOf('endstream', streamMatch.index + streamMatch[0].length);
      if (endStreamRel >= 0) {
        let absStreamEnd = bodyStart + endStreamRel;
        if (buf[absStreamEnd - 1] === 10) absStreamEnd--;
        if (buf[absStreamEnd - 1] === 13) absStreamEnd--;
        const streamLen = Math.max(0, absStreamEnd - absStreamStart);
        const streamBuf = streamLen <= maxStreamBytes ? buf.subarray(absStreamStart, absStreamEnd) : null;
        objects.set(objNum, { objNum, dict, streamBuf, oversized: streamLen > maxStreamBytes, raw: dict });
        continue;
      }
    }
    objects.set(objNum, { objNum, dict: rawBody.trim(), streamBuf: null, oversized: false, raw: rawBody.trim() });
  }
  return objects;
}

function inflateStream(obj) {
  if (!obj || !obj.streamBuf) return null;
  if (/\/Subtype\s*\/Image\b/.test(obj.dict)) return null;
  const hasFilter = /\/Filter\b/.test(obj.dict);
  const isFlate = /\/FlateDecode\b/.test(obj.dict);
  if (hasFilter && !isFlate) return null;
  if (!isFlate) return obj.streamBuf;
  try {
    return zlib.inflateSync(obj.streamBuf, { maxOutputLength: DEFAULT_MAX_DECOMPRESSED_BYTES });
  } catch (_) {
    return null;
  }
}

function unpackObjStmObjects(objects) {
  for (const obj of Array.from(objects.values())) {
    if (!/\/Type\s*\/ObjStm\b/.test(obj.dict)) continue;
    const nMatch = obj.dict.match(/\/N\s+(\d+)/);
    const firstMatch = obj.dict.match(/\/First\s+(\d+)/);
    if (!nMatch || !firstMatch) continue;
    const count = Number(nMatch[1]);
    const first = Number(firstMatch[1]);
    const inflated = inflateStream(obj);
    if (!inflated) continue;
    const text = inflated.toString('latin1');
    const header = text.slice(0, first).trim().split(/\s+/);
    const entries = [];
    for (let i = 0; i + 1 < header.length && entries.length < count; i += 2) {
      const id = Number(header[i]);
      const off = Number(header[i + 1]);
      if (Number.isFinite(id) && Number.isFinite(off)) entries.push({ id, off });
    }
    entries.sort((a, b) => a.off - b.off);
    for (let i = 0; i < entries.length; i++) {
      const start = first + entries[i].off;
      const end = i + 1 < entries.length ? first + entries[i + 1].off : text.length;
      const body = text.slice(start, end).trim();
      if (!objects.has(entries[i].id)) {
        objects.set(entries[i].id, { objNum: entries[i].id, dict: body, streamBuf: null, oversized: false, raw: body });
      }
    }
  }
}

function extractBalancedDict(src, key) {
  const idx = src.indexOf(key);
  if (idx < 0) return '';
  const start = src.indexOf('<<', idx + key.length);
  if (start < 0) return '';
  let depth = 0;
  let i = start;
  while (i < src.length - 1) {
    if (src[i] === '<' && src[i + 1] === '<') {
      depth++;
      i += 2;
      continue;
    }
    if (src[i] === '>' && src[i + 1] === '>') {
      depth--;
      i += 2;
      if (depth === 0) return src.slice(start, i);
      continue;
    }
    i++;
  }
  return '';
}

function parseRefList(val) {
  const out = [];
  const re = /(\d+)\s+\d+\s+R\b/g;
  let m;
  while ((m = re.exec(String(val || '')))) out.push(Number(m[1]));
  return out;
}

function resolveFontMapsForDict(dictText, objects, cmapCache) {
  const map = new Map();
  let resDict = extractBalancedDict(dictText, '/Resources');
  if (!resDict) {
    const resRef = dictText.match(/\/Resources\s+(\d+)\s+\d+\s+R/);
    if (resRef && objects.has(Number(resRef[1]))) {
      resDict = objects.get(Number(resRef[1])).dict;
    }
  }
  if (!resDict) return map;

  let fontDict = extractBalancedDict(resDict, '/Font');
  if (!fontDict) {
    const fontRef = resDict.match(/\/Font\s+(\d+)\s+\d+\s+R/);
    if (fontRef && objects.has(Number(fontRef[1]))) {
      fontDict = objects.get(Number(fontRef[1])).dict;
    }
  }
  if (!fontDict) return map;

  const entryRe = /(\/[A-Za-z0-9_.+-]+)\s+(\d+)\s+\d+\s+R/g;
  let m;
  while ((m = entryRe.exec(fontDict))) {
    const fontName = m[1];
    const fontObj = objects.get(Number(m[2]));
    if (!fontObj) continue;
    const toUniMatch = fontObj.dict.match(/\/ToUnicode\s+(\d+)\s+\d+\s+R/);
    if (!toUniMatch) continue;
    const cmapObjNum = Number(toUniMatch[1]);
    if (!cmapCache.has(cmapObjNum)) {
      const cmapObj = objects.get(cmapObjNum);
      const inflated = cmapObj ? inflateStream(cmapObj) : null;
      cmapCache.set(cmapObjNum, inflated ? parseToUnicodeCMap(inflated.toString('latin1')) : null);
    }
    const parsedCmap = cmapCache.get(cmapObjNum);
    if (parsedCmap) map.set(fontName, parsedCmap);
  }
  return map;
}

function collectPagesInOrder(objects, maxPages) {
  let rootPagesId = 0;
  for (const obj of objects.values()) {
    if (/\/Type\s*\/Catalog\b/.test(obj.dict)) {
      const pm = obj.dict.match(/\/Pages\s+(\d+)\s+\d+\s+R/);
      if (pm) { rootPagesId = Number(pm[1]); break; }
    }
  }
  if (!rootPagesId) {
    for (const obj of objects.values()) {
      if (/\/Type\s*\/Pages\b/.test(obj.dict) && !/\/Parent\b/.test(obj.dict)) {
        rootPagesId = obj.objNum;
        break;
      }
    }
  }
  if (!rootPagesId || !objects.has(rootPagesId)) return [];

  const pages = [];
  const visited = new Set();
  const cmapCache = new Map();

  function walk(nodeId, inheritedFontMaps) {
    if (pages.length >= maxPages || visited.has(nodeId)) return;
    visited.add(nodeId);
    const obj = objects.get(nodeId);
    if (!obj) return;
    const localFonts = resolveFontMapsForDict(obj.dict, objects, cmapCache);
    const mergedFonts = new Map([...(inheritedFontMaps || []), ...localFonts]);

    const kidsInline = obj.dict.match(/\/Kids\s*\[([\s\S]*?)\]/);
    let kidRefs = kidsInline ? parseRefList(kidsInline[1]) : [];
    if (!kidRefs.length) {
      const kidsObjRef = obj.dict.match(/\/Kids\s+(\d+)\s+\d+\s+R/);
      if (kidsObjRef && objects.has(Number(kidsObjRef[1]))) {
        kidRefs = parseRefList(objects.get(Number(kidsObjRef[1])).dict);
      }
    }
    if (/\/Type\s*\/Pages\b/.test(obj.dict) || kidRefs.length > 0) {
      for (const kidId of kidRefs) {
        if (pages.length >= maxPages) break;
        walk(kidId, mergedFonts);
      }
      return;
    }

    if (/\/Type\s*\/Page\b/.test(obj.dict) || /\/Contents\b/.test(obj.dict)) {
      const arrMatch = obj.dict.match(/\/Contents\s*\[([\s\S]*?)\]/);
      let contentRefs = arrMatch ? parseRefList(arrMatch[1]) : [];
      if (!contentRefs.length) {
        const singleMatch = obj.dict.match(/\/Contents\s+(\d+)\s+\d+\s+R/);
        if (singleMatch) contentRefs = [Number(singleMatch[1])];
      }
      if (contentRefs.length) {
        pages.push({ objNum: nodeId, contentRefs, fontMaps: mergedFonts });
      }
    }
  }

  walk(rootPagesId, new Map());
  return pages;
}

function cleanExtractedText(raw) {
  return String(raw || '')
    .replace(/\r\n/g, '\n')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ' ')
    .replace(/-\n([a-z])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

function printableRatio(text) {
  const s = String(text || '');
  if (!s.length) return 0;
  let good = 0;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if ((code >= 32 && code <= 126) || code === 10 || code === 9 || (code >= 0x4e00 && code <= 0x9fff) || (code >= 0x00a0 && code <= 0x024f)) {
      good++;
    }
  }
  return good / s.length;
}

function truncateText(text, maxChars) {
  const s = String(text || '');
  if (s.length <= maxChars) return { text: s, truncated: false };
  return { text: s.slice(0, maxChars).trim(), truncated: true };
}

function tryPdftotextCli(absPath, maxPages, maxChars, timeoutMs) {
  try {
    const out = execFileSync(
      'pdftotext',
      ['-enc', 'UTF-8', '-f', '1', '-l', String(maxPages), absPath, '-'],
      {
        timeout: timeoutMs,
        maxBuffer: 2 * 1024 * 1024,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore']
      }
    );
    const cleaned = cleanExtractedText(Buffer.isBuffer(out) ? out.toString('utf8') : String(out || ''));
    if (cleaned.length >= 40 && printableRatio(cleaned) >= 0.55) {
      return truncateText(cleaned, maxChars);
    }
  } catch (_) {
    // 缺少 pdftotext (ENOENT) 或超时，静默返回 null
  }
  return null;
}

function extractPdfTextSync(filePath, opts = {}) {
  const maxFileBytes = Number(opts.maxFileBytes) > 0 ? Number(opts.maxFileBytes) : DEFAULT_MAX_FILE_BYTES;
  const maxStreamBytes = Number(opts.maxStreamBytes) > 0 ? Number(opts.maxStreamBytes) : DEFAULT_MAX_STREAM_BYTES;
  const maxPages = Number(opts.maxPages) > 0 ? Number(opts.maxPages) : DEFAULT_MAX_PAGES;
  const maxChars = Number(opts.maxChars) > 0 ? Number(opts.maxChars) : DEFAULT_MAX_CHARS;
  const cliTimeoutMs = Number(opts.cliTimeoutMs) > 0 ? Number(opts.cliTimeoutMs) : DEFAULT_CLI_TIMEOUT_MS;

  const absPath = filePath ? path.resolve(String(filePath)) : '';
  if (!absPath || !fs.existsSync(absPath)) {
    return { ok: false, text: '', pagesExtracted: 0, method: 'none', truncated: false, error: 'PDF 文件不存在' };
  }

  let stat;
  try {
    stat = fs.statSync(absPath);
  } catch (e) {
    return { ok: false, text: '', pagesExtracted: 0, method: 'none', truncated: false, error: e.message || String(e) };
  }
  if (!stat.isFile()) {
    return { ok: false, text: '', pagesExtracted: 0, method: 'none', truncated: false, error: '目标不是 PDF 文件' };
  }
  if (stat.size > maxFileBytes) {
    return { ok: false, text: '', pagesExtracted: 0, method: 'none', truncated: false, error: 'PDF 文件超过体积上限' };
  }

  let buf;
  try {
    buf = fs.readFileSync(absPath);
  } catch (e) {
    return { ok: false, text: '', pagesExtracted: 0, method: 'none', truncated: false, error: e.message || String(e) };
  }

  if (buf.length < 8 || buf.subarray(0, Math.min(1024, buf.length)).indexOf('%PDF-') < 0) {
    return { ok: false, text: '', pagesExtracted: 0, method: 'none', truncated: false, error: '不是有效的 PDF 文档（缺少 %PDF- 头）' };
  }

  let pureText = '';
  let pagesExtracted = 0;

  try {
    const latin = buf.toString('latin1');
    const objects = parseIndirectObjects(buf, latin, maxStreamBytes);
    unpackObjStmObjects(objects);

    const pages = collectPagesInOrder(objects, maxPages);
    const pageChunks = [];

    if (pages.length > 0) {
      for (const page of pages) {
        let pageText = '';
        for (const refId of page.contentRefs) {
          const streamObj = objects.get(refId);
          const inflated = inflateStream(streamObj);
          if (!inflated) continue;
          const decoded = extractTextFromContentStream(inflated.toString('latin1'), page.fontMaps);
          if (decoded) pageText += decoded + '\n';
          if (pageText.length > maxChars * 2) break;
        }
        const cleanedPage = cleanExtractedText(pageText);
        if (cleanedPage && printableRatio(cleanedPage) >= 0.55) {
          pageChunks.push(cleanedPage);
          pagesExtracted++;
        }
        if (pageChunks.join('\n\n').length >= maxChars) break;
      }
    } else {
      // 回退：顺序扫描含 BT...ET 的非图片流
      const globalFonts = new Map();
      const cmapCache = new Map();
      for (const obj of objects.values()) {
        if (/\/Resources\b|\/Font\b/.test(obj.dict)) {
          const fm = resolveFontMapsForDict(obj.dict, objects, cmapCache);
          fm.forEach((v, k) => { if (!globalFonts.has(k)) globalFonts.set(k, v); });
        }
      }
      for (const obj of objects.values()) {
        if (!obj.streamBuf) continue;
        const inflated = inflateStream(obj);
        if (!inflated) continue;
        const streamStr = inflated.toString('latin1');
        if (!streamStr.includes('BT') || !streamStr.includes('ET')) continue;
        const decoded = cleanExtractedText(extractTextFromContentStream(streamStr, globalFonts));
        if (decoded && printableRatio(decoded) >= 0.55) {
          pageChunks.push(decoded);
          pagesExtracted++;
        }
        if (pagesExtracted >= maxPages || pageChunks.join('\n\n').length >= maxChars) break;
      }
    }

    pureText = cleanExtractedText(pageChunks.join('\n\n'));
    if (printableRatio(pureText) < 0.55) {
      pureText = '';
      pagesExtracted = 0;
    }
  } catch (_) {
    pureText = '';
    pagesExtracted = 0;
  }

  if (pureText.length < 200 && !opts.disableCliFallback) {
    const cli = tryPdftotextCli(absPath, maxPages, maxChars, cliTimeoutMs);
    if (cli && cli.text.length > pureText.length) {
      return {
        ok: true,
        text: cli.text,
        pagesExtracted: Math.max(pagesExtracted, 1),
        method: 'pdftotext',
        truncated: cli.truncated
      };
    }
  }

  if (!pureText) {
    return { ok: false, text: '', pagesExtracted: 0, method: 'none', truncated: false, error: '未能从 PDF 提取可读文本' };
  }

  const finalOut = truncateText(pureText, maxChars);
  return {
    ok: true,
    text: finalOut.text,
    pagesExtracted: Math.max(1, pagesExtracted),
    method: 'pure-js',
    truncated: finalOut.truncated
  };
}

async function extractPdfText(filePath, opts = {}) {
  return extractPdfTextSync(filePath, opts);
}

module.exports = {
  extractPdfText,
  extractPdfTextSync,
  extractTextFromContentStream,
  parseToUnicodeCMap,
  decodePdfLiteralString,
  decodePdfHexString
};
