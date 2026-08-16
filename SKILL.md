---
name: web-analysis-ai
description: Agent 主导的网页抓取与分析工作流（引擎=执行代码随 skill 自包含在 project/ 子目录；工作区=任务/输出/临时文件在 F:\despseekharness\crawler，两边分离）。Use when the user wants to crawl and analyze web pages (网页抓取/数据采集/网页分析/批量提取), needs login with saved cookies (Cookie-Editor / storageState), or says "用 web-analysis-ai / 用爬虫项目 / 抓取并分析". 核心模式：agent 主导编排，每一步裁决用本地脚本（确定性操作）还是大模型（语义判断），并把整个流程沉淀为可复用 skill。
---

# Web Analysis AI — Agent 主导的网页抓取分析工作流

> **引擎**（执行代码+依赖+参考）：**本 skill 基目录下的 `project/`**（Web Analysis AI，Node + Playwright 1.62）。
> **工作区**（任务文件+输出产物+临时文件）：`F:\despseekharness\crawler`——每次执行的结果和临时文件都放这里，不污染 skill。
> **路径解析规则**：
> - 引擎根 = 本 skill 基目录 `/project`（lib / node_modules / package.json）；入口 `lib/crawl.js`；
> - Cookie = 本 skill 基目录 `/cookies/<站点host>.json`；
> - 所有 node 命令在**工作区**执行（pwsh workdir=工作区），脚本用引擎绝对路径：`node "<引擎根>/lib/crawl.js" --task=tasks/xxx.json`（output 落在工作区 `output/`）；
> - 任务文件放**工作区** `tasks/`，`authFile` 用**绝对路径**指向 skill cookies（跨目录/跨盘必须绝对）。
> 本文档是 agent 的执行剧本：按阶段推进，每步先裁决「脚本 or 大模型」，再执行。

---

## 0. 定位与核心原则

1. **agent 主导**：整个流程由 agent（大模型）编排，不是一把梭跑脚本，也不是纯 LLM 现场发挥。
2. **两步裁决**：每个环节先判断——确定性/机械性 → **复用本地脚本**；语义/判断/需要用户 → **大模型介入**。
3. **失败降级**：脚本失败先诊断原因（看日志/页面结构），不要盲目重试；大模型判断失败不阻塞，回退到脚本能力。
4. **沉淀复用**：每个站点跑通后更新 `playbooks/<host>.json` 与 `EXPERIENCE.md`，下次直接复用。

---

## 0.5 执行范围（默认：只抓取保存到本地，分析另做）

- **默认执行范围 = 「抓取数据并保存到本地」**（Phase 1~4 + `data.json`/`snapshot.json` 落盘），到这一步即视为本次任务完成。
- **分析 / 报告 / PPT 是独立的后续任务**，不在默认范围内：用户后续说"分析"时，agent 读 `output/<任务名>/data.json` 自行深度分析（见 Phase 6/7），引擎不含分析/报告/PPT 脚本。
- 只有用户**明确要求**全流程（"抓取并分析并出报告"）才继续 Phase 6/7，否则不要自动跑到分析阶段。
- 遇到需要登录的站点，Cookie 过期干预（Phase 5）属于抓取阶段内，照常执行。

---

## 1. 前置条件检查（开始前必做）

| 检查项 | 命令/位置 | 不满足时 |
|---|---|---|
| 引擎就位 | 本 skill 基目录 `project/`（含 lib/node_modules/package.json） | 缺失则告知用户需还原引擎 |
| 依赖已装 | 引擎根 `node_modules` 存在 | 引擎根执行 `npm install`（含 playwright 浏览器：`npx playwright install chromium`） |
| 工作区就位 | `F:\despseekharness\crawler`（tasks/ 与 output/ 所在目录） | 不存在则创建 `tasks/`、`output/` |
| 经验文档 | 引擎内读 `EXPERIENCE.md` + `playbooks/` | 无则跳过，新站点按 §7 适配 |
| 任务定义 | 工作区 `tasks/<任务>.json`（模板见 Phase 2） | 由 agent 按 §3 生成 |
| 会话文件 | skill 目录内 `cookies/<站点host>.json`（标准位置与格式见 `references/cookie-guide.md`）或任务里 `authFile`/`cookiesText` | 没有则匿名模式（提示用户可能拿不到登录内容） |

执行工具：用 `pwsh`（workdir=**工作区** `F:\despseekharness\crawler`）跑 node 命令，脚本路径写引擎绝对路径（如 `node "C:/Users/sun/.agents/skills/web-analysis-ai/project/lib/crawl.js" ...`）；用 `read`/`write`/`edit` 读写任务与输出（输出落在工作区 `output/`）；用 `ask_user_question` 向用户索要 Cookie 等交互信息。

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
  - 字段：`url / authFile 或 cookiesText / headless / tabs / scroll / extract{module,fields,limit} / login{successIndicators,pageIndicators}`。
  - `authFile` 用**绝对路径**指向 skill cookies（如 `C:/Users/sun/.agents/skills/web-analysis-ai/cookies/x.com.json`）。
  - 字段 patterns 先按需求关键词给；**未知站点先做 Phase 3.5 探测**，别盲写。
- **任务模板**（虚拟滚动站点如 X 需另加 `"extract": { "incremental": true, ... }`，见站点专项 §X；playbook 会自动应用已沉淀配置）：

  ```json
  {
    "name": "任务名（输出目录名）",
    "title": "报告标题",
    "url": "https://目标网址",
    "authFile": "C:/Users/sun/.agents/skills/web-analysis-ai/cookies/<host>.json",
    "headless": false,
    "tabs": [{ "name": "tab 名", "waitMs": 1500 }],
    "scroll": { "rounds": 5, "delayMinMs": 1200, "delayMaxMs": 2500, "maxIdleRounds": 6 },
    "extract": {
      "module": "模块关键词（留空则自动定位重复列表）",
      "fields": [{ "name": "字段名", "patterns": ["页面标签词"] }],
      "limit": 100
    }
  }
  ```

### Phase 3 — 会话与 Cookie 准备（脚本为主）

1. **标准存放**：Cookie 按网站分文件放 **skill 目录** `cookies/<站点host>.json`（一个站点一个文件，随 skill 自包含；分享 skill 前先删 `cookies/`）。格式与填充步骤见 `references/cookie-guide.md`（Cookie-Editor 导出 JSON 数组整体替换 `[]` 即可）。
2. Cookie 来源二选一（lib/auth.js 两种格式都兼容，自动规范化）：
   - `authFile`：**绝对路径**指向 `cookies/<站点host>.json`（如 `C:/Users/sun/.agents/skills/web-analysis-ai/cookies/x.com.json`；任务文件在工作区，跨目录必须绝对路径）；
   - `cookiesText`：Cookie-Editor 导出的 JSON 文本直接内联（临时用）。
3. **Cookie 过期预检**（大模型判断）：agent 检查
   - 文件存在、非空；
   - 域名匹配目标站（脚本运行日志会打印 `✓ 会话有效` 或 `⚠ cookie 域名与目标站不完全匹配`）；
   - 若可疑 → 走 §5 干预流程，别等到抓完才发现。

### Phase 3.5 — 新站点探测（仅新站/未知结构）

```
node "<ENGINE>/lib/probe.js" --url=<目标URL> --cookies=<auth文件或cookiesText>
```
- 有头模式看页面结构；agent 根据输出确定：tab 名、模块关键词、字段 patterns（标签式/class 式/emoji 式/regex）。
- 反爬重的站按 `EXPERIENCE.md §一` 处理（maimai 必须有头、zhipin 已风控、x.com 需伪装）。

### Phase 4 — 抓取执行与监控（脚本执行 + agent 监控）【默认终点】

**默认只执行抓取**（data.json 保存即完成，见 §0.5）。命令在**工作区**执行，脚本用引擎绝对路径（下例 `<ENGINE>` = `C:/Users/sun/.agents/skills/web-analysis-ai/project`）：

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
   - 脚本已自动保存站点攻略 `playbooks/<host>.json`（质量达标时）；agent 检查并补充人工经验；
   - 新踩坑追加到 `EXPERIENCE.md`（反爬行为、结构套路、字段提取细节）；
   - 更新本 skill 如有新的决策模式。
3. 汇报：给用户交付物路径 + 核心结论摘要 + 复现命令。

---

### 站点专项：X（推特）时间线采集（含排序【最近】的正确打开方式）

> ⚠️ 实测经验（2026-08-16 记录，避免再踩坑）：排序菜单的正确打开方式是【**双击「正在关注」**】——单击只选中 tab，**双击才弹出排序菜单**。此前试过点 tab 右缘（clickEdge）等方法不稳定，别再走弯路。

1. **目标配置（实测验证 2026-08-16）**：tab 序列 = ① **直接双击「正在关注」**（一步完成"选中+弹出排序菜单"）→ ② 单击「最近」（Latest）。已写入 `playbooks/x.com.json`（tab 配 `"dblclick": true`）。
   - ⚠️ **踩坑记录**：不要"先单击再加双击"（共 3 次点击）——X 的排序菜单会"开了又关"，导致「最近」选项找不到、排序未生效（首跑即因此采到混序数据）。
   - 菜单弹出后，排序选项文本为「热门 / 最近」（role=menuitem），确认日志出现"已双击 tab「正在关注」（弹出排序菜单）"。
2. **执行前提**：
   - Cookie 登录（`authFile`/`cookiesText`）；X 登录 Cookie 有效时较稳定（EXPERIENCE.md §一）；
   - `headless: false`（有头）+ 反自动化伪装（脚本已内置 `--disable-blink-features=AutomationControlled` + 隐藏 webdriver）。
3. **采集要点**：
   - > 📌 **通用能力说明**：下述"自适应增量采集"是 `pipeline.js` 的**通用机制**（任何配了 `extract.incremental: true` 的虚拟滚动站点都生效，非 X 专属）；本节的 X 专属部分仅是「双击排序菜单/最近排序/广告过滤/富文本提取」等站点操作。
   - 时间线是**虚拟滚动**：DOM 只保留视口附近条目，必须 `extract.incremental: true`；
   - **⚠ 增量采集已改为自适应（无固定轮次上限）**：第一轮从顶部（0,0）提取最新推文，之后每次小步向下 0.6×视口（相邻窗口重叠，**任何条目至少被提取一次，不遗漏**）；**边采边计数**，直到达到目标条数或**真正触底**（连续 maxIdle 轮无新增且页面高度不再变化）才停；页面全程不关闭，条数不够自动继续。`maxRounds`（默认 500）仅防死循环。可以接受慢，但不能接受丢信息；
   - **自动刷新最新推文**：脚本会在采集前等待 `article` 渲染（≤20s），若出现「查看新帖子」按钮会自动点击加载最新（等价于双击主页刷新）；若一条都没采到且连续 maxIdle 轮无新增会**空转止损**报错（提示模块误定位），不会傻跑 500 轮；
   - 若顶部仍无"分钟/刚刚"级推文，可**双击「主页」刷新**时间线（会出现「查看新帖子」按钮），再重新采集；
   - 推文正文是**富文本**（嵌套 span）：字段配 `"tweetContent": true` 从条目全文剥作者/翻译/互动数；
   - **广告过滤**：X 关注流混入推广推文（文本含「广告」/「Ad」/「Sponsored」），采集后需过滤，否则污染数据；
   - 排序未生效的排查：结果混入明显旧推文（如数月前）或顺序混乱 → 检查是否误加了单击（见踩坑记录），重跑时只保留"双击+点最近"两步。
4. **任务字段速查**（playbook 自动应用；手工写任务时照抄）：
   ```json
   "tabs": [
     { "name": "正在关注", "dblclick": true, "waitMs": 2500 },
     { "name": "最近", "waitMs": 4000 }
   ],
   "extract": { "incremental": true, "containerSelectors": ["article", "[data-testid=\"tweet\"]"], "limit": N }
   ```

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
- `cookies/`（skill 基目录内）与 `authFile` 含登录凭证：**分享/上传本 skill 前先删除 `cookies/` 目录**；项目内任务文件含 authFile 路径引用，外发时同样注意脱敏。
- Cookie 会过期：session cookie 通常几小时~几天，任务失败先怀疑 Cookie 再怀疑代码。
- 本地文件页（file:///...）可用于无网络验证流程（如 `test/fixture.html`）。
