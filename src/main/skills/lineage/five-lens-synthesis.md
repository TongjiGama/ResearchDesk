---
id: five-lens-synthesis
name: Five-Lens Synthesis · 五维文献综述与对比矩阵
domain: lineage
version: "1.0"
badge: 五维综述
tier: standard
githubRepo: https://github.com/NeuraLiying/research-weave-skill
license: MIT
attribution: Adapted from NeuraLiying/research-weave-skill (5-lens synthesis), K-Dense-AI/scientific-agent-skills (literature-review), and AkariAsai/OpenScholar citation-grounding checks.
workflowSteps:
  - 历史演化透镜（Historical Evolution）：梳理核心问题范式迁徙
  - 证据冲突透镜（Support & Conflict）：定位结论一致点与方法分歧点
  - 研究相关透镜（Relevance Mapping）：对照当前课题区分核心精读与背景参考
  - 趋势收敛透镜（Convergence & Gaps）：识别收敛共识与尚未攻克的瓶颈
  - 对比矩阵与阅读队列（Matrix & Reading Queue）：生成六列横向对比表与最优精读顺序
summary: 借鉴 GitHub research-weave-skill、K-Dense literature-review 与 OpenScholar：通过五维透镜剖析文献关系，产出结构化横向对比矩阵、渐进式阅读队列与带引用校验的研究缺口。
---

# Five-Lens Synthesis · 五维文献综述与对比矩阵规范

来源参考：[NeuraLiying/research-weave-skill](https://github.com/NeuraLiying/research-weave-skill)（MIT）、[K-Dense-AI/scientific-agent-skills](https://github.com/K-Dense-AI/scientific-agent-skills)（MIT）、[AkariAsai/OpenScholar](https://github.com/AkariAsai/OpenScholar)（Apache-2.0）。

## 1. 五维分析透镜（Five Lenses）
1. **历史演化（History）**：按时间与范式梳理问题如何从早期原型演进到当前主流。
2. **证据支持与冲突（Evidence Support & Conflict）**：明确指出哪些论文相互印证，哪些论文在核心假设、表征设计或评估结论上存在直接分歧。
3. **课题相关性（Relevance）**：区分直接支撑当前课题的核心方法论文与外围背景工作。
4. **收敛与空白（Convergence & Gaps）**：提炼领域已形成共识的组件，以及多篇论文共同暴露却尚未解决的系统性局限。
5. **渐进阅读队列（Prioritized Reading Queue）**：按「先奠基概念 -> 再核心基线 -> 后前沿变体」排序，为每篇推荐给出具体阅读关注点。

## 2. 结构化文献对比矩阵（Six-Column Comparative Matrix）
为每篇论文提取以下六个可横向比较的维度（缺失信息标注「摘要未明示」，不得杜撰）：
- `task`：研究任务与应用场景
- `method`：核心方法与关键机制
- `assumption`：隐含或显式核心假设
- `dataset`：主要数据集 / 仿真基准 / 真机环境
- `metric`：主要评估指标
- `limitation`：局限性、失败模式或计算/数据瓶颈

## 3. OpenScholar 式引用核验准则
- 所有跨论文综合判断、分歧点与研究缺口都必须附带输入中存在的 `evidencePaperIds`。
- 任何未出现在输入论文列表中的编号不得作为引用输出。
