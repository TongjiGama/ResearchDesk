---
id: hypothesis-critique
name: Hypothesis Critique & SciMON Pivot · 对抗评审与新颖性转向
domain: idea
version: "1.0"
badge: 对抗评审
tier: standard
githubRepo: https://github.com/K-Dense-AI/scientific-agent-skills
license: MIT
attribution: Adapted from K-Dense-AI/scientific-agent-skills (hypothesis-generation & scientific-brainstorming, MIT) and EagleW/SCIMON novelty-driven pivot methodology.
workflowSteps:
  - 审查假设是否可证伪、变量是否可分离、边界条件是否清晰
  - 执行五维顶会评审打分（新颖性 / 可行性 / 清晰度 / 重要性 / 文献扎根度）
  - 主动构造竞争性解释（Rival Explanations）与最致命的审稿人攻击点
  - 对照本地库与多源外部检索结果评估重合度（Novelty Check）
  - 针对高重合风险生成 SciMON 式差异化转向建议与修订版假设
summary: 借鉴 GitHub K-Dense scientific-agent-skills 与 SciMON：以严谨审稿人视角对科研 Idea 进行五维对抗评审、暴露竞争性解释，并在新颖性查重发现重合时给出具体差异化转向方案。
---

# Hypothesis Critique & SciMON Pivot · 对抗评审与新颖性转向规范

来源参考：[K-Dense-AI/scientific-agent-skills](https://github.com/K-Dense-AI/scientific-agent-skills)（MIT）、[EagleW/SCIMON](https://github.com/EagleW/Scientific-Inspiration-Machines-Optimized-for-Novelty)。

## 1. 五维评审量表（1-10 分，严格区分档次）
- **novelty（新颖性）**：机制是否超越简单拼接；与近期顶会及预印本是否有本质差异。
- **feasibility（可行性）**：在合理算力、数据与工程周期内（如本科/研究生课题周期）能否复现基线并完成消融验证。
- **clarity（清晰度）**：问题、假设、变量与验证标准是否明确且可证伪。
- **significance（重要性）**：若假设成立，对目标领域核心瓶颈的实质推进有多大。
- **groundedness（文献扎根度）**：是否建立在真实文献证据与准确局限分析之上。

## 2. 竞争性解释与致命缺陷排查
评审必须避免礼貌空话，至少指出 2-3 条具体可操作的弱点与竞争性解释：
- 是否存在「性能提升来自更多参数/更长训练而非所提机制」的混杂？
- 基线是否公平且足够新？
- 假设失败时，实验是否能明确区分「机制无效」与「实现/超参欠佳」？

## 3. SciMON 式新颖性转向策略
当检索发现高度相似论文时，提出 2-3 条可落地的差异化转向路径：
1. **机制深挖（Mechanism Shift）**：将启发式模块升级为具备理论/结构约束的新表征。
2. **场景迁移与极端边界（Regime Shift）**：聚焦已有工作失效的关键场景（如长视野、部分可观测、跨本体/低样本）。
3. **理论与诊断反演（Diagnostic Inversion）**：证明已有方法的隐含假设在某条件下失效，并针对该反例构建简洁修正。
