/**
 * store.js — 数据层
 * 负责：全局配置、工作区 CRUD、三板块实体 CRUD（Markdown + frontmatter）、
 *       PDF/实验数据文件导入、skill 管理、[[引用]] 解析。
 * 所有方法通过 IPC dispatch 调用，返回普通对象（可结构化克隆）。
 */
const fs = require('fs');
const path = require('path');
const matter = require('gray-matter');

// 便携版：代码在 asar 内只读，数据必须外置到 exe 同级 data/（可写、随 U 盘走）。
// 开发模式（npm start / 测试）保持原来的源码同级 data/，不触碰用户现有数据。
let electronApp = null;
let packaged = false;
try {
  const electron = require('electron');
  if (electron && electron.app) {
    electronApp = electron.app;
    packaged = !!electron.app.isPackaged;
  }
} catch (_) { /* Node 直跑测试时 require('electron') 返回可执行文件路径 */ }

const APP_DIR = path.join(__dirname, '..', '..');
const DATA_ROOT = (packaged && electronApp)
  ? path.join(path.dirname(electronApp.getPath('exe')), 'data')
  : path.join(APP_DIR, 'data');
// 干净初始资源随应用代码进 asar，只在首次运行时复制到外部 DATA_ROOT，不含任何用户隐私。
const BUILTIN_DATA_DIR = path.join(APP_DIR, 'app-data');
const CONFIG_PATH = path.join(DATA_ROOT, 'app-config.json');
const SKILLS_DIR = path.join(DATA_ROOT, 'skills');
const TEMPLATES_DIR = path.join(DATA_ROOT, 'templates');
const WORKSPACES_DIR = path.join(DATA_ROOT, 'workspaces');

const BOARDS = ['papers', 'ideas', 'experiments'];
const BOARD_CN = { papers: '论文', ideas: '灵感', experiments: '实验' };

// ---------- 基础工具 ----------
function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

/**
 * 幂等初始化外部数据目录：建骨架 + 首次写入干净配置 + 首次复制内置 skill。
 * 已有文件绝不覆盖，因此开发模式的用户数据与自定义 skill 完全不受影响。
 */
function ensureData() {
  ensureDir(DATA_ROOT);
  ensureDir(WORKSPACES_DIR);
  ensureDir(SKILLS_DIR);
  ensureDir(TEMPLATES_DIR);
  if (!fs.existsSync(CONFIG_PATH)) {
    let seed = {};
    try {
      seed = JSON.parse(fs.readFileSync(path.join(BUILTIN_DATA_DIR, 'default-config.json'), 'utf8'));
    } catch (_) { /* 内置配置缺失时用代码默认值 */ }
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(Object.assign(defaultConfig(), seed), null, 2), 'utf8');
  }
  const builtinSkills = path.join(BUILTIN_DATA_DIR, 'skills');
  if (fs.existsSync(builtinSkills)) {
    for (const f of fs.readdirSync(builtinSkills)) {
      if (!f.endsWith('.md')) continue;
      const dst = path.join(SKILLS_DIR, f);
      if (!fs.existsSync(dst)) fs.copyFileSync(path.join(builtinSkills, f), dst);
    }
  }
}
function today() {
  return new Date().toISOString().slice(0, 10);
}
function safeName(name) {
  return String(name).replace(/[\\/:*?"<>|]/g, '_').trim();
}
function sleepSafeWrite(file, content) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, content, 'utf8');
}
function slugify(name) {
  return String(name)
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, '-')
    .replace(/[$()[\]{}]/g, '')
    .slice(0, 60) || 'untitled';
}

// ---------- 配置 ----------
function defaultConfig() {
  return {
    currentWorkspace: '',
    api: { baseUrl: 'https://api.openai.com/v1', apiKey: '', model: 'gpt-4o-mini' },
    activeSkill: 'default',
    ui: { workspaceCollapsed: false, boardCollapsed: false, theme: 'classic', listCollapsed: false },
    openalex: { apiKey: '', perPage: 10 }
  };
}
function getConfig() {
  ensureData();
  if (!fs.existsSync(CONFIG_PATH)) {
    const c = defaultConfig();
    sleepSafeWrite(CONFIG_PATH, JSON.stringify(c, null, 2));
    return c;
  }
  try {
    return Object.assign(defaultConfig(), JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')));
  } catch (e) {
    return defaultConfig();
  }
}
function updateConfig(patch) {
  const cur = getConfig();
  const merged = deepMerge(cur, patch);
  sleepSafeWrite(CONFIG_PATH, JSON.stringify(merged, null, 2));
  return merged;
}
function deepMerge(a, b) {
  const out = { ...a };
  for (const k of Object.keys(b || {})) {
    if (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k]) && a[k] && typeof a[k] === 'object') {
      out[k] = deepMerge(a[k], b[k]);
    } else {
      out[k] = b[k];
    }
  }
  return out;
}

// ---------- 工作区 ----------
function workspacePath(ws) {
  return path.join(WORKSPACES_DIR, safeName(ws));
}
function boardPath(ws, board) {
  return path.join(workspacePath(ws), board);
}
function listWorkspaces() {
  ensureDir(WORKSPACES_DIR);
  return fs.readdirSync(WORKSPACES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort((a, b) => a.localeCompare(b, 'zh'));
}
function createWorkspace(name) {
  const ws = safeName(name);
  const p = workspacePath(ws);
  if (fs.existsSync(p)) throw new Error('工作区已存在：' + ws);
  BOARDS.forEach((b) => ensureDir(path.join(p, b)));
  ensureDir(path.join(p, 'pdfs'));
  ensureDir(path.join(p, 'experiments', 'data'));
  return ws;
}
function renameWorkspace(oldName, newName) {
  const src = workspacePath(oldName);
  const dst = workspacePath(newName);
  if (!fs.existsSync(src)) throw new Error('工作区不存在：' + oldName);
  if (fs.existsSync(dst)) throw new Error('目标工作区已存在：' + newName);
  fs.renameSync(src, dst);
  const cfg = getConfig();
  if (cfg.currentWorkspace === oldName) updateConfig({ currentWorkspace: newName });
  return newName;
}
function deleteWorkspace(name) {
  const p = workspacePath(name);
  if (!fs.existsSync(p)) throw new Error('工作区不存在：' + name);
  fs.rmSync(p, { recursive: true, force: true });
  return true;
}
function copyWorkspace(src, dst) {
  const s = workspacePath(src);
  const d = workspacePath(dst);
  if (!fs.existsSync(s)) throw new Error('源工作区不存在：' + src);
  if (fs.existsSync(d)) throw new Error('目标工作区已存在：' + dst);
  fs.cpSync(s, d, { recursive: true });
  return dst;
}

// ---------- 实体（Markdown + frontmatter） ----------
function itemFile(ws, board, id) {
  return path.join(boardPath(ws, board), slugify(id) + '.md');
}
function listItems(ws, board) {
  const dir = boardPath(ws, board);
  ensureDir(dir);
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.md')) continue;
    try {
      const raw = fs.readFileSync(path.join(dir, f), 'utf8');
      const parsed = matter(raw);
      const item = { id: path.basename(f, '.md'), ...parsed.data, _excerpt: (parsed.content || '').slice(0, 120) };
      // 全文搜索用：笔记正文 + 摘要 纳入索引（规模小，直接随列表返回）
      item._fulltext = ((parsed.content || '') + '\n' + (parsed.data.summary || '')).toLowerCase();
      const refs = [parsed.content || '', parsed.data.title || ''];
      if (board === 'ideas') refs.push(parsed.data.nextStep || '');
      if (board === 'experiments') {
        const failure = parsed.data.failure && typeof parsed.data.failure === 'object' ? parsed.data.failure : {};
        const results = parsed.data.results && typeof parsed.data.results === 'object' ? parsed.data.results : {};
        refs.push(parsed.data.goal, parsed.data.hypothesis, parsed.data.protocol, parsed.data.conclusion,
          parsed.data.nextStep, failure.cause, failure.action, results.summary);
      }
      item._refs = extractRefNames(refs.join('\n'));
      out.push(item);
    } catch (e) {
      out.push({ id: path.basename(f, '.md'), _error: String(e.message) });
    }
  }
  // 实验板块：按日期倒序（时间线视图，D28）
  if (board === 'experiments') {
    out.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  }
  return out;
}
function getItem(ws, board, id) {
  const file = itemFile(ws, board, id);
  if (!fs.existsSync(file)) return null;
  const parsed = matter(fs.readFileSync(file, 'utf8'));
  return { id, frontmatter: parsed.data, body: parsed.content };
}
function saveItem(ws, board, id, payload) {
  const file = itemFile(ws, board, id);
  const { frontmatter = {}, body = '' } = payload || {};
  const data = { ...frontmatter };
  if (!data.updatedAt) data.updatedAt = today();
  const text = matter.stringify(body, data);
  sleepSafeWrite(file, text);
  return id;
}
function deleteItem(ws, board, id) {
  const file = itemFile(ws, board, id);
  if (fs.existsSync(file)) fs.unlinkSync(file);
  return true;
}
function renameItem(ws, board, oldId, newId) {
  const a = itemFile(ws, board, oldId);
  const b = itemFile(ws, board, newId);
  if (!fs.existsSync(a)) throw new Error('条目不存在：' + oldId);
  if (fs.existsSync(b)) throw new Error('目标条目已存在：' + newId);
  fs.renameSync(a, b);
  return newId;
}

// ---------- PDF 导入 ----------
function attachPdfToPaper(ws, id, sourcePaths) {
  const item = getItem(ws, 'papers', id);
  if (!item) throw new Error('论文不存在：' + id);
  const files = collectPdfs(Array.isArray(sourcePaths) ? sourcePaths : []);
  if (!files.length) throw new Error('请拖入一个 PDF 文件');
  const pdfDir = path.join(workspacePath(ws), 'pdfs');
  ensureDir(pdfDir);
  const src = files[0];
  const fname = path.basename(src);
  let target = path.join(pdfDir, fname);
  let i = 1;
  while (fs.existsSync(target)) {
    target = path.join(pdfDir, `${path.basename(fname, '.pdf')}_${i++}.pdf`);
  }
  fs.copyFileSync(src, target);
  const fm = { ...(item.frontmatter || {}), pdfPath: 'pdfs/' + path.basename(target), updatedAt: today() };
  saveItem(ws, 'papers', id, { frontmatter: fm, body: item.body || '' });
  return fm.pdfPath;
}

function parsePdfName(filename) {
  const base = path.basename(String(filename || '')).replace(/\.pdf$/i, '');
  let shortName = '', published = '', arxivId = '';
  const mArx = base.match(/arXiv[-_.:]?(\d{4}\.\d{4,5})(?:v\d+)?/i);
  if (mArx) arxivId = mArx[1];
  const mDate = base.match(/(20\d{2})[.\-_](\d{1,2})/);
  if (mDate) published = `${mDate[1]}-${mDate[2].padStart(2, '0')}`;
  // 去掉序号/分组前缀、日期、arXiv 段、状态标签，保留 V-JEPA2 / GR-1 / Pi0-FAST 中的连字符
  let rest = base
    .replace(/^(?:\d{1,3}[-_\s]+|[A-Za-z]\d{2,}[-_\s]+|[A-Za-z]\d+[_\s]+)/, '')
    .replace(/20\d{2}[.\-_]\d{1,2}/g, ' ')
    .replace(/arXiv[-_.:]?\d{4}\.\d{4,5}(?:v\d+)?/ig, ' ')
    .replace(/(?:^|[-_\s])(?:待读|已读|精读|在读|归档)(?=$|[-_\s])/g, ' ')
    .replace(/_+/g, ' ')
    .trim();
  const firstToken = (rest.split(/\s+/)[0] || '').replace(/^[-_.]+|[-_.]+$/g, '');
  shortName = firstToken || base;
  return { shortName, published, arxivId };
}
function collectPdfs(paths) {
  const out = [];
  for (const p of paths) {
    if (!fs.existsSync(p)) continue;
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      for (const f of fs.readdirSync(p)) out.push(...collectPdfs([path.join(p, f)]));
    } else if (/\.pdf$/i.test(p)) {
      out.push(p);
    }
  }
  return out;
}
function importPdfs(ws, sourcePaths) {
  const pdfDir = path.join(workspacePath(ws), 'pdfs');
  ensureDir(pdfDir);
  const created = [];
  const files = collectPdfs(sourcePaths);
  for (const src of files) {
    if (!fs.existsSync(src)) continue;
    const fname = path.basename(src);
    const dest = path.join(pdfDir, fname);
    let target = dest;
    let i = 1;
    while (fs.existsSync(target)) {
      target = path.join(pdfDir, `${path.basename(fname, '.pdf')}_${i++}.pdf`);
    }
    fs.copyFileSync(src, target);
    const meta = parsePdfName(fname);
    let id = slugify(meta.shortName);
    // 避免 id 冲突
    if (getItem(ws, 'papers', id)) id = `${id}-${Date.now().toString().slice(-4)}`;
    const fm = {
      title: meta.shortName,
      shortName: meta.shortName,
      authors: [],
      published: meta.published,
      arxivId: meta.arxivId,
      pdfPath: 'pdfs/' + path.basename(target),
      status: '待读',
      noteUpdatedAt: '',
      skill: 'default',
      summary: '',
      createdAt: today(),
      updatedAt: today()
    };
    saveItem(ws, 'papers', id, { frontmatter: fm, body: '' });
    created.push({ id, ...meta });
  }
  return created;
}

// ---------- 实验数据文件 ----------
function legacyExpDataDir(ws) {
  return path.join(workspacePath(ws), 'experiments', 'data');
}
function safeExpDirId(expId) {
  const raw = String(expId == null ? '' : expId).trim();
  if (!raw) return '';
  if (raw === '.' || raw === '..' || raw.includes('..') || /[\\/\0]/.test(raw)) {
    throw new Error('无效的实验 ID：' + raw);
  }
  const cleaned = slugify(raw);
  if (!cleaned || /^\.+$/.test(cleaned)) {
    throw new Error('无效的实验 ID：' + raw);
  }
  return cleaned;
}
function expDataDir(ws, expId) {
  const base = legacyExpDataDir(ws);
  const safeId = safeExpDirId(expId);
  if (!safeId) return base;
  const dir = path.join(base, safeId);
  const resolvedBase = path.resolve(base);
  const resolvedDir = path.resolve(dir);
  if (!resolvedDir.startsWith(resolvedBase + path.sep)) {
    throw new Error('实验数据目录越界：' + safeId);
  }
  return dir;
}
function legacyDataFileSet(ws, expId) {
  if (!expId) return null;
  const exp = getItem(ws, 'experiments', expId);
  const list = (exp && exp.frontmatter && exp.frontmatter.results && Array.isArray(exp.frontmatter.results.data_files))
    ? exp.frontmatter.results.data_files
    : [];
  const set = new Set();
  for (const item of list) {
    const base = path.basename(String(item == null ? '' : item).trim());
    if (base && base !== '.' && base !== '..') set.add(base);
  }
  return set;
}
function importDataFiles(ws, expId, sourcePaths) {
  const dir = expDataDir(ws, expId);
  ensureDir(dir);
  const out = [];
  for (const src of sourcePaths) {
    if (!fs.existsSync(src)) continue;
    const fname = path.basename(src);
    let target = path.join(dir, fname);
    let i = 1;
    while (fs.existsSync(target)) {
      const ext = path.extname(fname);
      target = path.join(dir, `${path.basename(fname, ext)}_${i++}${ext}`);
    }
    fs.copyFileSync(src, target);
    out.push(path.basename(target));
  }
  if (expId && out.length > 0) {
    const exp = getItem(ws, 'experiments', expId);
    if (exp) {
      const fm = { ...(exp.frontmatter || {}) };
      const results = (fm.results && typeof fm.results === 'object' && !Array.isArray(fm.results))
        ? { ...fm.results }
        : {};
      const existing = Array.isArray(results.data_files) ? results.data_files.slice() : [];
      for (const name of out) {
        if (!existing.includes(name)) existing.push(name);
      }
      results.data_files = existing;
      fm.results = results;
      fm.updatedAt = today();
      saveItem(ws, 'experiments', expId, { frontmatter: fm, body: exp.body || '' });
    }
  }
  return out;
}
function listDataFiles(ws, expId) {
  const dir = expDataDir(ws, expId);
  const files = fs.existsSync(dir)
    ? fs.readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
    : [];
  if (expId) {
    const allowedLegacy = legacyDataFileSet(ws, expId);
    if (allowedLegacy && allowedLegacy.size > 0) {
      const legacyDir = legacyExpDataDir(ws);
      const seen = new Set(files);
      for (const name of allowedLegacy) {
        if (seen.has(name)) continue;
        const candidate = path.join(legacyDir, name);
        try {
          if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
            files.push(name);
            seen.add(name);
          }
        } catch (_) {}
      }
    }
  }
  return files;
}

const TEXT_DATA_EXTENSIONS = new Set([
  '.csv', '.tsv', '.txt', '.md', '.log', '.json', '.jsonl', '.yaml', '.yml',
  '.xml', '.toml', '.html', '.htm', '.tex', '.py', '.r', '.js', '.ts',
  '.ipynb', '.sh', '.rst', '.sql', '.m', '.c', '.cpp', '.h', '.java'
]);

function isSafeFileInside(baseDir, fileName) {
  const resolvedBase = path.resolve(baseDir);
  const target = path.resolve(baseDir, fileName);
  if (!target.startsWith(resolvedBase + path.sep)) return '';
  try {
    if (fs.existsSync(target) && fs.statSync(target).isFile()) return target;
  } catch (_) {}
  return '';
}

function readDataFile(ws, expId, name) {
  const rawName = String(name == null ? '' : name).trim();
  if (!rawName || rawName === '.' || rawName === '..' || rawName.includes('..') || /[\\/\0]/.test(rawName)) {
    return null;
  }
  let file = isSafeFileInside(expDataDir(ws, expId), rawName);
  if (!file && expId) {
    const allowedLegacy = legacyDataFileSet(ws, expId);
    if (allowedLegacy && allowedLegacy.has(rawName)) {
      file = isSafeFileInside(legacyExpDataDir(ws), rawName);
    }
  }
  if (!file) return null;
  const ext = path.extname(file).toLowerCase();
  if (!TEXT_DATA_EXTENSIONS.has(ext)) {
    return { name: rawName, binary: true, path: file, url: 'file:///' + file.replace(/\\/g, '/') };
  }
  return { name: rawName, binary: false, content: fs.readFileSync(file, 'utf8') };
}
function absolutePath(ws, rel) {
  if (!rel) return '';
  if (path.isAbsolute(rel)) return rel;
  return path.join(workspacePath(ws), rel);
}
function fileUrl(ws, rel) {
  const abs = absolutePath(ws, rel);
  if (!abs) return '';
  return 'file:///' + abs.replace(/\\/g, '/');
}

// ---------- Skill ----------
function listSkills() {
  ensureDir(SKILLS_DIR);
  const out = [{ name: 'default', label: '默认（四段式）', builtin: true }];
  for (const f of fs.readdirSync(SKILLS_DIR)) {
    if (f.endsWith('.md')) out.push({ name: path.basename(f, '.md'), label: path.basename(f, '.md'), builtin: false });
  }
  return out;
}
function getSkillContent(name) {
  if (!name || name === 'default') return null;
  const safe = safeName(name);
  const file = path.join(SKILLS_DIR, safe + '.md');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
  const paperFile = path.join(SKILLS_DIR, 'paper', safe + '.md');
  if (fs.existsSync(paperFile)) return fs.readFileSync(paperFile, 'utf8');
  return null;
}
function importSkill(sourcePath) {
  ensureDir(SKILLS_DIR);
  if (!fs.existsSync(sourcePath)) throw new Error('文件不存在：' + sourcePath);
  const name = slugify(path.basename(sourcePath, path.extname(sourcePath))) || 'custom-skill';
  const dest = path.join(SKILLS_DIR, name + '.md');
  fs.copyFileSync(sourcePath, dest);
  return name;
}
function saveSkillFromText(name, text) {
  ensureDir(SKILLS_DIR);
  const file = path.join(SKILLS_DIR, slugify(name) + '.md');
  fs.writeFileSync(file, text, 'utf8');
  return slugify(name);
}

// ---------- 引用解析 ----------
function resolveRef(ws, refName) {
  const name = String(refName == null ? '' : refName).trim();
  if (!name) return null;
  for (const board of BOARDS) {
    for (const it of listItems(ws, board)) {
      if (it.id === name || it.shortName === name || it.title === name) {
        return { board, id: it.id, label: it.shortName || it.title || it.id };
      }
    }
  }
  return null;
}

// ---------- 反向链接 / 引用图（与 resolveRef 同规则） ----------
/** 从文本中提取 [[...]] 名称，保原大小写、去重。 */
function extractRefNames(text) {
  const out = [];
  const seen = new Set();
  const re = /\[\[([^\]]+)\]\]/g;
  let m;
  const src = String(text == null ? '' : text);
  while ((m = re.exec(src))) {
    const raw = m[1].trim();
    const separator = raw.indexOf('|');
    const name = (separator < 0 ? raw : raw.slice(0, separator)).trim();
    if (name && !seen.has(name)) { seen.add(name); out.push(name); }
  }
  return out;
}

/** 建三板块节点索引，保留 BOARDS 顺序供消歧。 */
function buildRefIndex(ws) {
  const nodes = [];
  for (const board of BOARDS) {
    for (const it of listItems(ws, board)) {
      const names = new Set();
      [it.id, it.shortName, it.title].forEach((v) => {
        if (typeof v === 'string' && v.trim()) names.add(v.trim());
      });
      nodes.push({
        board,
        id: it.id,
        label: it.shortName || it.title || it.id,
        names,
        kind: board === 'papers' ? 'paper' : board === 'ideas' ? 'idea' : 'experiment',
        status: it.status || '',
        item: it
      });
    }
  }
  return nodes;
}

/** 收集一个条目的五类出边：正文 / refs / basedOn / relatedIdea / relatedPapers。 */
function collectOutgoing(item) {
  const out = [];
  const add = (name, via) => {
    const n = String(name == null ? '' : name).trim();
    if (!n) return;
    if (!out.some((e) => e.name === n && e.via === via)) out.push({ name: n, via });
  };
  (item._refs || []).forEach((n) => add(n, '正文'));
  const refs = Array.isArray(item.refs) ? item.refs : (item.refs ? [item.refs] : []);
  refs.forEach((n) => add(n, 'refs'));
  if (item.basedOn) add(item.basedOn, 'basedOn');
  if (item.relatedIdea) add(item.relatedIdea, 'relatedIdea');
  const relatedPapers = Array.isArray(item.relatedPapers)
    ? item.relatedPapers
    : (item.relatedPapers ? [item.relatedPapers] : []);
  relatedPapers.forEach((entry) => {
    if (typeof entry === 'string') {
      if (entry.includes('[[')) {
        extractRefNames(entry).forEach((n) => add(n, 'relatedPapers'));
      } else {
        add(entry, 'relatedPapers');
      }
    } else if (entry && typeof entry === 'object') {
      add(entry.id || entry.shortName || entry.title || '', 'relatedPapers');
    }
  });
  return out;
}

/** 在索引中按 id / shortName / title 解析（与 resolveRef 同规则），排除自引用。 */
function resolveInIndex(index, name, selfNode) {
  const key = String(name == null ? '' : name).trim();
  if (!key) return null;
  for (const node of index) {
    if (selfNode && node.board === selfNode.board && node.id === selfNode.id) continue;
    if (node.names.has(key)) return node;
  }
  return null;
}

/** 谁引用了目标条目？返回 [{board,id,label,via}]，按 BOARDS 顺序 + id 排序。 */
function getBacklinks(ws, targetId) {
  const index = buildRefIndex(ws);
  const target = index.find((n) => n.id === targetId);
  if (!target) return [];
  const out = [];
  for (const node of index) {
    for (const edge of collectOutgoing(node.item)) {
      const resolved = resolveInIndex(index, edge.name, node);
      if (resolved && resolved.board === target.board && resolved.id === target.id) {
        out.push({ board: node.board, id: node.id, label: node.label, via: edge.via });
      }
    }
  }
  const order = {};
  BOARDS.forEach((b, i) => { order[b] = i; });
  out.sort((a, b) => (order[a.board] - order[b.board]) || a.id.localeCompare(b.id) || a.via.localeCompare(b.via));
  return out;
}

/** 一次扫描产出全量引用图：节点 / Idea 论断 / 边数 / 孤立论断数。 */
function getRefGraph(ws) {
  const index = buildRefIndex(ws);
  let linkCount = 0;
  // 先算每条节点的出边（已解析、已排除自引用）
  for (const node of index) {
    node._out = [];
    for (const edge of collectOutgoing(node.item)) {
      const r = resolveInIndex(index, edge.name, node);
      if (!r) continue;
      linkCount++;
      node._out.push({ board: r.board, id: r.id, label: r.label, via: edge.via });
    }
  }
  const nodes = [];
  const claims = [];
  for (const node of index) {
    const incoming = [];
    for (const other of index) {
      for (const e of (other._out || [])) {
        if (e.board === node.board && e.id === node.id) {
          incoming.push({ board: other.board, id: other.id, label: other.label, via: e.via });
        }
      }
    }
    nodes.push({ board: node.board, id: node.id, label: node.label, kind: node.kind, status: node.status });
    if (node.board === 'ideas') {
      claims.push({
        board: 'ideas', id: node.id, label: node.label, status: node.status,
        out: node._out, in: incoming
      });
    }
  }
  const orphanCount = claims.filter((c) => c.out.length === 0 && c.in.length === 0).length;
  return { nodes, claims, linkCount, orphanCount };
}

/** 把 PNG dataURL 写入实验数据目录，返回落盘文件名（重名加 _N）。 */
function saveDataFileBase64(ws, expId, name, dataUrl) {
  const dir = expDataDir(ws, expId);
  ensureDir(dir);
  const raw = String(name || 'chart.png');
  const rawExt = path.extname(raw).toLowerCase();
  const imageExts = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];
  const ext = imageExts.includes(rawExt) ? rawExt : '.png';
  const base = safeName(path.basename(raw, path.extname(raw))) || 'chart';
  let target = path.join(dir, base + ext);
  let i = 1;
  while (fs.existsSync(target)) {
    target = path.join(dir, base + '_' + (i++) + ext);
  }
  const s = String(dataUrl || '');
  const comma = s.indexOf(',');
  const b64 = comma >= 0 ? s.slice(comma + 1) : s;
  fs.writeFileSync(target, Buffer.from(b64, 'base64'));
  return path.basename(target);
}

// ---------- 实验档案（v5：基线复制） ----------
function normalizeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function cloneExperiment(ws, id) {
  const old = getItem(ws, 'experiments', id);
  if (!old) throw new Error('实验不存在：' + id);
  const oldFm = normalizeObject(old.frontmatter);
  const stamp = today();
  const newId = 'exp-' + Date.now().toString().slice(-6);
  const cloneFm = {
    ...oldFm,
    title: String(oldFm.title || id) + '（新版本）',
    status: '草稿',
    basedOn: id,
    priority: oldFm.priority || '中',
    tags: Array.isArray(oldFm.tags) ? oldFm.tags.slice() : [],
    goal: oldFm.goal || '',
    hypothesis: oldFm.hypothesis || '',
    protocol: oldFm.protocol || '',
    config: normalizeObject(oldFm.config),
    environment: normalizeObject(oldFm.environment),
    results: {
      metrics: {},
      charts: [],
      data_files: [],
      chartConfig: normalizeObject(normalizeObject(oldFm.results).chartConfig)
    },
    conclusion: '',
    nextStep: '',
    failure: {},
    createdAt: stamp,
    updatedAt: stamp
  };
  delete cloneFm.runs;
  saveItem(ws, 'experiments', newId, { frontmatter: cloneFm, body: old.body || '' });
  return newId;
}

// ---------- v3：OpenAlex 去重 / 入库 / 引用图 ----------

/** 规范化标题：小写 + 去标点 + 折叠空白，用于三级判重的最后一级。 */
function normalizeTitle(name) {
  return String(name == null ? '' : name)
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 从候选论文取 OpenAlex W id（兼容 NormalizedPaper 与 frontmatter 形态）。 */
function openalexIdOf(cand) {
  const c = cand || {};
  return String(c.openalexId || (c.externalIds && c.externalIds.openalex) || '').trim();
}

/**
 * 三级判重：arxivId → DOI → 规范化标题，按字段优先级整表扫描。
 * 注意：不能在单条论文内逐字段判断——否则排序靠前的条目 DOI 会压过排序靠后条目的 arxivId。
 * 命中即返回本地 id 与命中口径，供 UI 灰显/拦截并说明判重依据。
 */
function normalizeDoiStr(val) {
  return String(val == null ? '' : val)
    .trim()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')
    .replace(/^doi:\s*/i, '')
    .trim()
    .toLowerCase();
}

function normalizeArxivStr(arxivVal, doiVal) {
  const raw = String(arxivVal == null ? '' : arxivVal).trim();
  const bare = raw.match(/^(?:arxiv:\s*)?(\d{4}\.\d{4,5})(?:v\d+)?$/i);
  if (bare) return bare[1].toLowerCase();
  const doi = normalizeDoiStr(doiVal);
  const doiMatch = doi.match(/10\.48550\/arxiv\.(\d{4}\.\d{4,5})/i);
  if (doiMatch) return doiMatch[1].toLowerCase();
  return raw.replace(/^arxiv:\s*/i, '').replace(/v\d+$/i, '').toLowerCase();
}

function findDuplicate(ws, cand) {
  const c = cand || {};
  const doi = normalizeDoiStr(c.doi || (c.externalIds && c.externalIds.doi) || '');
  const arxiv = normalizeArxivStr(c.arxivId || '', doi);
  const oid = openalexIdOf(c).toLowerCase();
  const title = normalizeTitle(c.title || c.shortName);
  if (!arxiv && !doi && !oid && !title) return null;
  const items = listItems(ws, 'papers');
  // 第一级：arxivId（双向支持 vN 版本后缀与 10.48550/arxiv.<id> DOI 交叉判重）
  if (arxiv) {
    for (const it of items) {
      const itDoi = normalizeDoiStr(it.doi || ((it.externalIds || {}).doi) || '');
      const itArxiv = normalizeArxivStr(it.arxivId || '', itDoi);
      if (itArxiv && itArxiv === arxiv) {
        return { duplicateOf: it.id, matchedBy: 'arxivId' };
      }
    }
  }
  // 第二级：DOI
  if (doi) {
    for (const it of items) {
      const itDoi = normalizeDoiStr(it.doi || ((it.externalIds || {}).doi) || '');
      if (itDoi && itDoi === doi) {
        return { duplicateOf: it.id, matchedBy: 'doi' };
      }
    }
  }
  // 辅助级：OpenAlex ID
  if (oid) {
    for (const it of items) {
      if (openalexIdOf(it).toLowerCase() === oid) {
        return { duplicateOf: it.id, matchedBy: 'openalexId' };
      }
    }
  }
  // 第三级：规范化标题
  if (title) {
    for (const it of items) {
      if (normalizeTitle(it.title || it.shortName) === title) {
        return { duplicateOf: it.id, matchedBy: 'title' };
      }
    }
  }
  return null;
}

/** 将下载的开放获取 PDF 写入当前工作区 pdfs/，校验 %PDF- 魔数，返回相对路径。 */
function saveDownloadedPdf(ws, filenameHint, buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 1024) {
    throw new Error('下载内容不是有效的 PDF 文件');
  }
  if (buffer.slice(0, 5).toString('ascii') !== '%PDF-') {
    throw new Error('目标链接返回的不是 PDF 文档（可能需要网页登录或验证）');
  }
  const pdfDir = path.join(workspacePath(ws), 'pdfs');
  ensureDir(pdfDir);
  const base = slugify(filenameHint || 'paper') || 'paper';
  let target = path.join(pdfDir, base + '.pdf');
  let i = 1;
  while (fs.existsSync(target)) {
    target = path.join(pdfDir, `${base}_${i++}.pdf`);
  }
  fs.writeFileSync(target, buffer);
  return 'pdfs/' + path.basename(target);
}

/**
 * 把一条检索结果导入当前工作区 papers/。
 * 走既有 saveItem（gray-matter、一实体一文件），frontmatter 增量合并不覆盖旧字段。
 * @param {string} ws 工作区
 * @param {object} cand NormalizedPaper
 * @param {object} extras {summary, summarySource, rating, pdfPath, searchSkill}
 * @returns {string} 新条目 id
 */
function importFromOpenAlex(ws, cand, extras = {}) {
  const c = cand || {};
  if (!c.title) throw new Error('论文缺少标题，无法入库');
  if (!extras.force) {
    const hit = findDuplicate(ws, c);
    if (hit) throw new Error(`已在库（按 ${hit.matchedBy} 命中 ${hit.duplicateOf}），未重复创建`);
  }
  const shortName = String(c.title).split(/[:：]/)[0].trim().slice(0, 60) || 'untitled';
  let id = slugify(shortName);
  if (getItem(ws, 'papers', id)) id = `${id}-${Date.now().toString().slice(-6)}`;
  const old = getItem(ws, 'papers', id);
  const existing = (old && old.frontmatter) || {};
  const stamp = today();
  const summary = String(extras.summary || c.abstractExcerpt || '').trim();
  const summarySource = extras.summarySource || (extras.summary ? 'ai' : 'excerpt');
  const ratingObj = extras.rating || {};
  const newFm = {
    title: c.title,
    shortName,
    authors: Array.isArray(c.authors) ? c.authors : [],
    published: c.published || String(c.publicationDate || '').slice(0, 7),
    publicationDate: c.publicationDate || '',
    abstract: String(c.abstract || existing.abstract || '').trim().slice(0, 12000),
    arxivId: c.arxivId || '',
    pdfPath: String(extras.pdfPath || c.pdfPath || existing.pdfPath || ''),
    status: existing.status || '待读',
    noteUpdatedAt: existing.noteUpdatedAt || '',
    skill: String(extras.skill || existing.skill || 'default'),
    summaryMethod: String(extras.summaryMethod || existing.summaryMethod || ''),
    summary,
    summarySource,
    aiGenerated: summarySource === 'ai' ? true : !!existing.aiGenerated,
    externalIds: { openalex: openalexIdOf(c), doi: c.doi || '' },
    venue: c.venue || '',
    venueType: c.venueType || '',
    isPreprint: !!c.isPreprint,
    citedByCount: Number(c.citedByCount) || 0,
    citationFetchedAt: stamp,
    citedByCountAtImport: Number(c.citedByCount) || 0,
    rating: String(ratingObj.grade || '').toUpperCase() || '',
    ratingReason: String(ratingObj.reason || ''),
    ratingSource: String(ratingObj.source || ''),
    references: Array.isArray(c.referencedWorks) ? c.referencedWorks.slice() : [],
    citedByApiUrl: c.citedByApiUrl || '',
    oaUrl: c.oaUrl || '',
    createdAt: existing.createdAt || stamp,
    updatedAt: stamp
  };
  // 增量保留多源前沿元数据（仅在有值时落盘，保持 frontmatter 简洁）
  if (c.pdfUrl) newFm.pdfUrl = String(c.pdfUrl);
  if (c.codeUrl) newFm.codeUrl = String(c.codeUrl);
  if (Number(c.githubStars) > 0) newFm.githubStars = Number(c.githubStars);
  if (Number(c.hfUpvotes) > 0) newFm.hfUpvotes = Number(c.hfUpvotes);
  if (c.venueStatus) newFm.venueStatus = String(c.venueStatus);
  if (Array.isArray(c.sources) && c.sources.length) newFm.sources = c.sources.slice();
  if (c.citationSource) newFm.citationSource = String(c.citationSource);
  if (Number(c.influentialCitationCount) > 0) newFm.influentialCitationCount = Number(c.influentialCitationCount);
  if (c.tldr) newFm.tldr = String(c.tldr).slice(0, 600);
  if (extras.searchSkill) newFm.searchSkill = String(extras.searchSkill);
  // 合并不覆盖：旧字段（含用户手写备注 / starred / pdfPath）原样保留
  const fm = { ...existing, ...newFm };
  saveItem(ws, 'papers', id, { frontmatter: fm, body: (old && old.body) || '' });
  return id;
}

/** 从 frontmatter / staged 论文中取 W id 引用列表。 */
function referenceIds(raw) {
  const arr = Array.isArray(raw) ? raw : (raw ? String(raw).split(/[,;，；\s]+/) : []);
  const out = [];
  for (const v of arr) {
    const m = String(v || '').match(/W\d+$/i);
    if (m) out.push(m[0].toUpperCase());
  }
  return out;
}

/**
 * 一次扫描产出引用图：节点 = 本地库 ∪ 本次检索暂存（按 W id / arxiv / DOI / 标题合并）。
 * 引用边恒为「引用者 → 被引用者」；库外 W id 不生成幽灵节点，只累计 unresolvedEdgeCount。
 * @param {string} ws 工作区
 * @param {object[]} staged NormalizedPaper[]（渲染层传 S.searchResults）
 */
function getCitationGraph(ws, staged = []) {
  const local = listItems(ws, 'papers');
  const nodes = [];
  const index = {
    byLocalId: new Map(), byOa: new Map(), byArxiv: new Map(), byDoi: new Map(),
    byTitle: new Map(), byRefName: new Map()
  };
  const normalizeAuthors = (authors) => {
    const seen = new Set();
    return (Array.isArray(authors) ? authors : [])
      .map((author) => String(author || '').trim())
      .filter((author) => {
        const key = author.toLowerCase();
        if (!author || key === 'et al.' || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  };

  function register(node) {
    nodes.push(node);
    index.byLocalId.set(node.id, node);
    [node.id, node.shortName, node.title].forEach((value) => {
      const name = String(value || '').trim();
      if (name && !index.byRefName.has(name)) index.byRefName.set(name, node);
    });
    if (node.openalexId) index.byOa.set(node.openalexId, node);
    if (node.arxivId) index.byArxiv.set(String(node.arxivId).toLowerCase(), node);
    if (node.doi) index.byDoi.set(String(node.doi).toLowerCase(), node);
    const t = normalizeTitle(node.label);
    if (t) index.byTitle.set(t, node);
    return node;
  }
  function findNode(cand) {
    const c = cand || {};
    const oid = openalexIdOf(c);
    if (oid && index.byOa.has(oid)) return index.byOa.get(oid);
    if (c.duplicateOf && index.byLocalId.has(c.duplicateOf)) return index.byLocalId.get(c.duplicateOf);
    const ax = String(c.arxivId || '').trim().toLowerCase();
    if (ax && index.byArxiv.has(ax)) return index.byArxiv.get(ax);
    const doi = String(c.doi || '').trim().toLowerCase();
    if (doi && index.byDoi.has(doi)) return index.byDoi.get(doi);
    const t = normalizeTitle(c.title || c.label);
    if (t && index.byTitle.has(t)) return index.byTitle.get(t);
    return null;
  }

  // 本地节点：无 W id 的老论文保留为孤立节点，其余参与引用连线
  for (const it of local) {
    const fm = it || {};
    const pubDate = String(fm.publicationDate || fm.published || '');
    register({
      key: 'local:' + fm.id,
      source: 'local',
      board: 'papers',
      id: fm.id,
      label: String(fm.shortName || fm.title || fm.id),
      openalexId: openalexIdOf(fm),
      arxivId: String(fm.arxivId || ''),
      doi: String(fm.doi || ((fm.externalIds || {}).doi) || ''),
      pubDate,
      year: Number(pubDate.slice(0, 4)) || 0,
      rating: String(fm.rating || ''),
      citedByCount: Number(fm.citedByCount) || 0,
      references: referenceIds(fm.references),
      authors: normalizeAuthors(fm.authors),
      shortName: String(fm.shortName || ''),
      title: String(fm.title || ''),
      manualReferences: Array.isArray(fm._refs) ? fm._refs.slice() : []
    });
  }

  // 检索暂存节点：与本地合并时标 source:'local'（已入库优先），不产生双点
  for (const cand of (Array.isArray(staged) ? staged : [])) {
    const c = cand || {};
    const merged = findNode(c);
    if (merged) {
      const extraRefs = referenceIds(c.referencedWorks);
      for (const r of extraRefs) if (!merged.references.includes(r)) merged.references.push(r);
      normalizeAuthors(c.authors).forEach((author) => {
        if (!merged.authors.some((known) => known.toLowerCase() === author.toLowerCase())) {
          merged.authors.push(author);
        }
      });
      if (!merged.rating && c.rating) merged.rating = String(c.rating);
      if (!merged.openalexId && openalexIdOf(c)) {
        merged.openalexId = openalexIdOf(c);
        index.byOa.set(merged.openalexId, merged);
      }
      continue;
    }
    const pubDate = String(c.publicationDate || c.published || '');
    const oid = openalexIdOf(c);
    register({
      key: 'search:' + (oid || normalizeTitle(c.title).slice(0, 40) || 'unknown'),
      source: 'search',
      board: 'papers',
      id: oid || String(c.title || ''),
      label: String(c.shortName || c.title || oid || '（无标题）'),
      openalexId: oid,
      arxivId: String(c.arxivId || ''),
      doi: String(c.doi || ''),
      pubDate,
      year: Number(pubDate.slice(0, 4)) || 0,
      rating: String(c.rating || ''),
      citedByCount: Number(c.citedByCount) || 0,
      references: referenceIds(c.referencedWorks),
      authors: normalizeAuthors(c.authors),
      shortName: String(c.shortName || ''),
      title: String(c.title || ''),
      manualReferences: []
    });
  }

  const edges = [];
  const seenEdges = new Set();
  let unresolvedEdgeCount = 0;
  const unresolvedRefOwners = new Map();
  for (const from of nodes) {
    const via = from.source === 'local' ? 'references' : 'referenced_works';
    for (const oid of (from.references || [])) {
      const to = index.byOa.get(oid);
      if (!to) {
        unresolvedEdgeCount++;
        if (from.source === 'local') {
          let entry = unresolvedRefOwners.get(oid);
          if (!entry) {
            entry = { openalexId: oid, citingKeys: new Set(), citingPaperIds: [], citingPaperLabels: [] };
            unresolvedRefOwners.set(oid, entry);
          }
          if (!entry.citingKeys.has(from.key)) {
            entry.citingKeys.add(from.key);
            entry.citingPaperIds.push(from.id);
            entry.citingPaperLabels.push(from.label);
          }
        }
        continue;
      }
      if (to.key === from.key) continue;
      const sig = from.key + '|' + to.key + '|' + via;
      if (seenEdges.has(sig)) continue;
      seenEdges.add(sig);
      edges.push({ from: from.key, to: to.key, via, directed: true, weight: 1 });
    }
  }

  let unresolvedNoteEdgeCount = 0;
  for (const from of nodes) {
    for (const ref of from.manualReferences || []) {
      const target = index.byRefName.get(String(ref || '').trim()) ||
        index.byTitle.get(normalizeTitle(ref));
      if (!target) { unresolvedNoteEdgeCount++; continue; }
      if (target.key === from.key) continue;
      const sig = from.key + '|' + target.key + '|notes';
      if (seenEdges.has(sig)) continue;
      seenEdges.add(sig);
      edges.push({ from: from.key, to: target.key, via: 'notes', directed: true, weight: 1 });
    }
  }

  const pairKey = (a, b) => a < b ? a + '\u0000' + b : b + '\u0000' + a;
  const MAX_RELATION_PAIRS = 6000;
  let relationPairsTruncated = false;
  const strongestPairs = (map) => Array.from(map.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, 2500);
  const addPairEvidence = (map, a, b, evidence) => {
    if (a.key === b.key) return;
    const key = pairKey(a.key, b.key);
    if (!map.has(key) && map.size >= MAX_RELATION_PAIRS) {
      relationPairsTruncated = true;
      return;
    }
    let pair = map.get(key);
    if (!pair) {
      pair = { a: a.key < b.key ? a : b, b: a.key < b.key ? b : a, count: 0, evidence: [] };
      map.set(key, pair);
    }
    pair.count++;
    if (evidence && pair.evidence.length < 5 && !pair.evidence.includes(evidence)) pair.evidence.push(evidence);
  };
  const MAX_RELATION_DEGREE = 80;

  const refOwners = new Map();
  for (const node of nodes) {
    for (const ref of new Set(node.references || [])) {
      if (!refOwners.has(ref)) refOwners.set(ref, []);
      refOwners.get(ref).push(node);
    }
  }
  const coupling = new Map();
  for (const [ref, owners] of refOwners) {
    if (owners.length < 2 || owners.length > MAX_RELATION_DEGREE) continue;
    for (let i = 0; i < owners.length; i++) {
      for (let j = i + 1; j < owners.length; j++) addPairEvidence(coupling, owners[i], owners[j], ref);
    }
  }
  strongestPairs(coupling).forEach((pair) => {
    const norm = Math.sqrt(Math.max(1, pair.a.references.length * pair.b.references.length));
    edges.push({
      from: pair.a.key, to: pair.b.key, via: 'coupling', directed: false,
      sharedReferenceCount: pair.count, sharedReferenceIds: pair.evidence,
      weight: pair.count / norm
    });
  });

  const coCitation = new Map();
  for (const citing of nodes) {
    const cited = Array.from(new Set(citing.references || []))
      .map((oid) => index.byOa.get(oid))
      .filter((node) => node && node.key !== citing.key);
    if (cited.length < 2 || cited.length > MAX_RELATION_DEGREE) continue;
    for (let i = 0; i < cited.length; i++) {
      for (let j = i + 1; j < cited.length; j++) {
        addPairEvidence(coCitation, cited[i], cited[j], citing.key);
      }
    }
  }
  strongestPairs(coCitation).forEach((pair) => {
    edges.push({
      from: pair.a.key, to: pair.b.key, via: 'cocitation', directed: false,
      coCitedByCount: pair.count, coCitedBy: pair.evidence,
      weight: pair.count
    });
  });

  const authorOwners = new Map();
  for (const node of nodes) {
    for (const author of node.authors || []) {
      const normalized = author.toLowerCase();
      if (!authorOwners.has(normalized)) authorOwners.set(normalized, { label: author, nodes: [] });
      authorOwners.get(normalized).nodes.push(node);
    }
  }
  const coauthors = new Map();
  for (const author of authorOwners.values()) {
    const owners = author.nodes;
    if (owners.length < 2 || owners.length > 30) continue;
    for (let i = 0; i < owners.length; i++) {
      for (let j = i + 1; j < owners.length; j++) {
        addPairEvidence(coauthors, owners[i], owners[j], author.label);
      }
    }
  }
  strongestPairs(coauthors).forEach((pair) => {
    edges.push({
      from: pair.a.key, to: pair.b.key, via: 'coauthor', directed: false,
      sharedAuthors: pair.evidence, sharedAuthorCount: pair.count,
      weight: pair.count
    });
  });

  const graphNodes = nodes.map((n) => ({
    key: n.key, source: n.source, board: n.board, id: n.id, label: n.label,
    openalexId: n.openalexId, arxivId: n.arxivId, doi: n.doi,
    pubDate: n.pubDate, year: n.year,
    rating: n.rating, citedByCount: n.citedByCount, authors: n.authors
  }));
  const relationCounts = edges.reduce((counts, edge) => {
    counts[edge.via] = (counts[edge.via] || 0) + 1;
    return counts;
  }, {});
  const topCitedMissing = Array.from(unresolvedRefOwners.values())
    .map((entry) => ({
      openalexId: entry.openalexId,
      citedByLocalCount: entry.citingPaperIds.length,
      citingPaperIds: entry.citingPaperIds.slice(0, 12),
      citingPaperLabels: entry.citingPaperLabels.slice(0, 6)
    }))
    .sort((a, b) => b.citedByLocalCount - a.citedByLocalCount || a.openalexId.localeCompare(b.openalexId))
    .slice(0, 25);
  return {
    nodes: graphNodes,
    edges,
    missingSeeds: {
      topCited: topCitedMissing,
      topCiting: []
    },
    stats: {
      nodeCount: graphNodes.length, edgeCount: edges.length, unresolvedEdgeCount,
      unresolvedNoteEdgeCount, relationCounts,
      inferredRelationCapped: relationPairsTruncated ||
        coupling.size > 2500 || coCitation.size > 2500 || coauthors.size > 2500
    }
  };
}

// ---------- 初始化 ----------
function init() {
  ensureData();
  const cfg = getConfig();
  let wsList = listWorkspaces();
  if (wsList.length === 0) {
    // 首次运行创建通用默认工作区（本地已有工作区时此分支不会触发，不影响既有数据）。
    const defaultWorkspace = '我的研究';
    createWorkspace(defaultWorkspace);
    wsList = listWorkspaces();
  }
  if (!cfg.currentWorkspace || !wsList.includes(cfg.currentWorkspace)) {
    updateConfig({ currentWorkspace: wsList[0] });
  }
  return { config: getConfig(), workspaces: listWorkspaces() };
}

module.exports = {
  BOARDS, BOARD_CN, DATA_ROOT, APP_DIR, BUILTIN_DATA_DIR,
  init, ensureData,
  getConfig, updateConfig,
  listWorkspaces, createWorkspace, renameWorkspace, deleteWorkspace, copyWorkspace,
  listItems, getItem, saveItem, deleteItem, renameItem,
  importPdfs, attachPdfToPaper, parsePdfName,
  importDataFiles, listDataFiles, readDataFile, expDataDir, absolutePath, fileUrl, saveDataFileBase64,
  listSkills, getSkillContent, importSkill, saveSkillFromText,
  resolveRef, getBacklinks, getRefGraph,
  findDuplicate, importFromOpenAlex, saveDownloadedPdf, getCitationGraph,
  cloneExperiment,
  normalizeTitle, openalexIdOf
};
