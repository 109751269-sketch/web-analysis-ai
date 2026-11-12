# 专题：推特近期帖子找观点（24h 时间线）

> 状态：🟢 多轮已采，观点聚合与简报可复跑
> 站点分册：[sites/x.com.md](../../sites/x.com.md) ｜ 攻略：[playbooks/x.com.json](../../playbooks/x.com.json)

## 一、目标

抓关注流最近 24 小时的推文，提取「当下的市场观点」（方向、目标价、时间窗口），产出当天简报。

## 二、已完成

| 批次 | 规模 | 工作区目录 |
|---|---|---|
| 2026-10-31 24h | 约 500 条 | `output/x_24h_20261031/` |
| 2026-11-01 24h | 约 500 条 | `output/x_24h_20261101/` |
| 2026-11-09 24h | 561 posts（raw2.json）+ 关注者画像 | `output/x_24h_20261109/` |
| 关注流 500 条 | 505 条 | `output/x_recent_500/` |
| BTC 日更简报 | 12/10/11 三期 | `output/x_btc_2026/`、`output/x_btc_2026111*/` |

最近一期产出：`output/x_btc_20261112/`（`X_BTC_24h_简报_20261112.html`、`findings.md`、`candidates.json`、`credibility.json`、`cycle_score.json`、`final_stats.json`、`3d_views.json`、`following_stats.json`）

## 三、关键结论（勿重复踩）

- 排序菜单正确打开方式：**单击「正在关注」**弹出菜单，再单击「最近」。不要 `dblclick`（开了又关，导致 `found:false` 采到热门混排）
- `limit` 决定时间跨度不是「够数就行」：`limit:500` ≈ 24h / 505 条原始 / 430 条去重
- 增量采集第一轮从顶部 (0,0) 提取，之后 0.6×视口小步下移；引擎去重键不可靠，**必须二次去重**（`replace(/[\s\p{P}\p{S}]/gu,'').toLowerCase()` + 前缀判等）
- 广告过滤配 `dropNoise: true`；日志打不出来，只能数据比对验证
- 任务 JSON 必须 **UTF-8 无 BOM**

## 四、数据位置

```
F:\despseekharness\crawler\output\x_24h_*/        # 24h 时间线
F:\despseekharness\crawler\output\x_recent_500/   # 关注流 500 条
F:\despseekharness\crawler\output\x_btc_20261*/   # BTC 日更简报与候选池
```

## 五、下一步

1. 把每期简报的「观点-账号」结构化，供 `btc-analyst` 直接消费（先验候选池）
2. 日更流程固化成脚本（现在每期是手工跑）
