/**
 * src/main/services/experiment-service.js — 科学实验设计、消融矩阵、跨实验对比、日志诊断与复现打包服务（M4）
 * 融合以下 GitHub 开源研究方法：
 *   - K-Dense-AI/scientific-agent-skills (experimental-design & statistical-analysis): 事前 DOE、三类变量与统计严谨性
 *   - ai-scientist-bench/ablation-bench & fostiropoulos/ablator: AuthorAblation 矩阵一键派生 + ReviewerAblation 混杂审计
 *   - iterative/dvc & aimhubio/aim & WecoAI/aideml: 确定性参数/指标 Diff（Δ / %Δ）、LaTeX/Markdown 导出与 basedOn 演进树
 *   - karpathy/autoresearch & KalarisLabs/research-agent-skills: Keep/Discard/Blocked 裁决、日志异常扫描与负结果台账
 *   - sfb1638/elabftw-templates: 可复现 YAML 配置 + 启动脚本 + ELN 协议卡片导出
 */
'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const store = require('../store');
const ai = require('../ai');
const skills = require('../search/skills');
const ingestor = require('./cs-experiment-ingestor');
const Stats = require('../../renderer/stats');

function runReadOnlyCmd(cmd, args, cwd) {
  try {
    const out = execFileSync(cmd, args, {
      cwd: cwd || process.cwd(),
      timeout: 2500,
      maxBuffer: 256 * 1024,
      shell: false,
      windowsHide: true,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
    return { ok: true, output: String(out || '').trim() };
  } catch (e) {
    return { ok: false, output: '', error: (e && e.code) || (e && e.message) || 'failed' };
  }
}

function captureEnvironment(opts = {}) {
  const cwd = (opts && typeof opts.cwd === 'string' && opts.cwd.trim()) ? opts.cwd.trim() : process.cwd();
  const gitCommit = runReadOnlyCmd('git', ['rev-parse', '--short', 'HEAD'], cwd);
  const gitBranch = runReadOnlyCmd('git', ['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  const gitStatus = runReadOnlyCmd('git', ['status', '--porcelain'], cwd);

  let pythonRes = runReadOnlyCmd('python', ['--version'], cwd);
  let pythonBin = 'python';
  if (!pythonRes.ok) {
    pythonRes = runReadOnlyCmd('python3', ['--version'], cwd);
    pythonBin = 'python3';
  }
  const torchRes = pythonRes.ok
    ? runReadOnlyCmd(pythonBin, ['-c', 'import torch; print(torch.__version__)'], cwd)
    : { ok: false, output: '' };
  const gpuRes = runReadOnlyCmd('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader'], cwd);

  const gpus = gpuRes.ok && gpuRes.output
    ? gpuRes.output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    : [];

  return {
    ok: true,
    capturedAt: new Date().toISOString(),
    os: `${os.platform()} ${os.release()} (${os.arch()})`,
    node: process.version,
    git: {
      available: gitCommit.ok,
      commit: gitCommit.output || '',
      branch: gitBranch.output || '',
      dirty: Boolean(gitStatus.ok && gitStatus.output)
    },
    python: pythonRes.ok ? pythonRes.output : '',
    torch: torchRes.ok ? torchRes.output : '',
    gpu: gpus
  };
}

function normalizePlainObj(val) {
  return val && typeof val === 'object' && !Array.isArray(val) ? val : {};
}

function escapeMdCell(v) {
  return String(v == null ? '' : v).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}

function escapeLatexCell(v) {
  return String(v == null ? '' : v)
    .replace(/\\/g, '\\textbackslash{}')
    .replace(/([%&#_{}$])/g, '\\$1')
    .replace(/\r?\n/g, ' ')
    .trim();
}

function inferKeepBadge(fm = {}) {
  const explicit = String(fm.keepDecision || '').toLowerCase();
  if (['keep', 'discard', 'blocked', 'inconclusive'].includes(explicit)) return explicit;
  const status = String(fm.status || '');
  const conclusion = String(fm.conclusion || (fm.results && fm.results.summary) || '');
  if (status === '失败' || /推翻|退化|discard|worse/i.test(conclusion)) return 'discard';
  if (status === '阻塞' || /oom|nan|报错|崩溃/i.test(conclusion)) return 'blocked';
  if (status === '完成') return 'keep';
  return 'running';
}

function isLowerBetterMetric(name) {
  return /loss|error|err|mse|mae|rmse|latency|time|mem|memory|cost|perplexity|ppl/i.test(String(name || ''));
}

function buildLineageTree(rows) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const childrenMap = new Map(rows.map((r) => [r.id, []]));
  const roots = [];
  for (const r of rows) {
    const parentId = String(r.basedOn || '').trim();
    if (parentId && parentId !== r.id && byId.has(parentId)) {
      childrenMap.get(parentId).push(r.id);
    } else {
      roots.push(r.id);
    }
  }
  const visited = new Set();
  const buildNode = (id, depth = 0) => {
    if (visited.has(id) || depth > 8) return null;
    visited.add(id);
    const r = byId.get(id);
    return {
      id: r.id,
      title: r.title,
      status: r.status,
      basedOn: r.basedOn,
      verdictBadge: r.verdictBadge,
      metrics: r.metrics,
      depth,
      children: (childrenMap.get(id) || []).map((cid) => buildNode(cid, depth + 1)).filter(Boolean)
    };
  };
  const tree = roots.map((rid) => buildNode(rid, 0)).filter(Boolean);
  for (const r of rows) {
    if (!visited.has(r.id)) {
      const node = buildNode(r.id, 0);
      if (node) tree.push(node);
    }
  }
  return tree;
}

/**
 * 确定性跨实验对比矩阵（dvc params/metrics diff + LaTeX/Markdown 导出 + basedOn 演进树）。
 */
function compareExperiments(ws, expIds = [], opts = {}) {
  const targetWs = String(ws || store.getConfig().currentWorkspace || '').trim();
  const allItems = targetWs ? store.listItems(targetWs, 'experiments') : [];
  const requestedIds = Array.isArray(expIds) && expIds.length
    ? expIds.map((id) => String(id || '').trim()).filter(Boolean)
    : allItems.map((it) => it.id);

  const rows = [];
  const allConfigKeys = new Set();
  const allMetricKeys = new Set();

  for (const id of requestedIds) {
    const item = targetWs ? store.getItem(targetWs, 'experiments', id) : null;
    if (!item) continue;
    const fm = normalizePlainObj(item.frontmatter);
    const config = normalizePlainObj(fm.config);
    const results = normalizePlainObj(fm.results);
    const metrics = normalizePlainObj(results.metrics);
    Object.keys(config).forEach((k) => allConfigKeys.add(k));
    Object.keys(metrics).forEach((k) => allMetricKeys.add(k));
    let dataFiles = [];
    try { dataFiles = store.listDataFiles(targetWs, item.id); } catch (_) { dataFiles = []; }
    rows.push({
      id: item.id,
      title: String(fm.title || item.id),
      status: String(fm.status || ''),
      date: String(fm.date || ''),
      basedOn: String(fm.basedOn || ''),
      relatedIdea: String(fm.relatedIdea || ''),
      verdictBadge: inferKeepBadge(fm),
      conclusion: String(fm.conclusion || ''),
      config,
      metrics,
      dataFiles
    });
  }

  const configKeys = Array.from(allConfigKeys);
  const metricKeys = Array.from(allMetricKeys);
  const configDiffKeys = configKeys.filter((k) => {
    const vals = new Set(rows.map((r) => (r.config[k] === undefined ? '' : String(r.config[k]))));
    return vals.size > 1;
  });

  const requestedBase = String((opts && opts.baselineId) || '').trim();
  const baseline = (requestedBase && rows.find((r) => r.id === requestedBase)) || rows[0] || null;
  const baselineId = baseline ? baseline.id : '';

  const bestByMetric = {};
  for (const mk of metricKeys) {
    const lowerBetter = isLowerBetterMetric(mk);
    let bestVal = null;
    let bestId = '';
    for (const r of rows) {
      const n = Number(r.metrics[mk]);
      if (!Number.isFinite(n)) continue;
      if (bestVal === null || (lowerBetter ? n < bestVal : n > bestVal)) {
        bestVal = n;
        bestId = r.id;
      }
    }
    if (bestId) bestByMetric[mk] = { id: bestId, value: bestVal, lowerBetter };
  }

  if (baseline) {
    for (const row of rows) {
      row.metricDeltas = {};
      for (const mk of metricKeys) {
        const curNum = Number(row.metrics[mk]);
        const baseNum = Number(baseline.metrics[mk]);
        if (Number.isFinite(curNum) && Number.isFinite(baseNum)) {
          const delta = curNum - baseNum;
          const pct = baseNum !== 0 ? (delta / Math.abs(baseNum)) * 100 : null;
          row.metricDeltas[mk] = {
            delta: Number(delta.toFixed(4)),
            pct: pct === null ? null : Number(pct.toFixed(2))
          };
        }
      }
    }
  }

  const headers = ['实验', '状态', ...configDiffKeys.map((k) => `cfg:${k}`), ...metricKeys];
  const mdLines = rows.length
    ? [
        '| ' + headers.map(escapeMdCell).join(' | ') + ' |',
        '| ' + headers.map(() => '---').join(' | ') + ' |',
        ...rows.map((r) => {
          const cells = [
            r.id === baselineId ? `${r.title} (Baseline)` : r.title,
            r.status || '-',
            ...configDiffKeys.map((k) => (r.config[k] !== undefined ? String(r.config[k]) : '-')),
            ...metricKeys.map((k) => {
              const v = r.metrics[k];
              if (v === undefined || v === '') return '-';
              const d = r.metricDeltas && r.metricDeltas[k];
              const isBest = bestByMetric[k] && bestByMetric[k].id === r.id && rows.length > 1;
              let cell = String(v);
              if (d && r.id !== baselineId) {
                const sign = d.delta >= 0 ? '+' : '';
                const pctStr = d.pct !== null ? `, ${sign}${d.pct}%` : '';
                cell = `${v} (${sign}${d.delta}${pctStr})`;
              }
              return isBest ? `**${cell}**` : cell;
            })
          ];
          return '| ' + cells.map(escapeMdCell).join(' | ') + ' |';
        })
      ]
    : ['（暂无可对比实验）'];

  const colSpec = 'l' + 'c'.repeat(Math.max(0, headers.length - 1));
  const latexLines = [
    `\\begin{tabular}{${colSpec}}`,
    '\\hline',
    headers.map((h) => `\\textbf{${escapeLatexCell(h)}}`).join(' & ') + ' \\\\',
    '\\hline',
    ...rows.map((r) => {
      const cells = [
        escapeLatexCell(r.title),
        escapeLatexCell(r.status || '-'),
        ...configDiffKeys.map((k) => escapeLatexCell(r.config[k] !== undefined ? String(r.config[k]) : '-')),
        ...metricKeys.map((k) => {
          const v = r.metrics[k];
          if (v === undefined || v === '') return '-';
          const isBest = bestByMetric[k] && bestByMetric[k].id === r.id && rows.length > 1;
          const valEsc = escapeLatexCell(String(v));
          return isBest ? `\\textbf{${valEsc}}` : valEsc;
        })
      ];
      return cells.join(' & ') + ' \\\\';
    }),
    '\\hline',
    '\\end{tabular}'
  ];

  return {
    ok: true,
    rows,
    configKeys,
    configDiffKeys,
    metricKeys,
    baselineId,
    bestByMetric,
    lineageTree: buildLineageTree(rows),
    markdownTable: mdLines.join('\n'),
    latexTable: latexLines.join('\n')
  };
}

/**
 * AI 科学实验设计与双视角消融（K-Dense experimental-design + ablation-bench AuthorAblation/ReviewerAblation）。
 */
async function designExperiment({ idea = {}, papers = [], parentExp = null, skillId = 'experimental-design-ablation' } = {}) {
  const skill = skills.getSkill(skillId || 'experimental-design-ablation', 'experiment')
    || skills.listSkills('experiment', { includeContent: true })[0]
    || { id: skillId || 'experimental-design-ablation', name: 'Experimental Design & Ablation', content: '' };

  const ideaObj = idea && typeof idea === 'object' ? idea : {};
  const parentFm = parentExp && parentExp.frontmatter && typeof parentExp.frontmatter === 'object' ? parentExp.frontmatter : (parentExp || {});
  const baseTitle = String(ideaObj.title || parentFm.title || '核心机制验证实验').trim();
  const baseConfig = normalizePlainObj(parentFm.config);
  const hypothesis = String(ideaObj.hypothesis || parentFm.hypothesis || `在受控基准下验证「${baseTitle}」核心机制对主指标的净增益，并在消融核心模块后指标显著回落。`).trim();
  const nullHypothesis = `H0：在同等数据划分、超参预算与随机种子条件下，「${baseTitle}」与基线在主指标上无统计学显著差异（p >= 0.05）。`;

  const offlineDesign = {
    ok: true,
    skillId: skill.id,
    hypothesis,
    nullHypothesis,
    variables: {
      independent: [
        'core_module_enabled（核心机制开关：false / true）',
        'auxiliary_constraint_weight（关键正则或动力学约束权重：0 / 0.1 / 0.5）'
      ],
      dependent: [
        'primary_success_rate（主任务成功率 / 准确率）',
        'ood_generalization（分布外泛化指标）',
        'inference_latency_ms（推理延迟与显存开销）'
      ],
      controls: [
        'seeds = [42, 1024, 2025]（至少 3 个固定随机种子）',
        '统一训练集/验证集划分与同一评测脚本',
        '锁定总训练步数、Batch Size 与优化器预算'
      ]
    },
    successCriteria: '至少 3 个随机种子下，完整方案相对锚点基线主指标均值正向提升且 Welch t-test p < 0.05（Cohen\'s d >= 0.5），同时推理延迟增幅 < 15%。',
    confoundingChecks: [
      '【ReviewerAblation】核查基线与改进版是否使用完全相同的数据预处理与评测脚本（零数据泄漏）',
      '【ReviewerAblation】核查参数量与训练 FLOPs 是否对齐，增加「同参数量无机制对照」排除纯扩容红利',
      '【ReviewerAblation】至少运行 3 个独立随机种子，报告 Mean ± Std 与 95% 置信区间',
      '【ReviewerAblation】在运行前记录代码 Git Commit、Python/PyTorch 版本与完整超参快照'
    ],
    ablationMatrix: [
      {
        name: `${baseTitle} - [A0] 锚点基线`,
        role: 'baseline',
        changedConfig: { ...baseConfig, variant: 'baseline', core_module: 'off', aux_weight: '0' },
        hypothesis: '建立可复现的基线锚点，核对本地指标与文献报告一致。',
        rationale: 'AuthorAblation 必备基线对照组。'
      },
      {
        name: `${baseTitle} - [A1] 完整方案`,
        role: 'full',
        changedConfig: { ...baseConfig, variant: 'full', core_module: 'on', aux_weight: '0.1' },
        hypothesis,
        rationale: `验证完整提案相对基线的净增益（参考 ${Array.isArray(papers) ? papers.length : 0} 篇支撑论文）。`
      },
      {
        name: `${baseTitle} - [A2] 去除辅助约束消融`,
        role: 'ablation',
        changedConfig: { ...baseConfig, variant: 'wo_aux', core_module: 'on', aux_weight: '0' },
        hypothesis: '移除辅助动力学/正则约束后，长视野或分布外性能应出现可观测退化。',
        rationale: '隔离主结构与辅助训练目标的各自贡献（单变量消融）。'
      },
      {
        name: `${baseTitle} - [A3] 等参数容量对照`,
        role: 'control',
        changedConfig: { ...baseConfig, variant: 'param_matched_control', core_module: 'off', hidden_scale: '1.15' },
        hypothesis: '若仅增加同等参数量而不引入核心机制，指标无法达到完整方案水平。',
        rationale: '提前回击审稿人最常见的「性能仅来自参数量增加」质疑。'
      }
    ],
    fallbackUsed: true
  };

  const cfg = store.getConfig() || {};
  if (!(cfg.api && cfg.api.apiKey)) return offlineDesign;

  const sys = '你是严谨的机器学习与机器人实验设计专家（K-Dense experimental-design + ablation-bench 范式）。输出可执行、单变量隔离的消融矩阵与审稿人级混杂检查表。只输出合法 JSON。';
  const prompt = `${skill.content ? `## 实验设计 Skill（${skill.name}）\n${String(skill.content).slice(0, 2200)}\n\n` : ''}## 关联 Idea / 实验背景
标题：${baseTitle}
研究问题：${ideaObj.problem || parentFm.goal || ''}
假设：${hypothesis}
方法：${ideaObj.methodology || parentFm.protocol || ''}
竞争性解释：${Array.isArray(ideaObj.rivalExplanations) ? ideaObj.rivalExplanations.join('；') : ''}
父实验当前参数：${JSON.stringify(baseConfig)}
关联参考论文：${(Array.isArray(papers) ? papers : []).slice(0, 6).map((p) => `[${p.id || ''}] ${p.title || p.shortName || ''}`).join('；') || '无'}

请输出严格 JSON：
{
  "hypothesis": "H1 可证伪备择假设",
  "nullHypothesis": "H0 零假设",
  "variables": {"independent":["自变量1"],"dependent":["因变量1"],"controls":["控制变量1"]},
  "successCriteria": "明确可量化的成功标准（含多种子与显著性要求）",
  "confoundingChecks": ["ReviewerAblation 混杂检查1", "混杂检查2", "混杂检查3"],
  "ablationMatrix": [
    {"name":"消融臂名称","role":"baseline|full|ablation|control","changedConfig":{"key":"val"},"hypothesis":"本臂验证的假设","rationale":"设计理由"}
  ]
}`;

  try {
    const raw = await ai.callLLM(
      [{ role: 'system', content: sys }, { role: 'user', content: prompt }],
      { temperature: 0.25, maxTokens: 1600, timeoutMs: 26000 }
    );
    const parsed = ai.extractJsonBlock(raw);
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.ablationMatrix) || !parsed.ablationMatrix.length) {
      return offlineDesign;
    }
    const vars = parsed.variables && typeof parsed.variables === 'object' ? parsed.variables : offlineDesign.variables;
    return {
      ok: true,
      skillId: skill.id,
      hypothesis: String(parsed.hypothesis || offlineDesign.hypothesis),
      nullHypothesis: String(parsed.nullHypothesis || offlineDesign.nullHypothesis),
      variables: {
        independent: Array.isArray(vars.independent) && vars.independent.length ? vars.independent.map(String) : offlineDesign.variables.independent,
        dependent: Array.isArray(vars.dependent) && vars.dependent.length ? vars.dependent.map(String) : offlineDesign.variables.dependent,
        controls: Array.isArray(vars.controls) && vars.controls.length ? vars.controls.map(String) : offlineDesign.variables.controls
      },
      successCriteria: String(parsed.successCriteria || offlineDesign.successCriteria),
      confoundingChecks: Array.isArray(parsed.confoundingChecks) && parsed.confoundingChecks.length
        ? parsed.confoundingChecks.map(String)
        : offlineDesign.confoundingChecks,
      ablationMatrix: parsed.ablationMatrix.slice(0, 6).map((arm, idx) => ({
        name: String((arm && arm.name) || `消融组 ${idx + 1}`),
        role: String((arm && arm.role) || 'ablation'),
        changedConfig: normalizePlainObj(arm && arm.changedConfig),
        hypothesis: String((arm && arm.hypothesis) || ''),
        rationale: String((arm && arm.rationale) || '')
      })),
      fallbackUsed: false
    };
  } catch (_) {
    return offlineDesign;
  }
}

/**
 * AuthorAblation 一键批量派生消融子实验卡片（均挂在 basedOn: parentExpId 下）。
 */
function createAblationChildren(ws, parentExpId, ablationMatrix = []) {
  const targetWs = String(ws || store.getConfig().currentWorkspace || '').trim();
  const parent = targetWs && parentExpId ? store.getItem(targetWs, 'experiments', parentExpId) : null;
  if (!parent) throw new Error('父实验不存在：' + parentExpId);
  const arms = Array.isArray(ablationMatrix) ? ablationMatrix : [];
  if (!arms.length) throw new Error('消融矩阵为空');

  const pfm = normalizePlainObj(parent.frontmatter);
  const stamp = new Date().toISOString().slice(0, 10);
  const createdIds = [];
  const baseTs = Date.now();

  arms.forEach((arm, idx) => {
    let childId = `exp-${String(baseTs + idx).slice(-6)}-${idx + 1}`;
    while (store.getItem(targetWs, 'experiments', childId)) {
      childId = `exp-${String(baseTs + idx).slice(-6)}-${idx + 1}-${Math.floor(Math.random() * 90 + 10)}`;
    }
    const mergedCfg = { ...normalizePlainObj(pfm.config), ...normalizePlainObj(arm && arm.changedConfig) };
    const tags = Array.from(new Set((Array.isArray(pfm.tags) ? pfm.tags : []).concat(['消融', String((arm && arm.role) || 'ablation')])));
    const fm = {
      title: String((arm && arm.name) || `${pfm.title || parentExpId} 消融 ${idx + 1}`),
      date: stamp,
      status: '计划中',
      priority: pfm.priority || '中',
      tags,
      goal: pfm.goal || '',
      hypothesis: String((arm && arm.hypothesis) || pfm.hypothesis || ''),
      protocol: [
        pfm.protocol ? pfm.protocol : '',
        arm && arm.rationale ? `\n### 消融设计理由\n${arm.rationale}` : ''
      ].filter(Boolean).join('\n'),
      basedOn: parentExpId,
      relatedIdea: pfm.relatedIdea || '',
      relatedPapers: Array.isArray(pfm.relatedPapers) ? pfm.relatedPapers.slice() : [],
      environment: normalizePlainObj(pfm.environment),
      config: mergedCfg,
      results: { metrics: {}, charts: [], data_files: [], chartConfig: {} },
      conclusion: '',
      nextStep: '',
      failure: {},
      createdAt: stamp,
      updatedAt: stamp
    };
    store.saveItem(targetWs, 'experiments', childId, { frontmatter: fm, body: '' });
    createdIds.push(childId);
  });

  return { ok: true, parentExpId, createdIds };
}

/**
 * 确定性日志异常模式扫描（OOM / NaN / Inf / Divergence / Timeout / Traceback）。
 */
function scanLogAnomalies(logExcerpts = []) {
  const joined = (Array.isArray(logExcerpts) ? logExcerpts : [logExcerpts])
    .map((x) => String(x || ''))
    .join('\n');
  const issues = [];
  if (/cuda out of memory|outofmemoryerror|\boom\b|killed process.*memory/i.test(joined)) {
    issues.push({ type: 'OOM', severity: 'critical', message: '检测到显存/内存溢出（CUDA OOM）', fix: '降低 batch_size、开启 gradient checkpointing / bf16 混合精度或启用梯度累积' });
  }
  if (/\bnan\b|loss\s*[:=]\s*(?:nan|inf)|gradient.*overflow|explod/i.test(joined)) {
    issues.push({ type: 'NaN/Divergence', severity: 'critical', message: '检测到训练损失 NaN/Inf 或梯度爆炸', fix: '降低学习率（如减半）、增加 warmup 步数并开启梯度裁剪（grad_clip=1.0）' });
  }
  if (/traceback \(most recent call last\)|runtimeerror|assertionerror|valueerror|keyerror|filenotfounderror/i.test(joined)) {
    issues.push({ type: 'RuntimeError', severity: 'high', message: '检测到运行时异常/脚本崩溃（Traceback）', fix: '检查报错堆栈对应的张量维度、配置文件键名或数据路径' });
  }
  if (/timeout|timed out|deadline exceeded/i.test(joined)) {
    issues.push({ type: 'Timeout', severity: 'medium', message: '检测到执行超时', fix: '检查数据加载瓶颈（num_workers）或分段保存 checkpoint' });
  }
  return issues;
}

/**
 * AI 实验结果与失败根因诊断 + 负结果台账条目生成（autoresearch + KalarisLabs + statistical-analysis）。
 */
async function analyzeExperimentResults({ exp = {}, parentExp = null, statsSummary = null, logExcerpts = [], skillId = 'statistical-analysis-diagnosis' } = {}) {
  const skill = skills.getSkill(skillId || 'statistical-analysis-diagnosis', 'experiment')
    || skills.listSkills('experiment', { includeContent: true })[0]
    || { id: skillId || 'statistical-analysis-diagnosis', name: 'Statistical Analysis & Failure Diagnosis', content: '' };

  const fm = exp && exp.frontmatter && typeof exp.frontmatter === 'object' ? exp.frontmatter : (exp || {});
  const parentFm = parentExp && parentExp.frontmatter && typeof parentExp.frontmatter === 'object' ? parentExp.frontmatter : (parentExp || null);
  const expId = String((exp && exp.id) || fm.id || 'exp');
  const title = String(fm.title || expId);
  const metrics = normalizePlainObj(fm.results && fm.results.metrics);
  const parentMetrics = parentFm ? normalizePlainObj(parentFm.results && parentFm.results.metrics) : {};
  const logIssues = scanLogAnomalies(logExcerpts);

  // 计算与父实验的主指标变化
  const metricDiffs = [];
  for (const [k, rawV] of Object.entries(metrics)) {
    const v = Number(rawV);
    const pv = Number(parentMetrics[k]);
    if (Number.isFinite(v) && Number.isFinite(pv)) {
      const delta = Number((v - pv).toFixed(4));
      const improved = isLowerBetterMetric(k) ? delta < 0 : delta > 0;
      metricDiffs.push({ key: k, current: v, baseline: pv, delta, improved });
    }
  }

  let verdict = '待多随机种子确认';
  let keepDecision = 'inconclusive';
  const findings = [];
  let failureDiagnosis = '';
  let negativeResultEntry = '';
  const nextConfigPatch = {};

  if (logIssues.length) {
    verdict = '阻塞待排查';
    keepDecision = 'blocked';
    logIssues.forEach((iss) => findings.push(`${iss.message}；建议：${iss.fix}`));
    failureDiagnosis = logIssues.map((iss) => `[${iss.type}] ${iss.message} -> ${iss.fix}`).join('\n');
    if (logIssues.some((i) => i.type === 'OOM')) {
      nextConfigPatch.batch_size = 'halve';
      nextConfigPatch.grad_checkpointing = 'true';
    }
    if (logIssues.some((i) => i.type === 'NaN/Divergence')) {
      nextConfigPatch.lr = 'halve';
      nextConfigPatch.grad_clip = '1.0';
    }
    negativeResultEntry = `[${expId}] ${title}：因 ${logIssues.map((i) => i.type).join('/')} 阻塞失败。配置：${JSON.stringify(normalizePlainObj(fm.config))}。教训：${logIssues[0].fix}`;
  } else if (statsSummary && statsSummary.welch && statsSummary.welch.ok) {
    const p = statsSummary.welch.pValue;
    const diff = statsSummary.welch.meanDiff;
    const sig = statsSummary.welch.significant;
    const dStr = statsSummary.cohensD && statsSummary.cohensD.ok ? `，Cohen's d = ${statsSummary.cohensD.d.toFixed(2)}（${statsSummary.cohensD.magnitude}）` : '';
    findings.push(`统计检验：均值差 Δ = ${diff >= 0 ? '+' : ''}${diff.toFixed(4)}，Welch p = ${p.toFixed(4)}${dStr}`);
    if (statsSummary.lowNWarning) {
      findings.push('警告：样本量 N < 3，统计功效不足，建议补充随机种子后再做最终定论。');
    }
    if (sig && diff > 0) {
      verdict = '支持假设';
      keepDecision = 'keep';
    } else if (sig && diff < 0) {
      verdict = '推翻假设';
      keepDecision = 'discard';
      failureDiagnosis = '实验组在统计显著水平（p < 0.05）下弱于对照基线，应剪枝该改动方向并记入负结果台账。';
      negativeResultEntry = `[${expId}] ${title}：显著退化（Δ=${diff.toFixed(4)}, p=${p.toFixed(4)}），配置=${JSON.stringify(normalizePlainObj(fm.config))}，建议放弃该变体。`;
    } else {
      verdict = '待多随机种子确认';
      keepDecision = 'inconclusive';
      findings.push('差异未达 p < 0.05 显著性阈值，需排查超参或补充随机种子。');
    }
  } else if (metricDiffs.length) {
    const improvedCnt = metricDiffs.filter((m) => m.improved).length;
    const degradedCnt = metricDiffs.filter((m) => !m.improved && m.delta !== 0).length;
    metricDiffs.forEach((m) => {
      findings.push(`指标 ${m.key}：${m.current}（基线 ${m.baseline}，Δ=${m.delta >= 0 ? '+' : ''}${m.delta}，${m.improved ? '正向提升' : m.delta === 0 ? '持平' : '退化'}）`);
    });
    if (improvedCnt > 0 && degradedCnt === 0) {
      verdict = '支持假设';
      keepDecision = 'keep';
    } else if (degradedCnt > improvedCnt) {
      verdict = '推翻假设';
      keepDecision = 'discard';
      failureDiagnosis = `相对父基线（${parentExp.id || 'baseline'}）关键指标出现退化，建议回退该改动并记录负结果台账。`;
      negativeResultEntry = `[${expId}] ${title}：指标相对基线退化（${metricDiffs.map((m) => `${m.key}:${m.delta}`).join(', ')}），配置=${JSON.stringify(normalizePlainObj(fm.config))}。`;
    }
  } else if (Object.keys(metrics).length) {
    const metricText = Object.entries(metrics).map(([k, v]) => `${k}=${v}`).join('，');
    findings.push(`已记录定量指标：${metricText}（尚无对照基线或多种子数据）`);
  } else {
    verdict = '阻塞待排查';
    keepDecision = 'blocked';
    findings.push(`实验「${title}」尚未记录定量指标或有效日志数据`);
    failureDiagnosis = '缺少定量结果指标（results.metrics）与结果日志，请先导入 CSV/JSONL/LOG 或手工填写指标。';
  }

  const nextExperimentPatch = {
    title: `${title}（${keepDecision === 'keep' ? '多种子扩充' : keepDecision === 'blocked' ? '修复重跑' : '机制修正'}）`,
    basedOn: expId,
    configPatch: nextConfigPatch,
    hypothesis: keepDecision === 'keep'
      ? `在 ${expId} 基础上扩展至 >=3 个随机种子与分布外任务验证稳健性。`
      : `修复「${title}」暴露的 ${logIssues[0] ? logIssues[0].type : '退化问题'} 后重新对照基线验证。`
  };

  const markdown = [
    `### 实验诊断报告：${title}`,
    `- **裁决（Keep/Discard/Blocked）**：**${verdict}**（\`${keepDecision}\`）`,
    '',
    '#### 关键发现',
    ...findings.map((f) => `- ${f}`),
    ...(failureDiagnosis ? ['', '#### 失败根因与修复建议', failureDiagnosis] : []),
    ...(negativeResultEntry ? ['', '#### 负结果台账条目', `> ${negativeResultEntry}`] : [])
  ].join('\n');

  const offlineRes = {
    ok: true,
    skillId: skill.id,
    verdict,
    keepDecision,
    findings,
    logIssues,
    failureDiagnosis,
    negativeResultEntry,
    nextExperimentPatch,
    markdown,
    statsSummary: statsSummary || null,
    fallbackUsed: true
  };

  const cfg = store.getConfig() || {};
  if (!(cfg.api && cfg.api.apiKey)) return offlineRes;

  try {
    const sys = '你是资深 ML/机器人实验结果诊断专家（autoresearch + statistical-analysis 范式）。基于真实指标、统计检验和日志片段输出严谨裁决，绝不编造数字。只输出合法 JSON。';
    const prompt = `${skill.content ? `## 诊断 Skill（${skill.name}）\n${String(skill.content).slice(0, 1800)}\n\n` : ''}## 当前实验（${expId} - ${title}）
假设：${fm.hypothesis || '未填'}
参数：${JSON.stringify(normalizePlainObj(fm.config))}
指标：${JSON.stringify(metrics)}
父实验指标：${JSON.stringify(parentMetrics)}
统计摘要：${JSON.stringify(statsSummary || {})}
日志异常扫描：${JSON.stringify(logIssues)}
日志节选：${(Array.isArray(logExcerpts) ? logExcerpts : []).join('\n').slice(0, 1800)}

输出严格 JSON：
{
  "verdict": "支持假设|推翻假设|阻塞待排查|待多随机种子确认",
  "keepDecision": "keep|discard|blocked|inconclusive",
  "findings": ["量化发现1", "量化发现2"],
  "failureDiagnosis": "若失败/阻塞/退化，给出根因与修复动作；否则为空字符串",
  "negativeResultEntry": "若 discard/blocked，给出可归档的负结果台账单句；否则为空字符串",
  "nextExperimentPatch": {"title":"下一版标题","basedOn":"${expId}","configPatch":{},"hypothesis":"下一轮假设"}
}`;
    const raw = await ai.callLLM(
      [{ role: 'system', content: sys }, { role: 'user', content: prompt }],
      { temperature: 0.2, maxTokens: 1200, timeoutMs: 25000 }
    );
    const parsed = ai.extractJsonBlock(raw);
    if (!parsed || typeof parsed !== 'object') return offlineRes;
    const finalVerdict = String(parsed.verdict || verdict);
    const finalKeep = ['keep', 'discard', 'blocked', 'inconclusive'].includes(String(parsed.keepDecision || ''))
      ? String(parsed.keepDecision)
      : keepDecision;
    const finalFindings = Array.isArray(parsed.findings) && parsed.findings.length ? parsed.findings.map(String) : findings;
    const finalFail = String(parsed.failureDiagnosis !== undefined ? parsed.failureDiagnosis : failureDiagnosis);
    const finalNeg = String(parsed.negativeResultEntry !== undefined ? parsed.negativeResultEntry : negativeResultEntry);
    const finalPatch = parsed.nextExperimentPatch && typeof parsed.nextExperimentPatch === 'object'
      ? { ...nextExperimentPatch, ...parsed.nextExperimentPatch }
      : nextExperimentPatch;
    const aiMd = [
      `### 实验诊断报告：${title}`,
      `- **裁决**：**${finalVerdict}**（\`${finalKeep}\`）`,
      '',
      '#### 关键发现',
      ...finalFindings.map((f) => `- ${f}`),
      ...(finalFail ? ['', '#### 失败根因与修复建议', finalFail] : []),
      ...(finalNeg ? ['', '#### 负结果台账条目', `> ${finalNeg}`] : [])
    ].join('\n');

    return {
      ok: true,
      skillId: skill.id,
      verdict: finalVerdict,
      keepDecision: finalKeep,
      findings: finalFindings,
      logIssues,
      failureDiagnosis: finalFail,
      negativeResultEntry: finalNeg,
      nextExperimentPatch: finalPatch,
      markdown: aiMd,
      statsSummary: statsSummary || null,
      fallbackUsed: false
    };
  } catch (_) {
    return offlineRes;
  }
}

/**
 * 汇总工作区内的负结果台账（Negative Result Ledger），防止反复踩入同一死胡同。
 */
function listNegativeResults(ws) {
  const targetWs = String(ws || store.getConfig().currentWorkspace || '').trim();
  if (!targetWs) return [];
  const items = store.listItems(targetWs, 'experiments');
  const out = [];
  for (const it of items) {
    const full = store.getItem(targetWs, 'experiments', it.id);
    if (!full) continue;
    const fm = normalizePlainObj(full.frontmatter);
    const failure = normalizePlainObj(fm.failure);
    const badge = inferKeepBadge(fm);
    const hasNeg = badge === 'discard' || badge === 'blocked' || Boolean(failure.cause || failure.type || fm.negativeResultEntry);
    if (!hasNeg) continue;
    out.push({
      id: full.id,
      title: String(fm.title || full.id),
      date: String(fm.date || ''),
      status: String(fm.status || ''),
      badge,
      basedOn: String(fm.basedOn || ''),
      config: normalizePlainObj(fm.config),
      failureType: String(failure.type || (badge === 'blocked' ? '阻塞异常' : '假设未成立')),
      failureCause: String(failure.cause || fm.negativeResultEntry || fm.conclusion || ''),
      fixAction: String(failure.action || '')
    });
  }
  return out;
}

/**
 * 可复现实验脚本/配置导出（sfb1638/elabftw-templates + 标准 YAML/Shell 骨架）。
 */
function generateReproBundle(exp = {}) {
  const fm = exp && exp.frontmatter && typeof exp.frontmatter === 'object' ? exp.frontmatter : (exp || {});
  const id = String((exp && exp.id) || fm.id || 'exp-001');
  const title = String(fm.title || id);
  const config = normalizePlainObj(fm.config);
  const env = normalizePlainObj(fm.environment);
  const seed = String(env.seed || config.seed || '42');

  const yamlLines = [
    `# Reproducible Experiment Config: ${id}`,
    `experiment_id: "${id}"`,
    `title: "${title.replace(/"/g, '\\"')}"`,
    `based_on: "${String(fm.basedOn || '')}"`,
    `seed: ${/^\d+$/.test(seed) ? seed : `"${seed}"`}`,
    'config:',
    ...(Object.keys(config).length
      ? Object.entries(config).map(([k, v]) => `  ${k}: ${/^-?\d+(?:\.\d+)?$/.test(String(v)) ? v : JSON.stringify(String(v))}`)
      : ['  variant: "baseline"']),
    'environment:',
    `  system: ${JSON.stringify(String(env.system || env.device || ''))}`,
    `  framework: ${JSON.stringify(String(env.framework || ''))}`,
    `  python: ${JSON.stringify(String(env.python || ''))}`,
    `  code_commit: ${JSON.stringify(String(env.codeCommit || ''))}`
  ];

  const cliArgs = Object.entries(config)
    .map(([k, v]) => `  --${String(k).replace(/[^A-Za-z0-9_-]/g, '_')} "${String(v).replace(/"/g, '\\"')}" \\`)
    .join('\n');

  const runScriptSh = [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    `# Experiment: ${id} - ${title}`,
    `EXP_ID="${id}"`,
    `OUT_DIR="outputs/\${EXP_ID}"`,
    'mkdir -p "${OUT_DIR}"',
    'echo "[REPRO] git commit: $(git rev-parse --short HEAD 2>/dev/null || echo unknown)" | tee "${OUT_DIR}/env.log"',
    `for SEED in ${seed} 1024 2025; do`,
    '  echo "[RUN] seed=${SEED}"',
    '  python train.py \\',
    '    --config "config.yaml" \\',
    '    --seed "${SEED}" \\',
    ...(cliArgs ? [cliArgs] : []),
    '    --output-dir "${OUT_DIR}/seed_${SEED}" 2>&1 | tee "${OUT_DIR}/seed_${SEED}.log"',
    'done'
  ].join('\n');

  const elnMarkdown = [
    `# ELN 实验记录卡：${id} · ${title}`,
    `- **日期**：${fm.date || new Date().toISOString().slice(0, 10)} | **状态**：${fm.status || '计划中'} | **基线**：${fm.basedOn || '无'}`,
    `- **研究目标**：${fm.goal || '待填写'}`,
    `- **可证伪假设**：${fm.hypothesis || '待填写'}`,
    '',
    '## 执行协议',
    fm.protocol || '待补充实验步骤',
    '',
    '## 配置快照',
    '```yaml',
    yamlLines.join('\n'),
    '```'
  ].join('\n');

  return {
    ok: true,
    expId: id,
    configYaml: yamlLines.join('\n'),
    runScriptSh,
    elnMarkdown
  };
}

/**
 * 面向 CS/ML 科研的一键运行导入与同步：
 * 支持真实运行目录（Hydra/W&B/HF/Lightning/TensorBoard）、命令行、粘贴日志与 Git 代码快照，
 * 将抽取的配置、指标、曲线 CSV、代码 Diff Patch 写入实验隔离目录。
 */
function ingestRunIntoExperiment(ws, opts = {}) {
  const targetWs = String(ws || store.getConfig().currentWorkspace || '').trim();
  if (!targetWs) throw new Error('未指定工作区');

  const scanned = opts.runDir ? ingestor.scanRunDirectory(opts.runDir) : null;
  const cmdStr = String(opts.command || (scanned && scanned.command) || '').trim();
  const parsedCmd = cmdStr ? ingestor.parseCliCommand(cmdStr) : null;
  const parsedLog = opts.rawLog ? ingestor.parseTrainingLog(opts.rawLog) : null;
  const gitSnap = opts.codeDir ? ingestor.captureCodeSnapshot(opts.codeDir) : null;

  const existing = opts.expId && !opts.createNew ? store.getItem(targetWs, 'experiments', opts.expId) : null;
  const expId = existing ? existing.id : (opts.expId && !opts.createNew ? opts.expId : `exp-${Date.now().toString().slice(-6)}`);
  const oldFm = existing ? normalizePlainObj(existing.frontmatter) : {};
  const stamp = new Date().toISOString().slice(0, 10);

  const mergedConfig = {
    ...normalizePlainObj(oldFm.config),
    ...(scanned ? normalizePlainObj(scanned.config) : {}),
    ...(parsedCmd ? normalizePlainObj(parsedCmd.config) : {})
  };
  const oldResults = normalizePlainObj(oldFm.results);
  const mergedMetrics = {
    ...normalizePlainObj(oldResults.metrics),
    ...(scanned ? normalizePlainObj(scanned.metrics) : {}),
    ...(parsedLog ? normalizePlainObj(parsedLog.finalMetrics) : {})
  };
  const mergedEnv = {
    ...normalizePlainObj(oldFm.environment),
    ...(scanned ? normalizePlainObj(scanned.environment) : {}),
    ...(parsedCmd && parsedCmd.seed ? { seed: parsedCmd.seed } : {}),
    ...(gitSnap && gitSnap.ok ? {
      codeCommit: `${gitSnap.commit}${gitSnap.branch ? ` (${gitSnap.branch})` : ''}${gitSnap.dirty ? ' *dirty' : ''}`
    } : {})
  };

  const detectedFrameworks = Array.from(new Set([
    ...(Array.isArray(oldFm.detectedFrameworks) ? oldFm.detectedFrameworks : []),
    ...(scanned && Array.isArray(scanned.frameworks) ? scanned.frameworks : [])
  ]));
  const logErrors = [
    ...(scanned && Array.isArray(scanned.logErrors) ? scanned.logErrors : []),
    ...(parsedLog && Array.isArray(parsedLog.errors) ? parsedLog.errors : [])
  ];

  // 落盘提取的曲线 CSV 与代码 Diff Patch 到实验隔离附件目录
  const expDir = store.expDataDir(targetWs, expId);
  if (!fs.existsSync(expDir)) fs.mkdirSync(expDir, { recursive: true });
  const savedFiles = Array.isArray(oldResults.data_files) ? oldResults.data_files.slice() : [];
  const writeDataArtifact = (fname, text) => {
    if (!text) return;
    const safeFile = path.basename(fname).replace(/[^A-Za-z0-9._-]/g, '_');
    fs.writeFileSync(path.join(expDir, safeFile), text, 'utf8');
    if (!savedFiles.includes(safeFile)) savedFiles.push(safeFile);
  };
  if (scanned && Array.isArray(scanned.curves)) {
    scanned.curves.forEach((c) => writeDataArtifact(c.fileName, c.csvText));
  }
  if (parsedLog && parsedLog.csvText) {
    writeDataArtifact('pasted_log_curve.csv', parsedLog.csvText);
  }
  if (gitSnap && gitSnap.ok && gitSnap.diffPatch) {
    writeDataArtifact('code_diff.patch', gitSnap.diffPatch);
  }

  const autoStatus = logErrors.length
    ? '阻塞'
    : (Object.keys(mergedMetrics).length ? (oldFm.status === '草稿' || !oldFm.status ? '完成' : oldFm.status) : (oldFm.status || '计划中'));
  const title = String(
    opts.title || oldFm.title || (scanned && scanned.dirName) || (parsedCmd && parsedCmd.script ? `Run ${parsedCmd.script}` : '导入的 CS 实验')
  ).trim();

  const nextFm = {
    ...oldFm,
    title,
    date: oldFm.date || stamp,
    status: autoStatus,
    priority: oldFm.priority || '中',
    tags: Array.from(new Set([...(Array.isArray(oldFm.tags) ? oldFm.tags : []), ...detectedFrameworks])),
    goal: oldFm.goal || '',
    hypothesis: oldFm.hypothesis || '',
    protocol: oldFm.protocol || '',
    basedOn: opts.basedOn !== undefined ? String(opts.basedOn) : (oldFm.basedOn || ''),
    relatedIdea: opts.relatedIdea !== undefined ? String(opts.relatedIdea) : (oldFm.relatedIdea || ''),
    relatedPapers: Array.isArray(oldFm.relatedPapers) ? oldFm.relatedPapers : [],
    command: cmdStr || oldFm.command || '',
    codeDir: String(opts.codeDir || oldFm.codeDir || '').trim(),
    runDir: String(opts.runDir || oldFm.runDir || '').trim(),
    detectedFrameworks,
    checkpoints: (scanned && scanned.checkpoints && scanned.checkpoints.length) ? scanned.checkpoints : (oldFm.checkpoints || []),
    gitSnapshot: gitSnap && gitSnap.ok
      ? { commit: gitSnap.commit, branch: gitSnap.branch, commitMessage: gitSnap.commitMessage, dirty: gitSnap.dirty, diffStat: gitSnap.diffStat }
      : (oldFm.gitSnapshot || undefined),
    environment: mergedEnv,
    config: mergedConfig,
    results: {
      ...oldResults,
      metrics: mergedMetrics,
      charts: Array.isArray(oldResults.charts) ? oldResults.charts : [],
      data_files: savedFiles,
      chartConfig: normalizePlainObj(oldResults.chartConfig)
    },
    conclusion: oldFm.conclusion || '',
    nextStep: oldFm.nextStep || '',
    failure: logErrors.length && !(oldFm.failure && oldFm.failure.cause)
      ? { type: '日志异常', cause: logErrors.slice(0, 3).join('\n'), action: '运行 AI 诊断排查 OOM / NaN / Traceback' }
      : normalizePlainObj(oldFm.failure),
    createdAt: oldFm.createdAt || stamp,
    updatedAt: stamp
  };
  if (!nextFm.gitSnapshot) delete nextFm.gitSnapshot;

  store.saveItem(targetWs, 'experiments', expId, { frontmatter: nextFm, body: (existing && existing.body) || '' });
  return {
    ok: true,
    expId,
    title: nextFm.title,
    configCount: Object.keys(mergedConfig).length,
    metricCount: Object.keys(mergedMetrics).length,
    curveCount: (scanned ? scanned.curves.length : 0) + (parsedLog && parsedLog.csvText ? 1 : 0),
    checkpointCount: (nextFm.checkpoints || []).length,
    frameworks: detectedFrameworks,
    logErrors,
    gitCaptured: Boolean(gitSnap && gitSnap.ok)
  };
}

/** 批量扫描父级输出目录（如 outputs/、lightning_logs/、wandb/），发现所有子实验目录。 */
function batchScanRunsFolder(parentDir) {
  const dir = String(parentDir || '').trim();
  if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new Error('父目录不存在：' + dir);
  }
  const entries = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.'));
  const runs = [];
  for (const ent of entries.slice(0, 30)) {
    const sub = path.join(dir, ent.name);
    try {
      const scanned = ingestor.scanRunDirectory(sub);
      if (Object.keys(scanned.config).length || Object.keys(scanned.metrics).length || scanned.curves.length || scanned.frameworks.length) {
        runs.push({
          dirName: ent.name,
          runDir: sub,
          frameworks: scanned.frameworks,
          configCount: Object.keys(scanned.config).length,
          metricCount: Object.keys(scanned.metrics).length,
          metricsPreview: Object.entries(scanned.metrics).slice(0, 3).map(([k, v]) => `${k}=${v}`).join(', ')
        });
      }
    } catch (_) { /* ignore unreadable subdirs */ }
  }
  return { ok: true, parentDir: dir, runs };
}

/** 将超参 Sweep 矩阵批量落盘为子实验卡片（含精确 command、config 与 basedOn）。 */
function saveSweepChildren(ws, parentExpId, sweepRuns = []) {
  const targetWs = String(ws || store.getConfig().currentWorkspace || '').trim();
  const parent = targetWs && parentExpId ? store.getItem(targetWs, 'experiments', parentExpId) : null;
  const pfm = parent ? normalizePlainObj(parent.frontmatter) : {};
  const list = Array.isArray(sweepRuns) ? sweepRuns.slice(0, 32) : [];
  if (!list.length) throw new Error('Sweep 运行列表为空');
  const stamp = new Date().toISOString().slice(0, 10);
  const createdIds = [];
  const baseTs = Date.now();

  list.forEach((r, idx) => {
    let childId = `exp-${String(baseTs + idx).slice(-6)}-s${idx + 1}`;
    while (store.getItem(targetWs, 'experiments', childId)) {
      childId = `exp-${String(baseTs + idx).slice(-6)}-s${idx + 1}-${Math.floor(Math.random() * 90 + 10)}`;
    }
    const cfg = { ...normalizePlainObj(pfm.config), ...normalizePlainObj(r.mergedConfig || r.overrides) };
    const fm = {
      title: String(r.name || `Sweep #${idx + 1}`),
      date: stamp,
      status: '计划中',
      priority: pfm.priority || '中',
      tags: Array.from(new Set([...(Array.isArray(pfm.tags) ? pfm.tags : []), 'Sweep'])),
      goal: pfm.goal || '',
      hypothesis: pfm.hypothesis || '',
      protocol: pfm.protocol || '',
      basedOn: parent ? parent.id : '',
      relatedIdea: pfm.relatedIdea || '',
      relatedPapers: Array.isArray(pfm.relatedPapers) ? pfm.relatedPapers.slice() : [],
      command: String(r.command || ''),
      codeDir: pfm.codeDir || '',
      runDir: '',
      environment: { ...normalizePlainObj(pfm.environment), ...(cfg.seed ? { seed: String(cfg.seed) } : {}) },
      config: cfg,
      results: { metrics: {}, charts: [], data_files: [], chartConfig: {} },
      conclusion: '',
      nextStep: '',
      failure: {},
      createdAt: stamp,
      updatedAt: stamp
    };
    store.saveItem(targetWs, 'experiments', childId, { frontmatter: fm, body: '' });
    createdIds.push(childId);
  });

  return { ok: true, createdIds };
}

/** 读取实验隔离目录中的 .tfevents 二进制文件并转成 CSV 供图表直接绘制。 */
function readTfeventsForChart(ws, expId, fileName) {
  const df = store.readDataFile(ws, expId, fileName);
  if (!df || !df.path || !fs.existsSync(df.path)) throw new Error('tfevents 文件不存在');
  const buf = fs.readFileSync(df.path);
  return ingestor.parseTfeventsBuffer(buf);
}

/**
 * 面向 CS 顶会论文（NeurIPS/ICML/CVPR/RSS）的多种子自动聚合与 booktabs LaTeX 制表：
 * - 自动忽略 seed/random_seed 等随机性字段，将同配置多种子运行归为同一实验组；
 * - 计算 Mean ± Std、Google Research rliable IQM（四分位均值）及相对基线组的 Welch t-test p 值；
 * - 生成 booktabs LaTeX（\toprule/\midrule/\bottomrule，最优 \textbf，次优 \underline，显著性星号 * / **）。
 */
function aggregateByConfig(ws, expIds = [], opts = {}) {
  const cmp = compareExperiments(ws, expIds, opts);
  const rows = cmp.rows || [];
  const metricKeys = cmp.metricKeys || [];
  const SEED_KEYS = new Set(['seed', 'random_seed', 'trainer.seed', 'run_id', 'output_dir']);

  const groupMap = new Map();
  for (const r of rows) {
    const sigEntries = Object.entries(r.config || {})
      .filter(([k]) => !SEED_KEYS.has(String(k).toLowerCase()))
      .sort((a, b) => a[0].localeCompare(b[0]));
    const cleanTitle = String(r.title || r.id).replace(/[\s_-]*(?:seed|s)\s*[=:-]?\s*\d+\b/gi, '').trim() || r.id;
    const sigKey = sigEntries.length
      ? sigEntries.map(([k, v]) => `${k}=${v}`).join('|')
      : `title:${cleanTitle.toLowerCase()}`;
    const label = sigEntries.length
      ? (r.config.variant ? `${cleanTitle}` : `${cleanTitle}`)
      : cleanTitle;
    let grp = groupMap.get(sigKey);
    if (!grp) {
      grp = { key: sigKey, label, config: Object.fromEntries(sigEntries), runIds: [], metricValues: {} };
      groupMap.set(sigKey, grp);
    }
    grp.runIds.push(r.id);
    for (const mk of metricKeys) {
      const n = Number(r.metrics[mk]);
      if (Number.isFinite(n)) {
        if (!grp.metricValues[mk]) grp.metricValues[mk] = [];
        grp.metricValues[mk].push(n);
      }
    }
  }

  const groups = Array.from(groupMap.values()).map((g) => {
    const stats = {};
    for (const mk of metricKeys) {
      const vals = g.metricValues[mk] || [];
      stats[mk] = vals.length ? Stats.summarize(vals) : null;
    }
    return { ...g, seedCount: g.runIds.length, stats };
  });

  const baseKey = opts.baselineGroupKey || (groups[0] && groups[0].key) || '';
  const baseGroup = groups.find((g) => g.key === baseKey) || groups[0] || null;

  // 计算各指标最优/次优组与相对基线的 Welch t-test p 值
  const rankByMetric = {};
  for (const mk of metricKeys) {
    const lower = isLowerBetterMetric(mk);
    const ranked = groups
      .filter((g) => g.stats[mk] && g.stats[mk].mean !== null)
      .slice()
      .sort((a, b) => lower ? (a.stats[mk].mean - b.stats[mk].mean) : (b.stats[mk].mean - a.stats[mk].mean));
    rankByMetric[mk] = {
      lowerBetter: lower,
      bestKey: ranked[0] ? ranked[0].key : '',
      secondKey: ranked[1] ? ranked[1].key : ''
    };
  }

  for (const g of groups) {
    g.pValues = {};
    for (const mk of metricKeys) {
      if (!baseGroup || g.key === baseGroup.key) continue;
      const a = g.metricValues[mk] || [];
      const b = baseGroup.metricValues[mk] || [];
      if (a.length >= 2 && b.length >= 2) {
        const wt = Stats.welchTTest(a, b);
        if (wt.ok) g.pValues[mk] = wt.pValue;
      }
    }
  }

  const fmtCellTex = (g, mk) => {
    const st = g.stats[mk];
    if (!st || st.mean === null) return '--';
    const meanStr = st.mean.toFixed(2);
    const stdPart = st.n > 1 ? ` \\pm ${st.std.toFixed(2)}` : '';
    const p = g.pValues[mk];
    const star = p !== undefined ? (p < 0.01 ? '^{**}' : p < 0.05 ? '^{*}' : '') : '';
    const rk = rankByMetric[mk];
    if (rk && rk.bestKey === g.key && groups.length > 1) {
      return `$\\mathbf{${meanStr}}${stdPart}${star}$`;
    }
    if (rk && rk.secondKey === g.key && groups.length > 2) {
      return `$\\underline{${meanStr}}${stdPart}${star}$`;
    }
    return `$${meanStr}${stdPart}${star}$`;
  };

  const colSpec = 'l c ' + metricKeys.map(() => 'c').join(' ');
  const booktabsLatex = [
    '% Requires \\usepackage{booktabs}',
    '\\begin{table}[t]',
    '\\centering',
    '\\caption{Main Quantitative Results (Mean $\\pm$ Std across seeds; bold = best, underline = 2nd best; $^* p<0.05, ^{**} p<0.01$).}',
    `\\begin{tabular}{${colSpec.trim()}}`,
    '\\toprule',
    ['Method', 'Seeds', ...metricKeys.map((mk) => `${escapeLatexCell(mk)} ${isLowerBetterMetric(mk) ? '($\\downarrow$)' : '($\\uparrow$)'}`)].join(' & ') + ' \\\\',
    '\\midrule',
    ...groups.map((g) => [escapeLatexCell(g.label), String(g.seedCount), ...metricKeys.map((mk) => fmtCellTex(g, mk))].join(' & ') + ' \\\\'),
    '\\bottomrule',
    '\\end{tabular}',
    '\\end{table}'
  ].join('\n');

  const mdHeaders = ['Method', 'Seeds', ...metricKeys.map((mk) => `${mk} (${isLowerBetterMetric(mk) ? '↓' : '↑'})`), ...metricKeys.map((mk) => `IQM:${mk}`)];
  const markdownTable = groups.length
    ? [
        '| ' + mdHeaders.map(escapeMdCell).join(' | ') + ' |',
        '| ' + mdHeaders.map(() => '---').join(' | ') + ' |',
        ...groups.map((g) => {
          const cells = [
            g.label,
            String(g.seedCount),
            ...metricKeys.map((mk) => {
              const st = g.stats[mk];
              if (!st || st.mean === null) return '-';
              const p = g.pValues[mk];
              const star = p !== undefined ? (p < 0.01 ? '**' : p < 0.05 ? '*' : '') : '';
              const txt = `${st.mean.toFixed(2)}${st.n > 1 ? ` ± ${st.std.toFixed(2)}` : ''}${star}`;
              return rankByMetric[mk] && rankByMetric[mk].bestKey === g.key && groups.length > 1 ? `**${txt}**` : txt;
            }),
            ...metricKeys.map((mk) => {
              const st = g.stats[mk];
              return st && st.iqm !== null ? st.iqm.toFixed(2) : '-';
            })
          ];
          return '| ' + cells.map(escapeMdCell).join(' | ') + ' |';
        })
      ].join('\n')
    : '（暂无可聚合实验）';

  return {
    ok: true,
    groups,
    metricKeys,
    baselineGroupKey: baseGroup ? baseGroup.key : '',
    rankByMetric,
    booktabsLatex,
    markdownTable
  };
}

module.exports = {
  captureEnvironment,
  compareExperiments,
  designExperiment,
  createAblationChildren,
  analyzeExperimentResults,
  scanLogAnomalies,
  listNegativeResults,
  generateReproBundle,
  // CS 实用工程接入与分析能力
  parseCliCommand: ingestor.parseCliCommand,
  parseTrainingLog: ingestor.parseTrainingLog,
  parseTfeventsBuffer: ingestor.parseTfeventsBuffer,
  scanRunDirectory: ingestor.scanRunDirectory,
  captureCodeSnapshot: ingestor.captureCodeSnapshot,
  compareCodeCommits: ingestor.compareCodeCommits,
  generateSweepMatrix: ingestor.generateSweepMatrix,
  ingestRunIntoExperiment,
  batchScanRunsFolder,
  saveSweepChildren,
  readTfeventsForChart,
  aggregateByConfig
};
