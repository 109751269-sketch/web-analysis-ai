# X「正在关注 / 最近」时间线采集 —— 经验沉淀

> 踩坑日期：2026-10-29　适用：`web-analysis-ai` skill + x.com 关注流
> 结论先行：**排序菜单要用单击，不是双击；limit 要按时间跨度给足。**

---

## 一、核心坑（必看，会直接导致数据量少 8 倍）

### 坑 1：双击「正在关注」会失败，单击才对

**现象**：日志 `✓ 已双击 tab「正在关注」（弹出排序菜单）` 后紧接 `✗ 未找到 tab「最近」`，`snapshot.json` 记录 `{"name":"最近","found":false,"clicked":false}`。

**根因**：X 的排序菜单是 **单击**「正在关注」tab 就弹出（`role=menu` "排序方式"，内含 `menuitem` "热门"/"最近"）。双击 = 三次点击事件（click + click + dblclick），菜单开了又关，等下一步去找「最近」时菜单已经消失。

**修法**：任务 JSON 里

```json
"tabs": [
  { "name": "正在关注", "waitMs": 2500 },
  { "name": "最近", "waitMs": 4000 }
]
```

**去掉 `"dblclick": true`**。改完日志立刻变成：

```
✓ 已点击 tab「正在关注」，等待内容加载 2500ms
✓ 已点击 tab「最近」，等待内容加载 4000ms
```

**影响量化**：修前采到的是默认「热门」排序（时间混排、逆序断点 10.7%）；修后是真正「最近」（严格倒序、覆盖 24 小时）。

### 坑 2：`limit` 直接决定时间跨度，不是"条数够就行"

| limit | 实际覆盖 | 说明 |
|---:|---|---|
| 60 | **1 小时**（46/50 条集中在 1h 内） | 这就是"1 天只有 60 条"的真相 |
| 400 | 23 小时（401 条原始 / 367 去重） | |
| 500 | 24 小时（505 条原始 / 430 去重） | 该账号关注流 24h 真实量级 |

**经验公式**：关注流 24h ≈ **400~500 条原始**（去重后约 85%）。想覆盖 24 小时就设 `limit: 500`；只想看最近几小时设 100~150。

### 坑 3：`dropNoise: true` 的日志永远打不出来（但确实生效）

`extract.js` 里噪声过滤的日志依赖 `opts.log`，而 `pipeline.js` 的 `extOpts(pd)` **没透传 `log`** → 日志里看不到"已过滤 N 条广告"，但数据比对证明生效（15 条广告 → 0 条）。**不要靠日志判断，要靠数据比对。**

---

## 二、可复用的正确任务模板

`F:\despseekharness\crawler\tasks\x_recent_500.json`（已验证跑通）：

```json
{
  "name": "x_recent_500",
  "url": "https://x.com/home",
  "authFile": "C:/Users/sun/.agents/skills/web-analysis-ai/cookies/x.com.json",
  "headless": false,
  "verifyWaitTimeout": 1800000,
  "tabs": [
    { "name": "正在关注", "waitMs": 2500 },
    { "name": "最近", "waitMs": 4000 }
  ],
  "scroll": { "rounds": 3000, "adaptive": true, "delayMinMs": 250, "delayMaxMs": 900, "maxIdleRounds": 40 },
  "extract": {
    "incremental": true,
    "containerSelectors": ["article", "[data-testid=\"tweet\"]"],
    "limit": 500,
    "dropNoise": true,
    "tidyValues": true,
    "fields": [
      { "name": "内容", "patterns": [], "tweetContent": true, "fallback": true },
      { "name": "作者", "regex": "^(?:(?:已转帖|已转推)[\\s·]*)?(.{1,40}?)\\s+@([A-Za-z0-9_]+)" },
      { "name": "时间", "regex": "·\\s*([0-9]+月[0-9]+日|[0-9]+天|[0-9]+小时|[0-9]+分钟|[0-9]+秒|刚刚)" }
    ]
  }
}
```

耗时：约 **6 分钟** / 477 轮 / 505 条。

**注意**：任务 JSON 必须写成 **UTF-8 无 BOM**，否则中文 tab 名会变成 `姝ｅ湪鍏虫敞` 这种乱码，永远匹配不上（本次踩过）。

---

## 三、采集后的清洗要点（引擎原始数据很脏）

引擎输出的 `内容` 字段会混进：作者行 `XXX @handle · 5分钟`、尾部互动数字、`0:23 / 0:02` 播放进度、`翻译自 英语`、`显示更多`。

参考 `F:\despseekharness\crawler\output\cmp_merged24\build24.js` 的 `stripPrefix` + `cleanText`：

```js
const PREFIX_RES = [
  /^[^\n]{0,70}?@[A-Za-z0-9_]{2,}\s*·\s*(?:\d+\s*(?:秒|分钟|小时|天)|刚刚|\d+月\d+日)\s+/,
];
// cleanText 依次去掉：显示更多 / 翻译自 X / 显示原文 / 播放进度 \d+:\d+ / 尾部互动数字 / 折叠空白
```

清洗效果：脏污率从 73% 降到 **3.3%**（14/430），平均正文 78.9 字。

**去重**：用 `s.replace(/[\s\p{P}\p{S}]/gu,'').toLowerCase()` 归一化后比较，配合"一方是另一方前缀（长度≥20）"。引擎自带的去重键是 `_text.substring(0,150)`，而互动计数每轮都变且落在 150 字窗口内 → 同一条会被反复收录（本次 505 → 430，重复 73 条，14.5%）。

---

## 四、浏览器侧（browser-skill `bsk_*`）的经验

- `bsk_session({action:"start", url:"https://x.com/home"})` 起会话，`bsk_inspect({action:"observe"})` 看 DOM。
- **单击「正在关注」→ 立刻出现 `menu "排序方式"` / `menuitem "热门"` / `menuitem "最近"`**，`bsk_interact click` 点 menuitem 即可。
- `bsk_inspect({action:"extract", extractKind:"list", selector:'div[data-testid="primaryColumn"]', itemSelector:'article[data-testid="tweet"]'})` 每轮 4~13 条，`rows[].text` 是整块文本，`url` 恒为 null。
- `extractFields` 自定义列在 tweet `article` 上报 `"Field author matches multiple elements"` → 只能整块取 text 再本地正则解析。
- 窗口 1249x715 时单轮只 4 条；`bsk_assist resize` 到 1249x1600 后单轮 10–12 条。
- 转发条目作者行是「XXX 已转帖」+ 下一行真作者，需特判。

---

## 五、其他通道的边界（别浪费时间试）

| 通道 | 结果 |
|---|---|
| `agent-reach twitter *` | 四个动作全 `NEED_LOGIN` / `Not logged into x.com (no ct0 cookie)`。功能已实现，缺登录态 |
| DSH `browser_navigate` x.com | `chrome-error://chromewebdata/` + 403。根因：harness Chromium 不走 7890 代理，直连被 TLS 指纹拦 |
| `web_fetch` x.com | HTTP 200 但只有 `x.com`（纯 JS 壳，27.9KB） |
| `read_page` x.com/home | `Every engine for the web source failed` + `firecrawl: rejected the keyless request (403)` + "we do not support this site"（站点级封禁） |
| `read_page` x.com/<user> | **可用**（单用户公开主页），但不是关注流 |

**结论：【正在关注】是账号私有数据，只有带登录态的浏览器（web-analysis-ai / browser-skill）拿得到。**
