---
id: cs-ml-engineering-workflow
name: CS/ML Experiment Engineering · 计算机科研工程追踪与论文制表
domain: experiment
version: "1.0"
badge: CS 工程
tier: core
githubRepo: https://github.com/SwanHubX/SwanLab
license: Apache-2.0
attribution: Adapted from SwanHubX/SwanLab, ashleve/lightning-hydra-template, iterative/dvc (DVCLive), and google-research/rliable for zero-friction CS/ML experiment tracking.
workflowSteps:
  - 直接从真实训练命令行（torchrun/Hydra/argparse）或输出目录（Hydra/W&B/HF/Lightning/TensorBoard）自动采集配置与指标，拒绝纯手工录入
  - 每次关键实验绑定真实代码仓 Git Commit 与未提交代码 Diff Patch，确保任意历史指标可精确定位代码改动
  - 通过超参 Sweep 矩阵生成多卡并发队列、tmux 会话与 Slurm Array 脚本，系统覆盖多随机种子
  - 使用 Google Research rliable IQM 与 Mean±Std 按非种子配置自动聚合多种子，并导出 NeurIPS/ICML 标准 booktabs LaTeX 表格
summary: 面向计算机/机器学习/机器人科研：借鉴 SwanLab、Hydra-Lightning、DVCLive 与 Google rliable，打通「命令行/日志/输出目录自动接入 -> Git Diff 绑定 -> Sweep 集群脚本 -> 多种子 IQM 聚合与顶会 booktabs LaTeX 制表」全工程闭环。
---

# CS/ML Experiment Engineering · 计算机科研工程追踪规范

来源参考：[SwanHubX/SwanLab](https://github.com/SwanHubX/SwanLab)、[ashleve/lightning-hydra-template](https://github.com/ashleve/lightning-hydra-template)、[iterative/dvc](https://github.com/iterative/dvc)、[google-research/rliable](https://github.com/google-research/rliable)。

## 1. 零手工录入原则（Zero-Friction Ingestion）
- 训练前：优先保存完整启动命令（含 `CUDA_VISIBLE_DEVICES`、启动器与超参），并自动解析为结构化 `config`。
- 训练中/后：直接绑定本地输出目录或粘贴终端输出，自动从 `.hydra/config.yaml`、`trainer_state.json`、`wandb-summary.json`、`events.out.tfevents.*`、`metrics.csv` 或 `.log` 同步最新指标、训练曲线与 Checkpoint 路径。

## 2. 代码可复现锚点（Git-Native Provenance）
- 任何需要写入论文的主实验必须记录代码仓路径、Git Commit 与未提交改动 `code_diff.patch`。
- 对比两次实验指标突变时，同步审查「超参 Diff + 代码 Git Diff」，杜绝「跑出高分却找不回对应代码版本」的事故。

## 3. 多种子聚合与顶会制表（rliable + booktabs）
- 同一实验变体至少运行 3 个独立随机种子（如 `42, 1024, 2025`）。
- 报告 `Mean ± Std`、抗异常值四分位均值（`IQM`）以及相对基线的 Welch t-test 显著性标记；导出 `\toprule / \midrule / \bottomrule` `booktabs` LaTeX 表格并自动加粗最优、下划线次优。
