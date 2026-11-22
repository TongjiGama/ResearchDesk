/**
 * ai.js — AI 能力：OpenAI 兼容接口调用
 * 提供：生成四段式论文笔记、生成浓缩摘要、学习用户笔记样本成 skill 配置。
 */
const fs = require('fs');
const path = require('path');
const store = require('./store');
const pdfExtract = require('./services/pdf-extract');
const PAPER_READING_METHOD = fs.readFileSync(path.join(__dirname, 'skills', 'paper-reading-method.md'), 'utf8').trim();
const MAX_SOURCE_CHARS = 12000;

function getApiConfig() {
  const cfg = store.getConfig();
  return cfg.api || {};
}

async function callLLM(messages, { temperature = 0.3, maxTokens = 1600, timeoutMs = 0 } = {}) {
  const api = getApiConfig();
  if (!api.apiKey) throw new Error('尚未配置 API 密钥，请在设置中填写。');
  const baseUrl = (api.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
  const model = api.model || 'gpt-4o-mini';
  const ctrl = timeoutMs > 0 ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  let resp;
  try {
    resp = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${api.apiKey}`
      },
      body: JSON.stringify({
        model,
        messages,
        temperature,
        max_tokens: maxTokens
      }),
      ...(ctrl ? { signal: ctrl.signal } : {})
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`API 请求失败 (${resp.status}): ${txt.slice(0, 300)}`);
  }
  const data = await resp.json();
  const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!content) throw new Error('API 未返回内容');
  return content;
}

function skillInstruction({ summaryOnly = false } = {}) {
  const cfg = store.getConfig();
  const name = String(cfg.activeSkill || 'default');
  const method = `## 每次必用：论文阅读方法 Skill\n${PAPER_READING_METHOD}`;
  let style;
  if (name === 'default') {
    style = summaryOnly
      ? '使用中文、专业克制、信息密度高；保留重要英文术语，并在证据充分时联系读者的 VLA 研究方向。'
      : `请按以下四段式结构输出（每段用 ## 二级标题）：
## 问题与动机
这篇论文解决什么问题、为什么重要。
## 方法与架构
核心方法、模型结构、关键技术。
## 实验与结论
数据集、指标、主要实验结果。
## 局限与启发
不足之处，以及对"基于隐式动力学表征的 VLA"课题的启发。`;
  } else {
    const content = store.getSkillContent(name);
    if (!content) throw new Error(`当前选定的笔记 skill「${name}」不存在，请到设置中重新选择。`);
    style = summaryOnly
      ? `使用以下 skill 的术语、语气、详略和研究关联原则；本次指定的短摘要结构优先，不展开长笔记章节。\n---\n${content}\n---`
      : `请严格按以下 skill 的结构、字段、语气与详略总结论文。\n---\n${content}\n---`;
  }
  return `${method}\n\n## 当前笔记风格：${name}\n${style}`;
}

function paperEvidenceContext(fm = {}, body = '', opts = {}) {
  const parts = [];
  const add = (label, value) => {
    const text = String(value || '').trim();
    if (!text) return;
    parts.push(`${label}：\n${text.slice(0, MAX_SOURCE_CHARS)}${text.length > MAX_SOURCE_CHARS ? '\n（内容已截断）' : ''}`);
  };
  add('论文摘要原文（主要证据）', fm.abstract || fm.abstractText || '');
  if (fm.summary) {
    const isExcerpt = fm.summarySource === 'excerpt' || (!fm.aiGenerated && fm.summarySource !== 'ai');
    add(isExcerpt ? '已有摘要节选（非全文）' : '已有 AI 摘要（仅供上下文，须由论文材料核实）', fm.summary);
  }
  add('已有笔记（仅供研究方向上下文，事实须以论文材料核实）', body);

  if (fm.pdfPath && opts.includePdf !== false) {
    const absText = String(fm.abstract || fm.abstractText || '').trim();
    const shouldExtractPdf = !absText || absText.length < 400 || (!fm.summary && !String(body || '').trim());
    if (shouldExtractPdf) {
      const absPdf = path.isAbsolute(fm.pdfPath)
        ? fm.pdfPath
        : (opts.ws && typeof store.absolutePath === 'function' ? store.absolutePath(opts.ws, fm.pdfPath) : '');
      if (absPdf) {
        try {
          const res = pdfExtract.extractPdfTextSync(absPdf, {
            maxPages: 6,
            maxChars: parts.length ? 6000 : 10000,
            disableCliFallback: Boolean(opts.disableCliFallback)
          });
          if (res && res.ok && res.text) {
            add('PDF 正文摘录（自动提取，供核实）', res.text);
          }
        } catch (_) { /* PDF 提取失败不阻塞笔记生成 */ }
      }
    }
  }

  if (!parts.length) {
    return '未提供摘要、论文正文或可核实笔记。仅凭元数据无法可靠总结；请明确说明资料不足，不得推断方法、实验数据或结论。';
  }
  return parts.join('\n\n');
}

async function generateNote(ws, id) {
  const item = store.getItem(ws, 'papers', id);
  if (!item) throw new Error('论文不存在：' + id);
  const fm = item.frontmatter || {};
  const title = fm.title || fm.shortName || id;
  const sys = `你是一位机器人学习（VLA / 隐式动力学）领域的研究助手。用户是本科生，正在做相关毕业设计。`;
  const source = paperEvidenceContext(fm, item.body || '', { ws });
  const notePrompt = `${skillInstruction()}

请总结论文：${title}
arXiv: ${fm.arxivId || '未知'}
作者：${Array.isArray(fm.authors) ? fm.authors.join(', ') : ''}
发表时间：${fm.published || fm.publicationDate || '未知'}

可用论文材料：
${source}

只输出笔记正文，不要多余解释。`;
  const note = await callLLM([{ role: 'system', content: sys }, { role: 'user', content: notePrompt }], { maxTokens: 2000 });

  const sumPrompt = `${skillInstruction({ summaryOnly: true })}

请用一段话（80-140字）概括论文 ${title} 的要点，必须依次突出这三件事，并用"亮点：…；解决的问题：…；方法：…"的格式组织：
1) 亮点/创新点
2) 解决的问题
3) 核心方法
只输出这一段摘要。若现有材料不足以支持某项内容，明确说明未提供，不要猜测。

可用论文材料：
${source}`;
  const summary = await callLLM([{ role: 'system', content: sys }, { role: 'user', content: sumPrompt }], { maxTokens: 400, temperature: 0.2 });

  const today = new Date().toISOString().slice(0, 10);
  const skill = String(store.getConfig().activeSkill || 'default');
  // D48 AI 内容溯源：显式标记 AI 生成 + 更新时间，界面据此提示"请核对原文"
  store.saveItem(ws, 'papers', id, {
    frontmatter: { ...fm, summary: summary.trim(), noteUpdatedAt: today, aiGenerated: true, skill, summaryMethod: 'paper-reading-method@1.0' },
    body: note.trim()
  });
  return { note: note.trim(), summary: summary.trim() };
}

async function generateSummaryOnly(ws, id) {
  const item = store.getItem(ws, 'papers', id);
  if (!item) throw new Error('论文不存在：' + id);
  const fm = item.frontmatter || {};
  const title = fm.title || fm.shortName || id;
  const sys = '你是一位机器人学习（VLA / 隐式动力学）领域的研究助手。';
  const source = paperEvidenceContext(fm, item.body || '', { ws });
  const prompt = `${skillInstruction({ summaryOnly: true })}

请用一段话（80-140字）概括论文 ${title} 的要点，依次突出：亮点/创新点、解决的问题、核心方法，用"亮点：…；解决的问题：…；方法：…"格式。只输出摘要。若材料不足以支持某项内容，明确说明未提供，不要猜测。

可用论文材料：
${source}`;
  const summary = await callLLM([{ role: 'system', content: sys }, { role: 'user', content: prompt }], { maxTokens: 400, temperature: 0.2 });
  const today = new Date().toISOString().slice(0, 10);
  const skill = String(store.getConfig().activeSkill || 'default');
  // D48 AI 内容溯源
  store.saveItem(ws, 'papers', id, {
    frontmatter: { ...fm, summary: summary.trim(), noteUpdatedAt: today, aiGenerated: true, skill, summaryMethod: 'paper-reading-method@1.0' },
    body: item.body
  });
  return summary.trim();
}

async function testConnection() {
  await callLLM([{ role: 'user', content: '请只回复：ok' }], { maxTokens: 10 });
  return true;
}

// 从用户笔记样本学习风格，提炼成可复用的 skill 规范（D44）
async function learnSkill(sampleText, skillName) {
  if (!sampleText || sampleText.trim().length < 50) throw new Error('样本太短，请粘贴一篇完整的笔记（至少50字）');
  const sys = '你是提示词工程师，擅长从范例中提炼可复用的写作规范。';
  const prompt = `下面是一篇用户自己写的论文阅读笔记样本。请提炼出它的「笔记风格规范」，用于让 AI 以后按完全相同的风格总结任何论文。

规范必须包含：
1. 结构：有哪些小节、小节标题、先后顺序
2. 每个小节写什么内容、详略程度
3. 语气与人称（客观陈述/第一人称点评等）
4. 格式习惯（段落/列表/加粗/公式记法）
5. 其它风格特征

要求：输出一份可直接作为系统提示词使用的 Markdown 规范文档（中文），不要复述样本的具体内容本身，只提炼规则。

--- 样本开始 ---
${sampleText.slice(0, 6000)}
--- 样本结束 ---`;
  const spec = await callLLM([{ role: 'system', content: sys }, { role: 'user', content: prompt }], { maxTokens: 1500, temperature: 0.2 });
  const name = store.saveSkillFromText(skillName || 'my-style', spec);
  return name;
}

// ---------- v3：检索策略与一句话提炼（均为 callLLM 薄封装） ----------

/**
 * D66：仅入库时调用。把论文摘要压缩成 ≤60 字的一句话，说明它解决什么问题。
 * 失败由调用方降级为摘要节选，不在本函数吞错（保持与 callLLM 语义一致）。
 */
async function oneLineSummary({ title = '', abstract = '', pdfPath = '', ws = '' } = {}) {
  const sys = '你是机器人学习与人工智能领域的论文摘要助手。输出必须精确、克制、不夸大。';
  const prompt = `${skillInstruction({ summaryOnly: true })}

请用不超过 60 个汉字的一句话，说明下面这篇论文解决了什么问题（可包含核心手段）。
只输出这一句话，不要标题、解释、引号或列表。

论文标题：${title}
可用论文摘要：
${paperEvidenceContext({ abstract: String(abstract || '').slice(0, 3000), pdfPath }, '', { ws })}`;
  const text = await callLLM([{ role: 'system', content: sys }, { role: 'user', content: prompt }],
    { temperature: 0.1, maxTokens: 300 });
  return String(text || '').trim().replace(/^["“”'\s]+|["“”'\s]+$/g, '').slice(0, 120);
}

/**
 * 把自然语言研究问题转成适合 OpenAlex 的英文检索式。
 * 失败降级为原 query（不阻塞检索）；返回纯文本关键词，由调用方决定是否采用。
 */
async function searchStrategy(query, localSeeds = []) {
  const q = String(query || '').trim();
  if (!q) return q;
  const seeds = (Array.isArray(localSeeds) ? localSeeds : []).slice(0, 8).filter(Boolean);
  const sys = '你是学术文献检索专家，擅长将自然语言研究问题转成精准、可复现的 OpenAlex 英文检索式。';
  const prompt = `用户的原始研究问题：
${q}

本地论文标题（仅供校准学科术语与常用表达，不要据此排除主题）：
${seeds.length ? seeds.map((s, i) => `${i + 1}. ${s}`).join('\n') : '（暂无）'}

提取问题中的核心任务、方法和研究对象；保留专有名词与缩写，将中文术语转换成论文中常见的英文表达。
请输出一条简短英文检索式，包含 2–6 个有区分度的术语；不要添加年份、期刊等级或未提出的限制。
只输出检索式，不要解释、引号或列表。`;
  try {
    const text = await callLLM([{ role: 'system', content: sys }, { role: 'user', content: prompt }],
      { temperature: 0.1, maxTokens: 120 });
    const out = String(text || '').trim().replace(/^["“”'\s]+|["“”'\s]+$/g, '').replace(/\s+/g, ' ');
    return out || q;
  } catch (_) {
    return q;
  }
}

function extractJsonBlock(text) {
  const raw = String(text == null ? '' : text)
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .trim();
  if (!raw) return null;
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fence ? fence[1].trim() : raw;
  try { return JSON.parse(candidate); } catch (_) { /* 尝试提取首尾括弧 */ }
  const objStart = candidate.indexOf('{');
  const objEnd = candidate.lastIndexOf('}');
  const arrStart = candidate.indexOf('[');
  const arrEnd = candidate.lastIndexOf(']');
  let slice = '';
  if (arrStart >= 0 && arrEnd > arrStart && (objStart < 0 || arrStart < objStart)) {
    slice = candidate.slice(arrStart, arrEnd + 1);
  } else if (objStart >= 0 && objEnd > objStart) {
    slice = candidate.slice(objStart, objEnd + 1);
  }
  if (!slice) return null;
  try { return JSON.parse(slice); } catch (_) { return null; }
}

function fallbackSearchPlan(query, maxQueries = 3) {
  const q = String(query || '').trim();
  const tokens = q.replace(/[()[\]{}"'，。；：、！？]/g, ' ').split(/\s+/).filter((t) => t.length >= 2);
  const booleanQuery = tokens.length >= 2
    ? tokens.slice(0, 6).map((t) => (/\s/.test(t) ? `"${t}"` : t)).join(' AND ')
    : q;
  return {
    usedAi: false,
    intent: q,
    framework: 'Direct',
    queries: [{ term: q, angle: '原始问题' }].slice(0, Math.max(1, maxQueries)),
    booleanQuery,
    arxivCategories: []
  };
}

/**
 * 结合内嵌/导入的论文检索 Skill 规范，将研究问题规划为多角度英文检索式 + 标准布尔检索式。
 * 模型未配置或调用失败时确定性降级为 fallbackSearchPlan，不阻塞检索。
 */
async function planSearchQueries({ query = '', localSeeds = [], skillContent = '', skillName = '', maxQueries = 3 } = {}) {
  const q = String(query || '').trim();
  if (!q) return fallbackSearchPlan('', maxQueries);
  const api = getApiConfig();
  if (!api.apiKey) return fallbackSearchPlan(q, maxQueries);

  const count = Math.max(1, Math.min(4, Number(maxQueries) || 3));
  const seeds = (Array.isArray(localSeeds) ? localSeeds : []).slice(0, 8).filter(Boolean);
  const skillGuide = String(skillContent || '').trim().slice(0, 3600);
  const sys = `你是资深学术检索与系统综述专家，擅长根据检索 Skill 规范把研究问题转化为精准、高召回的多角度英文检索策略。输出必须为严格 JSON，不要额外说明。`;
  const prompt = `${skillGuide ? `## 当前执行的论文检索 Skill（${skillName || 'custom'}）\n${skillGuide}\n\n` : ''}## 用户原始检索需求
${q}

## 当前工作区已有论文（仅作领域术语锚点，不得据此缩小或偏离用户本次问题）
${seeds.length ? seeds.map((s, i) => `${i + 1}. ${s}`).join('\n') : '（暂无）'}

请按上述 Skill 规范规划检索方案，严格输出一个 JSON 对象：
{
  "intent": "一句话准确概括用户的检索意图（中文，≤40字）",
  "framework": "Open-ended | PICO | Frontier | Snowball",
  "queries": [
    { "term": "2-7个英文关键词组成的检索式", "angle": "角度简标（≤10字，如核心主题/方法同义词/前沿架构）" }
  ],
  "booleanQuery": "适用于 Google Scholar / OpenAlex / Scopus 的标准布尔检索式（英文，含 AND/OR 与引号）",
  "arxivCategories": ["最多3个最相关的 arXiv 分类码，如 cs.RO / cs.CV / cs.LG / cs.AI / cs.CL；跨学科或不确定则输出空数组"]
}
要求：
1. queries 输出 1 至 ${count} 条真正互补的英文检索式，不得重复或空泛；保留核心专有名词与缩写。
2. 不得编造论文标题或作者，不要添加用户未要求的年份限制。
3. 只输出合法 JSON。`;

  try {
    const raw = await callLLM([
      { role: 'system', content: sys },
      { role: 'user', content: prompt }
    ], { temperature: 0.15, maxTokens: 520, timeoutMs: 15000 });
    const parsed = extractJsonBlock(raw);
    if (!parsed || typeof parsed !== 'object') return fallbackSearchPlan(q, count);
    const seen = new Set();
    const queries = (Array.isArray(parsed.queries) ? parsed.queries : [])
      .map((item) => {
        if (typeof item === 'string') return { term: item.trim(), angle: 'AI 扩展' };
        return {
          term: String((item && item.term) || '').replace(/^["“”'\s]+|["“”'\s]+$/g, '').replace(/\s+/g, ' ').trim(),
          angle: String((item && item.angle) || 'AI 扩展').trim().slice(0, 16)
        };
      })
      .filter((item) => {
        const key = item.term.toLowerCase();
        if (!item.term || seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, count);
    if (!queries.length) return fallbackSearchPlan(q, count);
    const arxivCategories = (Array.isArray(parsed.arxivCategories) ? parsed.arxivCategories : [])
      .map((c) => String(c || '').trim())
      .filter((c) => /^[a-z\-]+(?:\.[A-Za-z\-]+)?$/.test(c))
      .slice(0, 3);
    return {
      usedAi: true,
      intent: String(parsed.intent || q).trim().slice(0, 80),
      framework: String(parsed.framework || 'Open-ended').trim().slice(0, 24),
      queries,
      booleanQuery: String(parsed.booleanQuery || fallbackSearchPlan(q, count).booleanQuery).trim().slice(0, 500),
      arxivCategories
    };
  } catch (_) {
    return fallbackSearchPlan(q, count);
  }
}

/**
 * 借鉴 paper-search-pro STEP 6（RCS 0-10）：单次批量调用 LLM 评估候选论文与研究问题的相关性。
 * 失败或未配置模型返回空数组，不阻塞检索结果展示。
 */
async function screenPapersRelevance({ query = '', papers = [], localSeeds = [], skillContent = '' } = {}) {
  const q = String(query || '').trim();
  const list = Array.isArray(papers) ? papers.slice(0, 15) : [];
  const api = getApiConfig();
  if (!q || !list.length || !api.apiKey) return [];

  const seeds = (Array.isArray(localSeeds) ? localSeeds : []).slice(0, 6).filter(Boolean);
  const digest = list.map((p, idx) => {
    const abs = String(p.tldr || p.abstract || p.abstractExcerpt || '').replace(/\s+/g, ' ').slice(0, 320);
    return `[${idx}] 标题：${String(p.title || '').slice(0, 180)} | 载体：${p.venue || '未知'}(${p.venueStatus || (p.isPreprint ? 'Preprint' : 'Published')}) | 日期：${p.publicationDate || p.published || '未知'} | 引用：${Number(p.citedByCount) || 0} | 代码：${p.codeUrl ? '有' : '无'} | 摘要：${abs || '无'}`;
  }).join('\n');

  const skillHint = String(skillContent || '').trim().slice(0, 1200);
  const sys = '你是严谨的学术文献初筛评审专家。严格依据给定的标题、载体与摘要评估论文与研究问题的相关性，不得臆造未提供的实验数据。只输出严格 JSON 数组。';
  const prompt = `${skillHint ? `参考筛选规范：\n${skillHint}\n\n` : ''}研究问题：${q}
${seeds.length ? `工作区上下文论文：${seeds.join('；')}\n` : ''}
请为下面 ${list.length} 篇候选论文给出 RCS 相关性打分（0–10 整数：8–10 核心前沿必读，6–7 高度相关，4–5 一般相关，0–3 偏题）与一句话匹配理由（中文，≤36字，说明为何契合或创新点，无证据不臆造）。

候选论文：
${digest}

只输出严格 JSON 数组，格式：[{"idx":0,"rcs":9,"why":"..."}]`;

  try {
    const raw = await callLLM([
      { role: 'system', content: sys },
      { role: 'user', content: prompt }
    ], { temperature: 0.1, maxTokens: 900, timeoutMs: 22000 });
    const parsed = extractJsonBlock(raw);
    const arr = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.results) ? parsed.results : []);
    return arr
      .map((item) => {
        const rawScore = item && (item.rcs !== undefined && item.rcs !== null && item.rcs !== ''
          ? item.rcs
          : (item.score !== undefined && item.score !== null && item.score !== '' ? item.score : NaN));
        const scoreNum = Number(rawScore);
        return {
          idx: item && item.idx !== undefined && item.idx !== null && item.idx !== '' ? Number(item.idx) : NaN,
          rcs: Number.isFinite(scoreNum) ? Math.max(0, Math.min(10, Math.round(scoreNum))) : NaN,
          why: String((item && (item.why || item.reason)) || '').replace(/\s+/g, ' ').trim().slice(0, 80)
        };
      })
      .filter((item) => Number.isInteger(item.idx) && item.idx >= 0 && item.idx < list.length && Number.isFinite(item.rcs));
  } catch (_) {
    return [];
  }
}

// ---------- M1 领域服务薄委托（懒加载避免循环依赖） ----------
async function synthesizeLineage(payload) {
  return require('./services/lineage-service').synthesizeLineage(payload);
}
async function generateIdeasFromLineage(payload) {
  return require('./services/idea-service').generateIdeasFromLineage(payload);
}
async function reviewIdea(payload) {
  return require('./services/idea-service').reviewIdea(payload);
}
async function checkIdeaNovelty(payload) {
  return require('./services/idea-service').checkIdeaNovelty(payload);
}
async function tournamentIdeas(payload) {
  return require('./services/idea-service').tournamentIdeas(payload);
}
async function evolveIdeas(payload) {
  return require('./services/idea-service').evolveIdeas(payload);
}
async function refineIdeaFromExperiment(payload) {
  return require('./services/idea-service').refineIdeaFromExperiment(payload);
}
async function designExperiment(payload) {
  return require('./services/experiment-service').designExperiment(payload);
}
async function analyzeExperimentResults(payload) {
  return require('./services/experiment-service').analyzeExperimentResults(payload);
}

module.exports = {
  generateNote, generateSummaryOnly, testConnection, callLLM, learnSkill,
  oneLineSummary, searchStrategy, planSearchQueries, screenPapersRelevance, fallbackSearchPlan,
  extractJsonBlock, paperEvidenceContext,
  synthesizeLineage, generateIdeasFromLineage, reviewIdea, checkIdeaNovelty,
  tournamentIdeas, evolveIdeas, refineIdeaFromExperiment,
  designExperiment, analyzeExperimentResults
};
