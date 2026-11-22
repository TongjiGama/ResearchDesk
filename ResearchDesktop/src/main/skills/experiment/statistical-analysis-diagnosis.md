---
id: statistical-analysis-diagnosis
name: Statistical Analysis & Failure Diagnosis · 统计检验、诊断与负结果台账
domain: experiment
version: "1.0"
badge: 统计诊断
tier: standard
githubRepo: https://github.com/karpathy/autoresearch
license: MIT
attribution: Adapted from K-Dense-AI/scientific-agent-skills (statistical-analysis, MIT), karpathy/autoresearch (Keep/Discard hypothesis tracking), and KalarisLabs/research-agent-skills (Negative Result Ledger).
workflowSteps:
  - 汇总多种子统计量（N / Mean / Std / 95% CI），自动触发 N < 3 小样本警示
  - 执行基线对照显著性检验（Welch t-test / Mann-Whitney U）与效应量评估（Cohen's d）
  - 扫描实验日志（OOM / NaN / 梯度爆炸 / 指标退化）定位根因
  - 给出明确 Keep / Discard / Blocked 裁决并生成负结果台账条目
  - 输出下一版本基于当前实验的最小改动配置补丁与 Idea 回流摘要
summary: 借鉴 GitHub K-Dense statistical-analysis、autoresearch 与 KalarisLabs：结合纯 JS 统计检验与日志扫描，对实验结果给出严谨的 Keep/Discard/Blocked 裁决、根因诊断、负结果台账与下一轮实验补丁。
---

# Statistical Analysis & Failure Diagnosis · 统计检验、诊断与负结果台账规范

来源参考：[K-Dense-AI/scientific-agent-skills](https://github.com/K-Dense-AI/scientific-agent-skills)（MIT）、[karpathy/autoresearch](https://github.com/karpathy/autoresearch)、[KalarisLabs/research-agent-skills](https://github.com/KalarisLabs/research-agent-skills)。

## 1. 统计严谨性准则
- 单次随机种子提升不足以宣称假设成立；样本量 `N < 3` 时必须标注小样本警告并要求补充多种子。
- 对比两组多种子结果时，同时报告均值差（`Δ`）、相对变化（`%Δ`）、双侧 p 值（Welch t-test / 非参数 Mann-Whitney U）以及效应量（Cohen's d）。
- 不得把数值微弱且 `p >= 0.05` 的波动解读为「显著提升」。

## 2. 两层裁决与死胡同剪枝（Keep / Discard / Blocked）
- **支持假设（keep）**：主指标相对基线呈稳定正向提升且无严重代价退化，可保留为新基线。
- **推翻假设（discard）**：实验执行正常但指标无提升或明显退化，应果断剪枝并写入负结果台账，避免重复踩坑。
- **阻塞待排查（blocked）**：日志出现 OOM、NaN/Inf、训练不收敛或脚本报错，先修复工程/数值问题再评判科学假设。

## 3. 负结果台账（Negative Result Ledger）
每次失败或指标退化都必须沉淀一条结构化记录：
- 失败配置与改动点；
- 现象与定量表现（或关键报错行）；
- 根因假设与教训（后续实验必须规避的条件）。
