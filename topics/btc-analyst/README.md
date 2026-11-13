# BTC 博主预测能力评测管线（v4 · 2026-11-13）

> `web-analysis-ai` 技能的专题档案。**只保留现行代码与最新结论**；已废弃的 v1–v3 打分脚本（`score_final.js` / `ledger.js` / `sim_trade.js` / `build_html.js`）已于 2026-11-13 删除，历史报告页面仍在 `btc-report` 仓库留档。
> 数据外置在工作区（`F:\despseekharness\crawler\`），不进本仓库。

## 回答什么问题

给一个推特账号清单，判断**谁对 BTC 走势的判断有稳定能力**，并按此更新 `btc-report` 仓库的 02 专题。

核心前提：**不能直接算胜率**。2026 年随机日期盲猜涨/跌都有约 2/3 命中；且「喊半年大顶」与「喊下周反弹」必须用不同尺子量。

## 文件一览

| 文件 | 作用 |
|---|---|
| `SCORING.md` | **先读这个**：哪些脚本是权威、哪些已废弃、口径改了怎么升版本 |
| `scoring.config.json` | **口径唯一来源**：周期天数、方向阈值、基准邻域、权重、门槛、档位切线、四个拐点节点 |
| `score_periodic.js` | 周期快照评分器：按 `asof` 截断行情 → 大周期终点方向 ≥10% 结算 → 扣同日基准 → 顶底提前预判加权 → 样本门槛 → 输出 `scorecard_<asof>.json/.md` |
| `verify_calls.js` | 观点承诺台账判定器：`down`/`up`/`bottom`/`reject` 四类判据写死，到期自动结算 |
| `PRED_SPEC.md` | 给 LLM 的抽取规范（date/dir/target/level/**horizon**/quote） |
| `FINDINGS.md` | **最新结论**：谁有证据、谁没有、能不能跟 |
| `paths.js` | 数据根解析（`BTC_DATA_DIR` > 工作区 > 本地 `data/`） |
| `freeze_digests.js` | 推文冻结成 `[YYYY-MM-DD] 正文` 快照，保证可复现 |
| `audit_preds.js` | 防编造：每条 `quote` 回原文 substring 校验，必须 0 未命中 |

## 数据从哪来（都在工作区）

```
F:/despseekharness/crawler/
├── output/x_btc_2026/preds/*.json        341 条历史预测（LLM 逐条精读，含 horizon）
├── output/x_btc_2026/btc_daily.json      BTC 日线（价格唯一来源）
├── state/calls_ledger.json               每日新增观点的 append-only 台账
└── output/scorecard/                     快照输出
```

路径可用环境变量覆盖：`BTC_CRAWLER_ROOT` / `BTC_PREDS_ROOT` / `BTC_LEDGER` / `BTC_SCORECARD_DIR` / `BTC_SCORING_CONFIG`。

## 两条命令

```bash
# 每日/到期：结算台账（判据写死，不改写历史结论）
node verify_calls.js

# 月末/季末：出能力快照（榜单）
node score_periodic.js --asof=2026-11-30 --window=365
```

## 节奏（为什么不是每天排名）

| 频率 | 做什么 | 产出 |
|---|---|---|
| 每次抓取 | 01（行情）/ 03（观点）+ 台账追加与到期结算 | 不排名 |
| 每月 1 日 | `score_periodic.js` | 02 周期快照（达标才排） |
| 每年 12-31 | 全量重算 + 分层命中率 + 派系小结 | 02 年度榜 |

日报进不了 02：今天的帖要 60/90 天后才可结算，当天打分等于用未出生的数据下结论。实测 96 个账号里大周期可结算 ≥8 条的只有 1 个。

## 口径改动规矩

1. 只改 `scoring.config.json`，`version` 升一位；
2. 同一 `--asof` 跑改前改后做回归，差异写进 commit；
3. 02 页面「口径版本与修订记录」同步；
4. 旧口径结论不追改，新建报告日期目录。
