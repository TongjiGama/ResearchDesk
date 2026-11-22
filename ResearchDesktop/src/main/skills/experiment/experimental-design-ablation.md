---
id: experimental-design-ablation
name: Experimental Design & Ablation · 科学实验设计与双视角消融
domain: experiment
version: "1.0"
badge: 消融设计
tier: core
githubRepo: https://github.com/K-Dense-AI/scientific-agent-skills
license: MIT
attribution: Adapted from K-Dense-AI/scientific-agent-skills (experimental-design, MIT), ai-scientist-bench/ablation-bench (AuthorAblation / ReviewerAblation), and fostiropoulos/ablator.
workflowSteps:
  - 形式化零假设（H0）与备择假设（H1）及量化成功判据
  - 明确自变量（Independent）、因变量（Dependent）与控制变量（Controls）
  - AuthorAblation：构造单变量递进/移除的对照消融矩阵（一键派生子实验）
  - ReviewerAblation：执行混杂因素、算力公平性、数据泄漏与多种子检查清单
  - 输出可复现配置模板与启动脚本骨架
summary: 借鉴 GitHub K-Dense experimental-design 与 ablation-bench：在运行实验前建立 H1/H0、三类变量与 ReviewerAblation 混杂检查表，并自动生成可一键落盘的 AuthorAblation 消融实验矩阵。
---

# Experimental Design & Ablation · 科学实验设计与双视角消融规范

来源参考：[K-Dense-AI/scientific-agent-skills](https://github.com/K-Dense-AI/scientific-agent-skills)（MIT）、[ai-scientist-bench/ablation-bench](https://github.com/ai-scientist-bench/ablation-bench)、[fostiropoulos/ablator](https://github.com/fostiropoulos/ablator)。

## 1. 事前实验设计（Pre-Collection DOE）
- **H1（研究假设）与 H0（零假设）**：明确需要被数据拒绝的零假设，防止事后合理化。
- **三类变量分离**：
  - `independent`：每次实验组严格改变的核心模块开关或超参数（单变量原则）。
  - `dependent`：主指标与辅助诊断指标（含效率/显存/推理延迟等代价指标）。
  - `controls`：必须跨组锁死的常数（随机种子集合、数据集划分、训练步数、优化器与硬件预算）。

## 2. AuthorAblation 消融矩阵设计
标准消融矩阵至少包含以下对照臂：
1. **Baseline（锚点基线）**：无核心改动，验证本地复现与文献报告口径一致。
2. **Full Proposed（完整方案）**：引入核心机制改动。
3. **Leave-One-Out 消融变体**：逐一移除或替换单个子模块，隔离真实增益来源。
4. **Control / Sensitivity 对照**：控制参数量/算力持平，排除「仅靠更大模型获益」的替代解释。

## 3. ReviewerAblation 审稿人混杂审计清单
- 是否存在训练集/验证集数据泄漏或评测脚本不一致？
- 基线是否获得同等超参调优与计算预算？
- 是否规划了至少 3 个随机种子以量化方差与 95% 置信区间？
- 是否记录了代码 Commit、依赖版本与完整配置快照？
