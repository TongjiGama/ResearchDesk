/**
 * src/main/search/skills.js — 统一领域 Skill 注册表与 GitHub SKILL.md 导入器
 * 职责：
 *   1. 统一管理 5 大领域（search / paper / lineage / idea / experiment）的内置与用户 Skill
 *   2. 加载内置 Skill（src/main/skills/<domain>/*.md，兼容 paper-reading-method.md 及 ideas/experiments 复数目录）
 *   3. 加载用户自定义 / GitHub 导入 Skill（data/skills/<domain>/*.md，兼容 legacy data/skills/*.md）
 *   4. 解析标准 Agent SKILL.md（YAML frontmatter + Markdown 正文），保持所有 search 导出 100% 向后兼容
 */
'use strict';

const fs = require('fs');
const path = require('path');
const matter = require('gray-matter');
const store = require('../store');

const SKILLS_BUILTIN_ROOT = path.join(__dirname, '..', 'skills');
const BUILTIN_DIR = path.join(SKILLS_BUILTIN_ROOT, 'search');
const DOMAINS = ['search', 'paper', 'lineage', 'idea', 'experiment'];
const DOMAIN_ALIASES = {
  search: 'search',
  paper: 'paper',
  papers: 'paper',
  lineage: 'lineage',
  idea: 'idea',
  ideas: 'idea',
  experiment: 'experiment',
  experiments: 'experiment'
};
const BUILTIN_ORDER = [
  'paper-search-pro',
  'frontier-sota-radar',
  'citation-snowball',
  'systematic-literature-review'
];
const ALL_SOURCES = ['openalex', 'arxiv', 'openreview', 'huggingface', 'crossref', 'semanticscholar'];
const ALLOWED_SORTS = ['frontier', 'relevance', 'cited_by_count:desc', 'publication_date:desc', 'velocity'];
const FETCH_TIMEOUT_MS = 12000;
const MAX_SKILL_BYTES = 180 * 1024;

const DEFAULT_SUMMARIES = {
  search: '自定义论文检索 Skill，用于指导多源检索与查询规划。',
  paper: '论文阅读与总结 Skill，用于指导结构化文献精读与证据核实。',
  lineage: '论文脉络分析 Skill，用于指导学术谱系梳理、流派演化与缺口定位。',
  idea: '科研 Idea 孵化与评审 Skill，用于指导可证伪假设生成与对抗评审。',
  experiment: '实验设计与分析 Skill，用于指导消融矩阵构建与统计结果诊断。'
};

function normalizeDomain(domain) {
  const key = String(domain == null ? '' : domain).trim().toLowerCase();
  return DOMAIN_ALIASES[key] || 'search';
}

function isDomainToken(val) {
  if (typeof val !== 'string') return false;
  return Object.prototype.hasOwnProperty.call(DOMAIN_ALIASES, val.trim().toLowerCase());
}

function builtinDirsForDomain(domain) {
  const dom = normalizeDomain(domain);
  if (dom === 'idea') {
    return [path.join(SKILLS_BUILTIN_ROOT, 'idea'), path.join(SKILLS_BUILTIN_ROOT, 'ideas')];
  }
  if (dom === 'experiment') {
    return [path.join(SKILLS_BUILTIN_ROOT, 'experiment'), path.join(SKILLS_BUILTIN_ROOT, 'experiments')];
  }
  return [path.join(SKILLS_BUILTIN_ROOT, dom)];
}

function userSkillsDir(domain = 'search') {
  return path.join(store.DATA_ROOT, 'skills', normalizeDomain(domain));
}

function userSearchSkillsDir() {
  return userSkillsDir('search');
}

function slugId(raw, fallback = 'custom-search-skill') {
  const cleaned = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return cleaned || fallback;
}

function normalizeSources(input, fallbackText = '') {
  if (Array.isArray(input) && input.length) {
    const valid = Array.from(new Set(
      input.map((s) => String(s || '').trim().toLowerCase()).filter((s) => ALL_SOURCES.includes(s))
    ));
    if (valid.length) return valid;
  }
  const text = String(fallbackText || '').toLowerCase();
  const detected = [];
  if (/\bopenalex\b/.test(text)) detected.push('openalex');
  if (/\barxiv\b/.test(text)) detected.push('arxiv');
  if (/\bopenreview\b/.test(text)) detected.push('openreview');
  if (/hugging\s*face|hf\s*papers|daily\s*papers/.test(text)) detected.push('huggingface');
  if (/\bcrossref\b/.test(text)) detected.push('crossref');
  if (/semantic\s*scholar|\bs2\b/.test(text)) detected.push('semanticscholar');
  return detected.length ? detected : ['openalex', 'arxiv', 'openreview', 'huggingface'];
}

function cleanSummary(text, limit = 260) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s || s.length <= limit) return s;
  const head = s.slice(0, limit);
  const cut = Math.max(head.lastIndexOf('。'), head.lastIndexOf('. '), head.lastIndexOf('；'), head.lastIndexOf(' '));
  return (cut >= Math.floor(limit * 0.6) ? head.slice(0, cut + (head[cut] === ' ' ? 0 : 1)) : head).trim() + '…';
}

function builtinSkillIds(domain = 'search') {
  const dom = normalizeDomain(domain);
  const set = new Set(dom === 'search' ? BUILTIN_ORDER : []);
  for (const dir of builtinDirsForDomain(dom)) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (/\.md$/i.test(name)) set.add(slugId(path.basename(name, path.extname(name))));
    }
  }
  if (dom === 'paper') {
    const legacyMethod = path.join(SKILLS_BUILTIN_ROOT, 'paper-reading-method.md');
    if (fs.existsSync(legacyMethod)) set.add('paper-reading-method');
  }
  return set;
}

function deriveDefaultSkillName(repo, relPath = '') {
  const cleanRel = String(relPath || '').replace(/^\/+|\/+$/g, '');
  if (!cleanRel) return repo;
  const segments = cleanRel.split('/').filter(Boolean);
  const last = segments[segments.length - 1] || '';
  const base = path.basename(last, path.extname(last));
  if (base.toLowerCase() === 'skill') {
    const parent = segments.length >= 2 ? segments[segments.length - 2] : '';
    return parent && parent.toLowerCase() !== 'skills' ? parent : repo;
  }
  return `${repo}-${base}`;
}

function hasUnsafePathSegment(relPath) {
  return String(relPath || '')
    .split(/[\\/]/)
    .some((seg) => seg === '..' || seg === '.' || /[\0?#]/.test(seg));
}

function isAllowedGithubHost(hostname) {
  const h = String(hostname || '').toLowerCase();
  return h === 'github.com' || h === 'www.github.com' || h === 'raw.githubusercontent.com';
}

function parseSkillMarkdown(rawText, { fallbackId = 'custom-skill', domain = '', builtin = false, filePath = '' } = {}) {
  const sourceText = String(rawText || '').trim();
  let parsed = { data: {}, content: sourceText };
  try {
    parsed = matter(sourceText);
  } catch (_) {
    parsed = { data: {}, content: sourceText };
  }
  const data = parsed.data && typeof parsed.data === 'object' ? parsed.data : {};
  const body = String(parsed.content || '').trim();
  const resolvedDomain = normalizeDomain(domain || data.domain || 'search');
  const id = slugId(data.id || fallbackId || data.name);
  const headingMatch = body.match(/^#\s+(.+)$/m);
  const name = String(data.name || (headingMatch && headingMatch[1]) || id).trim().slice(0, 80);
  const summary = cleanSummary(data.summary || data.description || '', 260)
    || DEFAULT_SUMMARIES[resolvedDomain]
    || DEFAULT_SUMMARIES.search;
  const workflowSteps = Array.isArray(data.workflowSteps)
    ? data.workflowSteps.map((s) => String(s || '').trim()).filter(Boolean)
    : [];
  const defaultSources = normalizeSources(data.defaultSources || data.sources, sourceText);
  const defaultSort = ALLOWED_SORTS.includes(String(data.defaultSort || ''))
    ? String(data.defaultSort)
    : 'frontier';
  const maxQueries = Math.max(1, Math.min(4, Number(data.maxQueries) || 3));
  const recentYears = Number(data.recentYears) > 0 ? Math.min(20, Number(data.recentYears)) : 0;
  const enableSnowball = data.enableSnowball !== undefined
    ? Boolean(data.enableSnowball)
    : /snowball|citation\s*chas|forward.{0,20}citation|backward.{0,20}citation|引文滚雪球|前向追踪/i.test(sourceText);
  const snowballDirection = ['forward', 'backward', 'both'].includes(String(data.snowballDirection || ''))
    ? String(data.snowballDirection)
    : 'both';
  const enableRcsScreening = Boolean(data.enableRcsScreening);
  const excludeRejected = data.excludeRejected !== false;

  return {
    id,
    name,
    domain: resolvedDomain,
    version: String(data.version || '1.0'),
    badge: String(data.badge || (builtin ? '内置技能' : 'GitHub 导入')).slice(0, 20),
    tier: String(data.tier || 'custom'),
    githubRepo: String(data.githubRepo || data.sourceUrl || '').trim(),
    license: String(data.license || '').trim(),
    attribution: String(data.attribution || '').trim(),
    summary,
    description: summary,
    workflowSteps,
    defaultSources,
    defaultSort,
    maxQueries,
    recentYears,
    enableSnowball,
    snowballDirection,
    enableRcsScreening,
    excludeRejected,
    builtin: Boolean(builtin),
    filePath,
    content: body,
    raw: sourceText
  };
}

function readSkillFile(full, domain, builtin, fallbackIdOverride = '') {
  try {
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return null;
    const raw = fs.readFileSync(full, 'utf8');
    const fallbackId = fallbackIdOverride || path.basename(full, path.extname(full));
    return parseSkillMarkdown(raw, { fallbackId, domain, builtin, filePath: full });
  } catch (_) {
    return null;
  }
}

function readSkillsFromDir(dir, builtin, domain = 'search') {
  if (!dir || !fs.existsSync(dir)) return [];
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    if (!/\.md$/i.test(name)) continue;
    const full = path.join(dir, name);
    const parsed = readSkillFile(full, domain, builtin);
    if (parsed) out.push(parsed);
  }
  return out;
}

function listSkillsForSingleDomain(domain, { includeContent = false } = {}) {
  const dom = normalizeDomain(domain);
  const builtins = [];
  for (const dir of builtinDirsForDomain(dom)) {
    builtins.push(...readSkillsFromDir(dir, true, dom));
  }
  if (dom === 'paper') {
    const legacyMethod = path.join(SKILLS_BUILTIN_ROOT, 'paper-reading-method.md');
    const parsedMethod = readSkillFile(legacyMethod, 'paper', true, 'paper-reading-method');
    if (parsedMethod && !builtins.some((s) => s.id === parsedMethod.id)) {
      builtins.push(parsedMethod);
    }
  }

  builtins.sort((a, b) => {
    if (dom === 'search') {
      const ia = BUILTIN_ORDER.indexOf(a.id);
      const ib = BUILTIN_ORDER.indexOf(b.id);
      if (ia >= 0 && ib >= 0) return ia - ib;
      if (ia >= 0) return -1;
      if (ib >= 0) return 1;
    }
    return a.name.localeCompare(b.name, 'zh');
  });

  const userSkills = readSkillsFromDir(userSkillsDir(dom), false, dom);
  if (dom === 'paper') {
    const legacyDir = path.join(store.DATA_ROOT, 'skills');
    for (const legacySkill of readSkillsFromDir(legacyDir, false, 'paper')) {
      if (!userSkills.some((s) => s.id === legacySkill.id)) userSkills.push(legacySkill);
    }
  }
  userSkills.sort((a, b) => a.name.localeCompare(b.name, 'zh'));

  const merged = new Map();
  builtins.forEach((skill) => {
    if (!merged.has(skill.id)) merged.set(skill.id, skill);
  });
  userSkills.forEach((skill) => {
    if (!merged.has(skill.id)) merged.set(skill.id, skill);
  });

  return Array.from(merged.values()).map((skill) => {
    if (includeContent) return skill;
    const { raw, content, filePath, ...meta } = skill;
    return meta;
  });
}

function listSkills(domainOrOpts = 'search', maybeOpts = {}) {
  let domain = 'search';
  let opts = maybeOpts || {};
  if (domainOrOpts && typeof domainOrOpts === 'object') {
    opts = domainOrOpts;
    domain = opts.domain || 'search';
  } else if (typeof domainOrOpts === 'string' && domainOrOpts.trim()) {
    domain = domainOrOpts.trim();
  }
  if (String(domain).toLowerCase() === 'all') {
    return DOMAINS.reduce((acc, d) => acc.concat(listSkillsForSingleDomain(d, opts)), []);
  }
  return listSkillsForSingleDomain(domain, opts);
}

function getSkill(id, domain = 'search') {
  const target = slugId(id, '');
  if (!target) return null;
  const dom = normalizeDomain(domain);
  const all = listSkills(dom, { includeContent: true });
  return all.find((s) => s.id === target) || null;
}

function listSearchSkills({ includeContent = false } = {}) {
  return listSkills('search', { includeContent });
}

function getSearchSkill(id) {
  return getSkill(id, 'search');
}

/**
 * 将用户输入的 GitHub 仓库简写 / blob URL / tree URL / raw URL 规范化为候选 raw URL 列表。
 * 严格限制仅允许 github.com 与 raw.githubusercontent.com，禁止路径穿越，防止 SSRF。
 */
function resolveGithubSkillUrls(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('请输入 GitHub 仓库名或 SKILL.md 链接');

  const shortRepo = raw.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:\/(.+))?$/);
  if (shortRepo) {
    const [, owner, repo, subPath] = shortRepo;
    if (owner === '.' || owner === '..' || repo === '.' || repo === '..') {
      throw new Error('GitHub 仓库路径非法');
    }
    const repoUrl = `https://github.com/${owner}/${repo}`;
    if (subPath) {
      const cleanSub = subPath.replace(/^\/+|\/+$/g, '');
      if (!cleanSub || hasUnsafePathSegment(cleanSub)) {
        throw new Error('GitHub 文件路径非法');
      }
      const isMd = /\.md$/i.test(cleanSub);
      const candidates = isMd
        ? [
            `https://raw.githubusercontent.com/${owner}/${repo}/main/${cleanSub}`,
            `https://raw.githubusercontent.com/${owner}/${repo}/master/${cleanSub}`
          ]
        : [
            `https://raw.githubusercontent.com/${owner}/${repo}/main/${cleanSub}/SKILL.md`,
            `https://raw.githubusercontent.com/${owner}/${repo}/master/${cleanSub}/SKILL.md`,
            `https://raw.githubusercontent.com/${owner}/${repo}/main/${cleanSub}/skill.md`
          ];
      return {
        owner,
        repo,
        repoUrl,
        explicitFile: isMd,
        defaultName: deriveDefaultSkillName(repo, isMd ? cleanSub : `${cleanSub}/SKILL.md`),
        candidates
      };
    }
    return {
      owner,
      repo,
      repoUrl,
      explicitFile: false,
      defaultName: repo,
      candidates: [
        `https://raw.githubusercontent.com/${owner}/${repo}/main/SKILL.md`,
        `https://raw.githubusercontent.com/${owner}/${repo}/master/SKILL.md`,
        `https://raw.githubusercontent.com/${owner}/${repo}/main/skill.md`
      ]
    };
  }

  let parsed;
  try {
    parsed = new URL(raw);
  } catch (_) {
    throw new Error('链接格式无效，请输入 https://github.com/owner/repo 或 SKILL.md 链接');
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('仅支持 HTTPS 的 GitHub 链接');
  }
  const host = parsed.hostname.toLowerCase();
  if (host === 'raw.githubusercontent.com') {
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parts.length < 4) throw new Error('raw.githubusercontent.com 链接不完整');
    const [owner, repo, , ...rest] = parts;
    const relPath = rest.join('/');
    if (hasUnsafePathSegment(relPath)) throw new Error('raw.githubusercontent.com 路径非法');
    return {
      owner,
      repo,
      repoUrl: `https://github.com/${owner}/${repo}`,
      explicitFile: true,
      defaultName: deriveDefaultSkillName(repo, relPath),
      candidates: [parsed.toString()]
    };
  }
  if (host === 'github.com' || host === 'www.github.com') {
    const parts = parsed.pathname.replace(/\.git$/i, '').split('/').filter(Boolean);
    if (parts.length < 2) throw new Error('GitHub 链接至少需包含 owner/repo');
    const [owner, repo, mode, branch, ...rest] = parts;
    const repoUrl = `https://github.com/${owner}/${repo}`;
    if (mode === 'blob' && branch && rest.length) {
      const fileRel = rest.join('/');
      if (hasUnsafePathSegment(fileRel)) throw new Error('GitHub 文件路径非法');
      return {
        owner,
        repo,
        repoUrl,
        explicitFile: true,
        defaultName: deriveDefaultSkillName(repo, fileRel),
        candidates: [`https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${fileRel}`]
      };
    }
    if (mode === 'tree' && branch) {
      const dirRel = rest.join('/');
      if (dirRel && hasUnsafePathSegment(dirRel)) throw new Error('GitHub 目录路径非法');
      const prefix = dirRel ? `${dirRel}/` : '';
      return {
        owner,
        repo,
        repoUrl,
        explicitFile: false,
        defaultName: deriveDefaultSkillName(repo, `${prefix}SKILL.md`),
        candidates: [
          `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${prefix}SKILL.md`,
          `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${prefix}skill.md`
        ]
      };
    }
    return {
      owner,
      repo,
      repoUrl,
      explicitFile: false,
      defaultName: repo,
      candidates: [
        `https://raw.githubusercontent.com/${owner}/${repo}/main/SKILL.md`,
        `https://raw.githubusercontent.com/${owner}/${repo}/master/SKILL.md`,
        `https://raw.githubusercontent.com/${owner}/${repo}/main/skill.md`
      ]
    };
  }

  throw new Error('出于安全限制，仅允许从 github.com 或 raw.githubusercontent.com 导入 Skill');
}

async function discoverGithubSkillFiles(owner, repo) {
  if (!owner || !repo || hasUnsafePathSegment(`${owner}/${repo}`)) return [];
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/HEAD?recursive=1`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const resp = await fetch(url, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'research-workbench-search-skill/1.0' },
      signal: ctrl.signal
    });
    clearTimeout(timer);
    if (!resp.ok) return [];
    const data = await resp.json();
    const tree = Array.isArray(data && data.tree) ? data.tree : [];
    const paths = tree
      .filter((entry) => entry && entry.type === 'blob' && /(?:^|\/)skill\.md$/i.test(String(entry.path || '')))
      .map((entry) => String(entry.path));
    const score = (p) => (/paper|research|literature|citation|arxiv|scholar|search|review/i.test(p) ? 0 : 1);
    return paths.sort((a, b) => score(a) - score(b) || a.localeCompare(b));
  } catch (_) {
    clearTimeout(timer);
    return [];
  }
}

function saveSkill(payload = {}, domain = '') {
  const dom = normalizeDomain(domain || payload.domain || 'search');
  const rawInput = String(payload.raw || '').trim();
  const contentInput = String(payload.content || '').trim();
  const baseId = slugId(payload.id || payload.name, dom === 'search' ? 'custom-search-skill' : `custom-${dom}-skill`);
  if (builtinSkillIds(dom).has(baseId)) {
    throw new Error(`「${baseId}」为系统内置 Skill ID，请更换名称后再保存`);
  }

  let markdownToWrite = '';
  if (rawInput && !payload.rebuildFrontmatter) {
    const parsed = parseSkillMarkdown(rawInput, { fallbackId: baseId, domain: dom, builtin: false });
    const fm = {
      id: baseId,
      name: String(payload.name || parsed.name).trim().slice(0, 80),
      domain: dom,
      version: parsed.version || '1.0',
      badge: String(payload.badge || 'GitHub 导入').slice(0, 20),
      tier: parsed.tier || 'custom',
      githubRepo: String(payload.githubRepo || parsed.githubRepo || '').trim(),
      license: String(payload.license || parsed.license || '').trim(),
      ...(payload.attribution || parsed.attribution ? { attribution: String(payload.attribution || parsed.attribution).trim() } : {}),
      ...(Array.isArray(payload.workflowSteps) && payload.workflowSteps.length
        ? { workflowSteps: payload.workflowSteps.map((s) => String(s || '').trim()).filter(Boolean) }
        : (parsed.workflowSteps.length ? { workflowSteps: parsed.workflowSteps } : {})),
      summary: cleanSummary(payload.summary || payload.description || parsed.summary || '', 260),
      importedAt: new Date().toISOString().slice(0, 10)
    };
    if (dom === 'search') {
      fm.defaultSources = normalizeSources(payload.defaultSources || parsed.defaultSources, rawInput);
      fm.defaultSort = ALLOWED_SORTS.includes(payload.defaultSort) ? payload.defaultSort : parsed.defaultSort;
      fm.maxQueries = Math.max(1, Math.min(4, Number(payload.maxQueries || parsed.maxQueries) || 3));
      if (Number(payload.recentYears || parsed.recentYears) > 0) {
        fm.recentYears = Math.min(20, Number(payload.recentYears || parsed.recentYears));
      }
      fm.enableSnowball = payload.enableSnowball !== undefined ? Boolean(payload.enableSnowball) : parsed.enableSnowball;
      fm.snowballDirection = ['forward', 'backward', 'both'].includes(String(payload.snowballDirection || parsed.snowballDirection || ''))
        ? String(payload.snowballDirection || parsed.snowballDirection)
        : 'both';
      fm.enableRcsScreening = payload.enableRcsScreening !== undefined ? Boolean(payload.enableRcsScreening) : parsed.enableRcsScreening;
      fm.excludeRejected = payload.excludeRejected !== undefined ? Boolean(payload.excludeRejected) : parsed.excludeRejected;
    }
    markdownToWrite = matter.stringify(parsed.content || rawInput, fm);
  } else {
    if (!contentInput) throw new Error('Skill 规范正文不能为空');
    const fm = {
      id: baseId,
      name: String(payload.name || baseId).trim().slice(0, 80),
      domain: dom,
      version: String(payload.version || '1.0'),
      badge: String(payload.badge || '自定义').slice(0, 20),
      tier: 'custom',
      githubRepo: String(payload.githubRepo || '').trim(),
      license: String(payload.license || '').trim(),
      ...(payload.attribution ? { attribution: String(payload.attribution).trim() } : {}),
      ...(Array.isArray(payload.workflowSteps) && payload.workflowSteps.length
        ? { workflowSteps: payload.workflowSteps.map((s) => String(s || '').trim()).filter(Boolean) }
        : {}),
      summary: cleanSummary(payload.summary || payload.description || '', 260) || DEFAULT_SUMMARIES[dom] || DEFAULT_SUMMARIES.search,
      importedAt: new Date().toISOString().slice(0, 10)
    };
    if (dom === 'search') {
      fm.defaultSources = normalizeSources(payload.defaultSources, contentInput);
      fm.defaultSort = ALLOWED_SORTS.includes(payload.defaultSort) ? payload.defaultSort : 'frontier';
      fm.maxQueries = Math.max(1, Math.min(4, Number(payload.maxQueries) || 3));
      if (Number(payload.recentYears) > 0) fm.recentYears = Math.min(20, Number(payload.recentYears));
      fm.enableSnowball = Boolean(payload.enableSnowball);
      fm.snowballDirection = ['forward', 'backward', 'both'].includes(String(payload.snowballDirection || ''))
        ? String(payload.snowballDirection)
        : 'both';
      fm.enableRcsScreening = Boolean(payload.enableRcsScreening);
      fm.excludeRejected = payload.excludeRejected !== false;
    }
    markdownToWrite = matter.stringify(contentInput, fm);
  }

  const dir = userSkillsDir(dom);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, baseId + '.md');
  fs.writeFileSync(target, markdownToWrite, 'utf8');
  return parseSkillMarkdown(markdownToWrite, { fallbackId: baseId, domain: dom, builtin: false, filePath: target });
}

function saveSearchSkill(payload = {}) {
  return saveSkill(payload, 'search');
}

async function fetchGithubRawText(urls) {
  let downloaded = '';
  let resolvedUrl = '';
  let lastStatus = 0;

  for (const url of urls) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const resp = await fetch(url, {
        headers: { Accept: 'text/plain, text/markdown, */*', 'User-Agent': 'research-workbench-search-skill/1.0' },
        signal: ctrl.signal
      });
      clearTimeout(timer);
      if (resp.url) {
        try {
          const finalUrl = new URL(resp.url);
          if (finalUrl.protocol !== 'https:' || !isAllowedGithubHost(finalUrl.hostname)) {
            throw new Error('GitHub 跳转目标域名不受信任，已拦截');
          }
        } catch (err) {
          if (err && /不受信任/.test(err.message || '')) throw err;
        }
      }
      if (!resp.ok) {
        lastStatus = resp.status;
        continue;
      }
      const text = await resp.text();
      if (!text || !text.trim()) continue;
      if (Buffer.byteLength(text, 'utf8') > MAX_SKILL_BYTES) {
        const sliced = text.slice(0, 60000);
        const lastNl = sliced.lastIndexOf('\n');
        downloaded = lastNl > 40000 ? sliced.slice(0, lastNl) : sliced;
      } else {
        downloaded = text;
      }
      resolvedUrl = url;
      break;
    } catch (e) {
      clearTimeout(timer);
      if (e && e.name === 'AbortError') {
        throw new Error('下载 GitHub SKILL.md 超时，请检查网络后重试');
      }
      if (e && /不受信任/.test(e.message || '')) throw e;
      lastStatus = lastStatus || 0;
    }
  }
  return { downloaded, resolvedUrl, lastStatus };
}

async function importSkillFromGithub(urlInput, domainOrOpts = 'search', customNameArg = '') {
  let domain = 'search';
  let customName = customNameArg;
  if (domainOrOpts && typeof domainOrOpts === 'object') {
    domain = normalizeDomain(domainOrOpts.domain || 'search');
    customName = domainOrOpts.customName !== undefined ? domainOrOpts.customName : customNameArg;
  } else if (isDomainToken(domainOrOpts)) {
    domain = normalizeDomain(domainOrOpts);
  } else if (typeof domainOrOpts === 'string' && domainOrOpts) {
    customName = domainOrOpts;
  }

  const resolved = resolveGithubSkillUrls(urlInput);
  let { repoUrl, defaultName, candidates } = resolved;
  let { downloaded, resolvedUrl, lastStatus } = await fetchGithubRawText(candidates);

  if (!downloaded && !resolved.explicitFile && resolved.owner && resolved.repo) {
    const discovered = await discoverGithubSkillFiles(resolved.owner, resolved.repo);
    if (discovered.length === 1) {
      const sub = discovered[0];
      defaultName = deriveDefaultSkillName(resolved.repo, sub);
      const retry = await fetchGithubRawText([
        `https://raw.githubusercontent.com/${resolved.owner}/${resolved.repo}/main/${sub}`,
        `https://raw.githubusercontent.com/${resolved.owner}/${resolved.repo}/master/${sub}`
      ]);
      downloaded = retry.downloaded;
      resolvedUrl = retry.resolvedUrl;
      lastStatus = retry.lastStatus || lastStatus;
    } else if (discovered.length > 1) {
      const examples = discovered.slice(0, 5).map((p) => `${resolved.owner}/${resolved.repo}/${p}`).join('、');
      const err = new Error(`该仓库包含 ${discovered.length} 个 SKILL.md，请指定具体路径（例如：${examples}）`);
      err.discoveredSkills = discovered.slice(0, 20).map((p) => ({
        path: p,
        shorthand: `${resolved.owner}/${resolved.repo}/${p}`
      }));
      throw err;
    }
  }

  if (!downloaded) {
    throw new Error(`未能从 GitHub 读取 SKILL.md（状态：${lastStatus || '网络不可达'}），请确认仓库存在 SKILL.md 或直接粘贴具体文件链接`);
  }

  const parsed = parseSkillMarkdown(downloaded, { fallbackId: customName || defaultName, domain, builtin: false });
  let candidateId = slugId(customName || parsed.id || defaultName, 'github-skill');
  if (builtinSkillIds(domain).has(candidateId)) candidateId = `${candidateId}-custom`;

  const saved = saveSkill({
    id: candidateId,
    domain,
    name: customName ? String(customName).trim() : parsed.name,
    raw: downloaded,
    githubRepo: parsed.githubRepo || repoUrl,
    badge: 'GitHub 导入'
  }, domain);
  return { ...saved, resolvedUrl };
}

async function importSearchSkillFromUrl(urlInput, customName = '') {
  return importSkillFromGithub(urlInput, { domain: 'search', customName });
}

function importSkillFromFile(filePath, domainOrOpts = 'search', customNameArg = '') {
  let domain = 'search';
  let customName = customNameArg;
  if (domainOrOpts && typeof domainOrOpts === 'object') {
    domain = normalizeDomain(domainOrOpts.domain || 'search');
    customName = domainOrOpts.customName !== undefined ? domainOrOpts.customName : customNameArg;
  } else if (isDomainToken(domainOrOpts)) {
    domain = normalizeDomain(domainOrOpts);
  } else if (typeof domainOrOpts === 'string' && domainOrOpts) {
    customName = domainOrOpts;
  }

  const src = String(filePath || '').trim();
  if (!src || !fs.existsSync(src)) throw new Error('文件不存在：' + src);
  const raw = fs.readFileSync(src, 'utf8');
  if (!raw.trim()) throw new Error('SKILL.md 文件内容为空');
  const baseName = path.basename(src, path.extname(src));
  const parentName = path.basename(path.dirname(src));
  const fallback = baseName.toLowerCase() === 'skill' && parentName ? parentName : baseName;
  const parsed = parseSkillMarkdown(raw, { fallbackId: customName || fallback, domain, builtin: false });
  let candidateId = slugId(customName || (baseName.toLowerCase() === 'skill' ? (parsed.id || fallback) : baseName), 'local-skill');
  if (builtinSkillIds(domain).has(candidateId)) candidateId = `${candidateId}-custom`;
  return saveSkill({
    id: candidateId,
    domain,
    name: customName ? String(customName).trim() : parsed.name,
    raw,
    badge: '本地导入'
  }, domain);
}

function importSearchSkillFromFile(filePath, customName = '') {
  return importSkillFromFile(filePath, { domain: 'search', customName });
}

function deleteSkill(id, domain = 'search') {
  const dom = normalizeDomain(domain);
  const target = slugId(id, '');
  if (!target) throw new Error('缺少 Skill ID');
  if (builtinSkillIds(dom).has(target)) throw new Error('系统内置 Skill 不可删除');
  const file = path.join(userSkillsDir(dom), target + '.md');
  if (fs.existsSync(file)) {
    fs.unlinkSync(file);
    return true;
  }
  if (dom === 'paper') {
    const legacy = path.join(store.DATA_ROOT, 'skills', target + '.md');
    if (fs.existsSync(legacy)) {
      fs.unlinkSync(legacy);
      return true;
    }
  }
  throw new Error('未找到自定义 Skill：' + target);
}

function deleteSearchSkill(id) {
  return deleteSkill(id, 'search');
}

module.exports = {
  ALL_SOURCES,
  BUILTIN_ORDER,
  DOMAINS,
  normalizeDomain,
  listSkills,
  getSkill,
  saveSkill,
  deleteSkill,
  importSkillFromGithub,
  importSkillFromFile,
  listSearchSkills,
  getSearchSkill,
  parseSkillMarkdown,
  resolveGithubSkillUrls,
  discoverGithubSkillFiles,
  saveSearchSkill,
  importSearchSkillFromUrl,
  importSearchSkillFromFile,
  deleteSearchSkill
};
