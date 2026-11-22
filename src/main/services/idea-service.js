/**
 * src/main/services/idea-service.js — 科研 Idea 孵化、对抗评审、新颖性查重与 Elo 进化服务（M3）
 * 融合以下 GitHub 开源研究方法（均支持在线 LLM + 高区分度离线确定性引擎）：
 *   - DAMO-NLP-SG/CoI-Agent & JinheonBaek/ResearchAgent: 文献链 CoI 孵化与结构化假设模式
 *   - K-Dense-AI/scientific-agent-skills (hypothesis-generation & scientific-brainstorming): 可证伪假设、前提假设、竞争性解释与五维对抗评审
 *   - SakanaAI/AI-Scientist & EagleW/SCIMON: 跨本地+多源实时新颖性查重与高重合自动转向建议
 *   - llnl/open-ai-co-scientist & guy915/Open-Co-Scientist: 成对辩论 Elo 锦标赛排名与头部杂交进化
 *   - ChicagoHAI/hypothesis-generation (HypoRefine): 实验结论/失败结果结构化回流修正假设与论断极性判定
 */
'use strict';

const store = require('../store');
const ai = require('../ai');
const openalex = require('../openalex');
const skills = require('../search/skills');

function clampScore(v, fallback = 5) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(10, Math.round(n)));
}

function asStringList(val, fallback = []) {
  if (Array.isArray(val)) {
    const cleaned = val.map((x) => String(x == null ? '' : x).trim()).filter(Boolean);
    return cleaned.length ? cleaned : fallback.slice();
  }
  if (typeof val === 'string' && val.trim()) {
    return val.split(/\r?\n|；|;/).map((s) => s.replace(/^[-*\d.)\s]+/, '').trim()).filter(Boolean);
  }
  return fallback.slice();
}

function tokenizeConcept(text) {
  const raw = String(text || '').toLowerCase();
  const stop = new Set([
    'the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'using', 'based', 'via',
    'towards', 'toward', 'learning', 'model', 'models', 'method', 'methods', 'approach',
    'study', 'analysis', 'framework', 'system', 'paper', 'research', 'based', 'improved'
  ]);
  const tokens = new Set();
  const eng = raw.match(/[a-z0-9][a-z0-9-]{1,}/g) || [];
  eng.forEach((t) => { if (!stop.has(t) && t.length >= 2) tokens.add(t); });
  const cjk = raw.match(/[\u4e00-\u9fa5]{2,}/g) || [];
  cjk.forEach((seg) => {
    for (let i = 0; i <= seg.length - 2; i++) tokens.add(seg.slice(i, i + 2));
  });
  return tokens;
}

function jaccardOverlap(setA, setB) {
  if (!setA.size || !setB.size) return 0;
  let inter = 0;
  for (const t of setA) if (setB.has(t)) inter++;
  const union = setA.size + setB.size - inter;
  return union > 0 ? inter / union : 0;
}

function containmentOverlap(setA, setB) {
  if (!setA.size || !setB.size) return 0;
  let inter = 0;
  for (const t of setA) if (setB.has(t)) inter++;
  const denom = Math.min(setA.size, setB.size);
  return denom > 0 ? inter / denom : 0;
}

function normalizeIdeaObject(raw, fallbackGrounded = []) {
  const obj = raw && typeof raw === 'object' ? raw : {};
  const grounded = asStringList(obj.groundedPapers, fallbackGrounded).slice(0, 8);
  return {
    title: String(obj.title || '未命名候选研究假设').trim().slice(0, 120),
    problem: String(obj.problem || '').trim(),
    gap: String(obj.gap || '').trim(),
    hypothesis: String(obj.hypothesis || '').trim(),
    methodology: String(obj.methodology || '').trim(),
    assumptions: asStringList(obj.assumptions, ['关键表征改动可在现有训练预算下稳定收敛']),
    rivalExplanations: asStringList(obj.rivalExplanations, ['需排除参数量增加、超参调优或随机种子波动带来的假性增益']),
    validationPlan: String(obj.validationPlan || '在相同基准与至少 3 个随机种子下对比基线与单变量消融变体，报告 95% 置信区间。').trim(),
    groundedPapers: grounded
  };
}

/**
 * 1. Chain-of-Ideas（CoI-Agent + ResearchAgent）：从文献脉络与研究缺口孵化结构化候选 Idea。
 */
async function generateIdeasFromLineage({ ws = '', papers = [], gaps = [], topic = '', count = 3, skillId = 'chain-of-ideas' } = {}) {
  let paperList = Array.isArray(papers) ? papers.slice() : [];
  if (!paperList.length && ws) {
    try {
      paperList = store.listItems(ws, 'papers').slice(0, 12);
    } catch (_) { paperList = []; }
  }
  const n = Math.max(1, Math.min(5, Number(count) || 3));
  const groundedAll = paperList
    .map((p) => String((p && (p.id || p.shortName || p.title)) || '').trim())
    .filter(Boolean);
  const gapItems = (Array.isArray(gaps) ? gaps : [])
    .map((g) => (typeof g === 'string'
      ? { title: g.slice(0, 48), gap: g, evidencePaperIds: groundedAll.slice(0, 3), suggestedDirection: '' }
      : {
          title: String((g && g.title) || '').trim(),
          gap: String((g && (g.gap || g.description || g.title)) || '').trim(),
          evidencePaperIds: Array.isArray(g && g.evidencePaperIds) && g.evidencePaperIds.length ? g.evidencePaperIds : groundedAll.slice(0, 3),
          suggestedDirection: String((g && g.suggestedDirection) || '').trim()
        }))
    .filter((g) => g.gap);

  const skill = skills.getSkill(skillId || 'chain-of-ideas', 'idea')
    || skills.listSkills('idea', { includeContent: true })[0]
    || { id: skillId || 'chain-of-ideas', name: 'Chain-of-Ideas', content: '' };

  const angles = [
    {
      label: '表征机制改进',
      hypo: '通过显式解耦任务无关扰动与隐式动力学状态表征，在分布外与长视野子任务上相对强基线提升成功率 >= 5%，且消融解耦约束后增益消失。',
      method: '在既有主干网络中间层引入轻量隐式动力学预测头与对比一致约束，保持参数增量 < 5%，与原基线同预算对照训练。',
      assumption: '隐式未来状态预测能够提供比像素重建更高信噪比的动作控制梯度。',
      rival: '性能提升可能源于辅助任务带来的隐式正则化，而非动力学建模本身；需增加随机辅助头对照验证。'
    },
    {
      label: '训练目标与对齐优化',
      hypo: '将动作生成目标从单步行为克隆升级为多步动力学一致性加权目标，可在不增加推理延迟的前提下显著降低长视野误差累积。',
      method: '基于高误差轨迹片段构造自适应时间步权重，与标准 BC/Flow-Matching 损失联合优化，推理阶段零额外计算开销。',
      assumption: '长视野任务失败主要集中在关键接触与状态切换帧，而非均匀分布于整条轨迹。',
      rival: '增益可能来自困难样本过采样而非动力学一致性损失；需与均匀难例挖掘基线做受控对比。'
    },
    {
      label: '推理自适应与失败检测',
      hypo: '在测试阶段利用隐式动力学预测残差作为不确定性信号动态触发重规划，可显著提升扰动环境下的任务恢复率。',
      method: '复用训练好的前向隐式状态预测器在线计算一步预测误差，超过阈值时切换精细高频动作块或回退安全策略。',
      assumption: '策略执行偏离预期流形之前，隐式特征空间已出现可检测的预测残差尖峰。',
      rival: '重规划带来的提升可能仅源于更高控制频率；需与固定周期重规划基线在同等推理步数下对比。'
    }
  ];

  const buildOffline = () => {
    const ideas = [];
    for (let i = 0; i < n; i++) {
      const g = gapItems[i] || gapItems[0] || {
        title: `${topic || '核心方向'}瓶颈 ${i + 1}`,
        gap: '现有文献在机制可解释性、跨场景泛化与算力效率之间尚未取得可验证的平衡。',
        evidencePaperIds: groundedAll.slice(0, 4),
        suggestedDirection: ''
      };
      const angle = angles[i % angles.length];
      const refs = (g.evidencePaperIds && g.evidencePaperIds.length ? g.evidencePaperIds : groundedAll.slice(0, 4)).slice(0, 5);
      ideas.push(normalizeIdeaObject({
        title: `${topic ? `${topic}：` : ''}${g.title ? g.title.slice(0, 36) + ' — ' : ''}${angle.label}`,
        problem: g.gap,
        gap: g.suggestedDirection ? `${g.gap}（潜在切入点：${g.suggestedDirection}）` : g.gap,
        hypothesis: angle.hypo,
        methodology: angle.method,
        assumptions: [angle.assumption, '基线复现与改进版严格共享同一数据划分与评估协议'],
        rivalExplanations: [angle.rival, '需至少 3 个随机种子验证以排除单次训练方差'],
        validationPlan: '1) 复现锚点基线；2) 执行单变量完整版与去核心模块消融；3) 报告 3–5 种子均值、95% 置信区间及 Welch t 检验 p 值。',
        groundedPapers: refs
      }, refs));
    }
    return { ok: true, skillId: skill.id, ideas, fallbackUsed: true };
  };

  const cfg = store.getConfig() || {};
  if (!(cfg.api && cfg.api.apiKey)) return buildOffline();

  const paperDigest = paperList.slice(0, 12).map((p, idx) => {
    const id = String((p && (p.id || p.shortName)) || `P${idx + 1}`);
    const year = String((p && (p.publicationDate || p.published || p.year)) || '').slice(0, 4);
    const abs = String((p && (p.summary || p.abstract || p.tldr)) || '').replace(/\s+/g, ' ').slice(0, 220);
    return `[${id}] ${String((p && p.title) || id).slice(0, 120)} (${year || '?'}) | ${abs || '无摘要'}`;
  }).join('\n');
  const gapDigest = gapItems.map((g, idx) => `${idx + 1}. ${g.title ? g.title + '：' : ''}${g.gap} (支撑: ${g.evidencePaperIds.join(', ')})`).join('\n');

  const sys = '你是顶级人工智能与机器人学科研导师（精通 CoI-Agent 与 ResearchAgent 范式）。生成结构化、可证伪、差异化的高质量研究 Idea。只输出合法 JSON。';
  const prompt = `${skill.content ? `## 遵循 Idea 孵化 Skill（${skill.name}）\n${String(skill.content).slice(0, 2400)}\n\n` : ''}## 研究课题
${topic || '结合以下文献推导前沿方向'}

## 文献演进链输入
${paperDigest || '（暂无本地论文，仅依据课题与缺口）'}

## 已知研究缺口
${gapDigest || '（请从上述文献演进链中自行提炼瓶颈）'}

请生成 ${n} 个路线显著不同、具体可落地的候选科研 Idea，严格输出 JSON：
{
  "ideas": [
    {
      "title": "精准的中文研究标题（可含英文术语）",
      "problem": "聚焦的具体痛点",
      "gap": "现有文献为何未解决（明确提及相关文献局限）",
      "hypothesis": "明确的可证伪因果假设（含预期效应与消融退化条件）",
      "methodology": "具体可执行的方法机制与单一变量设计",
      "assumptions": ["前提假设1", "前提假设2"],
      "rivalExplanations": ["竞争性解释1（如参数量/超参混杂）", "竞争性解释2"],
      "validationPlan": "基准数据集、核心指标、消融组与统计验证协议",
      "groundedPapers": ["必须使用输入中的论文 ID"]
    }
  ]
}`;

  try {
    const raw = await ai.callLLM(
      [{ role: 'system', content: sys }, { role: 'user', content: prompt }],
      { temperature: 0.45, maxTokens: 2200, timeoutMs: 30000 }
    );
    const parsed = ai.extractJsonBlock(raw);
    const arr = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.ideas) ? parsed.ideas : []);
    if (!arr.length) return buildOffline();
    const validSet = new Set(groundedAll);
    const ideas = arr.slice(0, n).map((item) => {
      const norm = normalizeIdeaObject(item, groundedAll.slice(0, 3));
      if (validSet.size) {
        const filtered = norm.groundedPapers.filter((id) => validSet.has(id));
        norm.groundedPapers = filtered.length ? filtered : groundedAll.slice(0, 3);
      }
      return norm;
    });
    return { ok: true, skillId: skill.id, ideas, fallbackUsed: false };
  } catch (_) {
    return buildOffline();
  }
}

/**
 * 2. 对抗性五维评审（ResearchAgent ReviewingAgent + K-Dense hypothesis-generation）。
 * 离线回退基于真实结构完整度与可证伪特征动态打分，而非写死常量。
 */
function offlineReviewIdea(idea, papers, skillId) {
  const obj = idea && typeof idea === 'object' ? idea : {};
  const title = String(obj.title || '未命名 Idea').trim();
  const problem = String(obj.problem || '').trim();
  const gap = String(obj.gap || '').trim();
  const hypothesis = String(obj.hypothesis || '').trim();
  const methodology = String(obj.methodology || obj.body || '').trim();
  const validationPlan = String(obj.validationPlan || '').trim();
  const assumptions = asStringList(obj.assumptions, []);
  const rivals = asStringList(obj.rivalExplanations, []);
  const grounded = Array.from(new Set(
    asStringList(obj.groundedPapers, [])
      .concat(asStringList(obj.refs, []))
      .concat((Array.isArray(papers) ? papers : []).map((p) => String((p && p.id) || '')).filter(Boolean))
  ));

  const hasQuant = /\d+%|\b\d+\s*(?:seed|种子|ms|hz|fps)\b|显著|消融|对比|优于|低于|p\s*</i.test(hypothesis + ' ' + validationPlan);
  const hasMechanism = methodology.length >= 35;
  const hasCausal = /若|如果|通过|导致|提升|降低|退化|if|when|by|improves|reduces/i.test(hypothesis);

  const novelty = clampScore(4 + (gap.length >= 20 ? 2 : 0) + (hasMechanism ? 1 : 0) + (rivals.length >= 1 ? 1 : 0));
  const feasibility = clampScore(5 + (hasMechanism ? 2 : 0) + (validationPlan.length >= 25 ? 2 : 0) - (methodology.length > 500 ? 1 : 0));
  const clarity = clampScore(3 + (problem.length >= 15 ? 2 : 0) + (hypothesis.length >= 20 ? 2 : 0) + (hasCausal ? 1 : 0) + (hasQuant ? 1 : 0));
  const significance = clampScore(4 + (problem.length >= 20 ? 2 : 0) + (gap.length >= 20 ? 2 : 0));
  const groundedness = clampScore(3 + Math.min(4, grounded.length * 2) + (gap.length >= 15 ? 1 : 0));

  const strengths = [];
  const weaknesses = [];
  if (problem) strengths.push(`研究问题聚焦清晰（${problem.slice(0, 42)}${problem.length > 42 ? '...' : ''}）`);
  else weaknesses.push('缺少明确的问题定义（problem），容易导致后续实验目标发散');
  if (hypothesis && hasCausal) strengths.push('具备可证伪的因果假设陈述，便于设计正反对照实验');
  else weaknesses.push('缺少可证伪的量化因果假设（hypothesis），建议补充「若引入 X 则指标 Y 提升、消融 X 后退化」');
  if (grounded.length > 0) strengths.push(`已锚定 ${grounded.length} 篇支撑文献，具备文献脉络依据`);
  else weaknesses.push('尚未绑定支撑论文（groundedPapers），存在脱离前沿基线重复造轮子风险');
  if (!validationPlan) weaknesses.push('缺少可执行的验证计划（validationPlan），需补齐基准、指标与多种子协议');
  if (!assumptions.length) weaknesses.push('未显式声明核心前提假设（assumptions），失败时难以定位是前提失效还是实现问题');
  if (!rivals.length) weaknesses.push('未预设竞争性解释（rivalExplanations），审稿人易质疑增益来自参数量或超参微调');

  const rivalExplanations = rivals.length ? rivals.slice() : [
    '性能提升可能源于模型容量/训练步数增加，而非核心假设机制本身（需等算力对照）',
    '单随机种子或特定任务过拟合导致的伪显著提升（需 >=3 种子与分布外验证）'
  ];

  const revisedIdea = normalizeIdeaObject({
    ...obj,
    title,
    problem: problem || `围绕「${title}」界定具体输入输出与失效场景`,
    gap: gap || '需对照最近 1-2 年强基线，明确现有方法在该场景下的具体失败模式',
    hypothesis: hypothesis || `在同等算力与数据预算下，针对「${title}」引入单一核心机制改动可稳定提升主指标，且移除该机制后增益显著回落。`,
    methodology: methodology || '构建与基线严格对齐的最小可行改动，拆分为 2-3 个可独立开关的子模块用于消融。',
    assumptions: assumptions.length ? assumptions : ['核心机制改动不会引入破坏收敛的优化不稳定'],
    rivalExplanations,
    validationPlan: validationPlan || '固定数据集划分与至少 3 个随机种子，报告均值、标准差、95% 置信区间及 Welch t-test p 值。',
    groundedPapers: grounded.slice(0, 6)
  }, grounded.slice(0, 6));

  return {
    ok: true,
    skillId: String(skillId || 'hypothesis-critique'),
    scores: { novelty, feasibility, clarity, significance, groundedness },
    overallScore: Number(((novelty + feasibility + clarity + significance + groundedness) / 5).toFixed(2)),
    strengths: strengths.length ? strengths : [`课题「${title}」已进入结构化孵化阶段`],
    weaknesses,
    rivalExplanations,
    falsificationTests: [
      '移除核心机制但保留同等参数量与训练步数的对照实验（验证增益确由机制带来）',
      '在分布外/扰动子集上检验核心假设前提是否成立'
    ],
    revisedIdea,
    fallbackUsed: true
  };
}

async function reviewIdea({ idea = {}, papers = [], skillId = 'hypothesis-critique' } = {}) {
  const skill = skills.getSkill(skillId || 'hypothesis-critique', 'idea')
    || skills.listSkills('idea', { includeContent: true })[0]
    || { id: skillId || 'hypothesis-critique', name: 'Hypothesis Critique', content: '' };
  const fallback = offlineReviewIdea(idea, papers, skill.id);
  const cfg = store.getConfig() || {};
  if (!(cfg.api && cfg.api.apiKey)) return fallback;

  const paperCtx = (Array.isArray(papers) ? papers : []).slice(0, 8).map((p) => {
    const id = String((p && (p.id || p.shortName)) || '');
    return `[${id}] ${String((p && p.title) || id).slice(0, 120)} (${String((p && (p.publicationDate || p.published)) || '').slice(0, 4)})`;
  }).join('\n');

  const sys = '你是 ICML/NeurIPS/RSS 资深领域主席（AC），执行严谨、尖锐、可操作的科研 Idea 对抗评审。只输出合法 JSON。';
  const prompt = `${skill.content ? `## 评审 Skill 规范（${skill.name}）\n${String(skill.content).slice(0, 2200)}\n\n` : ''}## 待评审 Idea
${JSON.stringify(normalizeIdeaObject(idea), null, 2)}

## 工作区参考论文上下文
${paperCtx || '（暂无）'}

请严格输出以下 JSON：
{
  "scores": {"novelty": 7, "feasibility": 8, "clarity": 7, "significance": 7, "groundedness": 6},
  "strengths": ["优势1", "优势2"],
  "weaknesses": ["尖锐且可修复的弱点1", "弱点2"],
  "rivalExplanations": ["竞争性解释1", "竞争性解释2"],
  "falsificationTests": ["能够证伪该假设的关键对照实验1", "对照实验2"],
  "revisedIdea": {
    "title": "优化后的标题",
    "problem": "收紧后的问题定义",
    "gap": "更精准的文献缺口",
    "hypothesis": "更可证伪的假设陈述",
    "methodology": "更清晰的单变量方法设计",
    "assumptions": ["前提1"],
    "rivalExplanations": ["竞争解释1"],
    "validationPlan": "修订后的验证计划",
    "groundedPapers": []
  }
}`;

  try {
    const raw = await ai.callLLM(
      [{ role: 'system', content: sys }, { role: 'user', content: prompt }],
      { temperature: 0.25, maxTokens: 1600, timeoutMs: 26000 }
    );
    const parsed = ai.extractJsonBlock(raw);
    if (!parsed || typeof parsed !== 'object' || !parsed.scores) return fallback;
    const scores = {
      novelty: clampScore(parsed.scores.novelty, fallback.scores.novelty),
      feasibility: clampScore(parsed.scores.feasibility, fallback.scores.feasibility),
      clarity: clampScore(parsed.scores.clarity, fallback.scores.clarity),
      significance: clampScore(parsed.scores.significance, fallback.scores.significance),
      groundedness: clampScore(parsed.scores.groundedness, fallback.scores.groundedness)
    };
    return {
      ok: true,
      skillId: skill.id,
      scores,
      overallScore: Number(((scores.novelty + scores.feasibility + scores.clarity + scores.significance + scores.groundedness) / 5).toFixed(2)),
      strengths: asStringList(parsed.strengths, fallback.strengths),
      weaknesses: asStringList(parsed.weaknesses, fallback.weaknesses),
      rivalExplanations: asStringList(parsed.rivalExplanations, fallback.rivalExplanations),
      falsificationTests: asStringList(parsed.falsificationTests, fallback.falsificationTests),
      revisedIdea: normalizeIdeaObject(parsed.revisedIdea || idea, fallback.revisedIdea.groundedPapers),
      fallbackUsed: false
    };
  } catch (_) {
    return fallback;
  }
}

/**
 * 3. 多源新颖性查重 + SciMON 差异化转向（SakanaAI/AI-Scientist + EagleW/SCIMON）。
 */
async function checkIdeaNovelty({ ws = '', idea = {}, localPapers = [], remotePapers = [], useRemote = true } = {}) {
  const norm = normalizeIdeaObject(idea);
  const queryText = [norm.title, norm.problem, norm.methodology].filter(Boolean).join(' ').trim();
  const ideaTitleTokens = tokenizeConcept(norm.title);
  const queryTokens = tokenizeConcept(`${norm.title} ${norm.problem} ${norm.gap} ${norm.hypothesis} ${norm.methodology}`);

  let locals = Array.isArray(localPapers) && localPapers.length ? localPapers.slice() : [];
  if (!locals.length && ws) {
    try { locals = store.listItems(ws, 'papers'); } catch (_) { locals = []; }
  }

  let remotes = Array.isArray(remotePapers) ? remotePapers.slice() : [];
  let remoteError = '';
  if (useRemote !== false && !remotes.length && queryText) {
    try {
      const disc = await openalex.discover({
        ws,
        query: queryText.slice(0, 140),
        skillId: 'paper-search-pro',
        sources: ['openalex', 'arxiv'],
        useAiStrategy: false,
        perPage: 10
      });
      remotes = Array.isArray(disc && disc.papers) ? disc.papers : [];
    } catch (e) {
      remoteError = (e && e.message) || String(e);
    }
  }

  const seenTitle = new Set();
  const pool = [];
  const pushCandidate = (p, origin) => {
    const title = String((p && (p.title || p.shortName || p.id)) || '').trim();
    if (!title) return;
    const key = title.toLowerCase().replace(/\s+/g, ' ');
    if (seenTitle.has(key)) return;
    seenTitle.add(key);
    const candTitleTokens = tokenizeConcept(title);
    const candTokens = tokenizeConcept(`${title} ${(p && (p.abstract || p.summary || p.tldr)) || ''}`);
    const titleScore = Math.max(jaccardOverlap(ideaTitleTokens, candTitleTokens), 0.9 * containmentOverlap(ideaTitleTokens, candTitleTokens));
    const fullScore = Math.max(jaccardOverlap(queryTokens, candTokens), 0.75 * containmentOverlap(queryTokens, candTokens));
    const overlap = Math.min(1, Math.max(titleScore, fullScore));
    const matchedTerms = [];
    for (const t of queryTokens) {
      if (candTokens.has(t) && matchedTerms.length < 5) matchedTerms.push(t);
    }
    pool.push({
      title,
      year: String((p && (p.publicationDate || p.published || p.year)) || '').slice(0, 4),
      source: origin === 'local' ? '本地工作区' : String((p && (p.venue || (Array.isArray(p.sources) && p.sources[0]))) || '外部学术库'),
      url: String((p && (p.oaUrl || p.pdfUrl || (p.openalexId ? `https://openalex.org/${p.openalexId}` : ''))) || ''),
      overlapScore: Number(overlap.toFixed(3)),
      matchedTerms,
      overlapReason: matchedTerms.length
        ? `核心概念重合（${Math.round(overlap * 100)}%）：${matchedTerms.join('、')}`
        : '主题相邻（词项重合度低）'
    });
  };

  locals.forEach((p) => pushCandidate(p, 'local'));
  remotes.forEach((p) => pushCandidate(p, 'remote'));
  pool.sort((a, b) => b.overlapScore - a.overlapScore);
  const closestPapers = pool.slice(0, 6);
  const maxOverlap = closestPapers.length ? closestPapers[0].overlapScore : 0;

  let overlapLevel = 'low';
  let verdict = '较高新颖性（未发现高重合工作）';
  if (maxOverlap >= 0.36) {
    overlapLevel = 'high';
    verdict = '高重合风险·建议差异化转向';
  } else if (maxOverlap >= 0.18) {
    overlapLevel = 'medium';
    verdict = '中度重叠·需明确差异边界';
  }

  const topTitle = closestPapers[0] ? closestPapers[0].title : '已有相关工作';
  const defaultDiff = overlapLevel === 'high'
    ? `与「${topTitle}」存在显著概念重合（约 ${Math.round(maxOverlap * 100)}%），直接照原方案推进易被质疑增量不足。`
    : overlapLevel === 'medium'
      ? `与「${topTitle}」共享部分方法或任务语境，需在核心机制与实验基准上清晰界定本质差异。`
      : '与现有已检索文献重合度较低，建议保留核心假设并补充最近 3 个月预印本人工核对。';

  const defaultPivots = overlapLevel === 'high'
    ? [
        `机制深化转向：不要重复「${topTitle}」的表层结构，改为针对其核心失败模式（如长视野误差累积/跨本体退化）设计结构性约束`,
        '评测边界转向：将验证焦点转向现有方法显著退化的极端工况（低样本、部分可观测或高动态扰动）',
        '效率与可控性转向：在同等精度下将推理延迟或训练样本需求压缩一个数量级，并给出理论/消融归因'
      ]
    : overlapLevel === 'medium'
      ? [
          `在论文 Related Work 与实验设计中显式将「${topTitle}」设为直接对比基线，通过单变量消融证明增量来源`,
          '进一步收紧假设边界，明确指出在哪些任务条件下本方案必然优于已有方法'
        ]
      : [
          '补充检索最近 90 天 arXiv 与 OpenReview 匿名投稿，确认无同期撞车工作',
          '设计针对最接近基线的对照消融实验，固化差异化证据'
        ];

  const offlineResult = {
    ok: true,
    verdict,
    overlapLevel,
    maxOverlapScore: maxOverlap,
    queryTitle: norm.title,
    checkedCount: pool.length,
    closestPapers,
    differentiation: defaultDiff,
    pivotSuggestions: defaultPivots,
    warning: remoteError ? `在线查重降级为本地/已提供候选：${remoteError}` : '',
    fallbackUsed: true
  };

  const cfg = store.getConfig() || {};
  if (!(cfg.api && cfg.api.apiKey) || !closestPapers.length) return offlineResult;

  const sys = '你是科研新颖性审查与 SciMON 创新转向专家。根据候选 Idea 与最相似论文列表客观评估重合度，并在中高重合时给出具体转向方案。只输出合法 JSON。';
  const prompt = `## 候选 Idea
标题：${norm.title}
问题：${norm.problem}
假设：${norm.hypothesis}
方法：${norm.methodology}

## 检索到的最相近论文
${closestPapers.map((p, i) => `${i + 1}. ${p.title} (${p.year || '?'}) [${p.source}] — ${p.overlapReason}`).join('\n')}

请输出严格 JSON：
{
  "overlapLevel": "high|medium|low",
  "verdict": "简短中文判定（如 高重合风险·建议转向 / 中度重叠·需强化差异 / 较高新颖性）",
  "differentiation": "1-2 句分析与最相近论文的核心异同",
  "pivotSuggestions": ["具体可落地的 SciMON 差异化转向建议1", "转向建议2", "转向建议3"]
}`;

  try {
    const raw = await ai.callLLM(
      [{ role: 'system', content: sys }, { role: 'user', content: prompt }],
      { temperature: 0.2, maxTokens: 700, timeoutMs: 22000 }
    );
    const parsed = ai.extractJsonBlock(raw);
    if (!parsed || typeof parsed !== 'object') return offlineResult;
    const lvl = ['high', 'medium', 'low'].includes(String(parsed.overlapLevel || '')) ? String(parsed.overlapLevel) : overlapLevel;
    return {
      ...offlineResult,
      overlapLevel: lvl,
      verdict: String(parsed.verdict || verdict),
      differentiation: String(parsed.differentiation || defaultDiff),
      pivotSuggestions: asStringList(parsed.pivotSuggestions, defaultPivots),
      fallbackUsed: false
    };
  } catch (_) {
    return offlineResult;
  }
}

/**
 * 4. Open-Co-Scientist 成对辩论 Elo 锦标赛排名。
 * 保证严格 Elo 守恒性质（K=32，初始 1500，总 Elo 和 = 1500 * N，每场胜负与 wins/losses 完全一致）。
 */
function applyEloMatch(ratings, wins, losses, idA, idB, winnerId, K = 32) {
  const ra = ratings.get(idA);
  const rb = ratings.get(idB);
  const ea = 1 / (1 + Math.pow(10, (rb - ra) / 400));
  const eb = 1 - ea;
  let sa = 0.5;
  let sb = 0.5;
  if (winnerId === idA) {
    sa = 1; sb = 0;
    wins.set(idA, (wins.get(idA) || 0) + 1);
    losses.set(idB, (losses.get(idB) || 0) + 1);
  } else if (winnerId === idB) {
    sa = 0; sb = 1;
    wins.set(idB, (wins.get(idB) || 0) + 1);
    losses.set(idA, (losses.get(idA) || 0) + 1);
  }
  const deltaA = Math.round(K * (sa - ea));
  ratings.set(idA, ra + deltaA);
  ratings.set(idB, rb - deltaA); // 精确零和守恒
  return deltaA;
}

async function tournamentIdeas({ ideas = [], skillId = 'co-scientist-tournament', criteria = '' } = {}) {
  const list = (Array.isArray(ideas) ? ideas : []).map((item, idx) => ({
    id: String((item && item.id) || `idea-${idx + 1}`),
    raw: item && typeof item === 'object' ? item : {},
    norm: normalizeIdeaObject(item)
  }));
  const skill = skills.getSkill(skillId || 'co-scientist-tournament', 'idea') || { id: skillId || 'co-scientist-tournament' };

  if (list.length <= 1) {
    return {
      ok: true,
      skillId: skill.id,
      rankings: list.map((it) => ({
        id: it.id,
        title: it.norm.title,
        elo: 1500,
        wins: 0,
        losses: 0,
        rationale: list.length === 1 ? '仅 1 个候选 Idea，保持初始 Elo 1500' : ''
      })),
      matchups: [],
      fallbackUsed: true
    };
  }

  // 生成成对对阵（最多 6 个全循环 15 场；更多时取前 8 个环状+邻近配对避免组合爆炸）
  const capped = list.slice(0, 8);
  const pairs = [];
  for (let i = 0; i < capped.length; i++) {
    for (let j = i + 1; j < capped.length; j++) {
      if (capped.length <= 6 || (j - i) <= 2 || (i === 0 && j === capped.length - 1)) {
        pairs.push([capped[i], capped[j]]);
      }
    }
  }

  // 先计算每个 Idea 的本地客观结构分用于离线或回退决策
  const qualityScores = new Map();
  capped.forEach((it) => {
    const rev = it.raw.review && it.raw.review.scores
      ? it.raw.review.scores
      : offlineReviewIdea(it.raw, [], skill.id).scores;
    const avg = (
      clampScore(rev.novelty, 5) * 1.15 +
      clampScore(rev.feasibility, 5) * 1.1 +
      clampScore(rev.clarity, 5) * 1.0 +
      clampScore(rev.significance, 5) * 1.0 +
      clampScore(rev.groundedness, 5) * 1.05
    ) / 5.3;
    const overlapPenalty = it.raw.noveltyCheck && it.raw.noveltyCheck.overlapLevel === 'high' ? 1.2 : 0;
    qualityScores.set(it.id, Number((avg - overlapPenalty).toFixed(3)));
  });

  let llmMatchDecisions = null;
  let fallbackUsed = true;
  const cfg = store.getConfig() || {};
  if (cfg.api && cfg.api.apiKey) {
    try {
      const sys = '你是 Open-Co-Scientist 科研辩论裁判。对每一对候选 Idea 执行严格成对比较，判断哪一方在可证伪性、新颖性与可行性综合表现更优。只输出合法 JSON。';
      const ideaSummaries = capped.map((it) =>
        `- [${it.id}] ${it.norm.title}\n  问题: ${it.norm.problem || '未填'}\n  假设: ${it.norm.hypothesis || '未填'}\n  方法: ${it.norm.methodology || '未填'}\n  验证: ${it.norm.validationPlan || '未填'}`
      ).join('\n');
      const pairList = pairs.map(([a, b], idx) => `${idx}: ${a.id} vs ${b.id}`).join('\n');
      const prompt = `${criteria ? `附加评判侧重：${criteria}\n\n` : ''}候选 Idea：\n${ideaSummaries}\n\n需要裁决的对阵：\n${pairList}\n\n输出 JSON 数组：[{"pairIndex":0,"winnerId":"id","debateSummary":"一句话说明胜出关键差异"}]`;
      const raw = await ai.callLLM(
        [{ role: 'system', content: sys }, { role: 'user', content: prompt }],
        { temperature: 0.2, maxTokens: 1200, timeoutMs: 26000 }
      );
      const parsed = ai.extractJsonBlock(raw);
      if (Array.isArray(parsed) && parsed.length) {
        llmMatchDecisions = new Map();
        parsed.forEach((m) => {
          if (Number.isInteger(m && m.pairIndex)) llmMatchDecisions.set(m.pairIndex, m);
        });
        fallbackUsed = false;
      }
    } catch (_) {
      llmMatchDecisions = null;
      fallbackUsed = true;
    }
  }

  const ratings = new Map(capped.map((it) => [it.id, 1500]));
  const wins = new Map(capped.map((it) => [it.id, 0]));
  const losses = new Map(capped.map((it) => [it.id, 0]));
  const matchups = [];

  pairs.forEach(([a, b], idx) => {
    const llmDec = llmMatchDecisions && llmMatchDecisions.get(idx);
    let winnerId = '';
    let debateSummary = '';
    if (llmDec && (llmDec.winnerId === a.id || llmDec.winnerId === b.id)) {
      winnerId = llmDec.winnerId;
      debateSummary = String(llmDec.debateSummary || '').trim();
    } else {
      const sa = qualityScores.get(a.id) || 5;
      const sb = qualityScores.get(b.id) || 5;
      if (Math.abs(sa - sb) < 0.05) {
        winnerId = a.norm.groundedPapers.length >= b.norm.groundedPapers.length ? a.id : b.id;
        debateSummary = `两者综合评分接近（${sa.toFixed(1)} vs ${sb.toFixed(1)}），胜方文献支撑或结构完整度略优`;
      } else {
        winnerId = sa > sb ? a.id : b.id;
        debateSummary = `${winnerId === a.id ? a.norm.title : b.norm.title} 在可证伪性、可行性与文献扎根度综合得分更高（${Math.max(sa, sb).toFixed(2)} vs ${Math.min(sa, sb).toFixed(2)}）`;
      }
    }
    const deltaA = applyEloMatch(ratings, wins, losses, a.id, b.id, winnerId, 32);
    matchups.push({
      aId: a.id,
      aTitle: a.norm.title,
      bId: b.id,
      bTitle: b.norm.title,
      winnerId,
      deltaA,
      debateSummary
    });
  });

  const rankings = capped
    .map((it) => ({
      id: it.id,
      title: it.norm.title,
      elo: ratings.get(it.id),
      wins: wins.get(it.id),
      losses: losses.get(it.id),
      qualityScore: qualityScores.get(it.id),
      rationale: `${wins.get(it.id)} 胜 ${losses.get(it.id)} 负 · Elo ${ratings.get(it.id)}`
    }))
    .sort((a, b) => b.elo - a.elo || b.wins - a.wins || b.qualityScore - a.qualityScore);

  return {
    ok: true,
    skillId: skill.id,
    rankings,
    matchups,
    fallbackUsed
  };
}

/**
 * 5. Open-Co-Scientist 杂交进化：融合头部 Idea 优势并修补评审弱点。
 */
async function evolveIdeas({ ideas = [], reviews = [], skillId = 'co-scientist-tournament' } = {}) {
  const list = (Array.isArray(ideas) ? ideas : []).map((it) => normalizeIdeaObject(it));
  const skill = skills.getSkill(skillId || 'co-scientist-tournament', 'idea') || { id: skillId || 'co-scientist-tournament' };
  if (!list.length) return { ok: true, skillId: skill.id, evolvedIdeas: [], fallbackUsed: true };

  const primary = list[0];
  const secondary = list[1] || null;
  const revList = Array.isArray(reviews) ? reviews : [];
  const allWeaknesses = revList.reduce((acc, r) => acc.concat(asStringList(r && r.weaknesses, [])), []).slice(0, 4);
  const mergedGrounded = Array.from(new Set(
    primary.groundedPapers.concat(secondary ? secondary.groundedPapers : [])
  )).slice(0, 6);

  const offlineEvolved = [normalizeIdeaObject({
    title: secondary
      ? `${primary.title.slice(0, 32)} × ${secondary.title.slice(0, 24)}（融合演化版）`
      : `${primary.title}（对抗修补演化版）`,
    problem: primary.problem || (secondary && secondary.problem) || '聚焦核心任务瓶颈',
    gap: primary.gap || (secondary && secondary.gap) || '融合两路线优势填补现有基线空白',
    hypothesis: secondary
      ? `将「${primary.title.slice(0, 28)}」的核心机制与「${secondary.title.slice(0, 28)}」的验证约束结合，可在保持单变量可消融的前提下同时缓解两者弱点。`
      : `${primary.hypothesis}（并显式纳入等算力与竞争性解释控制验证）`,
    methodology: secondary
      ? `以主方案为骨架（${primary.methodology.slice(0, 120)}），吸收次方案的互补机制（${secondary.methodology.slice(0, 100)}），拆解为独立可控开关做 2x2 消融。`
      : `${primary.methodology}；针对评审弱点补充控制组：${allWeaknesses.join('；') || '等参数与多种子验证'}`,
    assumptions: Array.from(new Set(primary.assumptions.concat(secondary ? secondary.assumptions : []))).slice(0, 4),
    rivalExplanations: Array.from(new Set(primary.rivalExplanations.concat(secondary ? secondary.rivalExplanations : []))).slice(0, 4),
    validationPlan: primary.validationPlan || '执行主方案、副方案与融合方案的 2x2 消融对照，报告 3 种子均值与 95% CI。',
    groundedPapers: mergedGrounded
  }, mergedGrounded)];

  const cfg = store.getConfig() || {};
  if (!(cfg.api && cfg.api.apiKey)) {
    return { ok: true, skillId: skill.id, evolvedIdeas: offlineEvolved, fallbackUsed: true };
  }

  try {
    const sys = '你是科研方案进化专家（Open-Co-Scientist 范式）。将头部候选 Idea 的互补优势与评审弱点融合为 1 个更简洁、更可证伪的新一代方案。只输出合法 JSON。';
    const prompt = `头部候选方案：\n${JSON.stringify(list.slice(0, 3), null, 2)}\n\n评审暴露弱点：\n${allWeaknesses.join('\n') || '（无额外弱点）'}\n\n输出 JSON：{"evolvedIdeas":[{title,problem,gap,hypothesis,methodology,assumptions,rivalExplanations,validationPlan,groundedPapers}]}`;
    const raw = await ai.callLLM(
      [{ role: 'system', content: sys }, { role: 'user', content: prompt }],
      { temperature: 0.35, maxTokens: 1400, timeoutMs: 25000 }
    );
    const parsed = ai.extractJsonBlock(raw);
    const arr = parsed && Array.isArray(parsed.evolvedIdeas) ? parsed.evolvedIdeas : [];
    if (!arr.length) return { ok: true, skillId: skill.id, evolvedIdeas: offlineEvolved, fallbackUsed: true };
    return {
      ok: true,
      skillId: skill.id,
      evolvedIdeas: arr.slice(0, 2).map((x) => normalizeIdeaObject(x, mergedGrounded)),
      fallbackUsed: false
    };
  } catch (_) {
    return { ok: true, skillId: skill.id, evolvedIdeas: offlineEvolved, fallbackUsed: true };
  }
}

/**
 * 判定单个关联实验对 Idea 假设的证据极性（supports / contradicts / untested）。
 */
function classifyExperimentPolarity(exp = {}) {
  const fm = exp.frontmatter && typeof exp.frontmatter === 'object' ? exp.frontmatter : exp;
  const status = String(fm.status || '').trim();
  const verdict = String(fm.verdict || fm.keepDecision || '').toLowerCase();
  const conclusion = String(fm.conclusion || (fm.results && fm.results.summary) || '').trim();
  const failureCause = String((fm.failure && fm.failure.cause) || '').trim();

  if (verdict.includes('discard') || verdict.includes('推翻') || status === '失败' || /推翻|不支持|退化|下降|无效|failed|worse/i.test(conclusion)) {
    return 'contradicts';
  }
  if (verdict.includes('keep') || verdict.includes('支持') || (status === '完成' && /支持|提升|优于|显著|improved|better|confirm/i.test(conclusion))) {
    return 'supports';
  }
  if (status === '完成' && conclusion && !failureCause) {
    return 'supports';
  }
  return 'untested';
}

/**
 * 6. HypoRefine 实验回流修正 Idea（ChicagoHAI/hypothesis-generation）。
 */
async function refineIdeaFromExperiment({ idea = {}, experiment = {}, skillId = 'co-scientist-tournament' } = {}) {
  const skill = skills.getSkill(skillId || 'co-scientist-tournament', 'idea') || { id: skillId || 'co-scientist-tournament' };
  const expFm = experiment && experiment.frontmatter && typeof experiment.frontmatter === 'object' ? experiment.frontmatter : (experiment || {});
  const expId = String((experiment && experiment.id) || expFm.id || 'exp');
  const expTitle = String(expFm.title || expId);
  const conclusion = String(expFm.conclusion || (expFm.results && expFm.results.summary) || '').trim();
  const metrics = (expFm.results && expFm.results.metrics && typeof expFm.results.metrics === 'object') ? expFm.results.metrics : {};
  const metricSummary = Object.entries(metrics).map(([k, v]) => `${k}=${v}`).join(', ');
  const failure = expFm.failure && typeof expFm.failure === 'object' ? expFm.failure : {};
  const polarity = classifyExperimentPolarity(expFm);
  const stamp = new Date().toISOString().slice(0, 10);

  const normIdea = normalizeIdeaObject(idea);
  const existingHistory = Array.isArray(idea && idea.experimentFeedback) ? idea.experimentFeedback.slice() : [];
  const feedbackEntry = {
    expId,
    expTitle,
    date: stamp,
    polarity,
    metrics: metricSummary,
    conclusion: conclusion || (failure.cause ? `失败原因：${failure.cause}` : '实验结果待补充'),
    lesson: polarity === 'contradicts'
      ? `原假设在「${expTitle}」中未获支持，需修正前提假设或调整机制`
      : polarity === 'supports'
        ? `「${expTitle}」提供正向支撑证据，建议扩充随机种子或跨基准压力测试`
        : `「${expTitle}」尚无明确统计定论，保持待检验状态`
  };

  const suggestedNextHypothesis = polarity === 'contradicts'
    ? `${normIdea.hypothesis}（修订：鉴于「${expTitle}」暴露的局限「${failure.cause || conclusion || '未达预期'}」，收紧适用条件并替换敏感组件）`
    : polarity === 'supports'
      ? `${normIdea.hypothesis}（已获「${expTitle}」初步支持，下一步在分布外场景检验泛化边界）`
      : normIdea.hypothesis;

  const updatedIdea = {
    ...(idea && typeof idea === 'object' ? idea : {}),
    hypothesis: suggestedNextHypothesis,
    nextStep: polarity === 'contradicts'
      ? `根据 ${expId} 负结果修订假设并设计最小反例诊断实验`
      : polarity === 'supports'
        ? `在 ${expId} 基础上补齐 3-5 随机种子与分布外消融验证`
        : `继续完善 ${expId} 的定量指标记录`,
    experimentFeedback: existingHistory.filter((x) => x && x.expId !== expId).concat([feedbackEntry])
  };

  const deltaSummary = `实验「${expTitle}」回流（极性：${polarity === 'supports' ? '支持假设' : polarity === 'contradicts' ? '反驳/需修正' : '待检验'}）${metricSummary ? `；指标：${metricSummary}` : ''}${conclusion ? `；结论：${conclusion}` : ''}`;

  const cfg = store.getConfig() || {};
  if (!(cfg.api && cfg.api.apiKey)) {
    return { ok: true, skillId: skill.id, polarity, updatedIdea, feedbackEntry, deltaSummary, suggestedNextHypothesis, fallbackUsed: true };
  }

  try {
    const sys = '你是 HypoRefine 科研假设迭代专家。根据实验结果客观判定极性（supports/contradicts/untested）并修正原假设与下一步验证计划。只输出合法 JSON。';
    const prompt = `原 Idea：\n${JSON.stringify(normIdea, null, 2)}\n\n实验记录（${expId} - ${expTitle}）：\n状态：${expFm.status || ''}\n指标：${metricSummary || '无'}\n结论：${conclusion || '无'}\n失败复盘：${JSON.stringify(failure)}\n\n输出 JSON：{"polarity":"supports|contradicts|untested","suggestedNextHypothesis":"修订后的假设","lesson":"一句话科研教训","nextStep":"下一步行动","deltaSummary":"回流变更摘要"}`;
    const raw = await ai.callLLM(
      [{ role: 'system', content: sys }, { role: 'user', content: prompt }],
      { temperature: 0.2, maxTokens: 650, timeoutMs: 22000 }
    );
    const parsed = ai.extractJsonBlock(raw);
    if (!parsed || typeof parsed !== 'object') {
      return { ok: true, skillId: skill.id, polarity, updatedIdea, feedbackEntry, deltaSummary, suggestedNextHypothesis, fallbackUsed: true };
    }
    const aiPolarity = ['supports', 'contradicts', 'untested'].includes(String(parsed.polarity || '')) ? String(parsed.polarity) : polarity;
    const aiEntry = { ...feedbackEntry, polarity: aiPolarity, lesson: String(parsed.lesson || feedbackEntry.lesson) };
    const aiHypo = String(parsed.suggestedNextHypothesis || suggestedNextHypothesis);
    return {
      ok: true,
      skillId: skill.id,
      polarity: aiPolarity,
      updatedIdea: {
        ...updatedIdea,
        hypothesis: aiHypo,
        nextStep: String(parsed.nextStep || updatedIdea.nextStep),
        experimentFeedback: existingHistory.filter((x) => x && x.expId !== expId).concat([aiEntry])
      },
      feedbackEntry: aiEntry,
      deltaSummary: String(parsed.deltaSummary || deltaSummary),
      suggestedNextHypothesis: aiHypo,
      fallbackUsed: false
    };
  } catch (_) {
    return { ok: true, skillId: skill.id, polarity, updatedIdea, feedbackEntry, deltaSummary, suggestedNextHypothesis, fallbackUsed: true };
  }
}

module.exports = {
  generateIdeasFromLineage,
  reviewIdea,
  checkIdeaNovelty,
  tournamentIdeas,
  evolveIdeas,
  refineIdeaFromExperiment,
  classifyExperimentPolarity
};
