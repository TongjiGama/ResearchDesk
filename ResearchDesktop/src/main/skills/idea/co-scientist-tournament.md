---
id: co-scientist-tournament
name: Co-Scientist Tournament · 成对辩论排名、进化与实验回流
domain: idea
version: "1.0"
badge: Elo 进化
tier: advanced
githubRepo: https://github.com/guy915/Open-Co-Scientist
license: Apache-2.0
attribution: Adapted from llnl/open-ai-co-scientist, guy915/Open-Co-Scientist (pairwise Elo tournament & evolution), and ChicagoHAI/hypothesis-generation (HypoRefine experiment feedback).
workflowSteps:
  - 对候选 Idea 进行两两成对辩论比较，而非容易失真的绝对打分
  - 使用标准 Elo 评分系统（初始 1500，K=32）汇总胜负并输出客观排序
  - 提取排名前列方案的互补优势与评审弱点，演化合成更强的新一代 Idea
  - 接收实验完成或失败结论，执行 HypoRefine 假设修正与极性判定
summary: 借鉴 GitHub Open-Co-Scientist 与 HypoGeniC/HypoRefine：通过两两成对辩论 Elo 锦标赛筛选最优研究方向，融合头部 Idea 生成演化方案，并将实验结果结构化回流修正原假设。
---

# Co-Scientist Tournament · 成对辩论、进化与实验回流规范

来源参考：[guy915/Open-Co-Scientist](https://github.com/guy915/Open-Co-Scientist)、[llnl/open-ai-co-scientist](https://github.com/llnl/open-ai-co-scientist)、[ChicagoHAI/hypothesis-generation](https://github.com/ChicagoHAI/hypothesis-generation)。

## 1. 成对辩论锦标赛原则（Pairwise Elo Debate）
- 相比单独给每个 Idea 打绝对分，两两直接对比更能揭示「哪一个假设更可证伪、更有区分度、更适合当前算力预算落地」。
- 每场对决必须说明胜出理由（机制清晰度、可行性与预期增益的权衡），不得以字数长短作为评判标准。

## 2. 杂交进化规则（Hybrid Evolution）
- 从排名前列的 Idea 中分别抽取最强机制与最稳健的验证设计，结合评审中暴露的弱点进行针对性修补。
- 避免「把两个复杂方法硬拼在一起」导致算力翻倍；优先保留最简洁、可单变量消融的核心机制。

## 3. 实验回流修正（HypoRefine Loop）
当关联实验得出定量或失败结论后，按证据极性更新 Idea：
- **supports（支持）**：强化假设置信度，提出边界压力测试或跨基准泛化实验。
- **contradicts（反驳）**：明确记录哪条前提假设被证伪，修正假设或提出最小化替代机制。
- **inconclusive（未决/阻塞）**：指出工程或统计瓶颈（如种子数不足、OOM），保持假设待检验并给出排查步骤。
