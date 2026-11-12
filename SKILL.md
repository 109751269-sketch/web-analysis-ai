---
name: web-analysis-ai
description: Agent 主导的网页抓取与分析工作流（引擎=执行代码随 skill 自包含在本 skill 基目录的 lib/；工作区=任务/输出/临时文件在 F:\despseekharness\crawler，两边分离）。Use when the user wants to crawl and analyze web pages (网页抓取/数据采集/网页分析/批量提取), needs login with saved cookies (Cookie-Editor / storageState), or says "用 web-analysis-ai / 用爬虫项目 / 抓取并分析". 核心模式：agent 主导编排，每一步裁决用本地脚本（确定性操作）还是大模型（语义判断），并把整个流程沉淀为可复用 skill。
---

# Web Analysis AI — Agent 主导的网页抓取分析工作流

> **引擎**（执行代码+依赖+参考）：**本 skill 基目录的 `lib/`**（Web Analysis AI，Node + Playwright 1.62）。⚠️ **没有 `project/` 子目录** —— 历史文档多处误称，2026-10-25 已更正。
> **工作区**（任务文件+输出产物+临时文件）：`F:\despseekharness\crawler`——每次执行的结果和临时文件都放这里，不污染 skill。
> **路径解析规则**：
> - 引擎根 = 本 skill 基目录（`lib/*.js` / `node_modules` / `package.json`）；入口 `lib/crawl.js`；
> - Cookie = 本 skill 基目录 `cookies/<host>.json`（文件名按站点简化，现有 `maimai.json`、`x.com.json`，**不是** `maimai.cn.json`）；
> - 所有 node 命令在**工作区**执行（pwsh workdir=工作区），脚本用引擎绝对路径：`node "<引擎根>/lib/crawl.js" --task=tasks/xxx.json`（output 落在工作区 `output/`）；
> - 任务文件放**工作区** `tasks/`，`authFile` 用**绝对路径**指向 skill cookies（跨目录/跨盘必须绝对）。
> **技能拓扑（2026-10-25 核实，勿误删）**：`C:\Users\sun\.agents\skills\` 是**唯一实体真源**；`C:\Users\sun\.claude\skills\*` 与 `C:\Users\sun\.workbuddy\skills\*` 下的同名技能**全部是指向真源的 Junction（目录联接）**。因此**改 `.agents` 即对所有 agent 生效，不存在"多副本"**；反过来说，**任何"删除后重建"这些 Junction 路径的行为都会把它变成实体目录，从那一刻起才开始分叉，且无告警**。
> 本文档是 agent 的执行剧本：按阶段推进，每步先裁决「脚本 or 大模型」，再执行。

---

## 0. 定位与核心原则

1. **agent 主导**：整个流程由 agent（大模型）编排，不是一把梭跑脚本，也不是纯 LLM 现场发挥。
2. **两步裁决**：每个环节先判断——确定性/机械性 → **复用本地脚本**；语义/判断/需要用户 → **大模型介入**。
3. **失败降级**：脚本失败先诊断原因（看日志/页面结构），不要盲目重试；大模型判断失败不阻塞，回退到脚本能力。
4. **沉淀复用**：每个站点跑通后更新 `playbooks/<host>.json` 与 `EXPERIENCE.md`，下次直接复用。

---

## 0.3 默认两段式：**先 browser-skill 探路，再本引擎批量**（用户 2026-10-29 定的默认偏好，必须遵守）

> 这是**默认起手式**，不是可选项。除非用户当场说了别的，任何新的网页采集任务都按这两段走。

| 段 | 用什么 | 干什么 | 为什么 |
|---|---|---|---|
| **第一段：探路** | **browser-skill 插件（`bsk_*`）** | 打开目标页 → `bsk_inspect observe` 看 DOM → 试出 tab/排序/翻页/滚动的**真实交互方式** → 确认容器选择器与字段所在节点 → 用 `bsk_inspect extract` 抓一小批（10~30 条）验证字段解析得出来 | 注入用户**真实已登录**的 Chrome，看见的就是用户看见的；改一步看一步，几秒钟一轮，适合试错 |
| **第二段：批量** | **本 skill 的 `lib/crawl.js`（Playwright 引擎）** | 把第一段探明的结论写成 `tasks/<名>.json` → 一条命令无人值守跑完 → `data.json` 落盘 | 独立 Chromium + 持久化 profile，可复跑、可定时、可长时间滚动；不需要 agent 守着手工循环 |

**为什么必须这么分**（2026-10-29 X 时间线实测教训）

- 反过来做（直接上引擎盲跑）的代价：X 的「最近」排序因为任务里照抄了错误的 `dblclick: true`，连跑两次都 `found:false`，采到的是「热门」混排，还以为是数据源问题 —— **盲跑时你只能看日志猜，看不见页面**。
- 而 bsk 一轮 `observe` 就直接看到 `menu "排序方式"` / `menuitem "热门"` / `menuitem "最近"`，立刻知道该单击还是双击。
- 引擎适合的是**已经知道怎么点之后**的重复劳动：477 轮滚动、500 条去重、6 分钟跑完，这种事让 agent 手工做会失控。

**第一段的产出必须落成这三样，才算探路完成**

1. **交互脚本**：进页面后依次点/等什么（tab 名、排序项文案、翻页按钮文案、滚动方式），逐条写清；
2. **选择器**：容器 selector + 条目 selector + 每个字段落在哪个节点（或"只能整块取 text 再正则"这类结论）；
3. **样例数据**：10~30 条真实记录，人工确认字段能对上，再进第二段。

**跳过的条件**：`playbooks/<host>.json` 已存在且近 7 天内跑通过 → 直接进第二段；探路结论与 playbook 冲突时，以**实测为准**并回头修 playbook。

**反例警告**：不要把 browser-skill 用来做批量（手工循环 `wheel` + `extract` 几十轮，慢且易漏），也不要用引擎做探路（看不见页面，日志误导）。**评论采集的选档细则见 §3.4.1**（A 引擎直采 / B 引擎+bsk 补漏 / C bsk 全程）。

---

## 0.5 执行范围（默认：只抓取保存到本地，分析另做）

- **默认执行范围 = 「抓取数据并保存到本地」**（Phase 1~4 + `data.json`/`snapshot.json` 落盘），到这一步即视为本次任务完成。
- **分析 / 报告 / PPT 是独立的后续任务**，不在默认范围内：用户后续说"分析"时，agent 读 `output/<任务名>/data.json` 自行深度分析（见 Phase 6/7），引擎不含分析/报告/PPT 脚本。
- 只有用户**明确要求**全流程（"抓取并分析并出报告"）才继续 Phase 6/7，否则不要自动跑到分析阶段。
- 遇到需要登录的站点，Cookie 过期干预（Phase 5）属于抓取阶段内，照常执行。

---

## 1. 前置条件检查（开始前必做）

### 1.-1 读待办（2026-11-10 新增，**比什么都先**）

**打开 `TODO.md`，看有没有未完成项。** 有相关的就接着做，不要重复已完成的工作。

执行完某项后**立即从 TODO.md 删除该条目**，不要留着「已完成」列表——那会让下次误判。
新增待办时写明：现象、根因、已确认的正确做法、执行命令。不写「待优化」这种空话。

### 1.0 站点分册必读（2026-11-10 新增，**最高优先级**）

**任何采集任务开始前，先查 `sites/<host>.md` 是否存在。**

| 情况 | 动作 |
|---|---|
| **有分册** | 严格按分册的「连接方式 / 登录 / 节流参数 / 风控信号 / 已知坑」执行。**不要临场发挥**，不要因为「看起来能跑」就跳过。 |
| **无分册** | 走探索模式：小批量（≤10 条）试通 → 记录真实交互方式与选择器 → 遇到坑当场记录 → **跑通后必须新建 `sites/<host>.md`** |
| **分册与实测冲突** | 以**实测为准**，并回头修正分册 |

分册索引：`sites/README.md`。已沉淀：`maimai.cn` / `xiaohongshu.com` / `nowcoder.com`。

**三条硬性原则**（详见 `sites/README.md`）：
1. **风控是终止信号，不是重试信号** —— 遇验证码/风控状态码/内容突然全空，立即停止报告用户，不重试不换账号。
2. **有头模式是默认** —— 统一用 `lib/headed.js` 的 `launchHeaded()`，有头 + 窗口在屏幕内 + 立即置底（不抢焦点）。headless 是多数站点的直接风控触发器。
3. **节流参数显式配置** —— 不依赖脚本硬编码 sleep，按分册写的间隔执行。

### 1.1 环境检查

| 检查项 | 命令/位置 | 不满足时 |
|---|---|---|
| 引擎就位 | 本 skill 基目录 `lib/`（9 个 js；`node_modules`/`package.json` 同在基目录，**无 `project/`**） | 缺失则告知用户需还原引擎 |
| 依赖已装 | 引擎根 `node_modules` 存在 | 引擎根执行 `npm install`（含 playwright 浏览器：`npx playwright install chromium`） |
| 工作区就位 | `F:\despseekharness\crawler`（tasks/ 与 output/ 所在目录） | 不存在则创建 `tasks/`、`output/` |
| 经验文档 | 引擎内读 `EXPERIENCE.md` + `playbooks/` | 无则跳过，新站点按 §7 适配 |
| 任务定义 | 工作区 `tasks/<任务>.json`（模板见 Phase 2） | 由 agent 按 §3 生成 |
| 会话文件 | skill 目录内 `cookies/<host>.json`（标准位置与格式见 `references/cookie-guide.md`）或任务里 `authFile`/`cookiesText` | 没有则匿名模式（提示用户可能拿不到登录内容） |

执行工具：用 `pwsh`（workdir=**工作区** `F:\despseekharness\crawler`）跑 node 命令，脚本路径写引擎绝对路径（如 `node "C:/Users/sun/.agents/skills/web-analysis-ai/lib/crawl.js" ...`，`.workbuddy`/`.claude` 路径因 Junction 亦可用，但**统一写 `.agents`**）；用 `read`/`write`/`edit` 读写任务与输出（输出落在工作区 `output/`）；用 `ask_user_question` 向用户索要 Cookie 等交互信息。

---

## 2. 步骤裁决总表（核心）

| # | 环节 | 执行者 | 判断依据 |
|---|------|--------|---------|
| 1 | 需求理解 → 参数提取（url/tab/条数/模块/字段/分析目标） | **大模型（agent 自己）** | 用户需求是自然语言，语义无穷，规则解析覆盖不全 |
| 2 | 任务 JSON 生成 | agent 写文件（参照 Phase 2 模板） | 结构化数据，由 agent 组装 |
| 3 | 站点攻略查询/应用 | **脚本**（pipeline 自动 loadPlaybook/applyPlaybook） | 确定性配置 |
| 4 | Cookie 读取/规范化/注入 | **脚本**（lib/auth.js） | 确定性格式处理 |
| 5 | Cookie 有效性预检 | 脚本日志 + **大模型判断** | 脚本给信号（"会话有效/域名不匹配/未检测到登录特征"），agent 裁决 |
| 6 | **Cookie 过期干预** | **大模型介入 + 用户交互**（见 §5） | 需要向用户要新 Cookie，脚本做不了 |
| 7 | 导航 / tab / 滚动 / 翻页 / 验证等待 | **脚本**（lib/interact.js + pipeline） | 确定性浏览器操作 |
| 8 | 模块定位 / 条目识别 | **脚本**（lib/extract.js 启发式） | 通用算法，与站点无关 |
| 9 | 字段语义映射（需求字段→页面字段/选择器） | **大模型产出 hints** → 脚本执行 | 跨站语义差异大；提取机制仍用脚本 |
| 10 | 提取执行 | **脚本** | 确定性 |
| 11 | 统计计算 | agent 读 data.json 用脚本/工具算（如 node -e 或临时脚本） | 数字必须确定性，禁止大模型编造 |
| 12 | 深度分析 / 结论 | **大模型（agent 读 data.json 自行推理）** | 回答用户的分析需求 |
| 13 | 结论汇总 / 交付 | **大模型**（agent 输出结论，可选写 findings.md） | 结论引用数据为依据 |
| 14 | 异常诊断（未定位/反爬/空数据） | **大模型看日志+页面结构摘要 → 决策**（重试/等验证/改参数/停止） | 情况复杂，需综合判断 |
| 15 | 结果验收 | **大模型**（对照用户需求逐条核对产出） | 质量把关 |

**口诀**：会动浏览器、算数字、渲染的东西 → 脚本；要理解人话、要判断、要问用户 → 大模型。

---

## 3. 工作流（按阶段执行）

### Phase 1 — 需求理解（大模型）

1. 向用户确认/提取：目标 URL、是否需要登录、要采集哪些内容（tab/模块/条数）、要分析什么（占比/数量/趋势/对比/明细）。
2. 把需求结构化为一组参数：`url / tabs[] / limit / module / fields[] / analysisGoals[]`。
3. 把 `analysisGoals` 单独列出来（如：`["统计有几家公司","每家公司各岗位占比","岗位主要工作内容"]`）——后面 Phase 6 按它逐条产出结论。

### Phase 2 — 生成任务文件（agent 写文件）

- 按下方模板生成**工作区** `tasks/<任务名>.json`（任务模板已内联，不再依赖引擎 `tasks/_template.json`）：
  - 任务名：`<站点host>_<YYYYMMDD_HHMMSS>` 或用户指定的短名。
  - 字段：`url / authFile 或 cookiesText / cdpUrl / headless / tabs / scroll / extract{module,fields,limit} / login{successIndicators,pageIndicators}`。
  - `authFile` 用**绝对路径**指向 skill cookies（如 `C:/Users/sun/.agents/skills/web-analysis-ai/cookies/x.com.json`）。
  - 字段 patterns 先按需求关键词给；**未知站点先做 Phase 3.5 探测**，别盲写。
- **任务模板**（虚拟滚动站点如 X 需另加 `"extract": { "incremental": true, ... }`，见站点专项 §X；playbook 会自动应用已沉淀配置）。
  > 📌 **滚动采集默认自适应（2026-08-16 升级）**：普通滚动（非分页）已内置「自适应调速 + 目标驱动」——延迟按加载速率自动调（**实际默认 300~1500ms**，即 `interact.js` 的 adaptive 上下限；经 `crawl.js` 归一化注入时为 **300~1200ms**。历史文档写的"400~2500ms"是旧值，已废），并用 `locateModule+detectItems` 条目计数，**达标即停、否则滚到触底，全程只提取一次**（既快又不漏）。`scroll.rounds` 仅作每批轮数。
  >
  > ⚠️ **2026-10-25 行为变化（须知情）**：每批轮数由 `max(5, min(20, rounds/3))` 改为 **`max(5, min(40, rounds/3), maxIdleRounds+2)`** —— 加下限是为了让"高度触底"**真的可达**（旧值可小于 `maxIdleRounds`，导致触底永不触发、主循环空转，详见 §8 D1b）。实测对照：
  >
  > | rounds / maxIdleRounds | 旧每批 | 新每批 | 旧单次上限 | 新单次上限 |
  > |---|---|---|---|---|
  > | 800 / 12（默认） | 20 | **40** | 4000 轮 | **8000 轮** |
  > | 60 / 8（search_center 保守慢参） | 20 | 20（不变） | 4000 | 4000 |
  > | 6 / 12 | 5 | **14** | 1000 | 2800 |
  > | 2 / 12 | 5 | **14** | 1000 | 2800 |
  >
  > 影响：条目计数/达标判定与 dupStop 由"每 20 轮"变为"每 40 轮"检查一次 → **大 rounds 任务可能比目标多滚一些**（属安全方向：多拿不少拿）；搜索类保守慢参**完全不受影响**。想恢复旧粒度就显式写小 `scroll.rounds`，并把 `maxIdleRounds` 一起调小（新下限恒为 `maxIdleRounds+2`）。
  > 增量模式（虚拟滚动站点）保持逐轮提取与 1200ms 下限不变。任务里不写 `scroll` 也可直接用默认。

  ```json
  {
    "name": "任务名（输出目录名）",
    "title": "报告标题",
    "url": "https://目标网址",
    "authFile": "C:/Users/sun/.agents/skills/web-analysis-ai/cookies/<host>.json",
    "headless": false,
    "tabs": [{ "name": "tab 名", "waitMs": 1500 }],
    "scroll": { "rounds": 60, "adaptive": true },
    "extract": {
      "module": "模块关键词（留空则自动定位重复列表）",
      "fields": [{ "name": "字段名", "patterns": ["页面标签词"] }],
      "limit": 100,

      "//可选-噪声与清洗（2026-10-25 新增，默认全关）": "",
      "dropNoise": false,
      "noisePatterns": ["自定义噪声正则"],
      "tidyValues": false,

      "//可选-评论区采集（2026-10-25 新增，默认关）": "",
      "comments": { "enabled": false, "maxPosts": 50 },

      "//可选-虚拟滚动站点（默认值与旧行为一致）": "",
      "incremental": false,
      "incrementalOptions": { "waitSelector": "article", "newPostsButtonRe": "查看新帖子|新帖子" }
    }
  }
  ```

  **新增 extract 选项速查（全部默认关闭 / 默认等价旧行为，可放心不写）**

  | 选项 | 默认 | 作用 |
  |---|---|---|
  | `dropNoise` | `false` | 条目级丢弃广告/推广类噪声（内置 `广告/推广/赞助/Sponsored/Promoted/\bAds?\b/品牌合作/商务合作`）。**不静默丢数据**：返回值与日志恒带 `dropped{noise,patterns,invalidPatterns}`。<br>⚠️ 三条经独立验证确认的边界：① **过滤发生在 `limit` 切片之后、不回填** → 开了它最终条数可能**低于 `limit`**（实测 `limit:5` 含 2 条广告 → 得 3 条），**请把 `limit` 设得比目标大一些**；② 条目级匹配会**误杀正文里恰好出现"广告/推广"字样的正常帖** —— 先以 `dropNoise:false` 跑一遍看命中样例再决定开启；③ 过宽模式（如 `.`）会全杀，但 `dropped` 会如实上报，不会静默 |
  | `noisePatterns` | — | 追加自定义噪声正则（与内置并存；非法正则记入 `invalidPatterns` 不抛错）。<br>⚠️ 用 `new RegExp(src,'i')` 编译、**不带 `u` 标志**：写 `\p{Han}` 会**"编译成功"但匹配字面量 `p{Han}`**（静默曲解意图），需要 `u` 语义的转义请改用等价写法（如 `[\u4e00-\u9fa5]`） |
  | `tidyValues` | `false` | 字段值强清洗：压连续空白/全角空格、去值尾孤立标点（`·、,，;；:`） |
  | `comments.enabled` | `false` | **评论区采集**（详见 Phase 3.4）：从列表记录的 `_link` 进详情页 → **循环点开全部评论直到 DOM 不再增长** → 落 `posts_with_comments.json` |
  | `incrementalOptions` | 见上 | 虚拟滚动站点的等待选择器 / 「查看新帖子」文案正则；**默认值 = 旧硬编码行为**，换站点时才需要改 |

### Phase 3 — 会话与 Cookie 准备（脚本为主）

1. **标准存放**：Cookie 按网站分文件放 **skill 目录** `cookies/<host>.json`（一个站点一个文件，随 skill 自包含；分享 skill 前先删 `cookies/`；**`.gitignore` 已忽略 `cookies/` 与 `profiles/`**）。格式与填充步骤见 `references/cookie-guide.md`（Cookie-Editor 导出 JSON 数组整体替换 `[]` 即可）。
2. Cookie 来源二选一（lib/auth.js 两种格式都兼容，自动规范化）：
   - `authFile`：**绝对路径**指向 `cookies/<host>.json`（如 `C:/Users/sun/.agents/skills/web-analysis-ai/cookies/maimai.json`；任务文件在工作区，跨目录必须绝对路径）；
   - `cookiesText`：Cookie-Editor 导出的 JSON 文本直接内联（临时用）。
3. **Cookie 过期预检**（大模型判断）：agent 检查
   - 文件存在、非空；
   - 域名匹配目标站（脚本运行日志会打印 `✓ cookie 域名匹配`（**仅域名对上，不代表登录仍有效**）或 `⚠ cookie 域名与目标站不完全匹配`）；
   - 想要**确定性**的登录态判定：在任务里配 `login.successIndicators`，引擎会在页面加载后真正校验并打印 `✓ 已确认登录态`；
   - 若可疑 → 走 §5 干预流程，别等到抓完才发现。

### Phase 3.2 — 跨浏览器登录态复用（CDP 挂载；站点「单会话」时必用）

**症状**：用户在自己的主 Chrome 扫码登录后，自动化有头浏览器显示登录失效要求重新扫码；在自动化里扫码后，主 Chrome 又掉线。→ 该站是**单会话**：新登录会使旧 token 失效。轮流登录 = 永远互踢。

**修法（已实现）**：不登录、不复制 cookie，而是**挂载用户已登录的主 Chrome**（`task.cdpUrl`）。同一会话、同一设备指纹，不产生新的登录事件 → 双方都保持在线。

```jsonc
{
  "url": "https://maimai.cn/...",
  "cdpUrl": "http://127.0.0.1:9222",   // 有此项 = 挂载模式；省略 = 原独立 profile 模式
  "authFile": "C:/Users/sun/.agents/skills/web-analysis-ai/cookies/maimai.json"
}
```

操作步骤：
1. **完全退出**主 Chrome（含托盘驻留）；
2. 运行 `tools/start-chrome-cdp.cmd`（用日常配置启动 + 开 9222 端口，登录态原样保留）；
3. 正常跑抓取；引擎在用户浏览器里开 1 个标签页干活，**抓完只关这个标签页，不关浏览器**。

要点与红线：
- CDP 模式下引擎**不注入** `authFile` 的 cookie（避免旧 token 顶掉好会话）；`authFile` 仅作为回存/备份。
- 端口未生效的典型原因：Chrome 没完全退出（`--remote-debugging-port` 只对首个实例生效）。用脚本内自带的 curl 验证是否返回 JSON。
- 系统 `HTTP_PROXY` 会代理 loopback 导致 502，引擎已自动把 `127.0.0.1,localhost` 写入 `NO_PROXY`。
- 挂载期间浏览器被占用（窗口会被驱动）；仍需**串行**执行，不要与其他抓取任务并行开车。
- 不推荐「复制主 Chrome profile / 解 Cookies 库」路线：Chrome 127+ App-Bound 加密使 cookie 无法离线解密，且运行中 Cookies 库被锁（实测 `Device or resource busy`）。

> **2026-09-12 更新（降级为备选）**：CDP 挂载需要用户每次带 `9222` 重启主 Chrome，仪式成本高；且**从工具无法启动浏览器**（WorkBuddy Job Object 会在调用返回时回收子进程，Chrome 一并返回即死）。
> **默认改为 Phase 3.3 持久化 profile**。CDP 仅在「用户主 Chrome 必须保持登录且不能重启」时才用。

### Phase 3.3 — 持久化 profile（默认登录方案，2026-09-12 起优先）

引擎启动**自己的** Chromium（`profiles/<host>`），与用户主 Chrome 完全无关进程。**不要在任务里写 `cdpUrl`**。

```jsonc
{
  "name": "maimai_topic_xxx",
  "url": "https://...",
  "authFile": "C:/Users/sun/.agents/skills/web-analysis-ai/cookies/maimai.json",
  "headless": false,                 // 必须有头：多数站点 headless 会退回登录页
  "verifyWaitTimeout": 600000        // 给人工扫码的等待窗口
}
```

执行：`node lib/crawl.js --task=<任务json>`（cwd 设为工作区，输出落 `<cwd>/output/<name>/`）。

会话生命周期：
- 首次没登录 → 有头窗口里人工扫码 → 引擎自动 `saveSession` 回存 `authFile` + profile，**之后长期免登录**。
- 后续跑任务自动 `injectAuth` 注入同 token（不产生新登录事件 → 主 Chrome 不会被挤下线）。
- token 过期（日志出现 `/login`、`/passport` 跳转）→ 重走上面扫码一次。

禁止ＣＤＰ/持久化混用：**串行**，同一 profile 一次只能跑一个任务；并发会让新实例以
`browserType.launchPersistentContext: Target page, context or browser has been closed` 直接失败。

### Phase 3.3.1 — 统一登录态（2026-11-09 起，多站点首选）

> **为什么改**：此前每个站点一个 profile（`profiles/maimai.cn`、`cdp-profile`），分裂成 2~3 个登录态，用户要重复登录。**实测：所有站点可共用一个 user-data-dir**，只要用 CDP 挂载模式即可。

**一个 profile 装所有站点**：

```
C:\Users\sun\.agents\skills\web-analysis-ai\profiles\unified
```

启动（Chrome 137+ 必须非默认 user-data-dir 才允许调试端口）：

```powershell
Start-Process 'C:\Program Files\Google\Chrome\Application\chrome.exe' -ArgumentList `
  '--remote-debugging-port=9222',`
  '--user-data-dir=C:\Users\sun\.agents\skills\web-analysis-ai\profiles\unified'
```

首次在该窗口里把要用的站点**各登录一次**（脉脉 / 小红书 / 其他），之后长期有效、互不干扰。

**已验证的事实（2026-11-09）**：

| 判断 | 结论 |
|---|---|
| 主 Chrome 默认 profile 能否开调试端口 | ❌ Chrome 137+ 硬性禁止，端口不监听 |
| 不同站点能否共用一个 profile | ✅ 能，cookie 按域名隔离 |
| 脉脉与小红书是否互踢 | ❌ 不互踢（脉脉单会话只影响脉脉自己的旧 token） |
| Cookie 能否离线复制主 Chrome | ❌ Chrome 127+ App-Bound 加密，无法解密 |

**代价**：需人工登录一次。**收益**：此后所有站点、所有脚本共用一套登录态。

### 单入口 `lib/research.js`（2026-11-09 新增）

一条命令跑完多渠道，产物落 `<out>/`：

```bash
node lib/research.js --company=携程
node lib/research.js --company=携程 --sites=maimai,nowcoder      # 只跑指定渠道
node lib/research.js --company=携程 --skip-comments              # 不抓评论
node lib/research.js --company=携程 --out=F:/crawler/output/xxx  # 指定输出
```

| 参数 | 默认 | 说明 |
|---|---|---|
| `--company` | 必填 | 公司名 |
| `--out` | `output/research_<公司>_<日期>` | 输出目录 |
| `--cdp` | `http://127.0.0.1:9222` | CDP 地址 |
| `--sites` | `maimai,nowcoder,xiaohongshu` | 渠道白名单 |
| `--skip-comments` | 关 | 加此 flag 则只抓正文 |
| `--xhs-keywords` | `<公司> 工作体验,<公司> 加班,<公司> 值得去吗` | 小红书关键词 |
| `--mm-scrolls` | 30 | 脉脉滚动轮次 |
| `--xhs-detail` | 15 | 小红书每关键词抓多少篇详情 |

**站点模块**（`lib/sites/`）：

| 模块 | 取数方式 | 需登录 | 风控熔断 |
|---|---|---|---|
| `maimai.js` | Next.js RSC 流拦截 | 是 | — |
| `nowcoder.js` | 公开 JSON API | 否 | 不需要（无风控） |
| `xiaohongshu.js` | 搜索 API（须带 xsec_token） | 是 | ✅ 461 / 验证码跳转 |

**加新站点**：在 `lib/sites/` 建 `<host>.js`，导出 `{ name, collect... }`，再在 `research.js` 里挂一段。
**同时必须**：建 `sites/<host>.md` 分册（见 §1.0），记录连接方式、节流参数、风控信号、已知坑。

### 有头浏览器启动器（`lib/headed.js`，2026-11-10 新增）

所有需要浏览器的采集**统一用这个**，不要自己写 `launchPersistentContext`：

```js
const { launchHeaded } = require('<引擎根>/lib/headed.js');
const { ctx, bottom } = await launchHeaded(chromium, {
  profile: 'F:/despseekharness/crawler/cdp-profile',
});
```

它做三件事：
1. `headless: false` —— headless 是多数站点的直接风控触发器
2. 窗口放在屏幕内（默认 700,200）—— 任务栏能点出来
3. 立即调 `win_bottom.ps1` 压到 Z 序最底层 —— **不抢焦点、不遮挡用户当前窗口**

窗口标题含 `Google Chrome for Testing`，与用户主浏览器 `Google Chrome` 区分，置底不会误伤主浏览器。

### 风控熔断模式（写新站点模块时照抄）

```js
class RiskControlError extends Error {
  constructor(msg, evidence) {
    super(msg);
    this.name = 'RiskControlError';
    this.evidence = evidence;
    this.requiresHuman = true;   // 标记：需要用户在官方页面处理
  }
}
```

**关键**：捕获到 `RiskControlError` 时，**抛出并终止整个任务**，不要在循环里 `continue`。理由：风控基于账号+设备+IP 的累积行为，继续请求只会加深标记。参考实现见 `lib/sites/xiaohongshu.js` 的 `attachRiskWatch()`。

### Phase 3.4 — 评论区采集（用户 2026-09-12 起对频道类任务的硬性要求）

列表页只能拿到帖子正文；**有价值的判断往往在评论里**。频道/搜索结果类任务必须带评论。

> ⚠️ **2026-10-25 重要更正**：本节此前声称的"循环点击直到 DOM 规模不再增长"**引擎里根本没有实现**——
> 参考实现是工作区脚本 `harvest_comments.js`，而它自己的注释写着"**本版先取首层**"（即从未展开过）。
> 现已落成引擎能力 **`lib/comments.js`**，由任务开关驱动，换机/分享后仍可用。

**用法：任务里加一段即可**

```jsonc
"extract": {
  "module": "推荐",
  "fields": [ /* ... */ ],
  "limit": 200,
  "comments": {
    "enabled": true,          // 必填，默认 false
    "maxPosts": 50,           // 最多进多少篇详情页
    "delayMs": 1800,          // 详情页之间的间隔（串行、拟人）
    "expandIdleRounds": 3,    // 连续 N 轮 DOM 未增长 → 认定展开完毕
    "include": "/community/", // 详情链接白名单正则（可选）
    "exclude": "topic-detail|search_center|hot-rank", // 黑名单（可选）
    "appendExisting": true    // 续抓：载入已有 posts_with_comments.json 去重合并
  }
}
```

引擎行为（`lib/comments.js` + `pipeline.js` 收尾钩子）：
1. **入口判定**（2026-11-09 P0）：从已抓列表记录的 `_link` 收集详情链接（去重 / include / exclude / 相对路径转绝对）；**链接为空且 `detailEntry: auto`（默认）时自动改走「点卡片进详情」**——按 `containerSelectors[0]`/`clickCardSelector` 依次点卡片、等 URL 命中 `detailUrlPattern`、抓完 `goBack()` 回列表（脉脉这类卡片无 href 的站由此可用）；
2. 逐条串行 `goto` 详情页 → **`expandComments`：循环点击展开控件**（`查看全部N条评论|全部评论|查看N条回复|加载更多|更多评论|展开|^\d+条评论$`，仅点短文本 ≤20 字；**2026-11-09 起穿透 open shadow root**）**直到连续 `expandIdleRounds` 轮 DOM 不再增长**（已点过的打标记，不重复点）；
3. `scrapeComments` 抽正文 + 评论块：**显式 `containerSelectors` 优先**，否则"时间密度法"启发式（子元素含相对时间最多者）；同时抽 `stats.claimCount`（页面声称总数）用于覆盖率校验（见 §3.4.1）；
4. 落盘 `output/<name>/posts_with_comments.json`（`{source, fetchedAt, posts:[{url,title,post,comments:[{text,author,time,likes,isReply}]}]}`）+ **逐条追加 `posts_with_comments.jsonl`（中断不丢）**；每 5 条写一次全量；
5. 列表循环判定：连续多轮"全是已抓过"→ 打印 `[需向用户确认]` 并停止；
6. **任何失败都不影响主数据**（`data.json` 照常落盘）。

⚠️ **成本提示**：评论采集是**串行 + 拟人节奏**，单篇约 `detailWaitMs + 展开轮数 × delayMs/2`（默认量级 5~40 秒）。
`maxPosts: 50` 可能跑十几分钟到半小时 —— **这不是卡住，是设计如此**；只想快速验证时先把 `maxPosts` 调到 2~3。

**前提**：列表记录的 `_link` 必须存在（`extract.js` 从条目里的 `<a href>` 抽取）。若某站详情页只能靠"点击卡片"进入（如脉脉频道页的 `div[role=button]` 无 href），**2026-11-09 起引擎会自动兜底点卡片**（`detailEntry: auto`），无需再换工作区脚本；只有「点卡片也不改 URL 的纯 SPA」才需要按 §3.4.1 换 C 档。

> 结构校准可用工作区脚本 `probe_channel_comments.js`；旧版脉脉专用实现留档于 `harvest_comments.js`。

### Phase 3.4.1 — 评论采集三档路径（2026-11-09 定版，先选档再动手）

评论这条链路上有**两种完全不同的工具**，选错就是白跑：引擎 `lib/comments.js` 是**无人值守的批量器**，browser-skill（`bsk`）是**贴着用户真实浏览器的手工台**。按下面三档选，不要凭感觉混用。

| 档 | 工具 | 适用判据（满足再选） | 产出/成本 |
|---|---|---|---|
| **A · 引擎直采**（默认） | `extract.comments.enabled: true` + `crawl.js` | ① 条目有 `_link`，**或卡片可点击**（2026-11-09 起 `detailEntry: auto` 自动兜底点卡片，脉脉已可跑）；② 目标 10~200 篇；③ 展开控件是**普通 DOM**（含 open shadow root，2026-11-09 起引擎可穿透）；④ 不需要人过验证 | 无人值守，实测约 **11 帖/分**（30 帖/227 评论/2m38s）；落 `posts_with_comments.json` + `.jsonl` 可断点续抓 |
| **B · 引擎批量 + bsk 补漏** | 先跑 A → 读覆盖率告警 → `refill: true` 重跑那几篇，仍不够再上 bsk | A 跑完 `覆盖率 < 70%` 的帖子通常是个位数（大帖、楼中楼、懒加载） | 用最少的人工时间补最贵的坑；**`refill: true` 会原地刷新已有记录**（`appendExisting` 只跳过、不更新，单靠它补不回数据） |
| **C · bsk 全程** | `bsk` 逐条点击 + `extract` | ① 卡片点击也进不去（纯 SPA 无 URL 变化）；② 展开控件在 **closed shadow root / iframe** 里；③ 需要登录/验证码/二次确认；④ 目标 ≤ 30 篇 | agent 逐步驱动，每篇 3~10 次命令往返；不可无人值守、不可定时；**不要用它做 >30 篇批量** |

**为什么不能反过来**（三条红线）

1. **bsk 不做批量**：每次 `click` / `extract` 都是一次 CLI 往返且要 `--context`，几十篇就是几百次往返；agent 一步错（点错折叠、漏点楼中楼）不会被发现，且会话需 `bsk session stop` 收尾。它是"探路 + 少量补抓"，不是采集器。
2. **引擎不做首次探路**：`crawl.js` 无人值守跑，看不见页面。第一段的交互结论（点哪个 tab、控件长什么样、字段在哪个节点）必须先用 bsk 拿到（见 §0.3），否则只能靠日志猜——2026-10-29 X 排序项就是这么踩的。
3. **两者不能并发**：引擎用持久化 profile（`profiles/<host>`）独占浏览器，bsk 驱动的是用户主浏览器；同一站点同时开跑会互相踩登录态/标签页。

**覆盖率验收（2026-11-09 起，必看）**：`scrapeComments` 现在会抽「**页面声称的评论总数**」（`stats.claimCount`，只认整段就是 `N 条评论` / `评论 N` 的短元素，正文里出现「这 3 条评论」不算），`harvestComments` 逐篇打印：

```
[3] https://.../post/123 → 评论 12 条（展开点击 3 次/idle）｜页面声称 48 条，覆盖 25.0% ⚠ 偏低
✓ 评论区落盘: ... 覆盖率: 实抓 312 / 页面声称合计 980 → 31.8%（7 篇低于 70%，见上方 ⚠）
```

- `coveragePct ≥ 70%` → 视为够用，直接进分析；
- `< 70%` 且 `stats.lowCoverage > 0` → **不许静默交付**：先 `expandIdleRounds: 4~5` 重跑一轮；仍不够就按 **B 档** 用 bsk 补那几篇，并在结论里标注"哪些帖评论不全"。
- `claimCount = 0`（页面没给分母）→ 不算异常，但要人工抽查 2~3 篇条数，别把"没分母"当成"没漏"。

**历史覆盖基线（避免把正常当异常）**：`EXPERIENCE.md §二十八` 实测大帖（80/49 评论）在懒加载 + 楼中楼限制下通常只有 **40%~60%**，小帖接近 100%。所以 70% 阈值是"小帖全绿、大帖报警"的分界，不是要求大帖也 100%。

### Phase 2.5 — 日期窗口 / 断点续抓（按时间范围抓取时必做，2026-09-10 起）

### Phase 2.7 — 抓取提速默认快参（用户 2026-09-11 硬性要求）

默认一律用快参，**不要再写保守慢参**：

**已落机器层（2026-09-12）**：`lib/crawl.js normalizeTask` 与 `lib/interact.js autoScroll` 的默认值本身已改为快参，写不写这段都快：

```jsonc
"scroll": { "rounds": 800, "adaptive": true, "delayMinMs": 300, "delayMaxMs": 1200, "maxIdleRounds": 12 }
```

- 仅当 URL 命中 `search_center` 时，引擎自动切回保守慢参 `{rounds:60, adaptive:false, delayMinMs:1200, delayMaxMs:2500}`（搜索类红线，Phase 2.6）。
- 需要更大目标量时在任务里显式提高 `rounds`（如 2500）。
- **重要更正（2026-09-12，用户指正）**：**瓶颈通常是服务端加载，不是我方 sleep**。
  一味压短延迟有害：页面还没加载完就判定「高度未变」→ 连续多轮 → **误判触底提前收工，反而少拿数据**。
  引擎已改为「**先等加载，再调速**」：滚动后轮询等待页面变高，最多 `loadWaitMs`（默认 3000ms，
  任务里可覆盖）；加载快就立刻继续，加载慢最多等到 3s 才计一次 idle。
  参数：`scroll.loadWaitMs`（默认 3000，卡顿时调到 5000~8000）、`maxIdleRounds`（**普通滚动默认 12；增量模式 `extract.incremental` 分支独立默认为 6**，两者触底灵敏度不同，别混用）。
- 判断「到底是真触底还是加载慢」：看日志的 `[滚动触底/停顿：连续 N 轮…第 i/j 轮]` ——
  若 `i` 远小于 `j` 且后续重跑又能拿到新数据 → 是误判，应调大 `loadWaitMs`，不是调小 `delayMinMs`。

### Phase 2.8 — feed 可见上限（2026-09-11 三专题交叉验证）

`topic-detail/<id>/crtime` 滚到 **~9900~9960 条**即连续多轮高度不变而触底；加轮次、降延迟都拿不到更早数据。
主页频道（`gossip`/`recommended`）是**近期流**，只保留最近数天，天然不是历史数据源。

→ 取更早历史的办法：**换 `since`/`until` 窗口分批做增量合并**（每个窗口各自能拿约 1 万），或换入口（hot 排序 / URL 变体 / 分页接口）。别用「加大 rounds 硬滚」。

> 用户硬性要求：按时间范围抓取（如「某专题 2026 全年」）时，必须**在抓取过程中识别日期是否满足要求**；已抓过的专题**不重复抓**——先看已覆盖到哪天、还差哪些天，再定位到对应日期开始。

1. **先读覆盖台账**：`output/<任务名>/coverage.json`（**引擎在每次运行结束后写一次**（不是"每轮"），跨轮累积靠读取旧文件合并；字段 `{min, max, days:{日期:条数}, runs}`，`runs` 保留最近 20 次）。有台账 → 判断缺口区间。
2. **任务里写窗口**（`extract` 内，全部可选）：

   | 字段 | 作用 |
   |---|---|
   | `dateField` | 日期字段名，默认 `时间`；缺省时从 `_text` 前 120 字自动抽 |
   | `since` / `until` | `'YYYY-MM-DD'`，只保留窗口内条目 |
   | `stopBeforeDate` | 列表时间倒序，滚到「末条早于该日」即停（不重复抓已覆盖段） |
   | `resumeFromCoverage` | `true` → 自动读 coverage.json 的 `min` 当 `stopBeforeDate` |
   | `appendExisting` | `true` → 载入已有 data.json，按 `_text` 去重合并，**真增量累积** |

3. **抓完核对**：日志 `✓ 覆盖度: min ~ max（N 天）`；缺口补完后汇报「已覆盖 X~Y，还差 Z」。
4. **解析范围**：刚刚/分钟前/小时前/今天/昨天/前天/N天前/N周前/N个月前/N年前/MM-DD/YYYY-MM-DD[ HH:mm:ss]；已排除 `1-3年`、`2-5个月` 年限干扰。

### Phase 2.55 — 数据保留纪律（用户硬性要求，2026-09-10）

- **抓到的数据一律保留**：同一任务名重跑必须开 `extract.appendExisting: true`（旧 data.json 载入 → 新数据按 `_text` 去重合并 → 真增量累积）。
- 未开 `appendExisting` 且检测到已有数据时：引擎会打 ⚠ 覆盖警告，并**自动备份** `output/<name>/data.bak.<ts>.json`（除非显式 `"overwrite": true`）。**禁止删除 `output/` 目录**。
- 配合 `resumeFromCoverage: true`（读 `coverage.json` 的 min 当断点）→ 既不重复抓，也不丢旧数据。
- 每次抓完更新 `playbooks/maimai.crawl-ledger.json`（含 `topics` 话题注册表：ID/帖子量/存储路径/已抓数）。

### Phase 2.6 — 搜索配额纪律（脉脉等 search_center，2026-09-10 实测）

- **默认走专题页，搜索只作兜底**：`topic-detail/<id>/crtime`（最新序）≡ 该主题全量帖；另有 `gossip`（职言）、`recommended`（推荐）频道页。频道页/话题页不受搜索风控影响。
- **搜索配额**：≤1 次 / 30 分钟、≤4 次 / 24h；两次搜索间隔 <10 分钟基本必被降级（结果区静默空白，不报错）。
- **拦截表现与冷却**：搜索区静默空白 → 全站提示「搜索频率过高，限制访问」；当日停止全部搜索类任务，隔日先用频道页小流量试探再放量。
- 新主题入口获取：搜薪酬关键词 → 进帖 → 点正文上的话题标签 → 抄 `topic-detail/<id>` 地址（如【职级薪资大揭秘】= `JFvwxmvD`）。

### Phase 3.5 — 新站点探测（仅新站/未知结构）

**顺序：先试 API，再试 DOM。** 站点有公开 JSON API 时抓 API 比渲染快 10 倍以上，且不怕改版（2026-11-09 牛客实测，详见 `EXPERIENCE.md §三十二`）。

**① API 优先（推荐先做，1 次浏览器）**

用 Playwright 拦 `response` 事件，滚动几轮触发分页，收集 `JSON + 体积 > 5KB + URL 含 list/page/feed/query` 的端点；拿到后改用 `fetch` 直连（不必再开浏览器）。

已知可直接复用的站：

| 站点 | 端点 | 备注 |
|---|---|---|
| 牛客公司搜索 | `POST gw-c.nowcoder.com/api/sparta/pc/search` | body `{query,type:'all',page}`；**只接受 POST** |
| 牛客评价 | `GET .../experience/company/evaluation/list?companyId=<id>&pageNo=<n>` | 支持 `&tagId=<维度tagId>` 分维度 |
| 牛客维度 tag | `GET .../experience/company/evaluation/tag?id=<id>` | 返回 `{id,word,count}` |

必需 header：`x-requested-with: XMLHttpRequest` + `Referer` + UA。中文 body **必须用 Node `fetch` + `JSON.stringify`**，shell 拼 JSON 会 UTF-8 损坏。

**② DOM 探测（API 不存在时才做）**

```
node "<ENGINE>/lib/probe.js" --url=<目标URL> --cookies=<auth文件或cookiesText>
```
- 有头模式看页面结构；agent 根据输出确定：tab 名、模块关键词、字段 patterns（标签式/class 式/emoji 式/regex）。
- 反爬重的站按 `EXPERIENCE.md §一` 处理（maimai 必须有头、zhipin 已风控、x.com 需伪装）。

**求职类站点可达性（2026-11-09 实测）**：牛客 ✅ 公开 API 无登录；职友集 ⚠️ 正文懒加载、性价比低；看准网 ❌ 域名已易主 301 跳婚恋站；BOSS ⚠️ 已风控。

### Phase 2.9 — 重复内容自动停 + 向用户确认（2026-09-12 用户要求）

滚动过程中若页面反复出现**已抓过的内容**，应自动停止，并**把情况反馈给用户确认**，而不是闷头跑完。

引擎已实现：每批滚动后抽样当前列表条目（**取列表「尾部」400 条 `innerText`**，`pipeline.js` 的 `all.slice(-400)`），与「已有记录 + 之前批次」做前缀去重，算**新增率**。⚠️ 早期版本取的是**头部** 400 条，因每批都 `scrollTo(0,0)` 导致"新增率恒为 0"→ 误判"内容已抓过"提前停止（这是历史多次「13 轮触底」的真凶，2026-09-14 已修）。

| 参数（`extract.dupStop`） | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 开启重复检测 |
| `minNewRatio` | `0.05` | 本批新增率低于此值记为一次「低新增」 |
| `consecutive` | `3` | 连续 N 批低新增 → 停止 |

停止时日志打印 `[需向用户确认]`，并给出三种处置建议（已抓完 / 加载慢需调 `loadWaitMs` / 调阈值）。
**agent 必须把这条转发给用户并等确认**，不要自行判定「抓完了」。

### 站点专项：脉脉 maimai.cn（2026-09-12 定版）

**范围与纪律（用户明确要求，违反=事故）**

| 规则 | 内容 |
|---|---|
| 专题集固定 | 已定 4 话题 + 3 频道 + 1 用户新增专题，**不再自行增删**。见 `playbooks/maimai.crawl-ledger.json` v2 |
| 新增专题 | **只接受用户给的 URL**，我登记进台账。**禁止为了找新专题而自行 `search_center` 搜索**（风控 ≤1 次/30min、≤4 次/24h，间隔<10min 必降级，结果区静默空白不报错） |
| 必须带评论 | 频道类（热榜/推荐/职言）与 offer 专题：抓正文同时抓评论，保留评论中有用信息（Phase 3.4） |
| 频道目标 | 每个频道 ≥1000 条才列为备选专题，后续持续抓 |
| 数据保留 | `output/` 永不删；重跑一律 `appendExisting` |

**固定专题清单**

| 类型 | 名称 | URL / ID |
|---|---|---|
| 话题 | 我来爆个料 | `topic-detail/SxAXPZZ2/crtime`（145099，已抓 9961，撞 feed 上限） |
| 话题 | 公司印象大爆料 | `topic-detail/12dLH8oC3/crtime`（14515，已抓 10753） |
| 话题 | 职级薪资大揭秘 | `topic-detail/JFvwxmvD/crtime`（11513，已抓 9894） |
| 话题 | 爆料各司工时强度 | `topic-detail/zfe4YoeG/crtime`（5967，已抓 5761，96.5%） |
| 频道 | 热榜 | `/community/hot-rank` |
| 频道 | 推荐 | `/community/home/recommended` |
| 频道 | 职言 | `/community/home/gossip` |
| 专题 | offer 选择 | `https://maimai.cn/web/search_center?type=gossip&query=offer&highlight=true`（用户提供，只直接访问） |

**分析侧**（不属于 skill，产出放项目空间）：`parse_maimai.js`（话题解析器）→ `analyze_multi.js`（六维度 + 贝叶斯收缩）→ `build_multi_report.js`（HTML 报告）。

**解析器要点**：post 文本形如 `{作者} {时间}[·{身份}] {话题名} {公司}印象[·{工龄}] {正文}[ 分享| N 评论 赞]`。
身份可选、`分享` 可能缺失（以 `N 评论 赞` 结尾）——二者**都必须按可选处理**，否则约 30% 有效评价会被误判噪音丢弃（2026-09-12 已修）。

### Phase 4 — 抓取执行与监控（脚本执行 + agent 监控）【默认终点】

**默认只执行抓取**（data.json 保存即完成，见 §0.5）。命令在**工作区**执行，脚本用引擎绝对路径（下例 `<ENGINE>` = `C:/Users/sun/.agents/skills/web-analysis-ai`，引擎代码在 skill 根 `lib/`，**无 `project/` 子目录**）：

```
node "<ENGINE>/lib/crawl.js"  --task=tasks/<任务名>.json [--cookies=...] [--headless=false] [--tabs=a,b] [--limit=N] [--module=...] [--pagination=true]
```

**抓取完成即本次任务终点**：确认 `output/<任务名>/data.json`（数据）+ `snapshot.json`（模块定位/tab 结果）已保存，按 §0.5 汇报，不自动进入分析。

**agent 监控要点（每步看日志）**：
- `✓ 会话有效` / `⚠ 域名不匹配` → 判断登录态；
- `✓ 模块已定位` / `✗ 未定位到模块内容` → 判断提取是否命中；
- `✓ 共提取条目 N 条` → 与目标条数对比（远少于目标 → 可能反爬/结构变化 → 走 §6）；
- `⏳ 检测到安全验证` → 等待人工完成（有头模式），超时按 §6 处理。

### Phase 5 — Cookie 过期干预子流程（大模型介入，用户举的例子）

> 默认：脚本从任务里的 `cookiesText`/`authFile` 读 Cookie 注入。若过期，agent 介入向用户要新 Cookie，再续跑。

**触发信号**（出现任一即判定 Cookie 可能过期）：
1. 日志 `⚠ cookie 域名与目标站不完全匹配`；
2. 日志 `未检测到登录特征`（配了 `login.successIndicators` 时）；
3. 页面跳转到登录页/`/passport`/`/login`（抓取结果为空或日志提示重定向）；
4. 抓取 0 条或明显少于预期，且页面结构摘要显示登录墙。

**干预步骤**：
1. **判定**：agent 综合信号确认 Cookie 过期（不要凭单条日志下结论）。
2. **向用户要新 Cookie**：用 `ask_user_question` 说明——
   - 打开目标站并登录；
   - 浏览器装 [Cookie-Editor](https://chrome.google.com/webstore/detail/cookie-editor/hlkenndednhfkekhgcdicdfddnkalmdm)，`Export → Export as JSON`；
   - 把 JSON 文本粘贴给我（或存成文件给路径）。
3. **落盘**：把新 Cookie 写入 skill 基目录 `cookies/<站点host>.json`（不存在则新建），并更新任务的 `authFile` 为绝对路径（或直接改 `cookiesText` 字段）。
4. **续跑**：只重跑抓取（不要再全流程），工作区执行：
   ```
   node "<ENGINE>/lib/crawl.js" --task=tasks/<任务名>.json
   ```
   确认日志 `✓ 会话有效` 且模块定位成功、条数正常。
5. **继续后续**：默认到此为止（§0.5）；仅当用户要求分析时，agent 读 `output/<任务名>/data.json` 自行深度分析（见 Phase 6/7）。
6. **仍失败**：按 §6 异常处理（可能不是 Cookie 问题，而是反爬/验证，考虑 `--headless=false` 人工登录一次生成 storageState）。

### Phase 6 —（后续独立阶段，按需执行）分析（agent 读数据 + 大模型深度分析）

> 仅在用户要求"分析"时执行；输入是已保存的 `output/<任务名>/data.json`，无需重跑抓取。

1. **统计（确定性）**：agent 读 `output/<任务名>/data.json`，用脚本/工具计算数字类结论（如 node -e 或临时脚本聚合），确保数字与数据一致、可核对；禁止凭印象编造数字。
2. **深度分析（大模型）**：agent 对照 Phase 1 的 analysisGoals 逐条产出结论：
   - 每条结论给出：问题（对应 goals 原文）、答案、依据（引用的数据）、置信度；
   - 数字类结论必须引用上面脚本统计的结果；
   - 大样本时抽样读（用脚本/工具过滤聚合），不要整包塞给模型。

### Phase 7 —（后续独立阶段，按需执行）结论交付（agent）

- 引擎不再提供报告/PPT 生成脚本（已移除 analyze.js / build_ppt.js / lib/report.js / lib/ppt.js）。
- agent 把 Phase 6 的结论直接回复给用户，或按需写 `output/<任务名>/findings.md`（自包含 markdown，无需服务）。

产物：
```
output/<任务名>/
├── data.json       # 抓取数据
├── snapshot.json   # 模块定位 + tab 结果
└── findings.md     # 分析结论（Phase 6/7 时由 agent 写，可选）
```

### Phase 8 — 收尾与沉淀

1. **验收**（大模型）：对照用户需求逐条核对产出（数据量、字段、结论），缺失/不符 → 回到对应 Phase 修复。
2. **沉淀**：
   - ⚠️ **黄金路径必须先落代码（机器层），再写文档（2026-08-16 用户纠正，勿再犯）**：发现可复用的执行方案（提速/防漏/新机制）时，第一步是**升级到引擎 `lib/` 代码并冒烟验证**（自动生效），第二步才是写 `EXPERIENCE.md`/更新本 skill——**只写文档不落代码 = 未沉淀**，下次执行仍是旧逻辑；也不要因"临时脚本用完删除"纪律把本应升级进引擎的方案直接删掉（那是任务级工具，黄金路径是引擎能力）。
   - 脚本已自动保存站点攻略 `playbooks/<host>.json`（质量达标时）；agent 检查并补充人工经验；
   - 新踩坑追加到 `EXPERIENCE.md`（反爬行为、结构套路、字段提取细节）；
   - 更新本 skill 如有新的决策模式。
3. 汇报：给用户交付物路径 + 核心结论摘要 + 复现命令。

---

### 站点专项：X（推特）时间线采集（含排序【最近】的正确打开方式）

> 🔴 **2026-10-29 更正（本机实测，以此为准）**：排序菜单的正确打开方式是【**单击「正在关注」**】，**不是双击**。
> 本文档旧版（2026-08-16 记录）写的"必须双击"是**错的**，正是它导致 2026-10-29 两次采集「最近」`found:false`、只拿到 60 条混序数据的根因。
> 原因：双击 = click+click+dblclick 三次事件，X 的排序菜单**开了又关**，下一步去找「最近」时菜单已消失。单击一次即可稳定弹出。
> `playbooks/x.com.json` 已同步修正；`interact.js` 的 `dblclick` 分支是**活代码**（其它站点仍可用），只是 X 上不要用。

1. **目标配置（2026-10-29 实测验证）**：tab 序列 = ① **单击「正在关注」**（弹出排序菜单）→ ② 单击「最近」（Latest）。
   - 任务 JSON 里**不要写 `"dblclick": true`**，用默认单击：
     ```json
     "tabs": [
       { "name": "正在关注", "waitMs": 2500 },
       { "name": "最近", "waitMs": 4000 }
     ]
     ```
   - 正确日志：`✓ 已点击 tab「正在关注」，等待内容加载 2500ms` / `✓ 已点击 tab「最近」，等待内容加载 4000ms`
   - 错误信号：`✗ 未找到 tab「最近」` + `snapshot.json` 里 `{"name":"最近","found":false,"clicked":false}` → 说明排序没生效，采到的是默认「热门」。
   - 菜单弹出后排序选项文本为「热门 / 最近」（`role=menuitem`）。
2. **执行前提**：
   - Cookie 登录（`authFile`/`cookiesText`）；X 登录 Cookie 有效时较稳定（EXPERIENCE.md §一）；
   - `headless: false`（有头）+ 反自动化伪装（脚本已内置 `--disable-blink-features=AutomationControlled` + 隐藏 webdriver）。
3. **采集要点**：
   - > 📌 **通用能力说明**：下述"自适应增量采集"是 `pipeline.js` 的**通用机制**（任何配了 `extract.incremental: true` 的虚拟滚动站点都生效，非 X 专属）；本节的 X 专属部分仅是「单击排序菜单/最近排序/广告过滤/富文本提取」等站点操作。
   - 时间线是**虚拟滚动**：DOM 只保留视口附近条目，必须 `extract.incremental: true`；
   - **⚠ `limit` 决定时间跨度，不是"够数就行"**：实测同一账号 `limit:60` → 只覆盖 **1 小时**（46/50 条挤在 1h 内）；`limit:400` → 23 小时；`limit:500` → **24 小时（505 条原始 / 430 条去重）**。关注流 24h 真实量级 ≈ 500 条原始。要覆盖一天就设 500，不要设 60。
   - **⚠ 增量采集已改为自适应（无固定轮次上限）**：第一轮从顶部（0,0）提取最新推文，之后每次小步向下 0.6×视口（相邻窗口重叠，**任何条目至少被提取一次，不遗漏**）；**边采边计数**，直到达到目标条数或**真正触底**（连续 maxIdle 轮无新增且页面高度不再变化）才停；页面全程不关闭，条数不够自动继续。`maxRounds`（默认 500）仅防死循环。可以接受慢，但不能接受丢信息；
   - **自动刷新最新推文**：脚本会在采集前等待 `article` 渲染（≤20s），若出现「查看新帖子」按钮会自动点击加载最新（等价于双击主页刷新）；若一条都没采到且连续 maxIdle 轮无新增会**空转止损**报错（提示模块误定位），不会傻跑 500 轮；
   - 若顶部仍无"分钟/刚刚"级推文，可**双击「主页」刷新**时间线（会出现「查看新帖子」按钮），再重新采集；
   - 推文正文是**富文本**（嵌套 span）：字段配 `"tweetContent": true` 从条目全文剥作者/翻译/互动数；
   - **广告过滤**：X 关注流混入推广推文（文本含「广告」/「Ad」/「Sponsored」），配 `extract.dropNoise: true`（实测 15 条 → 0 条）。⚠ 日志打不出来（`pipeline.js` 的 `extOpts` 没透传 `log`），**只能用数据比对验证**；
   - **去重不可靠**：引擎去重键是 `_text.substring(0,150)`，而互动计数每轮都变（31→32）且落在 150 字窗口内 → 同一条被反复收录（实测 505 → 430，重复 73 条 14.5%）。**必须自己做二次去重**，键用 `s.replace(/[\s\p{P}\p{S}]/gu,'').toLowerCase()` + 前缀判等（长度≥20）；
   - **排序仍非严格倒序**：即使「最近」生效，虚拟滚动重复读同一 DOM 段会带来约 9% 的逆序断点，`_idx` 是每轮局部序号**不能当全局顺序**；
   - 排序未生效的排查：结果混入明显旧推文（如数月前）或顺序混乱 → 先查 `snapshot.json` 的 `tabResults`，再看是否误加了 `dblclick`。
4. **任务字段速查**（playbook 自动应用；手工写任务时照抄）：
   ```json
   "tabs": [
     { "name": "正在关注", "waitMs": 2500 },
     { "name": "最近", "waitMs": 4000 }
   ],
   "extract": { "incremental": true, "containerSelectors": ["article", "[data-testid=\"tweet\"]"], "limit": 500, "dropNoise": true, "tidyValues": true }
   ```
   - 任务 JSON 必须 **UTF-8 无 BOM**，否则中文 tab 名变乱码（`姝ｅ湪鍏虫敞`），永远匹配不上。
   - 完整踩坑记录见 `references/x-timeline-lessons.md`。

---

## 4. 异常处理决策表（agent 判断）

| 现象 | 大模型判断 | 动作 |
|---|---|---|
| 0 条 / 远少于目标 | 反爬？结构变？字段错？ | 看 `snapshot.json` + `pageStructureSummary`；改参数重试 1 次；再失败按 §5/有头模式 |
| 安全验证页 | 反爬 | 有头等待人工完成（脚本已支持）；提示用户；超时停止并给建议 |
| 模块未定位 | 关键词错？懒加载？ | 探测页面结构 → 修正 module/containerSelectors → 重试 1 次 |
| 字段全空 | patterns 不匹配页面标签 | 用页面结构摘要生成新 patterns（label/class/regex）→ 改任务 → 重抓 |
| 连续失败 | 站点风控 | 降频、换有头、等待冷却（EXPERIENCE.md §一），不硬刚 |
| 分析结论数字存疑 | 引用数据不一致 | 用脚本/工具重新核对 data.json 统计后再下结论 |

**纪律**：每个异常最多重试 2 次；每次重试前先诊断（读日志/结构），禁止盲目重跑。

---

## 5. 完成标准（默认：抓取保存）

- [ ] `data.json` 有数据，条数达到目标或确认无更多可采；
- [ ] `snapshot.json` 已保存（模块定位 + tab 结果）；
- [ ] 登录类任务：会话有效（日志确认），拿到登录后内容；
- [ ] X 等带排序的站点：排序已按需求设置（如「最近」），日志有对应确认；
- [ ] 已按 §0.5 汇报数据位置，未擅自进入分析阶段。

（若用户要求分析，追加：深度结论覆盖全部 analysisGoals，数字与 data.json 统计一致；结论已交付或写入 findings.md。）

---

## 6. 复用与新站点适配

1. **已有 playbook**：直接跑，脚本自动应用攻略（maimai/x.com/zhipin 已有）。
2. **新站点**：`lib/probe.js` 探测 → agent 定 tab/模块/字段 → 跑通后 playbook 自动学习。
3. **本 skill 复用**：用户下次说"抓取并分析 XXX"，直接按 §3 各 Phase 推进，无需重新设计流程。

---

## 7. 注意事项

- 采集遵守目标站条款，控制频率（EXPERIENCE.md §一 风控警告：zhipin 已标记，谨慎）。
- `cookies/`（skill 基目录内）与 `authFile` 含登录凭证：**分享/上传本 skill 前先删除 `cookies/` 目录**；项目内任务文件含 authFile 路径引用，外发时同样注意脱敏。**2026-10-25 起 `.gitignore` 已忽略 `cookies/` 与 `profiles/`**（`profiles/` 里也有 Cookies 库），但 git 忽略不等于安全 —— 外发前仍要人工确认。
- **`profiles/` 是运行时状态（约 400MB）**：内含浏览器 profile 与 Cookies 库，勿删、勿纳入版本管理；它随引擎持久化 profile 模式自动生成。
- Cookie 会过期：session cookie 通常几小时~几天，任务失败先怀疑 Cookie 再怀疑代码。
- 本地文件页（file:///...）可用于无网络验证流程（如 `test/fixture.html`）。
- **任务 JSON 不要存成「UTF-8 with BOM」**：2026-10-25 前会直接报"任务文件解析失败"（`readJson` 未剥 BOM，已修复）；若仍失败，先查编码，再看 JSON 语法。

---

## 8. 引擎修复记录（2026-10-25 审计后）

> 背景：对三个技能做能力替代性审计时，回原文逐行核对了本技能 `lib/` 全部代码，以下为确认并已修复的行为级问题。

| # | 问题 | 位置 | 修复 |
|---|---|---|---|
| A1 | **站点攻略的三个注入分支是死代码**：`task.headless == null` / `!task.verifyWaitTimeout` / `!task.login.successIndicators` 与归一化端恒填的 `boolean` / `600000` / `[]` 永不同时成立 → `antiBot.headless`、`verifyWaitTimeout`、`login` **永不生效**（`maimai.cn.json` 的 `headless:false` 是死配置，引擎默认 `headless:true` → 首跑落登录页） | `lib/playbook.js` + `lib/crawl.js` | 归一化时新增 `_explicit`（记录"用户是否显式提供"），`applyPlaybook` 改判该标记；`login` 注入改为合并（保留 `pageIndicators` 默认值） |
| A2 | **`isLoggedIn()` 是死函数**（`auth.js` 定义并导出，但 `pipeline.js` 从未导入）；日志把"域名匹配"写成 `✓ 会话有效` | `lib/pipeline.js`、`lib/auth.js` | ① 日志改为「✓ cookie 域名匹配（…仅校验域名，不代表登录仍有效）」；② 页面加载后**真正调用** `isLoggedIn`，并在命中 `pageIndicators` 时给出提示，使攻略里的 `login` 配置生效 |
| A3 | 噪声清洗词表缺 `查看全文`（只有 `展开全文`）→ 实测漏出 `岗位="招聘 查看全文 赞12"` | `lib/extract.js` `clean()` | 词表抽为常量 `TRUNC_WORDS` 并补 `查看全文/查看更多/展开全部/展开更多`，长者优先 |
| A4 | 前瞻截断正则只认 `[\u4e00-\u9fa5]{1,8}[:：]`，遇到 `⏰工作强度：` 无法截断 → 实测漏出 `公司="字节跳动 ⏰"` | `lib/extract.js` lookahead | 允许标签前带 1~3 个符号/emoji 前缀（BMP 符号区 + 代理对；本正则无 `u` 标志，故不能用 `\u{...}`） |
| B6 | `cookies/` 与 `profiles/`（内含 Cookies 库）**未被 `.gitignore` 忽略** → 真凭证可被 git 追踪 | `.gitignore` | 追加 `cookies/`、`profiles/` |
| B7 | 任务 JSON 若带 **UTF-8 BOM** 直接解析失败，且报错只说"任务文件解析失败"（加固项，超出原定范围） | `lib/util.js` `readJson()` | 读取后 `.replace(/^\uFEFF/,'')` |

**第二批修复（2026-10-25，同一天，用户确认后继续）**

| # | 问题 | 位置 | 修复 |
|---|---|---|---|
| **F1** | **评论区采集引擎零实现**（`lib/` grep `评论` 只命中 1 处清洗正则）；文档声称"点开全部评论直到 DOM 不再增长"，但工作区脚本自认"**本版先取首层**"——**从未展开过** | **新增 `lib/comments.js`** + `lib/pipeline.js` 收尾钩子 | 真正实现：`expandComments` 循环点展开控件**直到连续 `expandIdleRounds` 轮 DOM 不再增长**（已点元素打标记）；`scrapeComments` 显式选择器优先 + 时间密度法启发式；落盘 `posts_with_comments.json` **+ `.jsonl` 逐条追加（中断不丢）**；支持 `appendExisting` 续抓与 `[需向用户确认]` 循环判定；**失败不影响主数据**。由 `extract.comments.enabled` 控制，默认关闭 |
| **A5/D2** | 增量分支**硬编码 X 专属** `article` 与「查看新帖子」→ 其它虚拟滚动站只能吃 20s 超时兜底 | `lib/pipeline.js` 增量分支 | 改为 `extract.incrementalOptions = {waitSelector, waitSelectorTimeoutMs, newPostsButtonRe, newPostsWaitMs}`，**默认值与旧行为逐字一致**（零行为变化），换站时才需覆盖 |
| **E4** | **广告/推广过滤完全未内置**（文档只写"采集后需过滤"，等于甩给 agent） | `lib/extract.js` | 新增 `extract.dropNoise`（默认 `false`）+ `extract.noisePatterns`；内置 `广告/推广/赞助/Sponsored/Promoted/\bAds?\b/品牌合作/商务合作`；**不静默丢数据**：恒返回 `dropped{noise,patterns,invalidPatterns}`。ⓘ `Ad\b` 已被收紧为 `\bAds?\b` —— 原写法在 `i` 标志下会误杀 `read/thread/download` 结尾的 `ad` |
| **E4b** | `clean()` 的首尾装饰区段**不含 `U+2300-23FF`** → `⏰`（U+23F0）清不掉，这正是 A4 那个 bug 的深层原因 | `lib/extract.js` `clean()` | 抽出 `DECOR_CHARS` 并补 `2300-23FF`（⏰⌛⏳）、`2190-21FF`、国旗 `1F1E6-1F1FF`、扩展符号 `1F900-1F9FF`；仍由 `^`/`$` 锚定，**值中间零影响**。新增 `extract.tidyValues`（默认 `false`）压空白/全角空格/值尾孤立标点 |
| **D4** | `output/` 落点**随 cwd 走** → 在技能目录内执行 node 会把产物写进**全 agent 共享的真源** | `lib/pipeline.js` | 落点护栏：检测到产物将落在技能目录内时**告警并改写**到工作区 `output/`（若 cwd 也在技能目录内则退到系统临时目录）；同时**透传** `dropNoise/noisePatterns/tidyValues`（`extOpts` 此前只传 4 个键，导致任务 JSON 里配了新选项也不生效） |

**第三批修复（2026-10-25，Lead 做端到端验收时发现，均为真 bug）**

| # | 问题 | 位置 | 修复 |
|---|---|---|---|
| **E5b** | **`_link` 从未写进 record（本批最严重）**：`detectItems` 已经把条目内 `<a href>` 抽成 `item.link`，但 `extractAll` 建 record 时只取 `{_idx,_text}` → **`rec._link` 恒为 undefined**。后果是**两个功能一直静默失效**：① `extract.detail` 职位详情补充——`enrichDetails` 里 `if (!link) continue` 把**全部条目**跳过（`zhipin` 攻略里配的 detail 从来没生效过）；② 新增的评论采集 `collectDetailLinks` 永远拿到 0 个详情链接 | `lib/extract.js` `extractAll` | 建 record 时补 `if (item.link) rec._link = item.link;`（只在确有链接时写入）。⚠️ 产物 `data.json` 会因此**多出 `_link` 字段**，属预期变化。**实测验证**：修复前 `extract.detail` 填充 0 条；修复后同一 fixture **2/2 条成功补充**（46 字 / 24 字） |
| **E5c** | 详情补充的相对链接基准错了：`enrichDetails` 用 `location.origin` 拼绝对地址，而 **`file://` 页面下 origin 是字符串 `"null"`** → 拼出 `null/xxx.html`，`goto` 必失败且**静默不填**（本地 fixture 实测） | `lib/pipeline.js` `enrichDetails` | 改为以**列表页自身 URL** 为基准 `new URL(link, baseUrl).href`（base 必须在循环**前**取，否则会被上一轮详情页 URL 污染），`file://` 与怪 origin 站点均可解析 |
| **D1b** | **自适应滚动主循环可能空转到 200 批（真·假死）**：`autoScroll` 的高度触底计数 `idle` 是**每次调用的局部变量**，每批重置；而批轮数 `passRounds` 原为 clamp(rounds/3, **5..20**)，可**小于** `maxIdleRounds`(默认 12) → `idle >= maxIdle` 永远攒不满 → 永不 `stalled`。叠加"`module` 关键词不匹配 → 条目计数恒 -1（`sameCount` 判定要求 `c > 0`）+ 无 `[data-dsh-module]` 标记导致 `dupStop` 取不到样本"，三个出口全堵 → **静默空转（实测约 50 分钟）** | `lib/pipeline.js` | ① `passRounds` 下限抬到 `maxIdleRounds + 2`（上限 20→40），保证触底可达；② 新增空转止损：连续 5 批条目计数失败即停止，并打印**页面结构摘要 + 明确的排查指引**（module 关键词不唯一 / 改用 `containerSelectors`）。实测：同样的错配关键词从 ~50 分钟静默空转变为 **53 秒带诊断失败** |
| **D1c** | **短正文页面 = 假死 10 分钟且无任何日志**：`waitPageStable` 写死 `st.len > 120` 才认为页面稳定；内容稀疏页或本地 fixture 正文 ≤120 字时**永不满足**，静默等满 `verifyWaitTimeout`（默认 10 分钟） | `lib/pipeline.js` `waitPageStable()` + `lib/crawl.js` | 新增 `task.minBodyChars`（默认 120，**与旧行为一致**）；非验证页却长时间不稳定时打印一次明确提示（当前字数 / 阈值 / 建议）。⚠️ 注意 `normalizeTask` 是**白名单式返回**，新增顶层选项必须显式透传——本轮已两次踩到同类问题（另一次是 `extOpts`） |

**第二批回归验证**：
- `lib/comments.js` 自测（`test/comments-selftest.js`）全绿；
- `lib/extract.js` 自测（`test/extract-noise-selftest.js`）**56/56 PASS**；新旧 `clean()` 差分 250 例：235 例逐字节一致、15 例为预期改进、**意外回归 0**；
- 定向实验：增量分支用自定义 `waitSelector` → **无「渲染超时」**（证明去硬编码生效）；`--out` 指向技能目录 → **被拦截改写，技能目录零写入**；
- 端到端离线复跑 `test/fixture.html` → `EXITCODE=0`、模块启发式定位、字段全命中。

**第三批回归验证（Lead，真 CLI 端到端，全部离线 fixture）**：

| 用例 | 结果 |
|---|---|
| 噪声 OFF（回归保护） | 4 条全保留，`EXITCODE=0` ✓ |
| 噪声 ON | **广告行被丢弃，剩 3 条** ✓（证明 `extOpts` 透传生效） |
| 评论采集（2 篇详情、`include` 过滤、链接去重） | 3 条记录 → **去重后 2 个详情链接** → 展开循环逐轮可见 → **落盘 `posts_with_comments.json`(2 篇) + `.jsonl`**，`EXITCODE=0`，21 秒 ✓ |
| 错配 `module` 关键词 | 53 秒内**带诊断失败**（不再空转）✓ |
| `--out` 指向技能目录 | 被拦截并改写，**技能目录零写入** ✓ |

**第四批修复（2026-11-09，browser-skill 对比后落地，均为「静默失真」类问题）**

| # | 问题 | 位置 | 修复 |
|---|---|---|---|
| **F2b** | **展开控件在 open shadow root 里时永远点不到**：`clickRound` 用 `document.querySelectorAll` 收集候选，进不去影子树 → 候选恒 0 → 一轮「DOM 未增长」就判定收敛，**少抓评论且零告警**（现代 Web Components 站点常见） | `lib/comments.js` `clickRound` | ① 候选收集改为递归 `walk(document)`，穿透 open shadowRoot（closed 树从页面上下文取不到，属站点限制不绕过）；② 「最内层」判定补 `containsDeep`（`contains` 不跨影子边界，否则宿主与影子按钮会双双被当叶子）；③ 点击校验补 `ev.composedPath()`（影子内点击在 document 上被重定向成宿主，只比 `ev.target` 会误判"未送达"）；④ 上一轮标记清理改为遍历 `all`（原用 `document.querySelectorAll('[data-dsh-…]')`，影子内的标记清不掉 → 无限加载按钮只生效一次） |
| **F2c** | **评论覆盖率不可验证**：日志只报「评论 N 条」，没有分母 → `EXPERIENCE §二十八` 已知大帖只拿 40%~60%，但交付时看不出来，属于静默失真 | `lib/comments.js` `scrapeComments` / `harvestComments`；`lib/pipeline.js` 汇总行 | `scrapeComments` 抽 `stats.claimCount`（页面声称总数，只认整段就是 `N 条评论`/`评论 N` 的短元素，正文里的「这 3 条评论」不算）；`harvestComments` 逐篇打印「页面声称 N / 覆盖 X%」，`< 70%` 且声称 ≥5 时打 ⚠ 并计 `stats.lowCoverage`；收尾汇总 `coveragePct`。**不改默认行为**：`claimCount=0` 时输出与旧版完全一致 |
| **F2d** | 无 `_link` 时的提示仍指向"工作区专用脚本"，与 §0.3 的默认两段式不一致 | `lib/pipeline.js` | 改为指向 Phase 3.4.1 三档路径：a) 有 href → 补 `containerSelectors` 重试；b) 只能点卡片 → auto 档自动兜底 |

**第五批修复（2026-11-09 晚，P0/P1/P2：让"有结论但落不了地"的三处闭环）**

| # | 问题 | 位置 | 修复 |
|---|---|---|---|
| **P0** | **脉脉评论区根本进不去**：`collectDetailLinks` 只认 `rec._link`，而脉脉频道页卡片是 `div[role=button]` 无 href —— 实测 `output/maimai_topic_baoliao/data.json` **14,556 条记录 `_link` = 0**。→ 打印「⚠ 无可用 _link」后整段跳过，能力只剩工作区脚本（换机即失） | `lib/comments.js` `harvestComments` | 新增 `detailEntry: auto\|link\|click`（默认 auto）：链接为空时走**点卡片进详情**——`clickCardAt()` 按索引点第 i 张可见卡片（页面上下文重新查，避免回退后 handle 失效）→ `waitUrlChange()` 等 URL 变成 `detailUrlPattern` → 展开+抽取 → `goBack()` 回列表 → 下一张。带「连续 5 张点不动就停」的保护，`stats.cardCount/clickEntryFails` 可核 |
| **P1** | **补抓承诺与实现不符**：`appendExisting: true` 只跳过已抓 URL、**从不更新记录** → 上批文档写的「bsk 补完把数补回」根本做不到，覆盖率告警只能看不能修 | `lib/comments.js` `harvestComments` | 新增 `refill: true`：`seen` 由 Set 改 Map（url→下标），已存在记录在**新抓更全**（`comments.length` 更大）时原地覆盖并写 `refilledAt/refillFrom`，统计 `refilled/refillGained`；不更全仍按重复跳过并打印 `old → new` |
| **P2** | **`maxPosts` 截的是"列表前 N"不是"价值前 N"**：列表顺序 ≠ 价值顺序，前 50 条可能是水帖 | `lib/comments.js` `collectDetailLinks` / 新增 `sortRecords` | 新增 `sortBy: index\|engage\|textLen`（默认 index 零行为变化）；engage = 赞 + 转×2 + 评×1.5（复用 `x_opinion` 口径），textLen 取 `正文/content/text/_text` 长度；同分用原始下标做次键，显式保证稳定 |

**契约兼容**：以上三个开关**不塞进 `normalizeCommentOpts`**（契约 §1.1 的 14 键被自测 `deepStrictEqual` 钉死）——放在 `extract.comments` 里由新增的 `extendCommentOpts()` 白名单并入，默认值在 `EXT_DEFAULTS`、由 `withDefaults` 兜底。不配这三个键时，输出与旧版逐字一致（自测 13b 守着）。

**配置写法**：

```json
"comments": {
  "enabled": true,
  "maxPosts": 50,
  "containerSelectors": ["div.bg-card"],
  "detailEntry": "auto",            // auto（默认）| link | click
  "detailUrlPattern": "gossip-detail|feed-detail",   // 脉脉：点开后 URL 含这两个之一
  "clickWaitMs": 8000,              // 点卡片后等跳转的上限
  "clickCardSelector": "",          // 留空则用 containerSelectors[0] → [role=button]
  "refill": true,                   // 已抓过但更全的记录原地刷新（补抓）
  "sortBy": "engage",               // index（默认）| engage | textLen
  "appendExisting": true
}
```

**第五批回归**：`test/comments-selftest.js` 68 → **72 条，全绿**；新增 13a（`sortRecords` 三种模式 + 同分稳定）、13b（`extendCommentOpts` 白名单、契约 14 键不被污染）、13c（**links 为空**也能点卡片抓到 3 篇、`cardCount=4 / clickEntryFails=0`）、13d（`refill` 把 1 条评论的记录刷成 3 条，`refilled=2 / refillGained=4 / added=0`）。新增夹具 `test/comments-click-fixture.html`（列表 4 张 `div[role=button]` → 同文件 `?d=<i>` 详情页，模拟脉脉无 href）。

**第四批回归（2026-11-09 下午）**：`test/comments-selftest.js` 由 64 条扩到 **68 条，全绿**；新增 12a（claimCount=12）、12b（coveragePct=100 / lowCoverage=0）、12c（正文「这 3 条评论」→ claimCount=0 不虚报分母）、12d（影子树内展开控件：`clicks=2 / clickFails=0 / 评论块 1+2`）。`lib/*.js` `node --check` 全通过。

**仍已知未修**：① **纯 SPA 点卡片不改 URL**（点开后仍是列表 URL）→ `waitUrlChange` 判不出来，按 Phase 3.4.1 走 **C 档 bsk**；③ 评论采集为串行拟人节奏，大批量耗时长（设计如此，见 Phase 3.4 成本提示）；④ `profiles/` 约 400MB 且位于技能目录内（已 gitignore，但迁移/外发时需手动排除）；⑤ **closed shadow root / iframe 内的展开控件**引擎仍点不到（跨域 iframe 尤其）→ 同样走 C 档。

> ~~② `expandComments` 多级展开漏评论~~ → **已修复**（2026-10-25 task-7：标记改按「元素+状态文案」记、叶子判定基于全部匹配元素、点击用捕获监听校验是否送达）。2026-11-09 自测实测 `多级展开: clicks=2 / DOM 评论 8/8`，本条不再适用——**旧文档"修好前把 expandIdleRounds 调到 4~5"的建议已过期，调大只用于覆盖率告警后的补救重跑**。

**回归验证（2026-10-25）**：`node --check` 9/9 通过；定点单测 10/10 通过（A1 三种场景、A3 三种词、A4 四种前缀）；端到端离线复跑 `test/fixture.html` → `EXITCODE=0`、12 条、模块启发式定位 `div.job-list`（itemCount=30）、字段 4/4 正确，**且故意使用带 BOM 的任务文件以验证 B7**。

**尚未修复（已确认的缺口，按优先级）**：~~① `F1` 评论区采集仍只在工作区脚本里~~ → **已于第二批修复，见下表**；~~② `D2` 增量分支硬编码~~、~~③ `E4` 广告过滤未内置~~、~~④ `output/` 落点随 cwd~~ → **均已于第二批修复**。
