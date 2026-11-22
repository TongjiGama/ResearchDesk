---
id: chain-of-ideas
name: Chain-of-Ideas · 文献链渐进式 Idea 孵化
domain: idea
version: "1.0"
badge: 文献链孵化
tier: core
githubRepo: https://github.com/DAMO-NLP-SG/CoI-Agent
license: MIT
attribution: Adapted from DAMO-NLP-SG/CoI-Agent (Chain-of-Ideas progressive synthesis) and JinheonBaek/ResearchAgent structured problem-method-experiment formulation.
workflowSteps:
  - 按时间与演进关系串联输入论文，构造文献发展链（Literature Chain）
  - 抽取相邻节点间的「遗留瓶颈 -> 局部修补 -> 新暴露局限」演进张力
  - 沿文献链向下一跳外推，生成 2-4 个差异化的候选研究假设
  - 按 ResearchAgent 规范补齐问题定义、可证伪假设、方法机制与验证计划
  - 强制绑定支撑文献 ID 与至少一条竞争性解释（Rival Explanation）
summary: 借鉴 GitHub CoI-Agent 与 ResearchAgent：将论文脉络中的文献演进链直接转化为结构化、可证伪的候选科研 Idea，确保每个灵感都有明确文献锚点、机制假设与实验验证路径。
---

# Chain-of-Ideas · 文献链渐进式 Idea 孵化规范

来源参考：[DAMO-NLP-SG/CoI-Agent](https://github.com/DAMO-NLP-SG/CoI-Agent)、[JinheonBaek/ResearchAgent](https://github.com/JinheonBaek/ResearchAgent)。

## 1. Chain-of-Ideas 构造原则
- 禁止脱离文献凭空泛泛而谈；必须先识别输入论文的演进序列 `P1 -> P2 -> ... -> Pk`。
- 明确每一步演进解决了什么旧问题、又引入了什么新代价（例如：动作离散化提升了训练吞吐，但牺牲了精细连续控制精度或长视野动力学一致性）。
- 生成的多个候选 Idea 必须在「核心机制路线」上显著分化（例如：表征层改进 vs 训练目标层改进 vs 推理规划层改进），避免同义反复。

## 2. 结构化 Idea 必填要素
每个候选 Idea 必须包含可检验的科研要素：
- **problem**：聚焦的具体科研痛点，避免宏大空泛表述。
- **gap**：现有文献为何尚未解决该问题（结合具体论文局限）。
- **hypothesis**：清晰的因果与可证伪陈述（若引入机制 X，则在条件 Y 下指标 Z 应优于基线，且在消融 X 后退化）。
- **methodology**：可执行的技术方案、模块改动点与基线对比锚点。
- **assumptions**：方案成立所依赖的前提条件（2-3 条）。
- **rivalExplanations**：即使实验指标上升，也可能由哪些非机制因素造成（如参数量增加、数据增广、超参微调）。
- **validationPlan**：基准数据集、核心指标、关键消融组与最低成功标准。
- **groundedPapers**：直接启发的本地论文 ID 列表。
