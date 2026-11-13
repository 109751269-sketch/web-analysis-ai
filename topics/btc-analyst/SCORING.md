# 打分链路总览（哪个文件说了算）

> 结论：**口径只在 `scoring.config.json`，分数只由 `score_periodic.js` 产出，结算只由 `verify_calls.js` 产出。**
> 其余脚本是历史版本，产出过已发布的报告，**冻结不再改**。

## 一、现行（唯一权威）

| 文件 | 作用 | 产出 |
|---|---|---|
| `scoring.config.json` | **口径单一来源**：权重、门槛、周期天数、节点定义、档位切线 | 被 `score_periodic.js` 读取 |
| `score_periodic.js` | 周期快照评分器（v4）：大周期终点方向 ≥10%、同日 ±45 天基准、顶底提前预判、样本门槛 | `output/scorecard/scorecard_<asof>.json/.md` |
| `verify_calls.js` | 观点承诺台账判定器：down/up/bottom/reject 四类判据写死在代码里 | `state/calls_ledger.json` 的 status + `output/x_btc_20261113/calls_verification_*.md` |
| `state/calls_ledger.json` | 每日新增观点的 append-only 台账（含起算日/结算日/判据） | 输入 |

调用关系：

```
scoring.config.json ──► score_periodic.js ──► scorecard_<asof>.json/.md ──► 02 专题页面
state/calls_ledger.json ──► verify_calls.js ──► 判定结果（不改写，只追加）
                    └────► score_periodic.js（台账里的命中/未中并入周期统计）
output/x_btc_2026/preds/*.json（341 条历史预测）──► score_periodic.js
```

## 二、历史版本（已于 2026-11-13 从本仓库删除，仅留档说明）

| 已删文件 | 代次 | 用途 | 为什么删 |
|---|---|---|---|
| `score_engine.js` | v1 | 最初的 8% 触及判定 | 无基准校正 |
| `verify_score.js` | v1 | 逐条预测验证 | 无 horizon 分层 |
| `verify_score2.js` | v2 | 逐条验证（加模糊容错） | 同上 |
| `score_final.js` | **v3** | 4 口径综合，产出 `final_v3.json`（02 报告 11-11 原版依据） | **完全不读 `horizon`**，喊半年大顶与喊下周反弹同尺；节点项 82/87 账号 0 命中 |
| `sensitivity.js` | v3 附件 | 4 口径稳健性检验 | 依赖 v3 判定 |
| `ledger.js` | v3 附件 | 生成 `ledger.json` | **读的是 `final_v2.json`**，与 `final_v3` 有 14/61 账号分数冲突 |
| `score_cycle.js` | v4 原型 | 首次按周期分层重算，产出 `cycle_score.json`（13 个可排名） | 逻辑已被 `score_periodic.js` 吸收，仅保留为对照 |
| `daily_roll.js` | 原型 | 每日滚动状态（`state/predictions.jsonl`、`credibility_snapshot.json`） | 与 `score_periodic.js` 口径不同，**不要把它的分数与 02 榜单混用** |

## 三、口径改动的规矩

1. 改口径 → 只改 `scoring.config.json`，并把 `version` 升一位（v4 → v5）。
2. 同步更新 02 页面「口径版本与修订记录」小节，写清**改了什么、为什么、对榜单影响**。
3. 改完必须跑一次回归：用同一 `--asof` 跑改前改后，对比入榜名单差异，把差异写进 commit message。
4. 已发布的旧报告不追改；需要新口径就新建 `blogger-scoring/<YYYY-MM-DD>/`。

## 四、文件位置

- 脚本与状态：`F:/despseekharness/crawler/`
- 报告站工作副本：`F:/despseekharness/crawler/repo/btc-report/`
- 快照输出：`F:/despseekharness/crawler/output/scorecard/`
- 历史预测语料：`F:/despseekharness/crawler/output/x_btc_2026/preds/`（12 个 batch 文件，去重后 341 条）
