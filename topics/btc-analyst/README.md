# BTC 博主预测能力评测管线

> 属于 `web-analysis-ai` 技能的专题档案（`topics/btc-analyst/`）。本目录只存代码与文档；数据默认外置在工作区 `F:\despseekharness\crawler\topics-data\btc-analyst\`，由 `paths.js` 解析（可用 `BTC_DATA_DIR` 覆盖）。首次建立 2026-11-11。

## 这个目录解决什么问题

给一个推特账号清单，评测「谁对 BTC 价格走势的预测靠谱」，并产出可发布的 HTML 报告。

核心难题是**不能直接算胜率**：2026 年 BTC 振幅极大，随机日期随便喊涨或喊跌都有约 2/3 的"命中率"。本管线用基准校正 + 4 口径稳健性检验 + 模拟操作，把"运气"和"真本事"分开。

---

## 文件作用一览

### 文档

| 文件 | 作用 | 什么时候读 |
|---|---|---|
| `README.md` | 本文件，流程总览与文件索引 | 第一次用、或忘了怎么跑 |
| `FINDINGS.md` | **结论**：87 个博主谁靠谱、谁不能跟、关键基准数字 | 想知道"跟谁"直接看这个 |
| `PRED_SPEC.md` | 给 LLM 的抽取规范（date/dir/target/level/quote 五字段） | 让子代理抽取预测前，把它喂给子代理 |

### 脚本（按流程顺序）

| 文件 | 输入 | 输出 | 作用 |
|---|---|---|---|
| `paths.js` | — | — | **公共模块**，被其它脚本 require。解析数据根：`BTC_DATA_DIR` 环境变量 > `F:\despseekharness\crawler\topics-data\btc-analyst` > 本目录 `data/`（已外置，见下） |
| `freeze_digests.js` | `data/<日期>/raw/*.json` | `data/<日期>/frozen/<账号>.txt` | 把原始推文冻结成快照，格式 `[YYYY-MM-DD] 正文` 时间正序。分析期间数据不再变动，保证可复现 |
| `[LLM 抽取]` | `data/frozen/*.txt` | `data/preds/batchN.json` | **不是脚本**，是把账号分批交子代理精读，按 `PRED_SPEC.md` 产出结构化预测 |
| `audit_preds.js` | `data/<日期>/preds/*.json` + `data/<日期>/frozen/` | 控制台报告 | **防编造**：把每条 `quote` 去空白后回原文做 substring 匹配，未命中即报警。必须 0 未命中才继续 |
| `score_final.js` | `data/<日期>/preds/` + `data/btc_daily.json` | `data/<日期>/final_v3.json` `data/<日期>/sensitivity.json` | **严格口径打分**：基准校正后的超额胜率 + 4 口径稳健性分层（stable_pos / stable_neg / unstable） |
| `sim_trade.js` | `data/<日期>/preds/` + `data/btc_daily.json` | `data/<日期>/sim_results.json` | **模拟操作**：预测日入场，−10% 止损、触目标止盈、最长 120 天。算中位收益、胜率、止损率、模糊正确率 |
| `ledger.js` | `data/<日期>/preds/` + `data/<日期>/final_v3.json` | `data/<日期>/ledger.json` | **逐条台账**：每条预测的"当时价格 → 后续 1/2/3 月涨跌 → 是否兑现" |
| `build_html.js` | 上述所有 json | `<REPORT_OUT>/index.html` | 生成暗色主题 HTML 报告（9 个章节、18 张表） |

### 数据（外置，默认 `F:\despseekharness\crawler\topics-data\btc-analyst\`）

**不进技能仓库**（1.6 MB，且会随评测期增长）。`paths.js` 自动解析：

1. `BTC_DATA_DIR` 环境变量
2. `F:\despseekharness\crawler\topics-data\btc-analyst`
3. 本目录 `data/`（仅作兜底）

按日期归档。`btc_daily.json` 是跨期共享的行情数据，留在数据根；其余都是单次运行的产物。

```
data/
├── btc_daily.json              共享：BTC 日线 OHLC（2026 全年），所有验证的价格来源
└── 2026-11-11/                 单次运行（第一次评测）
    ├── preds/batch*.json       9 个批次的结构化预测，共 349 条
    ├── frozen/                 87 个账号的推文快照，审计与重抽取的依据
    ├── final_v3.json           严格口径评分
    ├── sensitivity.json        4 口径明细
    ├── sim_results.json        模拟操作结果（含每笔明细）
    ├── ledger.json             逐条预测台账
    └── frozen_manifest.json    账号清单（推文数、时间跨度）
```

下次新评测就新建 `data/<新日期>/`，互不覆盖，`btc_daily.json` 继续复用。

> **未包含 `raw/`**：原始推文约 16 MB，可由 `frozen/` 重新生成，不进版本管理。

---

## 完整流程

### 第 1 步：抓推文（用技能主引擎）

先读 `../../sites/x.com.md`。核心要点：

- **主页虚拟滚动只能回溯约 3 个月**，必须用 `SearchTimeline` 按季度分段搜索
- 手工 fetch `UserOriginalsTimeline` 会 404（X 强制校验 `x-client-transaction-id`）
- 429 只命中辅助接口（`ViewerBadgeCounts` / `GetPublicKeysQuery`），核心接口正常
- 重抓必须按 tweet id 合并，否则覆盖旧数据

把抓到的推文放进数据根的 `raw/`（即 `F:\despseekharness\crawler\topics-data\btc-analyst\raw\`）。

下文命令里的 `data/...` 都按数据根理解。为免得每次写全路径，先设环境变量：

```bash
export BTC_DATA_DIR="F:/despseekharness/crawler/topics-data/btc-analyst"
```

### 第 2 步：冻结

```bash
node freeze_digests.js <数据根/日期目录>
```

### 第 3 步：LLM 语义抽取

把账号清单分批（每批 8~11 个），每批开一个子代理，提示词要求：读 `PRED_SPEC.md` → 读 `data/frozen/<账号>.txt` → 输出 `data/preds/batchN.json`。

**关键**：`quote` 必须逐字摘录。抽完立刻跑审计：

```bash
node audit_preds.js
```

必须看到 `quote 未命中: 0` 才继续。

### 第 4 步：打分（两种口径都要跑）

```bash
node score_final.js "$BTC_DATA_DIR/2026-11-11"   # 严格口径
node sim_trade.js "$BTC_DATA_DIR/2026-11-11"      # 模拟操作
```

### 第 5 步：出报告

```bash
node ledger.js data/2026-11-11
REPORT_OUT=./html node build_html.js data/2026-11-11
```

### 第 6 步：发布（可选）

把 `html/index.html` 复制到报告仓库的日期目录，更新目录页，push。

**坑**：GitHub Pages 在 `git push` 后**不会自动触发构建**，构建会停在上一个 commit。必须手动触发：

```bash
gh api -X POST repos/<owner>/<repo>/pages/builds
```

然后用真实浏览器验证 URL 返回 200，不要只看 curl 状态码。

---

## 两个口径为什么要同时看

| 口径 | 衡量 | 陷阱 |
|---|---|---|
| **严格** | 预测方向在窗口内是否达标 | 把「抄底略早、短期磨一下、最终涨起来」判成错，对人不公平 |
| **模拟操作** | 照着买卖能否赚钱 | 必须加止损，否则把「先亏 40% 再涨回来」当成赚 |

实测两者结论会打架：

- `_Checkmatey_` 严格口径稳定正，但模拟操作中位 **-10%**（点位太少，触发不了止盈）
- `realGuanYu` 严格口径不稳定，模拟操作中位 **+12.3%**（点位可执行、止损纪律好）
- `huangdaobtc` 追涨杀跌 94.7%，模拟操作 +4.2%（止损快，靠盈亏比活着）

**结论：预测准确率和能不能赚钱是两件事，都要看。**

---

## 下次评测新一波博主

1. 只抓增量推文，按 tweet id 与 `data/frozen/` 合并
2. 跨年的话补新行情到 `btc_daily.json`
3. 重跑第 3~5 步
4. 对比新旧 `sim_results.json`：谁变好了、谁变差了
5. 更新 `FINDINGS.md`

---

## 已知限制

1. **不打分「大周期顶底预测能力」**：4 个关键节点中 87 个账号有 82 个一个都没命中，最多 1 个。样本太稀疏，统计无意义
2. **目标价不参与日常胜率判定**：只用于节点命中分析和「点位明确度」分类。两者标尺必须一致，否则会系统性压低给远目标价的账号（这是修过的一个真 bug）
3. **追涨杀跌判定需要方向多样性门**：少数方向占比 ≥20% 才参与判定，否则单边看空者在下跌年会被误判（也是修过的 bug）
4. **数据缺陷**：`rektcapital` 原 833 条被重抓覆盖成 241 条，缺 2~7 月，评分不可信
