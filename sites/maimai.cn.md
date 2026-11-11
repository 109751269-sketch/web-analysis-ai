# 脉脉 maimai.cn

> 状态：已沉淀（多轮实测，最新 2026-11-10）
> 需登录：是
> 连接方式：持久化 profile `profiles/maimai.cn`（skill 目录内）

---

## 连接方式

```js
const ctx = await chromium.launchPersistentContext(SKILL + '/profiles/maimai.cn', {
  headless: false,                       // 必须
  args: ['--disable-blink-features=AutomationControlled'],
  viewport: { width: 1440, height: 950 }, locale: 'zh-CN',
});
```

或统一走 `lib/headed.js` 的 `launchHeaded()`（有头 + 置底）。

**登录态有效性已验证**：cookie（`web_session`/`cms`/`seid` 等 35 条）到 2027-09 过期，实测话题页可正常读取内容。

---

## 关键事实

### 页面已改版为 Next.js RSC

2026-11 起，脉脉社区走 React Server Components，数据以 `N:{...}` 行流式下发，DOM 里**没有** `a[href*=topic-detail]` 这类链接。

- 列表页 RSC 含 `listDefault[]` — 帖子（`id`/`egid`/`copy_text`/`author_info`/`cmts`）
- 详情页 RSC 含 `comments.lst[]` — 评论（`rt`/`copy_text`/`u.name`/`u.compos`/`time_str`/`likes`）

**必须用 `maimai_rsc_collect.js` 的方案**：挂 `page.on('response')` 收集所有非静态资源响应体，再用 `extractObjects` 按锚点 `{"author_info":` 提取 JSON 对象。不要试图从 DOM 取。

### 已确认的话题页 ID

| 话题 | URL |
|---|---|
| 公司印象大爆料 | `https://maimai.cn/community/topic-detail/12dLH8oC3/crtime` |
| 我来爆个料 | `https://maimai.cn/community/topic-detail/SxAXPZZ2/crtime` |
| 职级薪资大揭秘 | `https://maimai.cn/community/topic-detail/JFvwxmvD/crtime` |
| 爆料各司工时强度 | `https://maimai.cn/community/topic-detail/zfe4YoeG/crtime` |
| 职言 | `https://maimai.cn/community/home/gossip` |
| 推荐 | `https://maimai.cn/community/home/recommended` |

### RSC 编码是 cp1252 mojibake

中文会变成 `æœå‹` 这类乱码。用 `enc_fix.js` 的 `fixMojibake()` 修。已验证 3/3 PASS。

---

## 风控规则

| 行为 | 限制 | 后果 |
|---|---|---|
| **搜索** | ≤1 次/30 分钟，≤4 次/24 小时 | 超了**静默返回空白**，不报错 |
| 话题页滚动 | 无硬限制 | 可长滚（实测 45 轮无异常） |
| 详情页评论 | 串行 + 拟人节奏 | 每篇约 5-40 秒 |

**默认走话题页/频道页，不要用搜索。** 搜索是最容易触发风控的入口。

**信号**：页面跳 `/login` 或 `/passport` 即登录失效；搜索返回空但登录态正常 = 搜索被限流。

---

## 已知坑

### 坑 1：RSC listener 必须先挂再 goto

- **现象**：首屏数据全漏，只能抓到滚动后的。
- **根因**：RSC 响应在 `goto` 期间就发出了，listener 挂晚了收不到。
- **修法**：先 `page.on('response', handler)`，再 `page.goto()`。

### 坑 2：playbook 的 `headless:false` 曾是死配置（已修）

- **现象**：maimai playbook 里写了 `antiBot.headless:false`，但实际没生效。
- **根因**：`crawl.js` 里 `headless` 恒为布尔、`verifyWaitTimeout` 恒为 600000、`login.successIndicators` 恒为 `[]`，导致 `playbook.js` 的三个注入条件恒为假。
- **状态**：`crawl.js:71-79` 已修（有注释说明）。

### 坑 3：公司主页/公司库没有公开入口（2026-11-10 实测）

- **现象**：`/company/search`、`/web/company/search`、`/company/detail`、`/web/search` 全部 404。
- **根因**：脉脉没有公开的公司主页路径，公司信息只在帖子正文里。
- **影响**：想抓某条业务线（如「携程金融」）的口碑，只能靠**关键词过滤全量话题数据**，不能定向抓公司页。
- **结论**：金融线这类细分线，脉脉命中率天然极低（44936 条里只有 5-8 条）。

### 坑 4：feed 可见上限 ≈ 1 万条

三个专题交叉验证：单话题能滚到的帖子量约 1 万上限，超过需换时间窗口或换排序（`/hot` vs `/crtime`）。

### 坑 5：话题页自报数 ≠ 实得数

如「公司印象大爆料 15122 条帖子」，实际能滚到的取决于页面加载和去重，报告中两个数都写。

---

## 采集脚本（工作区）

| 脚本 | 用途 |
|---|---|
| `maimai_rsc_collect.js list <url> <name> [max]` | 抓话题列表 |
| `maimai_rsc_collect.js comments <listJson> <name> [max]` | 抓评论 |
| `maimai_rsc_collect.js both <url> <name> [max] [kw]` | 列表 + 评论 |

**任务 JSON 走 `lib/crawl.js` 时**用 `tasks/inc_*.json`（`extract.fields` 里用 emoji 前缀正则，如 `📍公司：`、`⏰上班时间：`）。

---

## 实测数据参考（2026-11-09）

| 专题 | 条数 | 覆盖期 |
|---|---|---|
| 公司印象大爆料 | 11,522 | 2025-10 ~ 2026-11 |
| 职级薪资大揭秘 | 10,452 | — |
| 爆料各司工时强度 | 5,768 | — |
| 我来爆个料 | 14,556 | 2025-10 ~ 2026-11 |
| 职言帖 + 评论 | 41 帖 / 248 评论 | — |

---

## 节流参数与风控等级

**风控等级：中**（有搜索限流，但话题页滚动无硬限制）

| 动作 | 间隔 | 说明 |
|---|---|---|
| 话题页首屏 | 5000ms | 等 RSC 流下发 |
| 滚动轮次 | 1800ms | 实测 45 轮无异常 |
| 评论详情 | 3000ms | 串行 + 拟人节奏 |
| **搜索** | **≥30 分钟/次** | 最容易触发风控，默认不用 |

**策略**：话题页可以正常速度滚，搜索必须避免。
