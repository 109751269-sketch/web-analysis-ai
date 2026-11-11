# 小红书 xiaohongshu.com

> 状态：已沉淀（2026-11-10 实测）
> 需登录：是
> 连接方式：持久化 profile `F:\despseekharness\crawler\cdp-profile`

---

## 连接方式

```js
const { launchHeaded } = require('lib/headed.js');
const { ctx } = await launchHeaded(chromium, { profile: 'F:/despseekharness/crawler/cdp-profile' });
```

**必须用 `launchHeaded`（有头）**，不要用 `headless:true`。

---

## 关键接口

| 用途 | 端点 | 备注 |
|---|---|---|
| 搜索 | `POST https://so.xiaohongshu.com/api/sns/web/v2/search/notes` | 响应 `data.items[]` |
| 笔记详情 | `GET https://www.xiaohongshu.com/api/sns/web/v1/feed` | 拦截响应拿正文 |
| 搜索筛选 | `GET edith.xiaohongshu.com/api/sns/web/v1/search/filter` | 可用 |
| 搜索建议 | `GET edith.xiaohongshu.com/api/sns/web/v1/search/recommend` | 可用，风控时仍返回 |

**`xsec_token` 是硬要求**：笔记链接必须带 `xsec_token`，否则 404。token 只能从搜索 API 响应里拿，拼在 `https://www.xiaohongshu.com/explore/<id>?xsec_token=<token>`。

---

## 两阶段策略（默认做法）

小红书的**列表扫描**和**详情抓取**风控成本差 10 倍以上。必须分两阶段。

### 阶段 1：列表扫描（便宜，可广撒网）

搜索 API 一次返回 20 条笔记的标题 + 摘要 + 互动数 + `xsec_token`。**不碰详情页**。

- 成本：1 次搜索 = 1 个请求，间隔 10s
- 200 个关键词 ≈ 33 分钟，但完全不触发风控
- 产出：标题、作者、点赞/收藏数、发布时间、`noteId` + `xsec_token`

搜索阶段能回答的问题：**哪些话题有人在讨论、讨论量多少、标题里出现什么关键词**。

### 阶段 2：按需详情（贵，精准打）

只有列表里**标题命中目标**的才去抓详情（正文 + 评论）。

- 成本：1 篇详情 = 1 个请求，间隔 9s
- 触发风控的是**连续详情请求总量**，不是单次
- 实测：18 篇连续 @9s 安全；47 篇 @2.5s 直接 461

### 分诊规则（列表 → 详情）

```
标题含目标关键词（如「携程」「加班」「裁员」）→ 抓详情
标题是泛泛吐槽但互动数很高（≥1000赞）      → 抓详情（代表性）
标题与目标无关                              → 跳过
```

### 为什么必须这样

本项目的实际教训：昨天 1,995 条搜索列表 → 只抓了 48 篇详情（2.4% 覆盖），但已经触发过一次 461。如果按「全量抓详情」的思路，1,995 篇 @9s = 5 小时，且中途必然被封。

**两阶段把「覆盖广度」和「风控风险」解耦了**：宽的是搜索，深的是详情。

### 实现

```bash
# 阶段 1：列表（可跑大量关键词）
node xhs_api.js search "携程 加班" "携程 工作体验" "携程 裁员"

# 阶段 2：详情（只抓 hit 的）
node xhs_api.js detail output/xhs/s_携程_加班.json 30
```

---

## 风控信号（出现即停止）

| 信号 | 表现 | 含义 |
|---|---|---|
| **HTTP 461** | 搜索 API 返回 461，body 是 `{"code":0,"success":true,"data":{},"msg":""}` | 机器流量判定，最明确的拦截 |
| **验证码跳转** | URL 变 `/website-login/captcha?verifyType=124&verifyBiz=461` | 需本人用小红书 APP 扫码 |
| **`code 40006`** | `redcaptcha/v2/qr/init` 返回「请求太频繁，请一分钟后再试」 | 风控计数已超阈值 |
| **空结果** | `section.note-item` 数量为 0，但页面不报错、不跳登录 | 已被静默拦截 |

**注意**：461 不是 401/403。cookie 可能完全有效（`web_session`/`id_token`/`a1` 都未过期），但账号已被标记。

---

## 节流参数（必守）

**风控等级：高**（headless 直接封、高频请求账号级标记、解封需人工扫码）

| 动作 | 间隔 | 依据 |
|---|---|---|
| 搜索 | ≥ 10000ms | agent-reach 基线：同平台两次搜索 ≥10 秒 |
| 详情页 | ≥ 9000ms | 实测 2.5 秒 → 47 篇即被封 |
| 单任务上限 | ≤ 50 篇详情 | 超过需分段，中间插入长间隔 |

**并发**：同平台 ≤2，全平台 ≤4。

---

## 已知坑

### 坑 1：headless 直接触发风控（2026-11-09/10 实测）

- **现象**：`headless:true` 时，连首页 `/explore` 都 302 到验证码页。
- **根因**：headless Chrome 缺 GPU 渲染、`navigator.webdriver` 为 true、窗口尺寸异常，设备指纹判定为自动化。`--disable-blink-features=AutomationControlled` 只能掩盖一部分。
- **修法**：用 `headless:false`。实测同样 profile 有头模式首页正常加载（bodyLen 1820，无验证码）。

### 坑 2：高频详情请求 → 账号级风控（2026-11-09 实测）

- **现象**：连续抓 47 篇详情（每篇 sleep 仅 2.5 秒，共 43 分钟），第 48 篇起全部跳验证码。搜索接口仍可用，但详情全废。
- **根因**：风控基于账号+设备+IP 的历史行为累积，不是单次请求判定。
- **修法**：详情间隔提到 9-10 秒；检测到 461 或验证码页立即停止，**不重试**。
- **代价**：该 profile 被标记后，即使恢复有头模式仍需扫码解封。

### 坑 3：详情页正文选择器几乎全失效（2026-11-09 实测）

- **现象**：47 篇里 33 篇正文为空。试过 `#detail-desc` / `.note-content` / `[class*=note-text]` / `.desc` / `.note-desc`，全部 `null`。
- **根因**：小红书详情页正文不是稳定 DOM，可能走 canvas/virtual 渲染，或根本在 API 响应里。
- **修法**：**不要靠 DOM 取正文**。拦截 `api/sns/web/v1/feed` 响应，从 JSON 取 `data.items[0].note_card.desc`。
- **状态**：待验证（本轮未跑通 API 取正文路径）。

### 坑 4：搜索结果 hash 只匹配标题关键词

- **现象**：搜「携程金融」得 145 条，但标题真正含金融词的只有 61 条，其余是「携程 + 泛职场」内容。
- **修法**：搜索结果必须按标题二次过滤，不能直接当精准样本。

---

## 内容性质区分（做口碑分析时必须）

小红书搜公司名，结果混着两类完全不同的内容：

| 类型 | 特征词 | 用途 |
|---|---|---|
| **员工职场类** | 离职、面经、offer、在职、试用期、转正、薪资爆料 | 口碑证据 |
| **用户投诉类** | 高利贷、催收、分期、服务费、利率、退款、征信 | 业务风险证据 |

**不能混为一谈**。做「这家公司值不值得去」时，用户投诉是间接信号（业务合规风险 → 岗位稳定性），要在报告里单独标注来源类型。

---

## 实测数据参考（2026-11-09 / 11-10）

| 项 | 值 |
|---|---|
| 7 个金融线关键词搜索 | 1065 条，去重后 812 条 |
| 标题精确命中金融线 | 61 条 |
| 最终抓到详情 | **61 篇，32 篇有正文，146 条评论** |
| 员工职场类 | 12 篇，**正文覆盖 12/12** |
| 用户投诉类 | 约 45 篇 |

---

## 解封流程（风控后恢复访问）

已被标记的 profile 无法靠改参数恢复，必须人工扫码：

```js
const ctx = await chromium.launchPersistentContext(PROFILE, {
  headless: false,
  args: ['--window-size=1200,850', '--window-position=300,100'],
  viewport: { width: 1200, height: 850 }, locale: 'zh-CN',
});
const page = ctx.pages()[0] || await ctx.newPage();
await page.goto('https://www.xiaohongshu.com/explore');  // 会被 302 到 captcha
// 等用户扫码，轮询 page.url() 是否离开 /website-login/captcha
```

**关键**：解封期间不要关闭窗口、不要并发请求。扫码通过后 `page.url()` 变回 `/explore`，即可恢复采集。

**实测**：解封后立刻验证搜索 API 返回 200、抓到 20 条；随后连续补抓 18 篇（间隔 9 秒）全程无风控。

---

## 坑 5：解封进程未退出时无法重开 profile（2026-11-10）

- **现象**：扫码窗口还开着时跑采集，报 `browserType.launchPersistentContext: Target page, context or browser has been closed` 或导航 60 秒超时到 `about:blank`。
- **根因**：Playwright 的 persistent context 对同一 profile 目录是**独占**的，第二个进程打不开。
- **修法**：先确认旧进程退出（`Get-Process chrome` 确认只剩主浏览器），再启动新采集。

---

## 坑 6：正文为空 ≠ 抓取失败（2026-11-10）

- **现象**：首轮 47 篇里 33 篇正文为空。
- **真因**：其中大部分是**首轮就撞上风控**（headless + 高频），页面其实是验证码页，自然抓不到正文。
- **验证**：解封后重抓同样的笔记，14 篇全部拿到正文（37-865 字不等）。
- **结论**：**正文为空先怀疑风控，不要怀疑选择器**。检查 `page.url()` 是否含 `website-login/captcha`。

---

## 生产参数（本轮验证有效）

| 参数 | 值 | 说明 |
|---|---|---|
| `headless` | `false` | 必须 |
| 详情间隔 | 9000ms | 18 篇连跑无风控 |
| 搜索间隔 | 10000ms | — |
| 单批上限 | 18 篇 | 超过建议分段 |
| 窗口位置 | `300,100` 或默认 `700,200` | 屏幕内，置底 |
