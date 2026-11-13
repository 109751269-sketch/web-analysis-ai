# x.com 分册

> **产出规范（用户硬性要求，2026-11-13）**：任何 HTML 简报 / 复盘 / 榜单里出现推特博主，名字必须可点击跳转 `https://x.com/<handle>`（新标签打开、inherit 色 + 虚线下划线，不破坏排版）。详见 `SKILL.md` → `Phase 7.1`。交付前用无头浏览器数 `a[href^="https://x.com/"]` 自查。

## X(Twitter) 个人主页全量推文采集（2026-11-11 实测）

### 核心结论：主页滚动只能回溯约 3 个月，必须改用分段搜索

| 方法 | 结果 |
|---|---|
| 主页虚拟滚动（`x.com/<user>`） | 只能回到约 3 个月前。88 个账号实测只有 17 个覆盖到 1 月 |
| 手工 fetch `UserOriginalsTimeline` 分页 | **一律 404**。X 已强制校验 `x-client-transaction-id`，页面内 fetch 缺这个头 |
| **`SearchTimeline` 按季度分段搜索** | **有效**。单账号 80→229 条、435→547 条，可覆盖全年 |

### 分段搜索写法

在页面上下文（已登录）里逐段跳转，靠 response 监听收数据：



- 季度切分：01-01~03-01 / 03-01~05-01 / 05-01~07-01 / 07-01~09-01 / 09-01~11-12
- 每段独立滚动到底（约 70 轮、idle 9 轮）再进下一段，最后按 tweet id 去重合并
- 结果落在 `SearchTimeline` 响应：`data.search_by_raw_query.search_timeline.timeline.instructions[].entries[].content.itemContent.tweet_results.result`
- 用户对象 schema 已改：用 `core.screen_name` / `core.name`、`profile_bio.description`、`relationship_counts.followers`，**不再是 `legacy.*`**

### 429 的真实分布（重要：不要误判为账号风控）

| 接口 | 状态 |
|---|---|
| `SearchTimeline` / `UserOriginalsTimeline` | **全部 200** |
| `ViewerBadgeCounts` | 每页必 429 |
| `GetPublicKeysQuery` | 每页 4~5 次 429 |
| 页面导航 | 200，不跳验证页 |

结论：这是**辅助接口软限流**，不是账号级风控。核心数据照常返回。
对策：并发降到 2~3 标签页、单页等待 7~9s、每 25 轮遇 429 冷却 6s。
**不要**因 429 就换账号或放弃任务。

### 关注列表全量拉取（176 个账号 4 页）

`https://x.com/<screen>/following` 滚动拦截 `/graphql/<qid>/Following`。
tip：**不要用 `/me/following`** —— 它会被解析成真实账号 `@me`。

### 踩过的坑

| 坑 | 后果 | 修法 |
|---|---|---|
| 滚动停顿 900ms | 小于 X 加载下一页所需（1.5~2.5s），idle 计数提前满，只抓到 3 个月 | 停顿 ≥1500ms，且触底判定要同时要求「条目数不增 **且** pages 不增」 |
| 重抓时没写 merge | 直接把 833 条的账号覆盖成 241 条，**数据永久丢失** | 重抓前必须按 tweet id 合并旧数据；覆盖前先备份 |
| `created_at` 是 `Fri Nov 06 ...` 格式 | 用 `slice(0,10)` 取日期得到 "Fri Nov 06"，覆盖度统计全错 | 一律 `new Date(x).toISOString().slice(0,10)` |
| Playwright 持久化 profile 被占用 | 报 `Target page, context or browser has been closed` | 同一 profile 只能串行跑，先确认没有残留 node 进程 |
