---
id: research-genealogy
name: Research Genealogy · 学术谱系与骨干演进
domain: lineage
version: "1.0"
badge: 谱系演进
tier: core
githubRepo: https://github.com/unumbrela/PaperWeave
license: MIT
attribution: Adapted from unumbrela/PaperWeave (research-genealogy) and belinghy/paper-lineage Core Backbone DAG methodology for local Electron execution.
workflowSteps:
  - 识别奠基工作（Foundation）与核心问题定义（Problem Formulation）
  - 沿有向引用与方法传承抽取骨干 DAG，剔除低信噪比耦合噪音
  - 划分技术演进阶段（Eras）与并行方法分支（Branches）
  - 标注演进边语义（builds_on / extends / contrasts / replaces / evaluates）
  - 提炼尚未闭合的技术前沿缺口（Research Gaps）并严格绑定本地论文 ID
summary: 借鉴 GitHub PaperWeave 与 paper-lineage：从本地与引文库论文中梳理「奠基 -> 问题演进 -> 技术分支 -> 前沿突破」学术谱系，抽取无环骨干 DAG 并输出严格基于证据的演进叙事与研究缺口。
---

# Research Genealogy · 学术谱系与骨干演进规范

来源参考：[unumbrela/PaperWeave](https://github.com/unumbrela/PaperWeave)（MIT）、[belinghy/paper-lineage](https://github.com/belinghy/paper-lineage)。本规范用于驱动科研台的「论文脉络」AI 谱系综合引擎。

## 1. 节点角色分类（Node Roles）
对输入文献集合中的每一篇论文，仅依据标题、发表时间、引用位置与摘要证据分配角色：
- **foundation（奠基工作）**：提出核心范式、问题形式化、关键基准或被后续多篇论文直接继承的早期源头工作。
- **bridge（承前启后）**：解决前序范式的关键瓶颈，连接两个阶段或融合两条技术路线的枢纽节点。
- **branch（分支探索）**：在同一问题下提出差异化架构、表征或训练范式的代表性工作。
- **frontier（前沿突破）**：近期在效率、泛化、规模化或新假设上推进边界的最新工作。
- **survey（综述/基准）**：系统梳理领域脉络或提供核心评估基准的论文。

## 2. 演进边语义（Typed Evolution Edges）
只建立有明确时间/方法/引用依据的有向关系，禁止臆造引用：
- `builds_on`：直接继承前作架构、表征或训练目标。
- `extends`：将前作扩展到新任务、新模态、更大规模或新泛化场景。
- `contrasts`：针对前作核心假设提出对立或替代路线（如隐式动力学 vs 显式像素世界模型）。
- `replaces`：以更优机制替代前作关键组件（如离散动作 tokenizer 替代连续扩散头）。
- `evaluates`：对前作方法提供基准评估、诊断分析或失败边界验证。

## 3. 严格证据约束（Anti-Hallucination & Citation Grounding）
- 每个论断与每条研究缺口都必须绑定输入集合中真实存在的 `[paperId]`。
- 严禁编造输入列表之外的论文 ID、作者名、数据集分数或未提及的实验结论。
- 若某些论文缺少摘要或细节，明确标注「资料有限」，只做元数据与引文结构层面的归类。
