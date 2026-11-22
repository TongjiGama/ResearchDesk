/**
 * rating.js — 可信度评级服务
 * 系统提示词来自 data/skills/paper-rating.md（可迭代、可替换），低温度 JSON 输出；
 * LLM 不可用 / 解析失败时走确定性规则兜底，保证列表评级永不空白。
 * 依赖方向：rating → {store, ai}，无反向依赖。
 */
const store = require('./store');
const ai = require('./ai');

const DEFAULT_SKILL = 'paper-rating';

/** skill 文件缺失时的内置规则，保证服务不因 skill 缺失而崩。 */
const FALLBACK_SKILL = `version: v1.1
# 论文可信度评级（内置兜底规则）
五维度：venue 级别 40%、引用量 20%、同行评审 20%、机构 5%、时效 15%。
OpenAlex primary_location 常为 arXiv 镜像，不等于正式载体；顶会/顶刊正式成果按正式载体评级。
输出严格 JSON：{"grade":"S|A|B|C","reason":"≤60字","dimensions":{"venue":"...","citation":"...","peerReview":"...","institution":"...","recency":"..."}}
预印本最高 B（高引用开源基座也不抬升）；workshop 最高 B、引用<100 为 C；评级仅辅助判断、非学术定论。`;

/** 从 skill 文本解析版本号，用于 ratingSource 可追溯。 */
function skillVersion(text, fallback = 'v1.0') {
  const m = String(text || '').match(/version\s*[:：]\s*(v?\d+(?:\.\d+)*)/i);
  return m ? (m[1].toLowerCase().startsWith('v') ? m[1] : 'v' + m[1]) : fallback;
}

function loadSkill(name = DEFAULT_SKILL) {
  try {
    return store.getSkillContent(name) || FALLBACK_SKILL;
  } catch (_) {
    return FALLBACK_SKILL;
  }
}

/** 组装给 LLM 的用户消息：只放结构化事实，不把摘要节选当作完整摘要。 */
function buildPrompt(paper) {
  const p = paper || {};
  const authors = Array.isArray(p.authors) ? p.authors.slice(0, 8).join(', ') : String(p.authors || '');
  return `请按系统提示词的五维度规则，为下面这篇论文评级。只输出严格 JSON，不要 Markdown 围栏。

标题：${String(p.title || '').slice(0, 400)}
摘要 / 摘要节选：${String(p.abstract || p.abstractExcerpt || '（摘要不全）').slice(0, 2200)}
发表载体：${String(p.venue || '未知')}（类型：${String(p.venueType || '未知')}）
是否预印本：${p.isPreprint ? '是' : '否'}
引用量：${Number(p.citedByCount) || 0} 次（OpenAlex 口径）
发表时间：${String(p.publicationDate || p.published || '未知')}
作者：${authors || '未知'}
作者机构：${String(p.authorInstitutions || '未知')}`;
}

/** 解析 LLM 文本：去围栏 → JSON.parse → 校验等级与理由。失败返回 null。 */
function parseRating(text) {
  const raw = String(text == null ? '' : text).trim();
  let jsonText = raw;
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) jsonText = fence[1].trim();
  else {
    const a = raw.indexOf('{');
    const b = raw.lastIndexOf('}');
    if (a >= 0 && b > a) jsonText = raw.slice(a, b + 1);
  }
  let obj = null;
  try { obj = JSON.parse(jsonText); } catch (_) { return null; }
  if (!obj || !['S', 'A', 'B', 'C'].includes(String(obj.grade || '').toUpperCase())) return null;
  const reason = String(obj.reason || '').trim();
  if (!reason) return null;
  const dims = obj.dimensions && typeof obj.dimensions === 'object' ? obj.dimensions : {};
  return {
    grade: String(obj.grade).toUpperCase(),
    reason: reason.slice(0, 120),
    dimensions: {
      venue: String(dims.venue || '—'),
      citation: String(dims.citation || '—'),
      peerReview: String(dims.peerReview || '—'),
      institution: String(dims.institution || '—'),
      recency: String(dims.recency || '—')
    }
  };
}

/** venue 分类：顶会 / 顶刊 / 会议 / workshop / 预印本 / 未知。 */
function venueClass(paper) {
  const p = paper || {};
  const venue = String(p.venue || '');
  if (p.isPreprint || /arxiv|biorxiv|medrxiv|preprint/i.test(venue) || /repository/i.test(String(p.venueType || ''))) return 'preprint';
  if (/workshop|symposium@|demo track/i.test(venue)) return 'workshop';
  if (/neurips|iclr|icml|cvpr|iccv|eccv|acl\b|naacl|corl\b|siggraph/i.test(venue)) return 'topConf';
  if (/nature|science\b|tpami|pami|ijrr|jmlr|t-?ro\b|ieee transactions|journal of/i.test(venue)) return 'topJournal';
  if (/icra|iros|rss\b|aaai|ijcai|emnlp|eacl|icra|icml workshop|conference|proc\./i.test(venue)) return 'conf';
  if (String(p.venueType || '') === 'journal') return 'topJournal';
  if (String(p.venueType || '') === 'conference') return 'conf';
  return 'unknown';
}

/**
 * 确定性兜底评级（v1.1 校准规则）：
 * 顶会 SOTA / 顶刊 = S；常规会议 = A；workshop = B；纯预印本上限 A。
 * 引用量只在同档内微调，不跨越预印本/workshop 上限；近 3 年新论文不因引用积累期扣分。
 */
function heuristicRate(paper) {
  const p = paper || {};
  const cls = venueClass(p);
  const cites = Number(p.citedByCount) || 0;
  const date = String(p.publicationDate || p.published || '');
  const year = Number(date.slice(0, 4)) || 0;
  const age = year ? new Date().getUTCFullYear() - year : 99;
  let grade = 'B';
  if (cls === 'topConf' || cls === 'topJournal') grade = 'S';
  else if (cls === 'conf') grade = 'A';
  else if (cls === 'workshop') grade = cites >= 100 ? 'B' : 'C';
  else if (cls === 'preprint') grade = cites >= 1000 ? 'B' : 'C';
  else grade = cites >= 3000 ? 'A' : 'B';

  // v1.1 封顶：顶会/顶刊引用 <200 降 A；预印本与 workshop 不因引用抬到 A/S
  if ((cls === 'topConf' || cls === 'topJournal') && cites < 200) grade = 'A';

  const label = { topConf: '顶会', topJournal: '顶刊', conf: '会议', workshop: 'workshop', preprint: '预印本', unknown: '载体不明' }[cls];
  const reason = `${label}${p.isPreprint ? '（预印本）' : ''}，引用 ${cites} 次，综合评 ${grade}（辅助判断）`;
  return {
    grade,
    reason: reason.slice(0, 120),
    dimensions: {
      venue: label,
      citation: cites >= 1000 ? `${cites}（领域高位）` : cites >= 200 ? `${cites}（中位）` : `${cites}（积累期或低位）`,
      peerReview: cls === 'preprint' || cls === 'workshop' ? '弱/无正式评审' : '同行评审',
      institution: '未核验，不作为主导维度',
      recency: age <= 1 ? '近 1 年 · 引用尚在积累' : age <= 3 ? `${age} 年 · 正常积累期` : '较早发表'
    },
    source: 'heuristic:fallback'
  };
}

/**
 * 为单篇论文评级。
 * @param {object} paper NormalizedPaper 子集
 * @param {{skillName?:string, forceHeuristic?:boolean}} opts
 * @returns {Promise<{grade:string,reason:string,dimensions:object,source:string}>}
 */
async function rate(paper, opts = {}) {
  const skillName = String(opts.skillName || DEFAULT_SKILL);
  if (opts.forceHeuristic) return heuristicRate(paper);
  let skillText = FALLBACK_SKILL;
  try { skillText = loadSkill(skillName); } catch (_) { skillText = FALLBACK_SKILL; }
  const source = skillName + '@' + skillVersion(skillText);
  try {
    const raw = await ai.callLLM([
      { role: 'system', content: `${skillText}\n\n重要：评级仅辅助判断、非学术定论。输出必须严格为一行 JSON。` },
      { role: 'user', content: buildPrompt(paper) }
    ], { temperature: 0.1, maxTokens: 300 });
    const parsed = parseRating(raw);
    if (!parsed) return heuristicRate(paper);
    return { ...parsed, source };
  } catch (_) {
    return heuristicRate(paper);
  }
}

/** 批量串行评级（校准专用），逐篇独立兜底，返回带 key 的结果数组。 */
async function rateBatch(papers, opts = {}) {
  const list = Array.isArray(papers) ? papers : [];
  const out = [];
  for (const paper of list) {
    const key = (paper && (paper.openalexId || paper.title)) || String(paper);
    try {
      const r = await rate(paper, opts);
      out.push({ key, ...r });
    } catch (e) {
      out.push({ key, ...heuristicRate(paper), error: (e && e.message) || String(e) });
    }
  }
  return out;
}

module.exports = {
  rate, rateBatch,
  // 纯函数导出，供校准与离线单测复用
  parseRating, heuristicRate, loadSkill, skillVersion, FALLBACK_SKILL
};
