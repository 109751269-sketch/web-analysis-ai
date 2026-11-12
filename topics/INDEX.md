# 专题索引（Topics）

> 每个专题是一个独立分支，互不干扰。**开工前先读本索引，确认该专题做到哪一步、数据在哪、下一步是什么。**
>
> 目录约定：
> - 技能内 `topics/<slug>/`：只放**档案**（目标、流程、脚本、结论、状态），小文件、可提交 GitHub、可跨机器继承。
> - 工作区 `F:\despseekharness\crawler\output/<slug>/`：**原始抓取数据**，体积大，不进 git；路径登记在 `topics/LEDGER.json`。

## 专题清单

| slug | 专题 | 状态 | 数据目录（工作区） | 档案 |
|---|---|---|---|---|
| `btc-analyst` | 推特 BTC 博主预测能力评测 | 🟢 已完成一期，可复跑 | `topics-data/btc-analyst/` | [TOPIC.md](btc-analyst/README.md) |
| `maimai-workplace` | 脉脉抓帖+评论、职场/公司评价 | 🟢 四个专题已采，分析待做 | `output/maimai_topic_*`、`output/maimai_*_comments/` | [TOPIC.md](maimai-workplace/TOPIC.md) |
| `x-recent-opinion` | 推特近期帖子找观点（24h 时间线） | 🟢 多轮已采，观点聚合待做 | `output/x_24h_*`、`output/x_recent_500/` | [TOPIC.md](x-recent-opinion/TOPIC.md) |
| `company-reviews` | 牛客 + 职友集公司评价与薪资 | 🟡 15 家已采，若干口径待修 | `output/nowcoder/`、`output/jobui/` | [TOPIC.md](company-reviews/TOPIC.md) |
| `xhs` | 小红书关键词搜索 + 详情 | 🟡 列表已采，详情覆盖率低 | `output/xhs/` | [TOPIC.md](xhs/TOPIC.md) |

## 状态图例

- 🟢 可复跑、结论可用
- 🟡 有数据但未收口（缺分析/缺覆盖率/口径待修）
- 🔴 阻塞（风控/登录/依赖外部）

## 新增专题的三步

1. 建 `topics/<slug>/TOPIC.md`（照抄任一现有 TOPIC.md 的五段结构）
2. 在 `topics/LEDGER.json` 加一条状态记录（含数据目录、进度、下一步）
3. 在本表补一行

## 与引擎的关系

专题**不是**引擎的一部分。`topics/` 只记「做过什么、结论是什么、从哪继续」；
抓取能力仍在 `lib/`，站点规则仍在本 skill 的 `sites/` 与 `playbooks/`。
专题脚本若可复用，放 `topics/<slug>/` 内自包含，不要散落到工作区。
