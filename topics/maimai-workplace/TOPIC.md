# 专题：脉脉职场评价与评论采集

> 状态：🟢 四个专题已采完，跨公司分析可复跑
> 站点分册：[sites/maimai.cn.md](../../sites/maimai.cn.md) ｜ 攻略：[playbooks/maimai.cn.json](../../playbooks/maimai.cn.json)

## 一、目标

1. 抓脉脉专题帖（公司印象 / 工时强度 / 职级薪资 / 爆料），做跨公司对照分析
2. 抓帖子评论区，做职场评价（情绪、稳定性、加班、薪资）分析

## 二、已完成

| 专题 | 条数 | 工作区目录 |
|---|---|---|
| 我来爆个料 `SxAXPZZ2` | 14,556 | `output/maimai_topic_baoliao/` |
| 公司印象大爆料 `12dLH8oC3` | 11,522 | `output/maimai_topic_company_impressions_5000/` |
| 职级薪资大揭秘 `JFvwxmvD` | 10,452 | `output/maimai_topic_salaryrank/` |
| 爆料各司工时强度 `zfe4YoeG` | 5,768 | `output/maimai_topic_worktime/` |

合计 42,298 条，时间跨度 2025-10 ~ 2026-11；薪资条目 93% 可从正文正则提取公司字段。

评论采集已跑通：`output/maimai_gossip_comments/`、`output/maimai_recommended_comments/`（`posts_with_comments.json` + `.jsonl`）。

已产出报告（工作区根目录）：`bigtech_compare.html`、`net_emotion_compare.html`、`daji_report.html`、`report_bigtech_vs_dji.md`。

工时/薪资统计结论见 **[FINDINGS.md](FINDINGS.md)**（2026-11-12）；复跑：`node topics/analyze_topics.js`，产物落 `output/_analysis/`。

## 三、关键结论（勿重复踩）

- 脉脉频道页卡片是 `div[role=button]` **无 href**，评论采集必须用 `detailEntry: auto`（点卡片进详情），不能只靠 `_link`
- 必须 `headless: false`，否则退回登录页
- 跨公司比「谁更差」**必须先统一分母**，否则样本量差异会直接决定结论（见 EXPERIENCE.md §二十一）
- 公司名需归一化（EXPERIENCE.md §十六）
- 抓取前读 `playbooks/maimai.crawl-ledger.json` v2 查 coverage，别重复抓

## 四、数据位置

```
F:\despseekharness\crawler\output\maimai_topic_*/data.json    # 主数据
F:\despseekharness\crawler\output\maimai_*_comments\          # 评论
```

## 五、下一步

1. 评级薪资专题的「公司 × 职级 × 薪资」交叉表尚未产出
2. 评论区覆盖率补齐（`refill: true` 重跑低覆盖篇目）
3. 若要新增专题，先在 `output/` 建目录，跑完在 `topics/LEDGER.json` 登记
