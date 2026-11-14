# EXPERIENCE.md - 踩坑经验与成功模式（下次直接照做，避免重复试错）

> 本文件记录 Web Analysis AI 在真实站点（maimai / BOSS直聘 / X.com）实战中总结的经验。
> 新站点分析前先读本文件 + 查看 `playbooks/` 是否已有该站点攻略。

---

## 一、反爬与安全验证（最重要的坑）

> **2026-11-10 起：站点规则已迁到独立分册 `sites/<host>.md`**（按媒体分开，含节流参数、风控信号、已知坑）。
> 采集前先读分册；本节只保留跨站点通用结论与索引。

| 站点 | 行为 | 经验 |
|------|------|------|
| **xiaohongshu.com** | **headless 直接进验证码页**；搜索 API 高频请求返回 **HTTP 461**；详情页触发后跳 `/website-login/captcha` 要求 APP 扫码 | **必须 headless=false + 详情间隔 ≥9 秒 + 461 立即停**。完整规则见 [`sites/xiaohongshu.com.md`](sites/xiaohongshu.com.md) |
| maimai.cn | headless 会被退回登录页 | **必须 headless=false**（有头）；会话用 Cookie-Editor JSON 或 storageState。完整规则见 [`sites/maimai.cn.md`](sites/maimai.cn.md) |
| zhipin.com | 自动化浏览器被反复踢到 verify 安全验证页/首页，**风险会升级**（先能进职位页 → 后来连手动访问都被踢） | 风控按 IP+指纹累积升级；当前环境已被标记。对策：有头+人工验证（工具已支持等待）、或真实 Chrome（`channel:'chrome'`）、或换 IP/等待冷却；**降低访问频率** |
| x.com | 登录 Cookie 有效时较稳定；有反爬但较轻 | 有头模式 + `--disable-blink-features=AutomationControlled` + 伪装 `navigator.webdriver` 即可 |

**通用机制（已实现）**：
- `verifyWaitTimeout`（默认 10 分钟）：检测到 verify/security 页时暂停，日志提示「请在浏览器窗口完成验证」，**人工完成后自动继续**
- 导航后上下文销毁（验证跳转）→ 等待恢复后自动重试一次

## 二、页面结构套路（识别即用）

| 场景 | 现象 | 对策（已实现） |
|------|------|------|
| 虚拟滚动列表（X 时间线） | DOM 只保留视口附近 ~5 条，滚过的被移除，普通"滚动后提取"只能拿到几条 | `extract.incremental: true`：**每滚一轮提取一次**，跨轮去重，直到目标条数 |
| **X 排序菜单（2026-08-16 实测）** | 「正在关注」的排序菜单（热门/最近）打开方式 | **直接双击「正在关注」** 弹出菜单（菜单项「热门/最近」，role=menuitem），再点「最近」。**不要先单击再加双击**（3 次点击会让菜单开了又关）。旧方法 clickEdge（点 tab 右缘）已弃用 |
| **X 最新推文丢失（2026-08-16 实测）** | 最近排序下抓到的最早推文是"3小时"、没有"分钟/刚刚"级 | 根因：增量采集第一轮就 `scrollTo(底部)`，虚拟滚动把顶部最新节点清出 DOM。**修复：第一轮从顶部（0,0）开始提取，之后逐步向下走（scrollBy 0.6×视口，相邻窗口重叠保证不遗漏）**。若顶部仍无最新推文，可**双击「主页」刷新**（出现「查看新帖子」按钮） |
| **采集轮次上限（2026-08-16 重构）** | 固定 `scroll.rounds`（30/40/90…）是硬上限，条数不够会提前停 | 已改为**自适应**：边采边计数，无固定轮次上限，直到达到目标条数或**真正触底**（连续 maxIdle 轮无新增 且 页面高度不再变化）才停；`maxRounds`（默认 500）仅防死循环。页面全程不关闭，条数不够自动继续在页面采集 |
| X 关注流混入广告 | 推广推文（文本含「广告」/「Ad」/「Sponsored」）污染数据 | 采集后按广告过滤；若需 N 条干净数据，任务 limit 上浮（如要 100 条设 150） |
| X 作者名含空格/全角字符 | 旧正则 `[^|@\s·]{1,30}` 匹配不到（如「ChandlerGuo 郭宏才 宝二爷」「AB Kuai.Dong」） | 作者正则：`^(?:(?:已转帖|已转推)[\s·]*)?(.{1,40}?)\s+@([A-Za-z0-9_]+)`（名字允许空格，兼容已转帖前缀） |
| 分页「下一页」 | 站点用按钮翻页 | `pagination.enabled + buttonText: "下一页"`，每页去重累计 |
| **热榜页（maimai hot-rank，2026-08-16 实测）** | 热榜固定 15 条，**不滚动加载**（scrollHeight 恒定、底部即全部）；下方帖子流约 30 条 | 直接采全部即可。热榜容器 `li:has(img[alt="hot"])`（li=排名 div + 标题 div + 标签 div，文本无分隔符 → 用 class 属性 patterns 提排名/标题 + 尾部 regex 提标签）；帖子流容器 `div.px-3.sm:bg-background.sm:px-0 > div`（作者/时间/内容用 regex；「姓名+公司」格式无时间，作者 lookahead 需兼容空格） |
| **多组采集同页共存（2026-08-16 修复）** | 同一页面采多组（如热榜+帖子）时，第二组误定位到第一组容器 | 根因：locateModule 残留 `[data-dsh-module]` 标记，detectItems 取 DOM 第一个标记 → 每组定位前先清除旧标记（已修复） |
| **多组任务被旧攻略污染（2026-08-16 修复）** | 用 `extract.pages` 的任务被旧单组 playbook 注入 module/fields，导致 qualifies 字段填充率误判、自动学习被跳过 | 根因：applyPlaybook 对多组任务注入顶层单组配置 → 多组任务跳过顶层注入；buildPlaybook 现会保存 `extract.pages`（含每组 containerSelectors/fields） |
| 富文本正文（X 推文） | 正文是嵌套 span，属性取文本只能拿到第一个子元素 | 字段加 `"tweetContent": true`（从条目全文剥作者行/翻译行/互动数）或 `"richText": true` |
| 页脚/导航被误当列表 | 重复的短文本元素（店长直聘…）评分更高 | 模块定位按「重复数 × 文本丰富度」评分，短文本容器自动排除 |
| 每条目独立包裹 | selector 命中多条但每条各有父级 | 容器自动向上找公共祖先 |
| 无标签字段（学历/城市） | 页面没有「学历：」标签 | 字段用 `"regex"` + `"group"` 模式直接在全文匹配 |
| **maimai topic-detail 页（2026-08-16 实测）** | 话题详情评论区（如 /community/topic-detail/<id>/crtime） | 卡片容器 `div.mt-4.rounded-lg.bg-background.px-3.sm\:px-0`（列表容器与卡片同 class，locateModule 自动上溯到公共祖先；**无限追加滚动非虚拟化**，普通 autoScroll+单次提取即可，60 轮约够 200 条）。字段正则：公司=`公司印象大爆料\s*([^\s·]{1,30}?印象)`（勿直接匹配「XX印象」会误命中话题名「公司印象大爆料」）；**时间必须同时兼容相对时间与 MM-DD 日期**（新帖「1小时前」，老帖「08-13」，正则加 `\d{1,2}-\d{1,2}(?=·|\s)` 且用前瞻排除「1-3年」这类年限；**别漏 `\d+天前` 分支**）；内容含 emoji 标签模板（🖥工作环境/🤝团队氛围/💰公司福利/⏰工作强度/💡其他补充），用 `regex` + 下一标签 lookahead 逐字段提取，值尾部由 clean() 截掉「查看更多/分享/评论/赞」 |
| **maimai 大采集（2000 条，2026-08-16 实测）** | 评论区走 RSC 私有协议（`?_rsc=`），**无公开 JSON 分页接口**；每次 scrollTo 底部固定只 +10 条 | 大采集仍需 DOM 滚动：plain 模式（勿用 incremental，逐轮重提取太慢）+ scroll.rounds≈260（delay 900~1400ms）约 5-6 分钟采满 2000 条；容器选择器用 `div.bg-card`（确定性 selector 模式，避免含 `sm:px-0` 的类选择器退化到 repeated）；append 型列表 DOM 保留全部卡片 → 采后一次性提取 + 去重 + 条数校验即可保证不漏 |
| **自适应滚动升级（2026-08-16 引擎默认）** | 固定延迟（如 800~1200ms）会空转浪费轮次（实测 4882/5000，13% 轮次无产出） | 引擎已改为**自适应调速默认开启**：`lib/interact.js autoScroll` 按高度增长自动调延迟（400~2500ms，`adaptive:false` 退化为旧固定延迟）；`lib/pipeline.js` 普通滚动（非分页）升级为**目标驱动**：autoScroll（每批 5~20 轮）→ `locateModule+detectItems` 条目计数 → 达标即停，否则滚到触底；**全程只提取一次**（速度）且**计数与最终提取同机制**（准确，勿用裸 `querySelectorAll(选择器).length`——`div.bg-card` 会命中卡片内部嵌套元素导致计数虚高，实测初始 571 vs 实际 11 张卡）；增量模式（虚拟滚动）延迟下限仍为 1200ms 不变；5000 条自适应实测 5151 卡 / 459s（约 2 倍提速） |

## 三、分析（agent 读数据自行推理）

- 引擎只负责抓取落盘（data.json），**分析由 agent 直接读数据完成**（不再有 analyze.js / lib/stats.js / lib/llm.js 脚本链，已移除）。
- 统计类数字结论必须用脚本/工具核对 data.json（如 node -e 聚合），禁止凭印象编造数字。
- 大样本时抽样读（脚本/工具过滤聚合），不要整包塞给模型。

### 3.1 评价「某次行情谁看对了」的三条硬规矩（2026-11-13 用户质疑后补，**勿再犯**）

> 背景：11-13 跌破 7 万事件复盘里，我把 `@huangdaobtc` 评为 S 级「从头看对」，而 11-11 的报告判他「追涨杀跌 95%、负分档」。用户直接质问「是标准不同还是你漂移了」。复核后确认是漂移 + 3 处错误。

1. **单波事件评级必须做历史一致性校验**
   只截「事件窗口内是否看空/是否喊底」，会系统性奖励**顺势者**。必查 `output/x_btc_2026/final_v3.json` 的 `trend.rate` 与 `trend.variety`：
   - `trendFollow ≥ 0.72 且 n ≥ 8` → **评级封顶 B**，只能写「这波跟对了」，**禁止写「提前预判」「从头看对」**；
   - 看跨月方向切换：涨月看涨、跌月看跌 = 顺势，不是能力；
   - 实测 `@huangdaobtc`：9 月看涨（「83000 无疑会被突破」）→ 10-09 转空，全年 up 10/down 17、trendFollow 94.7%（19 次中 18 次顺 21 日趋势）、4 口径 unstable、超额 +1pt。

2. **博主自述一律不能当证据**
   「我是一直看空」「我从顶上就看空」「我早就说过」这类话必须回 `preds/*.json` 按 `date + dir` 核对：
   - 核对不上 → 标「自述，未经验证」并降权；
   - 台账为空（如 `@pathusa` 无 preds 记录）→ 标「无历史基准，仅按原文判断」，**不与有基准的账号同权排名**；
   - 实测：`@huangdaobtc` 自述「我是一直看空」但 9 月看涨；`@CryptoApprenti1` 自述「从顶上就看空」但 preds 最早 11-03。

3. **同一对象两次结论相反时，先假设是自己漂移**
   逐项对齐四项：评价窗口 / 评价维度（能力 vs 单波）/ 样本范围（全年台账 vs 事件内推文）/ 是否新增校验项。四项都对不上就不是「口径不同」，而是漂移 → **必须在报告里出勘误**（原判 + 推翻依据 + 修正后定性），不能悄悄改。

> 完整版见共用池 `~/.agent-memory/EXPERIENCE.md`（「单波事件评级」「自述不可信」两行，2026-11-13 同批写入）。

## 四、会话/Cookie（继承 Crawler-mm 经验）

- 加载用 `newContext({storageState})` 或 `context.addCookies()`；**绝不用 `storageState()` 写入覆盖**
- Cookie-Editor 裸数组自动规范化：`No_restriction→Lax`、`session→-1`、`path 默认 /`、`SameSite=None 必须补 secure`
- Cookie-Editor 用 `expirationDate` 字段（不是 `expires`），都要兼容
- 会话按主域名校验，换站自动适配

## 五、字段提取细节

- inline span 无分隔符 → 值用**懒匹配 + 下一标签前瞻截断**（`公司：腾讯 👷岗位：招聘` → 公司=腾讯）
- emoji/ZWJ 残留 → 值清理正则（含 U+200D 连接符、`查看更多/赞12/评论3` 互动尾缀）
- 数字带单位：`63.0万→630000`、`¥129→129`、`1.2k→1200`
- 日期识别排除点号（`4.0` 不是日期）；`07-27·招聘HR` 前缀式日期要支持
- 分类/文本阈值 75%（小样本真实分类字段唯一值占比也常 >60%）

## 六、测试与开发流程（成功模式）

1. **先探测后配置**：新站点用 `node lib/probe.js --url=... --cookies=...`（有头）看结构，再定 tab/字段——不要直接跑全流程试错
2. **引擎自检**：`node --check` 逐个检查 lib（语法），或临时写最小脚本 `require('./lib/pipeline')` 验证模块可加载（本地无网络验证用 `test/fixture.html`，`node lib/crawl.js --url=file:///.../test/fixture.html`）
3. 命名规范：输出只在 `output/<任务名>/`；临时探测脚本用完删除

## 七、当前环境事实（2026-08-15）

- Node v24 / Playwright 1.62.1（chromium-1234）
- zhipin 已被风控标记；x.com 可用（Cookie 登录）

## 十、多渠道采集台账纪律（2026-09-09 用户要求）

| 规则 | 落地 |
|---|---|
| 每个专题/渠道内容独立存放 | `output/<渠道名>/data.json` + 独立解析 master `parsed_<渠道名>.json`，不混渠道 |
| 历史+新增合并，减少重复工作 | `parse_maimai.js --append` 按 公司\|正文\|日期 去重拼接，master 永久保留 |
| 记录「已抓过什么」避免重复执行 | 机器层台账 `playbooks/maimai.crawl-ledger.json`：每渠道记 coverage/bottomReached/lastRun/master 路径；**抓取前先查台账，抓完立即更新** |
| 台账用法 | 台账 = 机器层确定性配置，agent 每次规划抓取时先读它判断增量必要性，勿凭印象重抓 |
| **搜集方向库（2026-09-09 用户要求，长期有效）** | 台账 `directions` 数组登记所有有价值方向：①公司正负面评价 ②公司吐槽 ③**公司八卦新闻（用户点名重点，高管变动/裁员/组织调整/爆料）** ④其他有价值信息。八卦按公司分类：master=`output/master_company_gossip.json`，字段 `{company, text, date, source, channel}`，按 company 聚合，不逐公司建文件；其他类探索完先 probe 结构再定存储方案回写台账 |

## 八、登录持久化（2026-09-09 实测，用户硬性要求：登录一次，永久复用）

| 现象 | 根因 | 修法（已实现于 pipeline.js） |
|---|---|---|
| Cookie 文件每次都加载了，但仍反复弹安全验证、要求人工干预 | ① `auth.js` 的 `saveSession()` 定义了却从未被调用 → 人工过验证后新发的会话令牌没回存，浏览器一关即丢；② `chromium.launch` 无 `userDataDir` → 每次全新浏览器指纹，站点视为「新设备」 | ① 改用 `chromium.launchPersistentContext(profileDir, {...})`，持久化目录 `profiles/<主域名>/`（记住设备指纹 + localStorage）；注意 **`userDataDir` 不能传给 `chromium.launch`**（会报错退出），必须用 `launchPersistentContext`，且后者返回的直接就是 context（无 browser.newContext 步骤，关闭用 `context.close()`）；② 页面加载/验证通过后调用 `saveSession()` 把 context storageState 回写 `cookies/<域名>.json` |
| 首次「暖设备」流程 | 持久化目录为空时仍需人工过一次验证 | 流程：有头启动 → 用户过验证 → saveSession 回存 → 后续运行复用 profiles + cookies，原则上不再弹验证；例外：站点 access_token 过期（maimai 约 5 天）需重登一次，重登后再被记住 |

验证方式：下次同站点抓取时检查日志是否出现「复用持久化 profile」且未弹验证；若仍弹验证，查 profiles 目录是否为空（说明上次 saveSession 未执行）。

### 同批踩的其他坑（2026-09-09）

| 现象 | 根因 | 对策 |
|---|---|---|
| 后台任务「成功启动」却无浏览器、无输出 | WorkBuddy managed node 路径是 `binaries/node/versions/22.22.2-2/node.exe`（带 `-2` 后缀），写 `22.22.2` 时 node 不存在，`&&` 链静默失败 | 启动引擎前先 `-v` 验证 node 路径；后台任务启动后 15s 内查 chrome 进程数确认浏览器真起来了 |
| `rm -rf 目录 && node crawl.js` 直接失败未跑 | 沙箱安全删除包装器对「不存在的目录」返回非 0，`&&` 短路 | rm 前缀单独跑，或直接省略（引擎自建输出目录） |
| fallback 字段污染（评论内容=整段 _text） | `lib/extract.js` 字段带 `fallback:true` 时正则失败就把全文塞入 | 站点正则不可靠时写专用解析器（从 `_text` 二次解析），勿依赖 fallback |
| 任务 JSON 文件解析失败（Bad escaped character） | 用 bash heredoc 写含 `\d` 的正则字段，`\d` 被 shell 吃掉成无效转义 | **任务 JSON 一律用 Write 工具写**，禁 heredoc；写完必须 `JSON.parse` 校验再跑 |
| 热榜到底后脚本仍空转刷新（2026-09-09 用户纠正） | 已有攻略的站点（maimai）也凭旧印象直接写任务，把「固定榜单+有限feed」当无限 feed 滚；idle 检测未兜住 | **probe-first 对所有渠道一律适用**，包括有攻略的站：先 `probe.js` 摸容器/滚动特性（有限页 vs 无限feed vs 旧版UI），再按实测写任务。有限页 rounds≤8；各渠道容器已入台账 `channelStructure` 字段 |

## 十一、脉脉风控触发条件（2026-09-09 实测复盘）

| 触发条件 | 表现 | 实测证据 |
|---|---|---|
| **单日抓取总量过大**（约 2.4 万条/日） | 频道不再加载新内容、搜索结果区静默空白（不报错）；通常隔 1-3 天自动恢复 | 受限集中出现在大批量抓取之后；恢复验证：次日先用热榜这类单页小流量试探 30 秒 |
| 短时高频滚动 | 每次滚动即触发加载 API，连续 27 分钟数千次请求 | 深抓 8000+9913 条后出现受限 |
| 安全验证未通过 | 只给 10 条预览，懒加载静默不触发（非报错） | 上轮深抓实测 |
| 搜索页部分查询降级 | 同页面「WLB」出 509 条，「加班」结果区直接空白 | 疑似按查询/会话降级，换方案（API 或换词重试） |
| 同账号多浏览器并发 | 未踩，明确红线 | 全程串行执行 |
| access_token 过期 | maimai 约 5 天（下次约 9/14），届时重登+验证一次后自动再保存 | Cookie 文件 expirationDate 检查 |

**节奏纪律**：单账号单日总量控制（<1 万条为宜）；大批量后主动停 1-2 天；恢复时先小流量探测再放量。验证方式：下次抓取前先跑 probe 单页，通了再批量。

## 九、黄金路径落地纪律（2026-08-16 用户纠正，勿再犯）

| 现象 | 根因 | 修法（已实现） |
|---|---|---|
| 自适应采集方案（`_run5000.js` 实测 5151 卡/459s，约 2 倍提速）只写进了本文件就删掉了临时脚本，**引擎仍用固定延迟**，直到用户明确要求才升级 lib/ 代码 | ① 把"沉淀"窄化为"写文档"，忽略 skill-memory 三层模型中「机器层=执行代码自动生效」才是最强落地方式；② 把"临时脚本用完删除"纪律误用到本应升级进引擎的黄金路径上；③ 对共享引擎改动过于保守，默认"用户没要求不动引擎"，与 AGENTS.md「试错只付一次/黄金路径必须固化」冲突 | **发现可复用执行方案 → 第一步升级引擎 lib/ 代码 + 冒烟验证（自动生效），第二步才写 EXPERIENCE.md / SKILL.md**；文档与代码必须同批落地，验证方式：下次执行同一流程前查记忆并报告命中 |


## 十二、主浏览器登录态复用：CDP 挂载（2026-09-10 用户主诉，已实现）

**用户原话场景**：「我在主 Chrome 扫码登录后，你抓取时打开有头 Chrome 就显示登录失效让我重新扫码；但如果我在你的有头 Chrome 扫码，我又没办法在主浏览器登录。」

| 项 | 结论 |
|---|---|
| 根因 | maimai 等站是**单会话**：每次「登录」都会签发新 token 并使旧 token 失效。主 Chrome 与自动化浏览器各自 profile = 两个会话，轮流登录必然互踢。**不是反爬，也不是 cookie 过期。** |
| 错解 A | 复制主 Chrome 的 profile / 解 Cookies 库 → 本机 Chrome 152 已启用 App-Bound 加密（Local State 含 `app_bound_encrypted_key`），离线解密不可行；且运行中 `Default/Network/Cookies` 被锁，复制报 `Device or resource busy`。 |
| 错解 B | 让用户每次在自动化里扫码 → 主浏览器掉线，体验不可接受。 |
| 正解 | **CDP 挂载**：用户主 Chrome 带 `--remote-debugging-port=9222` 启动，引擎 `chromium.connectOverCDP()` 挂上去，用其 cookie/localStorage/access_token/设备指纹。**不产生新的登录事件 → 双方都在线。** |

实现要点（`lib/pipeline.js`）：
1. `task.cdpUrl` 存在 → `connectOverCDP(cdpUrl)`，取 `browser.contexts()[0]`，走**挂载模式**；否则原 `launchPersistentContext` 路径不变（向后兼容）。
2. 挂载模式**跳过 `injectAuth`**（注入旧 cookie 可能把好会话顶掉）；`authFile` 退化为回存/备份。
3. 统一收尾函数 `closeBrowser()`：挂载模式只关本任务新开的标签页，**绝不 close 浏览器**；独立 profile 模式仍关整个 context。
4. 系统 `HTTP_PROXY` 会把 loopback CDP 探测也代理掉（表现为 `Unexpected status 502`，随后 `ECONNREFUSED`）→ 连接前把 `127.0.0.1,localhost` 并入 `NO_PROXY` / `no_proxy`。**这条坑与本机代理环境强相关，换机仍建议保留此豁免。**
5. 端口未生效的头号原因：Chrome 没完全退出。`--remote-debugging-port` 只对**首个**实例生效，向已运行实例再次传该参数会被静默忽略。启动器 `tools/start-chrome-cdp.cmd` 已内置「先检测 chrome.exe 是否在跑」和 curl 自检。

冒烟验证（2026-09-10 实测通过）：临时 profile + 9223 端口 → `contexts: 1`、`newPage` 正常、可读 `ctx.cookies()`、`page.close()` 后浏览器存活。测试脚本 `test/cdp-attach-test.js`，冒烟任务 `tasks/maimai_cdp_smoke.json`。

纪律：挂载模式下浏览器被占用（窗口会被驱动），所以**仍必须串行**，不可与其他抓取任务并行。

## 十三、搜索风控频率复盘 + 日期窗口/断点续抓（2026-09-10 实测，用户硬性要求）

### 13.1 搜索（search_center）触发拦截的频率复盘

| 时间 | 动作序列 | 结果 |
|---|---|---|
| 09-09 22:58 | 5 任务同批 ≈2 分钟内发起，其中**搜索 2 次**（WLB、加班） | 第 1 次（WLB）成功 241KB；第 2 次（加班）结果区**静默空白**，只抓到页脚 |
| 09-10 19:39 | 24h 内**首次**搜索（大疆），前序全是频道页 | ✅ 成功 510 条 |
| 09-10 20:19 | 话题页 topic-detail 抓取 1500 条（频道页，非搜索） | ✅ 成功，未受限 |
| 09-10 20:31 | 第 2 次搜索（大疆创新），距上次搜索 **52 分钟** | ✗ 空白，仅页脚 2 条 |
| 09-10 20:35 | 第 3 次搜索（卓驭），距上次搜索 4 分钟 | ✗ 无输出；随后全站提示「搜索频率过高，限制访问」 |

**结论（写入纪律）**：
1. **触发阈值≈1~2 次/小时内**：同一账号 1 小时内 ≥2 次搜索就高风险（52 分钟时已降级空白）；连续 2 次搜索间隔 <10 分钟基本必挂。
2. **拦截表现**：搜索结果区静默空白（不报错、不跳验证），随后全站提示「搜索频率过高，限制访问」。**它不影响频道页/话题页**（同日 20:19 话题页 1500 条正常）。
3. **对策（默认走专题页，搜索仅作兜底）**：
   - 搜索配额：**≤1 次 / 30 分钟，且 ≤4 次 / 24h**；连续 2 次搜索必须间隔 ≥30 分钟；
   - 优先用**专题页/频道页**替代搜索：`/community/topic-detail/<id>/crtime`（最新序，等价于搜索该主题全部帖子）、`/community/home/gossip`（职言）、`/community/home/recommended`（推荐）；
   - 触发拦截后**冷却**：当日停止搜索类任务，隔 1 天才恢复；恢复先用频道页小流量试探。
4. **新主题入口的获取方式**（用户 09-10 传授）：搜薪酬关键词 → 点进任一帖子 → 点正文上方的话题标签（如【职级薪资大揭秘】）→ 复制 `topic-detail/<id>` 地址。**主题页 1w+ 帖子且支持 `/crtime` 最新序，是替代搜索的首选。**

### 13.2 日期窗口 / 断点续抓（已实现于 `lib/datefilter.js` + `lib/pipeline.js`）

**用户要求**：「如果我让你获取某专题 2026 年全年数据，你需要在抓取过程中识别日期是否满足要求；已有数据的专题不要重复抓，先看日期到哪、还差哪些天，然后定位到对应日期开始抓。」

任务字段（`extract` 内，全部可选）：

| 字段 | 作用 |
|---|---|
| `dateField` | 日期字段名，默认 `时间`；缺失时从 `_text` 前 120 字自动抽日期 |
| `since` / `until` | `'YYYY-MM-DD'`，只保留窗口内条目（越界条目在日志中计数丢弃） |
| `stopBeforeDate` | 列表按时间倒序，滚动到「末条日期 < 该日期」即停止 → 不重复抓已覆盖区间 |
| `resumeFromCoverage` | `true` → 读 `output/<任务名>/coverage.json` 的 `min`，自动作为 `stopBeforeDate` |
| `appendExisting` | `true` → 先载入已有 `data.json`，新数据按 `_text` 去重合并（真增量累积，不覆盖） |

配套产物：每轮抓完写 `output/<任务名>/coverage.json`（`{min, max, days:{日期:条数}, runs:[...]}`，跨轮累积）。**执行纪律：任何"按时间范围"的抓取任务，先读 coverage.json 判断缺口 → 设 `resumeFromCoverage: true` → 抓完核对 min/max。**

日期解析覆盖：`刚刚/秒前/N分钟前/N小时前/今天/昨天/前天/N天前/N周前/N个月前/N年前/MM-DD/YYYY-MM-DD[ HH:mm:ss]`；**已排除 `1-3年`、`2-5个月` 这类年限/月限**（否则会被误判为 1 月 3 日）。

冒烟验证（2026-09-10 通过）：`tasks/_smoke_datewin.json`（fixture）→ 日期窗口生效、越界丢弃计数正确、第二轮 `appendExisting` 载入 4 条去重后合并、`coverage.json` 生成；已对 5 个历史输出目录回填 coverage（如 `maimai_topic_salaryrank` 覆盖 2026-07-04~09-10 共 69 天）。

**限制**：相对时间（N天前）在跨天重跑时基准会漂移，覆盖台账按解析当天计算；严格按天核对时优先用带绝对日期的渠道（搜索中心、话题页历史帖为 MM-DD）。

## 十四、话题 ID 枚举方法（2026-09-10 破解，替换「点击不跳转」的错误结论）

**表象**：feed 内话题标签（`span.text-xs.font-medium.text-primary` 的外层 `div.cursor-pointer`）用 `locator.click()` 与坐标 `mouse.click()` 点击后，**当前页 URL 不变** → 早先误判为「无法通过点击拿到 topic-detail」。

**真相**：标签是 `target=_blank` 的**新标签页**打开。必须用 `context.waitForEvent('page')` 捕获 popup，popup 的 URL 才是 `/community/topic-detail/<id>/hot`（`/hot`=热度序，替换为 `/crtime` 得最新序）。

**可用代码骨架**（见 `F:/despseekharness/crawler/topic_probe2.js` / `topic_lib.js`）：
```js
const popupP = ctx.waitForEvent('page', { timeout: 8000 }).catch(() => null);
await page.mouse.click(box.x, box.y);              // 坐标点击标签中心
const popup = await popupP;                        // 关键：捕获新标签
const url = popup.url();                           // 含 topic-detail/<id>
const cnt = await popup.evaluate(() => (document.body.innerText.match(/([\d.]+万?\+?)\s*(?:篇|条)?帖子/) || [])[1]);
await popup.close();
```

**话题帖子量读法**：topic-detail 页头部直接渲染「N条帖子」（如 `11513条帖子`），无需滚动。

**已确认**：公司印象大爆料 `12dLH8oC3` = **14,515 条**；职级薪资大揭秘 `JFvwxmvD` = **11,513 条**；爆料各司工时强度 `zfe4YoeG` = **5,967 条**。→ 前两者均 ≥1 万，属待抓大专题。

**页面侧无效路径（勿再试）**：HTML/RSC payload 内搜 `topic-detail`（feed 页 0 命中）；监听 `topic/tag` 网络请求（0 命中）；`el.click()`（不触发新标签，也无路由跳转）。

## 十五、数据保留与增量合并纪律（2026-09-10 用户硬性要求，已落机器层）

**用户要求**：「用这个技能获取到的数据都要保留，以便日后新数据拿到后跟旧数据合并。」

| 场景 | 现象 | 对策（已实现于 `lib/pipeline.js`） |
|---|---|---|
| 重跑同一任务名 | 默认会整包覆盖 `output/<name>/data.json` → 旧数据丢失 | ① 新增 `extract.appendExisting: true`（推荐）：载入旧 data.json，新数据按 `_text` 去重合并，**真增量累积**；② 未开 appendExisting 且检测到已有数据时，日志打 ⚠ 覆盖警告 + **自动备份** `data.bak.<ts>.json`（除非显式 `"overwrite": true`） |
| 想知道「抓到哪儿了」 | 无日期台账 → 重复抓已覆盖区间 | 每轮自动写 `output/<name>/coverage.json`（`min/max/days/runs`，跨轮累积），配合 `resumeFromCoverage: true` 自动断点 |
| 覆盖跨天的相对时间（N天前） | 基准随抓取日漂移 | 台账按解析当天记录；严格核对优先用绝对日期/MM-DD 渠道 |

**固化动作清单（新任务默认写法）**：
```json
"extract": {
  "dateField": "时间",
  "since": "YYYY-01-01", "until": "YYYY-12-31",
  "stopBeforeDate": "YYYY-01-01",
  "resumeFromCoverage": true,
  "appendExisting": true
}
```

验证：`tasks/_smoke_datewin.json`（第二轮日志出现「增量累积：载入已有 5 条」）；`tasks/_smoke_overwrite.json`（未开 appendExisting → 打覆盖警告并生成 `data.bak.*.json`）。两者均通过（2026-09-10）。

**话题注册表（机器层）**：已知话题 ID 与帖子量登记在 `playbooks/maimai.crawl-ledger.json` 的 `topics` 字段 + `directions` 数组，抓前先查，避免重复探索。当前：我来爆个料 `SxAXPZZ2`=145,099；公司印象大爆料 `12dLH8oC3`=14,515；职级薪资大揭秘 `JFvwxmvD`=11,513；爆料各司工时强度 `zfe4YoeG`=5,967。

## 十六、公司名归一化（2026-09-11 用户发现统计 bug，已修）

**现象**：大疆报告里「字节跳动 声量 = 0，印象样本 247」，其余公司声量正常；且出现"只有大疆净情绪为负"的假象。

**根因**：「公司印象大爆料」的公司名来自正文前缀（`公司印象大爆料 字节跳动印象 · 1年以内 …`）→ key = **字节跳动**；而声量统计用的是简称 key = **字节** → `voice['字节跳动']` 取不到值 → 0。同理 阿里巴巴/蚂蚁集团/海康威视/中兴通讯 全部为 0。排序按声量 → 这些公司被挤到表尾，看似"只有大疆为负"。

**修法（已落代码 / 脚本）**：
1. 建 `CANON` 别名表：`字节跳动→字节`、`阿里巴巴→阿里`、`蚂蚁集团→蚂蚁`、`海康威视→海康`、`中兴通讯→中兴`。
2. 声量统计改用 `ALIAS` 多别名匹配（`阿里 → 阿里|淘宝`、`海康 → 海康` 等），两边统一用规范名做键。
3. 修复后：字节 **声量 2991 / 印象 247 / 净 +21%**；净情绪为负的仅 **大疆 −10%（n=42）**、途虎养车 −13%（n=24）、安克创新 −7%（n=29）。

**口径提醒（写报告必须标注）**：同一指标在不同报告里可能因**统计范围**不同而符号相反——大疆「印象渠道净情绪 −10%」vs「全渠道净口碑 +24%」，前者只统计公司印象结构化评价，后者统计全库所有提及。报告里必须写明口径，否则读者会认为统计出错。

**通用教训**：任何"按公司聚合"的统计，先归一化名称（简称/全称/别名三件套），再做 join；跨数据集 join 前先打印两边的 key 集合核对。脚本：`daji_report_stats.js`。

## 十七、HTML 报告：数据注入必须校验「图表所需字段未丢」+ 渲染自检（2026-09-11 用户发现）

**现象**：大厂横向对比报告第 2/3/4 节全空（图表未渲染、汇总表无行），但第 1 节正常。

**根因（两层）**：
1. 注入 HTML 前把 `rows[].dims` 用 `delete` 剪掉了（当时想减小体积），而第 1 节「关注度=声量×提及率」图表需要 `r.dims` → `TypeError: Cannot read properties of undefined (reading '加班')` → **脚本在第一张图之后整体中断**，后续所有 `new Chart()` 与表格 innerHTML 全部没执行。
2. 只有「第一个 canvas」被 Chart.js 初始化（其余保持浏览器默认 `300x150`），这就是"只有第一节有图"的表现。

**踩的第二个坑（注入手法）**：用非贪婪正则 `const D = \{[\s\S]*?\};\n` 做替换，容易匹配到错误边界 → 替换结果丢字段且不易察觉（本次表现为"数据变小、dims 消失"）。**正解：按 index 切片定位并替换整行**（`start = h.indexOf('const D = '); end = h.indexOf('\n', start)`）。

**修法与固化**：
- 注入数据时**保留图表用到的全部字段**，只剪真正没用的；体积不是优化目标。
- 新增通用自检脚本 `F:/despseekharness/crawler/render_check.js`：无头打开 HTML，打印每个 canvas 的 `hasChart / canvas 尺寸 / wrapper 尺寸`、表格行数、页面错误。
  - **判定标准**：全部 `hasChart=true` 且 `canvas > 300x150`、`ERRORS: none`。
  - 用法：`node render_check.js output/xxx.html`（加第三个参数可顺带截图）。
- **纪律**：任何生成/注入数据的 HTML 报告，交付前必须跑一次 `render_check.js`，不得只靠肉眼或直接 present。

验证：修复后横向报告 12 张图全部 ✓（canvas 尺寸与 wrapper 一致）、汇总表 20 行 × 15 列、`ERRORS: none`；大疆报告 3 张图同样 ✓。

### 17.1 内链必须机器校验，肉眼与 console 都发现不了 404（2026-11-13 连续两次踩，用户指出）

**现象**：同一站点连续两次出现点了就 404 的内部链接。① 报告在 `blogger-scoring/2026-11-11/`，正文写 `href="2026-11-12/"`——把日期目录当成同级目录，实际少一层 `../`；② 图例里指向另一个专题写成 `../2026-11-11/`，实际是 `../../blogger-scoring/2026-11-11/`。

**为什么自检漏掉**：无头浏览器只报 `console.error` 与 `pageerror`，**点不进去的链接不会报错**；页面渲染完全正常，只有真的点一下才发现。而且本地 `file://` 打开目录会显示目录列表，看上去"跳转成功"，更容易误判。

**修法（已落引擎 `lib/check-links.js`，勿再手写临时脚本）**：
```bash
node lib/check-links.js <报告目录或整站>        # 退出码非 0 = 有坏链，不许交付
node lib/check-links.js <dir> --json            # 程序化读取
```
- 覆盖 `<a href>` / `<link href>` / `<img|script|source|iframe src>` 的本地地址；`http(s)/mailto/#/data:` 跳过
- 相对地址按**所在文件目录**解析；目标为目录时要求有 `index.html`（GitHub Pages 行为）
- 额外报「大小写不一致」：Windows 本地能打开、Pages 上会 404
- `_template/` 与含 `{{占位符}}` 的链接自动跳过

**纪律**：交付话术必须能写出「检查 N 个文件 / M 条本地链接 / 0 坏链」。加链接（尤其 `handle-links.js` 批量加链接）之后，内链校验**跑在 handle 审计之后**，两步都过才算完。

## 十八、HTML 报告生成流水线（2026-09-11 固化，用户认可"美观度不错"）

**组件栈（无专用 skill，全部手写 + 内置设计规范）**：
| 层 | 用什么 |
|---|---|
| 图表 | Chart.js 4.4.1 UMD，CDN `cdnjs.cloudflare.com`（允许清单内） |
| 样式 | 手写 CSS 变量（飞书/Arco 色板）：`--bg #f7f8fa` / `--card #fff` / `--line #e5e6eb` / `--txt #1d2129` / `--sub #86909c` / 语义色 `--red #d54941` `--green #00b42a` `--blue #165dff` `--amber #ff7d00` |
| 设计规范来源 | WorkBuddy 内置 Visualizer 的 `read_me`（主题变量、字号、扁平化规则：无渐变/阴影、圆角 8–12px、0.5px 边框、只用 400/500 字重） |
| 结构 | `wrap(1120px)` → KPI 卡网格 `g2/g3/g4` → 卡片包图表（`.chart` 固定高 340/420px）→ 表格 → 引用块 → 方法/缺口 |
| 必备块 | ① 核心结论框（`.concl`）② KPI 卡 ③ 图表 ④ 明细表 ⑤ 原文引用（`.q-src` 标来源/时间/身份）⑥ 方法+缺口（写口径，否则数字会被质疑） |

**生成流水线（三步，缺一不可）**：
1. `xxx_stats.js` → 把统计结果写成 `output/xxx_stats.json`（数字必须脚本算出，禁止手填）。
2. `node inject_html.js output/xxx.html D output/xxx_stats.json rows` → 把数据写进 HTML 的 `const D = ...;`（按 index 切片整行替换；注入后自动 JSON 校验）。
3. `node render_check.js output/xxx.html` → 无头渲染自检（每个 canvas 的 `hasChart` / 尺寸、表格行数、页面错误）。**判定：全部 ✓ 且 `ERRORS: none` 才算完成**。

**模板**：`F:/despseekharness/crawler/templates/report_template.html`（含全部样式与图表骨架，复制改 `__TITLE__/__META__/__CONCLUSION__` 占位即可）。

**已知坑（都踩过）**：注入时删掉图表用到的字段 → 脚本中断只有第一张图渲染；用非贪婪正则替换注入行 → 字段静默丢失；无头不校验就交付 → 用户看到空白报告。

## 十九、极性分析重构：子句级 + 词表补全（2026-09-11 用户纠正「钱多应算正、正负不能丢一个」）

**用户指出的两个错误**：
1. 「钱给得多」被算成负面/中性 → 正面词表缺"钱多/给得多/给到位"这类**口语化正评**。
2. 一条评论里正负同现时，旧逻辑（整条级 `POS.test/NEG.test`）把整条判成"中性"，**两个维度的评价同时被丢弃**。

**修法（已落代码，`F:/despseekharness/crawler/polarity_lib.js` 公共库）**：

| 项 | 旧 | 新 |
|---|---|---|
| 粒度 | 整条文本 | **子句级**：按 `，,。；;!?` **和空格**切句（脉脉常见「卷 压力大 钱给到位」），逐句判极性 |
| 正负同现 | 判中性，双向丢弃 | **pos、neg 各 +1** 并记 mixed，两维度都保留 |
| 正词表 | 好/不错/给力… | 补 `钱给得多/给得多/给很多/钱多/薪资高/给力/到位/舍得/有保障/不加班/双休/清场/五险一金/健身房/房补/餐补/公寓/体检/GT` 等 |
| 负词表 | 卷/加班/差… | 补 `少/低/抠门/晋升难/晋升慢/卡/事多/活多/顶不住/想跑/跑路/流动快/末位/淘汰/变动/占用` 等 |
| 否定式 | 未处理 | `不加班/不用加班/不卷/很少加班/没有加班/不打卡/准点下班` → 判正面 |
| 文本清洗 | 无 | 去作者行、话题前缀、"X印象 · 司龄"、互动尾（分享/评论/赞 + 数字）、纯占位（`m+`/`middle`/`plus`/纯数字） |
| 公司名 | 简/全称混用致 join 失败 | `canonCompany()` 归一化（字节跳动→字节、阿里巴巴→阿里、蚂蚁集团→蚂蚁、海康威视→海康、中兴通讯→中兴） |
| 方面关键词 | 缺裸「压力」，压力句漏归强度 | 各方面正则补全（压力、钱、公积金、职级、食堂、班车、mentor…） |

**验收（重算后）**：大疆：强度 3 正 / **355 负**、薪资 **75 正 / 12 负（净 +63）**、福利 56 正 / 2 负、组织 12 正 / 49 负、环境 25 正 / 8 负 → 此前被吞掉的"钱给得多=正面"已正确归位。全库重算后各公司净情绪重排（大疆 −17%、华为 −30%、小米 −31%、比亚迪 −40%、腾讯 +33%、百度 +25%）。

**遗留局限（写报告须标注）**：① 反语/讽刺（"恭喜喜提大礼包"）仍会误判；② 方面关键词有歧义（「领导」同时命中组织与氛围）；③ 公司别名未穷举（如"虾皮/Shopee"）；④ 相对时间（N天前）随抓取日漂移；⑤ 子句计数非互斥，各方面之和 > 条目数。

## 二十、跨公司净情绪对比的两个方法论要点（2026-09-11）

| 要点 | 说明 |
|---|---|
| **口径必须标注，否则结论反向** | 同一公司两套口径可得出相反符号：字节「全库净差 −1061（负）」vs「印象渠道 +2%（正）」——因负评集中在职言/爆料渠道，结构化印象里福利/环境打分高。大疆「全库 −14%」vs「印象 −17%」（同向），但绝对值不同。**报告必须写清统计范围**。 |
| **用「负面密度」而非绝对数比较** | 各公司声量差 10 倍以上（字节 3,575 vs 追觅 134），绝对子句数不可比。改用 `negative_clauses / mentions × 100`（每 100 条提及的负面子句数）→ 大疆强度 168.2 vs 腾讯 100.8、字节 153.3，才看得出"单位负面强度"。 |
| 正评率 | `pos / (pos + neg)`，用于方面级横向比较；福利/环境普遍 76–100%（及格线），差异化在强度与组织。 |

复用脚本：`net_compare.js`（产出 `output/net_emotion_compare.{json,md,html}`，含双口径表 + 方面级正评率 + 负面密度图）。

## 二十一、跨公司"谁更差"必须先统一分母（2026-09-11 用户追问引发）

**用户追问**：「互联网大厂一样加班到很晚，为什么大疆强度负评最高？」→ 实测发现结论口径依赖，需自我纠偏。

| 口径 | 大疆 | 小米 | 华为 | 阿里 | 字节 | 腾讯 |
|---|---|---|---|---|---|---|
| 负面子句 / 100 条提及（**全库文本包含口径**） | **51.5（最低）** | 90.7 | 83.5 | 81.8 | 79.4 | 62.1 |
| 强度负面子句 / 强度句（同等口径） | 1.32 | 1.23 | 1.23 | 1.18 | 1.34 | 1.09 |
| 中位在岗时长 | 12.0h | 12.0h | 12.0h | 11h | 11.5h | 11h |
| 提"招聘/内推/offer"类占比 | **29%** | 22% | 27% | 30% | 35% | 32% |

**方法论教训（三条）**：
1. **分母必须与被比较对象同源**：同一家公司「结构化识别口径 211 条」与「全库文本包含 878 条」会得出**相反排名**。报告里每个比值都要写清分子分母怎么来的。
2. **中性帖占比会稀释密度**：招聘/内推/竞品资讯帖多 → 负面密度低。比较"谁更被吐槽"时要么剔除中性帖，要么明示占比差异。
3. **声量小 → 密度敏感**：大疆 878 条 vs 字节 3,469 条，密度类指标波动更大，跨量级比较应给区间或标注样本。

**结论修正**：同等口径下大疆强度负评**并非最多**（低于华为/小米/阿里/字节）；其"刺眼"来自 ①员工体验帖占比高（招聘帖少）②样本小。真实差异是客观工时（12.0h vs 互联网 11–11.5h）+ 强度吐槽常与组织/氛围负面绑定（情绪成本共现 8%，腾讯 1%、百度 2%）。

### §二十一 补：口径错误已落代码修正（2026-09-11，用户第二次追问）

用户反馈「报告里大疆负评还是最高」→ 确认上一版只加了文字说明、**图与表未重算**，属"文档改了、数据没改"。

修正动作：
1. 新增 `net_compare2.js`：**五家公司统一「全库文本包含」分母**重算（大疆 878 / 百度 1,415 / 腾讯 2,362 / 字节 3,318 / 阿里 1,684），逐方面输出 pos/neg/posRate/negPer100。
2. 重建 `output/net_emotion_compare.html`（图表数据与叙述全部换成新值）+ `.md`，`render_check` 通过，桌面副本同步。
3. 修正后关键值：强度负密度 大疆 **46.6（最低）**、腾讯 49.2、百度 57.7、阿里 63.2、字节 **76.0**；强度正评率 大疆 **1%**（最低）、字节 6%、腾讯 13%、百度/阿里 14%。

**纪律（新增）**：口径修正必须**同时重算数据 + 图表 + 叙述**三者，只补文字注释等于没修——用户第二次追问即因此。自检清单：① 指标定义写进页面 ② 图表 JSON 与叙述数字同源 ③ `render_check.js` 通过 ④ 关键数字全局 grep 无残留旧值。


### 十二·补 (2026-09-11) 关键坑：引擎/工具无法自起浏览器
- **现象**：从工具里 `Start-Process` / 后台 `&` / `run_in_background` 启 Chrome，调用一返回 Chrome 进程即被杀（`chrome_count=0`）。WorkBuddy 用 Job Object 回收子进程，连 `Start-Process` 派生的进程也会被带走。`cmd.exe` 调用被安全策略直接拦截（"bypasses command validation"）。
- **推论**：**浏览器只能由用户经资源管理器双击启动**（explorer 启动的进程不在工具 Job 内 → 存活）。引擎侧所有"我来起 Chrome"的尝试必然失败，别再试。
- **修正**：`tools/start-chrome-cdp.cmd` 升级 v2 = one-click 全自动：先 probe 9222（已就绪则直接结束）→ 有残留则 `taskkill /F /IM chrome.exe` → `start "" chrome --remote-debugging-port=9222 ...` → 循环 10 秒 curl 验证。用户双击即视为同意重启 Chrome。
- **为何旧版总失败**：旧版在检测到任意 chrome.exe 时 `exit /b 1` 并 pause，但 Chrome 常驻后台进程（后台模式/扩展宿主）导致守卫误判 → 用户以为"跑了"实际没带端口 → 表现为 `User Data/DevToolsActivePort` 缺失 + `netstat` 无 922x 监听。
- **诊断三连**：`ls "$UD/DevToolsActivePort"`（缺=未带端口）、`netstat -ano | grep 922x`、`curl --noproxy 127.0.0.1 http://127.0.0.1:9222/json/version`。


## 二十二、抓取提速规范（2026-09-11 用户要求，之后默认执行）

**用户原话**：翻页太慢；之前测过，尽量提速；后续都按此要求；唯一注意=不要频繁搜索（站易限流）。

**速度杠杆（`lib/interact.js autoScroll`）**
| 参数 | 默认 | 说明 |
|---|---|---|
| `adaptive` | `true` | 页面长高则减 delay（下探到 min），停顿则加 delay（升到 max） |
| `delayMinMs` | 400（adaptive）/1200（非 adaptive） | **实际下限**；设 300 可再快 |
| `delayMaxMs` | 2500 | 上限 |
| `maxIdleRounds` | 8 | 连续 N 轮高度不变 = 触底 |

**实测**：adaptive:true → 10.0 条/秒；adaptive:false + 1500~2600ms → 5.3 条/秒。提速 1.9×，未触发风控。

**默认快速预设（话题页/频道页）**
```json
"scroll": { "rounds": 2500, "adaptive": true, "delayMinMs": 300, "delayMaxMs": 1200, "maxIdleRounds": 12 }
```

**红线（唯一限制）**
- `search_center` 搜索：≤1 次/30min、≤4 次/24h，间隔 <10min 必被降级（结果静默空白）。**搜索类任务绝不提速、绝不加频**。
- 提速只用于：`topic-detail/<id>/crtime`、`home/gossip`、`home/recommended` 等频道/专题页（不受搜索风控）。
- 仍需：全程串行、单账号单日 <1 万条。

### feed 可见上限 ≈1 万（2026-09-11 三个专题交叉验证）
- `topic-detail/<id>/crtime` 滚到 **~9900~9960 条**就连续 12+ 轮高度不变而触底；再加轮次/再降延迟都无效。
- 已验证：SxAXPZZ2=9961、12dLH8oC3≈9915(本次计数)、JFvwxmvD=9894(本次计数)。
- 推论：单个话题/频道一次最多拿 ~1 万条。要更早历史 → 换入口（hot 排序 / URL 变体 / 分页接口）或多账号；别再靠“加大 rounds”硬滚。
- 增量合并仍有效：换窗口（更早 since/until）能把另一批 ~1 万拿进来（12dLH8oC3 由 6390→10753，JFvwxmvD 由 7759→9894）。


## 二十三、脉脉用户要求与常踩坑速查（2026-09-12 汇总）

> §十二（CDP 挂载）**已降级为备选**：默认改用持久化 profile（§十二·补 / SKILL.md Phase 3.3）。CDP 只在必保用户主 Chrome 在线时用。

| 场景 | 现象 | 对策（已实现 / 下次怎么做） |
|---|---|---|
| 用户要求「别关我浏览器」 | 我为腾 CDP 端口反复 `taskkill /F /IM chrome.exe`，关掉用户正在用的主 Chrome | **最高优先级红线**：禁止任何 `taskkill` 浏览器；确需重启须先征求同意。浏览器只能用户双击启动（工具起必被回收） |
| 「能不能复用我主 Chrome 登录」 | 主 Chrome 与自动化浏览器单会话互踢；主 Chrome cookie App-Bound 加密不可离线读 | 只有两条路：CDP 挂载（要重启+9222，现为备选）或持久化 profile（默认，independent chromium，复用同 token 不互踢） |
| 「太慢了，提速」 | 任务自设 `adaptive:false` + 1500~2600ms → 5.3 条/秒 | 快参 `adaptive:true, delayMinMs:300, delayMaxMs:1200` → 10.0 条/秒。**搜索类任务除外** |
| 「不要频繁搜索」 | `search_center` ≤1 次/30min、≤4 次/24h；间隔<10min 结果区静默空白 | 默认走频道/话题页；用户给 URL 就直接访问；禁止自行搜索找新专题 |
| 「专题固定，我给 URL 才新增」 | — | 台账 v2 `policy.topicSet` + `policy.noSelfSearch`；新增只登记用户 URL |
| 「频道要带评论」 | 列表页只有正文，有价值的判断在评论 | 走 SKILL.md Phase 3.4：详情链接 → 展开评论区 → 提取；脚本 `harvest_comments.js` |
| 「抓过的不重复抓」 | — | `resumeFromCoverage` + `appendExisting` + `since/until/stopBeforeDate`（Phase 2.5） |
| 「数据别删」 | — | `output/` 永不删；不开 appendExisting 时引擎自动备份 `data.bak.<ts>.json` |
| topic 抓不到更早历史 | 滚到 ~9900~9960 条连续多轮高度不变 | feed 可见上限≈1 万；换 since/until 窗口分批增量，或换入口；别加大 rounds 硬滚 |
| 解析器丢数据 | master 只 +98 条（应为 +2000+） | 正则把「身份」和结尾「分享」设为必选 → 丢 30%；改成可选后 7430→9551 |
| 两个 node/浏览器同时跑同一 profile | `launchPersistentContext: Target page, context or browser has been closed` | 串行！同一 profile 一次一个任务 |

### 下次开工自检（按顺序确认再动手）
1. 没有浏览器类 kill 操作；
2. 任务里没写 `cdpUrl`（除非用户明确要挂载）；
3. `scroll` 用的是快参；
4. 同一时刻只有一个抓取进程；
5. 任务的 `name` 与要合并的旧数据目录一致 + `appendExisting:true`；
6. 频道类任务是否要求带评论（是则走 Phase 3.4）；
7. 抓前先读 `playbooks/maimai.crawl-ledger.json` v2，确认 coverage/caught，别重复抓。


**2026-09-12 机器层已落地（勿再只写文档）**：引擎默认本身就是快参了——
- `lib/crawl.js normalizeTask.scroll` 默认 `{rounds:800, adaptive:true, delayMinMs:300, delayMaxMs:1200, maxIdleRounds:12}`；
- `lib/interact.js autoScroll` 默认 min/max：`adaptive ? 300/1200 : 1200/2500`；
- URL 命中 `search_center` 自动切回保守慢参（搜索红线）。
→ **新任务不写 scroll 也快**；要更大目标量只显式调 `rounds`。


**2026-09-12 更正（用户指正，之前结论偏了）**：
- 「慢」的主因是**服务端加载**，不是我方 sleep。压短延迟 → 页面未加载完即判「高度未变」→ 连续 N 轮 → **误判触底提前收工**，反而少拿数据。
- 之前的「feed 可见上限≈1万条」结论**存疑**：几次「13/20 轮触底」可能就是这个误判，需新逻辑复测再确认。
- 引擎已改为**先等加载再调速**：`autoScroll` 滚动后 `waitGrow()` 轮询等高度增长（最多 `loadWaitMs`，默认 3000），加载慢最多等 3s 才计一次 idle；加载完立刻继续。
- 调参优先级：**先调 `loadWaitMs`（卡顿调 5000~8000）与 `maxIdleRounds`，再谈 `delayMinMs`**。
- 判别法：日志 `[滚动触底/停顿：连续 N 轮…第 i/j 轮]` 中 i≪j 且重跑又能拿到新数据 → 误判，不是真触底。

## 二十四、重复内容自动停（2026-09-12 用户要求，已落机器层）
- 需求：抓取过程中若反复出现已抓过的内容 → **自动停止并反馈用户确认**，别闷头跑完。
- 实现：`lib/pipeline.js` 普通滚动分支，每批滚动后抽样前 400 条 `innerText`，与「已有记录 + 历史批次」前缀去重算新增率；`extract.dupStop={enabled:true,minNewRatio:0.05,consecutive:3}`。
- 触发后日志打 `[需向用户确认]`，agent **必须转发给用户等确认**，不得自行判定「抓完了」。
- 易混：低新增也可能是**加载慢导致重复采样** → 此时应调大 `scroll.loadWaitMs`，不是判「已抓完」。

## 二十五、脉脉「推荐/职言」页结构实测（2026-09-12）
- feed 容器：`div.mx-3.mt-3.overflow-hidden.rounded-lg.max-sm:mt-0.sm:mx-0.sm:bg-background`（首屏约 10 条）。
- **列表页没有帖子详情链接**：`a[href]` 只有频道导航（`/community/home/*`、`/hot-rank`）。
- **列表页没有「N 条评论」文案**，只有数字计数 `div.flex.cursor-pointer.items-center`（如 分享/7 32/10）。
- 点卡片正文、点数字计数 → **URL 不变、文本几乎不变、评论区不出现**（4.5s 观察）。→ 评论不在 DOM 层简单展开，需另找入口。
- 推荐流本身含大量 offer 内容（「offer对比」「这两个不知道咋选」「offer选择 大疆48×15 拓竹47×15 739人参与」）→ offer 专题除用户给的搜索 URL 外，推荐流也是来源。

### 大坑：探针必须注入 authFile
- `profiles/maimai.cn` 里的 cookie 已陈旧 → 裸探针打开任何页都跳 `maimai.cn/platform/login`，会被误判为「会话失效」。
- 引擎跑任务时会注入 `cookies/maimai.json`（仍有效）→ 正常。
- **写探针脚本务必 `resolveAuth + injectAuth`**，否则结论全错。

### 53 分钟空转真因（不是登录、不是重复内容）
- 引擎日志「条目计数 2」= 模块检测在该页失败 → `n` 永远 < 目标 20000 → 一直滚到 200 批上限。
- 教训：先确认「条目计数是否与肉眼一致」，再谈速度/重复/上限。

## 二十六、评论区入口破解（2026-09-12，可复用黄金路径）

**结论**：评论在**详情页 SSR**，不需要接口。

| 步骤 | 选择器/URL |
|---|---|
| 列表卡片正文 | `div[role="button"]`（innerText>15，无 href） |
| 点击后跳转 | `/community/gossip-detail/<gid>?egid=..&gid=<gid>`（也有 `/community/feed-detail/<id>`） |
| 评论列表定位 | 在详情页找「子元素中含相对时间（`\d+天前\|小时前\|分钟前\|刚刚\|MM-DD`）最多的容器」= 评论列表 |
| 每条评论内容 | 昵称 / 身份 / 正文 / 时间 / 地区 / 赞数；楼中楼需点「查看全部N条回复」 |

**实现方式**：列表页逐个 `el.click()` → 等 URL 出现 `gossip-detail|feed-detail` → 抓 → `goBack()` → 下一个。
**必须注入 authFile**（profile cookie 陈旧会跳登录页）。
**逐条落盘**（`.jsonl` + 每 5 条写全量），避免长跑中断零产出。

**实测**：推荐频道 30 帖 / 227 评论 / 2m38s（≈11 帖/分）。

### 十七·补 重复率检测（2026-09-12 用户要求，harvest_comments.js）
- 频道内容有上限但可无限下翻 → 靠**详情 URL 去重**统计重复率。
- 判定：本轮点击里「已抓过」占比 ≥90% 且本轮点击 ≥5 → 记一次；**连续 2 轮** → 停止并打 `[需向用户确认]`。
- 落盘用 `.jsonl` 逐条追加 + 每 5 条写全量 `posts_with_comments.json`（长跑中断不丢）。
- 实测推荐频道：150 帖 / 1153 评论 / 15m19s，**全程 0 重复**（没触发上限）。

## 二十七、推荐 vs 职言 是否重复？（2026-09-12 实测，结论：不重复）

| 指标 | 值 |
|---|---|
| 推荐帖 / 评论 | 150 帖 / 1153 评论（15m19s） |
| 职言帖 / 评论 | 150 帖 / 989 评论（12m31s） |
| 详情 URL 交集 | **1 帖（0.7%）** |
| 正文指纹交集 | 1 |
| 首 60 字交集 | 1 |

**结论**：两者**不是包含关系**，各自独立，都要抓。
- 推荐 = 算法挑选的「高讨论度/话题性」内容（大厂 offer 对比、公司爆料、公司印象），带跨频道聚合性质。
- 职言 = 实时信息流（行业新闻、AI 资讯、每日小游戏类帖子），时效性强。

**方法论**：判两个频道是否重复 → 统一用**详情 URL（`gossip-detail/<gid>` / `feed-detail/<id>`）+ 正文指纹**做集合交并，别靠肉眼。

## 二十八、search_center 搜索结果页抓取（2026-09-13 实测，「大疆搜索」）

**URL 形态**：`https://maimai.cn/web/search_center?type=gossip&query=<关键词>&highlight=true`
（`type` = `gossip`(职言交流) / `feed`(实名动态) / 人脉；tab 顺序 `实名动态｜职言交流｜人脉`）

| 元素 | 选择器 / 事实 |
|---|---|
| 排序栏 | `.gossipSort > div.left`(综合排序，**默认带 `highlight`**) / `div.middle`(时间排序) / `div.right`(热门排序) |
| 列表项 | `.searchList ul.list-group > li.list-group-item.cursor-pointer`（**li 无 href**） |
| 卡片文本 | `发布者:<昵称>\n<YYYY-MM-DD HH:mm:ss>\n<正文>\n<N 赞 M 评论>` |
| 列表加载 | **无限滚动**，每滚一屏 +10 条（实测 30 轮拿到 274+ 卡，未见上限） |
| 点卡片 | **开新标签页**（不是同页跳转！）→ `/community/gossip-detail/<gid>?gid=<gid>&egid=<token>` |

**两个坑（必踩）**
1. **点击 = 新标签页**：必须 `ctx.waitForEvent('page')` 接 popup；用 `li.click()`（JS click）**不触发**，要真实点击（`page.mouse.click` 或 locator click）。
2. **详情 URL 缺 `egid` → 404**（"服务器正在紧急搜索它的人脉…"）。所以只能从 popup 里拿真实 URL，**不能自己拼** `gossip-detail/<gid>`。

**搜索配额纪律**：搜索结果页**只加载 1 次**，之后所有操作都在新标签页里做并**立即 close**，避免标签页堆积 + 避免重发搜索请求（风控 ≤1次/30min、≤4次/24h，2026-09-13 当日已用满 4 次）。

**实现**：工作区 `harvest_search_dji.js`（v2）——Stage A 滚动收卡片 → Stage B 逐卡 popup 抓正文+评论 → `popup.close()` + `closeExtras()`；已有记录评论数不足时**自动补抓**（`refilledAt`）；重复率≥90%（每 10 条评估）自动停并打 `[需向用户确认]`。
**评论抓取率**：小帖 100%，大帖（80/49 评论）只能拿到 40%~60%（评论区懒加载 + 楼中楼限制），已尽力展开仍不全——报告里需标注。

## 二十九、专题 feed 上限攻坚（2026-09-13，「我来爆个料」SxAXPZZ2）

**现状**：专题显示 **145,710 条帖子**，历史抓取仅 9,961（6.9%），远超其他专题。

**已验证的绕行路径（全部失败，别再重复试）**
| 尝试 | 结果 |
|---|---|
| `/topic-detail/SxAXPZZ2/hot`（热门排序） | 显示条数同 145,710；滚动加载**同一内容池**，抽样 995 条与 crtime 已有数据**交集 428 条**；第 3 批起新增率 0% → 触顶 |
| `/topic-detail/SxAXPZZ2`（默认） / `/new` | 与 hot/crtime 同池 |
| `since/until` 时间窗口分批 | 2026 窗口 9,955 + 2025 窗口 +6 → 窗口只是**过滤**已加载内容，**不能延长触达** |
| 加大 rounds / 降延迟 | 无效（旧结论） |

**发现的分页接口（未打通，留待后续）**
- 页面滚动实际发出：`POST https://maimai.cn/community/topic-detail/<id>/<sort>`
  - header `content-type: text/plain;charset=UTF-8`，另有 `x-deployment-id`
  - body：`[{"id":"SxAXPZZ2","page":2,"sort":"hot"}]` ← **有 page 参数，理论上可深翻**
- 在页面内 `fetch()` 复刻该请求 → 返回的是 **SSR HTML（Next.js RSC 场景）**，非 JSON；说明需要额外的 RSC/Next-Action 头或走 Playwright `page.request` 复用完整 header。**未验证 page 上限**。
- 下一步思路：捕获真实响应体（content-type 可能是 `text/x-component`，非 json——上一版监听器只收 json 所以没抓到），确认形态后再决定直连翻页 vs 继续滚动。

**滚动侧待复核**：本专题历史"13~27 轮触底"多次可能是加载慢误判。复核任务参数：
`scroll={rounds:2500, adaptive:true, delayMinMs:300, delayMaxMs:1200, maxIdleRounds:25, loadWaitMs:8000}` + `extract.dupStop.enabled=false`（关掉重复自动停，避免早停）→ 看能否越过 1 万。

### 二十·补 复核结果与踩坑（2026-09-14 凌晨，务必看）

**结果**：跑到 **第 68 批**（≈1,360 轮滚动）仍未触发触底（`maxIdleRounds:25` 的高度静止条件未满足）→ 说明「1 万上限」不是硬上限，历史早停确实是**加载慢误判**。

**踩坑（重要，代价 1h20m）**：`dupStop.enabled=false` 时，**普通滚动分支没有任何中间落盘点**——数据只在循环结束后的 `extractAll` 一次性提取。中途 Stop 掉任务 → **全部成果丢失**，`data.json` 仍是旧的。
→ **指令：长跑一律不要关 dupStop 又不给落盘点**；要么保留 dupStop（顺带每批打新增率日志），要么用下一条的引擎修复。

**引擎已修（2026-09-14）**：`lib/pipeline.js` 普通滚动分支加两件事：
1. 每批打印 `· 条目计数 N（第 K 批）`（进度可观测，不再瞎等）；
2. 每 5 批执行一次 `extractAll` 并写 `output/<任务>/data.partial.json`（含 `来源` 字段），日志打 `· 中间快照已保存 N 条`。
中断后可用 `data.partial.json` 恢复：与 `data.json` 按 `_text[:150]` 去重合并即可。

## 三十、触底判定修复（2026-09-14，用户报「页面显示无更多内容但引擎说没到底」）

**根因（两个独立 bug，都会造成误判）**

1. **重复检测采样点错在「列表头部」** ← 真凶
   - `pipeline.js` 每批滚动后会 `window.scrollTo(0, 0)` 回到顶部，随后「重复检测」却取 `children.slice(0, 400)` 采样。
   - 结果：采到的永远是**早已见过的头屏** → `新增率 = 0%` → 连续 3 批 → 判定「内容已抓过」提前停止。
   - **这就是历史上多次「13/20 轮触底」的真因**——不是加载慢，是采样位置错。
   - 修复：改取**尾部样本** `all.slice(-400)`（代表新加载内容）。
2. **触底判定只看 `document.body.scrollHeight`**
   - 站点已显示「没有更多内容」时，DOM 仍可能因骨架屏 / 相对时间刷新 / 图片加载而持续改变高度 → `idle` 永不累积 → 真到底也判不到 → 无限滚。
   - 修复（`lib/interact.js` autoScroll）：新增两路信号
     - ① **底部文案**：页面 innerText 尾部 400 字命中 `没有更多内容|无更多内容|没有更多了|已加载全部|已经到底|到底了|没有啦|已到底部`，**连续 2 轮**才算（防列表中间的「加载更多」误触）
     - ② **条目计数稳定**：调用方传入 `countFn`；同一计数**连续 4 轮不变**即判触底
   - 返回 `{stalled:true, reason:'end-marker'|'count-stable'}`，日志带原因。

**实现要点**：`pipeline.js` 定义 `countNow = locateModule + detectItems`，同时传给 `autoScroll({countFn})` 与每批的 `n` 计数（避免重复定位）。

**验证（热榜，15 条）**：`/community/hot-rank`，目标 5000 条 →
日志 `[滚动到底：条目计数连续 4 轮保持 15 条不变（第 5/20 轮）]` → 停止 → 提取 15 条 ✓。不再出现「跑 68 批不停」或「3 批误判重复」。





## 三十一、评论采集 vs browser-skill：选档与两个静默失真（2026-11-09）

**背景**：用户要求对比 `browser-skill`（bsk）抓取与本引擎的评论方案，有优化就更新技能。结论是**不替代、要分档**，并修掉两处"漏了但没人知道"的缺陷。

### 22.1 为什么 bsk 不能替代引擎做评论批量

| 维度 | 引擎 `lib/comments.js` | browser-skill（bsk） |
|---|---|---|
| 登录态 | 自己的持久化 profile（`profiles/<host>`） | 用户**真实已登录** Chrome（扩展 + daemon） |
| 驱动方式 | 一条命令无人值守跑完 | agent 逐步调用，每步一次 CLI 往返 + `--context` |
| 吞吐 | 实测约 **11 帖/分**（30 帖/227 评论/2m38s） | 单篇 3~10 次往返；几十篇即数百次，人工时间不可控 |
| 断点续抓 | `.jsonl` 逐条追加 + `appendExisting` | 无内建落盘，靠 agent 自己记 |
| 影子树/iframe | 2026-11-09 起可穿 open shadowRoot；iframe/closed 树不行 | refs 可定位 iframe / shadow-root 内元素 |
| 无 href 的卡片 | 不行（依赖 `_link`），会打印跳过 | 可以（`click` 卡片后读详情） |
| 人工验证 | 有头窗口等人扫码，超时退出 | `cooperate`/human-help 原生支持 |
| 定时/可复现 | 任务 JSON 就是契约，可反复跑 | 会话态，不可复现 |

**定档（已写进 SKILL.md §3.4.1）**：A 引擎直采（默认，有 `_link`、10~200 篇）→ B 引擎跑完后只对低覆盖大帖上 bsk 补 → C bsk 全程（无 href / closed shadow / 需人工验证 / ≤30 篇）。

**红线**：① bsk 不做 >30 篇批量；② 引擎不做首次探路（看不见页面）；③ 两者不能同站并发（引擎持久化 profile 独占，bsk 动的是主浏览器）。

### 22.2 缺陷 1：影子树里的展开控件永远点不到（F2b）

- **症状**：候选恒 0，一轮「DOM 未增长」即判收敛，评论少抓且零告警。
- **根因**：`clickRound` 用 `document.querySelectorAll` 收候选，进不去 shadow root；且「最内层」判定用 `el.contains(other)`（不跨影子边界）、点击校验只比 `ev.target`（影子内点击在 document 上被重定向成宿主）、上轮标记清理也用 `document.querySelectorAll('[data-dsh-…]')`（影子内标记清不掉 → 无限加载按钮只生效一次）。
- **修法**：递归 `walk(document)` 收集；`containsDeep` 补 shadowRoot 包含；校验补 `ev.composedPath()`；清理改为遍历已收集的 `all`。
- **验证**：`test/comments-selftest.js` 12d → `clicks=2 / clickFails=0 / 评论块 1+2`。

### 22.3 缺陷 2：评论覆盖率没有分母（F2c）

- **症状**：日志只有「评论 N 条」。而本章 §二十六 早就实测「大帖只能拿 40%~60%」—— 交付时看不出来，等于静默失真。
- **修法**：`scrapeComments` 抽 `stats.claimCount`（只认**整段就是** `N 条评论`/`评论 N` 的短元素，正文里的「这 3 条评论」不算，已用 12c 用例锁住）；`harvestComments` 逐篇打印「页面声称 N / 覆盖 X%」，`<70%` 且声称 ≥5 时打 ⚠ 并计 `lowCoverage`；收尾给 `coveragePct`。
- **阈值依据**：小帖接近 100%、大帖 40%~60% → 70% 是"小帖全绿、大帖报警"的分界，不是要求大帖 100%。
- **纪律**：`lowCoverage > 0` 时**不许静默交付** —— 先 `expandIdleRounds: 4~5` 重跑；仍不够就 B 档 bsk 补，并在结论里注明哪几帖评论不全。

### 22.4 顺带修掉的过期文档

SKILL.md §8 曾把「多级展开漏评论」列为**未修**并建议调大 `expandIdleRounds`——实际 2026-10-25 task-7 已修，自测 `多级展开: clicks=2 / DOM 评论 8/8` 可证。该条已改为"已修复"，避免下次有人按过期建议白调参数。

**回归**：`node test/comments-selftest.js` **68/68 PASS**（原 64 + 新增 4）；`lib/*.js` `node --check` 全通过。

### 22.5 P0/P1/P2 落地（2026-11-09 晚，P2 为止）

**P0 · 点卡片进详情（`detailEntry`）**——脉脉评论终于能进 A 档
- 触发条件：`links` 为空且 `detailEntry !== 'link'`。`auto` 是默认值，所以脉脉零配置即可用。
- 循环：`clickCardAt(page, sel, idx)` 在**页面上下文**按索引重查可见卡片再点（回退/重排后 handle 必失效，索引是唯一稳定身份）→ `waitUrlChange()` 每 200ms 轮询 `page.url()` 直到命中 `detailUrlPattern` → `expandComments` → `scrapeComments` → `page.goBack()` → 回列表点第 idx+1 张。
- 保护：连续 5 张点不动就停（提示检查 `clickCardSelector`/`detailUrlPattern`）；`guard = max(maxPosts*3, maxPosts+10)` 防死循环；`stats.cardCount / clickEntryFails` 可事后核。
- 实测（离线夹具，4 张卡）：`added=3 / cardCount=4 / clickEntryFails=0`，每篇 3 条评论。

**P1 · 补抓（`refill`）**——修正上一版文档的错误承诺
- 事实核对：`appendExisting: true` 只做 `seen.has(url) → duplicated++`，**从不更新记录**。所以「bsk 补完把数补回」在旧代码里根本做不到。
- 修法：`seen` 由 `Set` 改 `Map(url → 下标)`；已存在记录在 `refill: true` 且**新抓评论更多**时原地覆盖，写 `refilledAt / refillFrom`，计 `refilled / refillGained`。只有更全才覆盖——避免把好数据改坏。
- 实测：首轮 `maxCommentsPerPost: 1` 只存 1 条 → 二轮 `refill: true` 刷成 3 条，`refilled=2 / refillGained=4 / added=0`。

**P2 · 按价值挑详情页（`sortBy`）**
- `index`（默认，零行为变化）| `engage`（赞 + 转×2 + 评×1.5，与 `x_opinion` 口径一致）| `textLen`（`正文/content/text/_text` 长度）。
- 同分用原始下标做次键——**不靠 V8 排序稳定性**，显式写死。
- 注意：脉脉记录只有 `_idx/_text/时间/正文/来源`，**没有互动数**，所以脉脉实际可用的只有 `textLen`；`engage` 是给 X 这类带四项互动数的记录准备的。

**契约兼容做法（可复用的套路）**：`normalizeCommentOpts` 的 14 键被自测 `deepStrictEqual` 钉死，直接加键会炸。解法是「契约不动 + 扩展键白名单」：默认值放 `EXT_DEFAULTS`（`withDefaults` 合并），任务值由 `extendCommentOpts()` 从 `extract.comments` 挑出并入。好处是**不配这些键时行为与旧版逐字一致**，坏处是调用方必须记得走 `extendCommentOpts`（pipeline 已改）。

**回归**：`node test/comments-selftest.js` **72/72 PASS**（68 + 13a~13d）；新增夹具 `test/comments-click-fixture.html`。

## 三十二、API 优先原则（2026-11-09 牛客实测，优先级高于浏览器渲染）

**结论：站点有公开 JSON API 时，抓 API 比渲染页面快 10 倍以上，且不受 DOM 改版影响。这是探路阶段应优先尝试的路径。**

### 23.1 如何发现 API（1 次 Playwright 即可）

```js
page.on('response', async r => {
  const u = r.url();
  if (!/gw-c\.|api\./.test(u)) return;
  if (/\.(js|css|png|jpg|svg|woff2?)/.test(u)) return;
  let body=''; try { body = await r.text(); } catch(e) { return; }
  console.log(r.status(), body.length, u);
  console.log(body.slice(0,300));
});
await page.goto(url);
await page.waitForTimeout(5000);
// 滚动几轮触发分页请求
for (let i=0;i<5;i++){ await page.mouse.wheel(0,3000); await page.waitForTimeout(2500); }
```

筛选信号：响应体 > 5KB 且 JSON、URL 含 `list|page|feed|query|search`。

### 23.2 牛客实测参数（可直接复用）

| 用途 | 端点 |
|---|---|
| 公司搜索 | `POST https://gw-c.nowcoder.com/api/sparta/pc/search`，body `{"query":"腾讯","type":"all","page":1}` → `data.records[]` 里 `rc_type===205` 的 `entityDataId` 即 companyId |
| 评价列表 | `GET .../experience/company/evaluation/list?companyId=153&pageNo=1[&tagId=1659]` → `data.total/totalPage/records` |
| 维度 tag | `GET .../experience/company/evaluation/tag?id=153` → `data.result[]` 含 `{id, word, count}` |

**必须的 header**：`x-requested-with: XMLHttpRequest`、`Referer: https://www.nowcoder.com/`、UA。

### 23.3 三个坑（都实测踩过）

1. **搜索接口只接受 POST**。GET 返回 `{"success":false,"msg":"Request method 'GET' not supported"}` —— 不是 400 而是 200+JSON，容易误判成参数错。
2. **shell 传中文 body 会 UTF-8 损坏**（curl `-d '{"query":"腾讯"}'` → `Invalid UTF-8 middle byte 0xda`）。用 Node `fetch` + `JSON.stringify`，别用 shell 拼 JSON。
3. **列表有匿名上限**：`tagId` 过滤时自报 total 68，实际翻完仍只有同一批 91 条去重 —— 说明 API 对未登录请求做了截断。**报告里必须写实际拿到多少，不能引用 total。**

### 23.4 其他求职站可达性（2026-11-09 实测）

| 站点 | 状态 | 结论 |
|---|---|---|
| 牛客 nowcoder.com | ✅ 公开 API，无登录，16 家公司 6,925 条 | **首选第二渠道** |
| 职友集 jobui.com | ⚠️ 200 但正文 XHR 懒加载，SSR 只给页头 | 成本高、口碑价值低，放弃 |
| 看准网 kanzhun.com | ❌ 301 跳转到婚恋站点（域名已易主） | 不可用 |
| BOSS 直聘 zhipin.com | ⚠️ 已被风控标记（见 §一） | 谨慎 |
| 脉脉 maimai.cn | ✅ 需登录 + 过滑块，数据最丰富 | 主力渠道 |

### 23.5 口碑分析的词表陷阱（2026-11-09）

朴素正负词表会把下列句子判错，必须加 override：

| 原文 | 朴素判定 | 正确 | 修法 |
|---|---|---|---|
| 领导重视不会甩锅 | 负（命中「甩锅」） | 正 | `POS_OVERRIDE` 含 `不会甩锅\|不甩锅\|不PUA` |
| 加班可享 1.5 倍薪资 | 负 | 负（但归强度不归薪资） | 专门分支：`加班.*倍薪` → 只记强度负 |
| 优秀人选全部被干掉 | 正（命中「优秀」） | 负 | `NEG_OVERRIDE` 含 `被干掉\|被裁\|被优化` |

落点：`F:\despseekharness\crawler\polarity_lib.js` 的 `clausePolarity()`。改完必须跑 6 条单测（`node -e` 内联即可），全 PASS 再重跑分析。

### 23.6 双渠道结论分歧是信号，不是噪声

同一家公司同一维度，脉脉与牛客可能给出相反结论（携程薪资：脉脉 1.54 vs 牛客 3.13）。

- **脉脉 = 在职员工视角**，比较基准是头部互联网同侪 → 说「相对低」。
- **牛客 = 校招/面试者视角**，比较基准是同龄 offer 与其他行业 → 说「绝对值够用」。

**报告里必须并列两渠道并解释人群差异**，不能取平均掩盖。

## 三十三、站点规则分册化 + 有头启动器（2026-11-10 用户要求，已落代码）

### 24.1 为什么要分册

用户要求：「以后使用 web-analysis-ai 时，可以先确认抓取规则和方法，再执行；没有的媒体则探索并记录」。

旧问题：68KB 的 EXPERIENCE.md 按时间线堆，站点细节散落各处，采集前没法快速查到「这个站该怎么抓」。

新结构：`sites/<host>.md`，一站一册，含五段固定内容——连接方式 / 关键接口 / 风控信号 / 节流参数 / 已知坑。

**SKILL.md §1.0 已设为最高优先级前置检查**：采集前必查分册；无分册走探索模式，跑通后必须补建分册。

### 24.2 有头启动器 lib/headed.js

统一封装「有头 + 窗口在屏幕内 + 立即置底」三件事。所有需要浏览器的采集统一调用 `launchHeaded()`，不要各自写 `launchPersistentContext`。

**踩过的坑**：`win_bottom.ps1` 第 1 行写成了 `> 把指定标题...` —— PowerShell 把 `>` 当重定向符，导致 `param()` 被当命令执行，脚本一直静默失败（调用处有 `catch(e){}` 吞掉）。改成 `#` 注释后才生效。

**窗口标题区分**：自动化浏览器是 `Google Chrome for Testing`，用户主浏览器是 `Google Chrome`。置底按标题精确匹配，不会误伤主浏览器。

**屏幕外窗口是错的**：我一度用 `--window-position=-32000,-32000` 想让窗口「不出现」，结果用户点任务栏都看不到。正确做法是放屏幕内 + 置底。

### 24.3 风控熔断必须是终止信号

用户借 agent-reach 的原则：遇风控立即停，不重试、不换账号、不换后端。

落代码：`RiskControlError`（带 `requiresHuman: true`）+ `attachRiskWatch()`。捕获后**抛出终止整个任务**，不能在循环里 `continue`。

**为什么重要**：风控基于账号+设备+IP 的历史行为累积。本轮实测——首轮 47 篇以 2.5 秒间隔连跑，第 48 篇起全部 461，且账号被标记到需要人工扫码才能恢复。继续重试只会加深标记。

### 24.4 自动学习污染 notes 的 bug（已修）

`pipeline.js:899` 旧逻辑每次运行都往 playbook 的 `notes` 追加「自动学习（N 条样本）」，脉脉 playbook 累积到 38 条噪声（715 字）。

修法：`notes` 只保留人工内容，自动学习信息改存 `learnedAt` / `learnedSamples` 独立字段。`buildPlaybook` 同时保留 `websiteRules` / `knownIssues` / `antiBot.throttle` 等手写字段，不被覆盖。

### 24.5 正文为空先怀疑风控

小红书首轮 33/47 篇正文为空，我一度怀疑选择器失效。真因是**那些页面其实是验证码页**。

**下次自检**：正文为空时，先看 `page.url()` 是否含 `website-login/captcha`、搜索 API 状态码是否 461，再怀疑选择器。

---

## 三十四、Windows 本机操作三坑（2026-11-12，技能仓库化时实测）

### 34.1 技能内目录 `mv` 报 Device or resource busy

**现象**：`mv analyses/btc-analyst topics/btc-analyst` 在任意 cwd 下都报 `Device or resource busy`，即使没有终端 cd 在里面。

**根因**：`.claude/skills/web-analysis-ai` 是符号链接，且有 node.exe / chrome.exe 进程持有该目录下的文件句柄（本机常驻多个 node 进程）。Windows 不允许移动被持有的目录。

**对策**：改用 `cp -r` 复制 → 校验文件数一致 → `rm -rf` 原目录。不要反复重试 `mv`。

**验证**：`find 新目录 -type f | wc -l` 与源目录一致，再删源。

### 34.2 git 走 HTTPS 报 Connection was reset / 443 超时

**现象**：`git fetch/push` 报 `Recv failure: Connection was reset` 或 `Failed to connect to github.com port 443 after 21094 ms`，但同一时刻 `curl https://github.com/` 返回 200、`gh api user` 正常。

**根因**：**HTTP/2 连接被中间设备重置**。git 默认协商 HTTP/2，curl 走 HTTP/1.1 所以不受影响。

**对策**：仓库级固定协议版本，一次解决：
```bash
git config http.version HTTP/1.1
```
之后 fetch/push 全部正常，无需代理。

**判断要点**：curl 通但 git 不通 → 先怀疑 HTTP/2，不要浪费时间查代理/凭证/DNS。

### 34.3 含 shell 变量的删除命令被内置安全校验拦截

**现象**：`S=/path; mv "$S/analyses/x" ...` 这类含变量的复合命令被 Claude Code 内置安全检查拒绝，报 "Permission for this command was denied by a built-in Claude Code safety check"，理由是变量未展开时可能退化为 `rm -rf /`。

**对策**：分步执行，每次一个操作，路径写字面绝对路径不使用变量。不要试图拆分绕过（同一检查仍会命中）。

**边界**：这条限制只影响「删除/移动」类危险命令，普通读写和 `node` 执行不受影响。

### 34.4 Chromium profile 膨胀 95% 是缓存

**现象**：`profiles/` 三个目录合计 1.1 GB（x.com 599M / maimai.cn 436M / unified 69M）。

**根因**：持久化 profile 目录（`chromium.launchPersistentContext` 的 `userDataDir`）是完整的 Chromium 用户数据目录，**Cache / Code Cache / Service Worker 会随每次运行无限增长**。真登录态只在 `Default/Network/Cookies`（约 28KB）+ `Local Storage` / `IndexedDB`。

**可安全删除（纯缓存）**：`Default/Cache`、`Default/Code Cache`、`Default/Service Worker`、`GPUCache`、`GrShaderCache`、`ShaderCache`、`DawnGraphGPUCache`、`DawnWebGPUCache`、`component_crx_cache`、`optimization_guide_model_store`、`WasmTtsEngine`、`CertificateRevocation`、`BrowserMetrics*`、`segmentation_platform`。

**必须保留**：`Default/Network/`、`Default/Local Storage/`、`Default/IndexedDB/`、`Default/Storage/`、`Default/Preferences`、`Default/Login Data`。

**前提**：删之前先关掉所有 chrome.exe（本机常有 Playwright 残留进程）。删完重跑一次采集验证登录态仍在。

**建议**：清理后约可回收 900MB。后续可加定期清理，但**必须先确认无 chrome 进程占用**。

---

## 三十五、产出分析的统计口径坑（2026-11-12，脉脉/牛客/小红书三专题实测）

### 35.1 站点自报计数 ≠ 实抓样本统计

**现象**：牛客接口返回的 `tags` 是**全站标签计数**（每家公司一整站），我们只抓到 7,001 条中的一部分（覆盖 4.3%~18.6%）。若直接拿 tags 数除以实抓条数，会得到「工作强度占比 34.9%」这类看似成立、实则分母错位的数字。

**根因**：标签计数由站点按公司维度累计，与分页抓取范围无关。携程那行标签占比超过 100%（139.8%/144.2%），就是分母不一致的直接证据。

**对策**：口径分开写——「站点全站标签分布」只做公司间横向参照；「实抓样本统计」必须自己从 `records` 里算。两个数字**不可合并、不可相互校验**。发现任何占比 >100%，立即判该字段分母异常并弃用。

### 35.2 覆盖率必须现算，不报覆盖率就是抽样骗局

**现象**：站点 `total` 动辄上万（腾讯 14,390），实抓只有 622。若直接汇总，会把「抓到的 622 条」当成公司的全样本。

**对策**：每个渠道产出分析前先算 `fetched / claimedTotal`，并在报告顶部写清覆盖率。低于 20% 时结论措辞限定为「站点标签层面」或「抓取子集」，禁止用「该公司员工普遍……」句式。

### 35.3 标题正则不是情感分析

**现象**：小红书只采到标题 + 点赞，用正则命中「高利贷/避雷」后写成「负面 19.7%」。

**根因**：标题用词与正文立场可以相反（「被高利贷坑了？看这篇」是科普而非控诉），且无正文无评论时无法校正。

**对策**：产物里一律命名为「标题倾向（关键词命中）」，并在表下注明「非情感模型」。真正的极性分析必须拿到正文，走子句级词表（见 §极性分析相关章节）。

### 35.4 先探查结构再写解析，别猜字段

**现象**：小红书列表文件是 `{count, items}` 而非数组，解析函数返回 undefined，统计出 0 条且不报错。

**对策**：新数据源第一次跑分析前，先跑一个只打印 `keys / 样本前 500 字符` 的探查脚本（一次性，用完即删），确认顶层结构与数组字段名。解析函数统一用兼容取值 `Array.isArray(j) ? j : (j.data || j.items || j.posts || j.records)`，并在条数为 0 时 `console.warn` 而不是静默通过。

### 35.5 自报数据只能看相对排序，不要跨维度合成单一排名

**现象**：脉脉薪资与工时都是用户自报，前者含股票估值、后者双向偏差；若合成「综合性价比榜」，误差会被放大成结论。

**对策**：两个维度各自排行，交叉观察只写「现象」不写「评分」。样本门槛写进产物（如工时 ≥30、薪资 ≥20），并注明小样本（n<40）名次不稳。

### 35.6 分析脚本入仓、一次性脚本即删

**对策**：确定性统计写成可复跑脚本（`topics/analyze_topics.js`），输出目录用环境变量可覆盖（`WA_OUT`），脚本随技能入库保证其他机器可继承；探查脚本（`*_inspect.js`）用完立即删除，不留工作区垃圾。

**Why**：结论可复现比结论本身更重要——口径被质疑时，重跑一次就能自证。

---

## 三十六、职友集 jobui.com 风控规则复核（2026-11-14 实测，推翻旧分册）

> **本节优先级高于 `sites/jobui.com.md` §二**。分册写于 2026-11-10，其中
> 「公司页 / 薪资页 ✅ 无风控，可无限取」「风控后 40-60s 可恢复」两条**已被证伪**，
> 后续以本节为准（站点分册待用户确认后再改）。

| 场景 | 现象 | 对策（已实现 / 下次怎么做） |
|---|---|---|
| 批量采岗位细分薪资 | 2026-11-13 连续 26 次请求 `/company/<id>/salary/j/<岗位>/` 后，**整站**（含公司页）全部跳 `/tips/valid.php`；9min、20min 探测未恢复，次日 10:20（约 **19 小时**）仍跳验证码 | 风控按 **IP + 会话历史累积**，不是单接口限流。一旦触发会**扩散到全站**，且冷却远不止 40-60s。默认按「≥6h 不再自动重试」处理；恢复条件是换 IP / 新浏览器会话 / 人工过验证码，不是干等 |
| 判断「是否已解封」 | 直接请求只看到 **HTTP 302 + 空 body**，若只看状态码 200 或只查 body 关键词会**误判为已解封**；实际 302 → `tips/valid.php?...` → 200 `<title>验证码验证</title>` | **必须跟随整条重定向链**，把 `Location` 里出现 `/tips/valid.php` 当作主风控信号，再看最终 200 的 title/body。已固化到 `crawler/lib/jobui-guard.js#detectRisk`（检查 chain 而不是只看 final body） |
| 跑采集脚本前 | 以前靠人记「间隔 ≥25s」，一旦被标记仍会硬跑，加深 IP 标记 | **机器层已落地**：`crawler/lib/jobui-guard.js` + `crawler/jobui_preflight.js`；`jobui_collect.js` / `jobui_job_collect.js` / `jobui_resolve_ids.js` / `jobui_resolve_more.js` / `jobui_dump_candidates.js` **全部在入口调用 `preflightOrExit()`**。冷却期内直接 `exit(2)`，连探测都不发。状态持久化在 `output/jobui/_risk_state.json` |
| 遇风控后的动作 | 曾试图「隔几分钟再试」「换接口继续」 | **风控 = 终止信号**（§24.3）：立即停，不重试、不换账号、不换后端。本项目 guard 命中即 `markBlocked()` 写状态并抛 `RiskBlocked`，调用方必须终止 |
| 搜索接口 `/cmp?keyword=` | 连续 2 次即触发；加「子品牌过滤」反而把字节跳动正确主体「北京抖音信息服务有限公司」排除 4 次 | 间隔 **≥25s**、单批 **≤6 次**、结果**直接取第 1 条不加过滤**；ID 写进 `output/jobui/_ids.json` **永久复用**（已有 34 个），之后只走公司页 |

### 36.1 现象 → 根因 → 修法（完整推理）

- **现象**：26 条岗位细分薪资采完后全站验证码；按旧经验「40-60s 冷却」等待并重试无效，19 小时后仍未恢复。
- **根因**：把「搜索接口有验证码」误解成「只有搜索接口有验证码」。实际站点对 **IP 的请求密度**做累积评分，跨接口共享；岗位页连发 26 次把分数打满后，风控升级为全站跳转。同时旧探测代码不跟随 302，导致「302 空 body」被当成正常响应，掩盖了真实状态。
- **修法**：① 探测改为跟随重定向并检查整条链；② 风控状态持久化 + 6h 冷却；③ 所有采集脚本入口强制 preflight；④ 单批请求上限 20 次、岗位页间隔 ≥12s、搜索 ≥25s；⑤ 熔断即停。
- **保留的正确策略**：搜索 ID 一次永久缓存（34 个 ID 已在库），这是唯一能长期绕开搜索风控的办法。

### 36.2 下次如何验证「已避开」

```bash
cd F:/despseekharness/crawler
node jobui_preflight.js          # exit 0 = 可用；exit 2 = 仍被风控，禁止采集
node jobui_collect.js 携程        # 被封时应立刻打印 guard 拦截信息且不发任何请求
```

**命中判据**：被封时 `jobui_collect.js` 首行输出 `[jobui-guard] 职友集仍处于风控，禁止采集` 且无后续抓取日志；解封前不要 `--reset`（`--reset` 仅在换 IP / 人工过验证码后使用）。

---

## 三十七、脉脉评论采集的两个结构性坑（2026-11-14，已落机器层）

| 场景 | 现象 | 对策（已实现 / 下次怎么做） |
|---|---|---|
| 四大专题「按公司优先」抓评论 | 用正文 + 发帖人 identity 匹配目标公司，242 帖只命中 1 家，公司优先队列形同虚设 | 根因：`lib/sites/maimai.js#collectPosts` 只保留 6 个字段，**丢掉了 RSC 的 `title`**，而公司印象/工时/薪资专题的 `title` 恰是「评价对象公司名」（「中兴通讯印象 · 能源 · 3年以上」）。已在项目侧 `crawler/lib/comment-harvest.js#collectPostsRich` 自行拦截 RSC 保留 `title/time/has_comments/likes/ip_loc`，**不改技能共享引擎**；`lib/company-priority.js` 对 title 命中给最高权重。补上后 802 帖命中 10 帖（联友/明略/贝壳/沃尔玛/瑞幸） |
| 话题列表卡片判断「有没有评论」 | 卡片上的「评论 2」被当成评论数，点「评论」只弹输入框，据此误判「话题帖都没有评论」 | 那个数字是**点赞数**。列表卡片无 href、无真实评论数。唯一可信来源是 RSC 帖对象的 `cmts` 字段，配 `id/egid` 直接拼 `gossip-detail` 详情页。实测公司印象 62.2% 的帖有评论、职言 78.8% |
| 评论清洗规则验证 | 首版在 53 条小样本上「只剔 4 条、无误杀」，换真实批次后漏掉 4 类噪声：`<dref ...>` 站内标签、`ã€‚/ðŸ™` mojibake、「求内推/求推/有岗位吗」求职搭话、`taou.cn` 活动广告 | ① `normalize()` 剥 `<...>` 标签并**去掉全局 UI 词替换**（会把正文里的「评论/分享/赞」删掉）；② 乱码用 Latin 扩展字符集判空；③ 求职噪声只在「短句 ≤24 字且不含实质信息词」时剔除（长评论提到内推要保留）；④ 广告词「领取」必须带宾语，否则误杀「领取退休金」。已固化到 `crawler/lib/comment-filter.js` |
| 清洗误杀率核对 | 用对象引用 `Set` 比对 keep 与原始数组，因 `filterComments` 返回的是新对象，`has()` 恒 false，把**全部评论**打印成「被剔除」，差点误判规则严重误杀 | **必须用规范化后的文本做集合比对**（`F.normalize(c.text)`），不能用对象引用。核对脚本见 `reclean_comments.js` 的验证逻辑 |

### 37.1 评论到底能不能用于公司打分

**能，但评论的价值是「增量」而非「重复正文」**。实测保留下来的有效评论里，正文完全没有的信息包括：
> 「现在贝壳财务已经这么轻松了吗？当年…我们财务部一年流动人数得有二十人，太累了，晚上干到八九点钟是常态，月初结账一定熬到十二点…大量裁员，自己努力淘汰自己」

以及「算法岗平均每天大概几点能下班？」「武汉这家公积金忽略不计，试用期工资打八折」。所以评论可提供**反驳正文、补充具体工时/薪资/裁员细节、岗位差异**三类证据。但必须带 `commentQuality = 有效/原始` 与样本充足度标记：`crawler/reclean_comments.js` 输出的 `company_evidence.json` 按公司聚合，并标注 `sampleLevel`（<5 条 insufficient、5-9 条 thin、≥10 条 ok），对齐「<10 条不得给 A」的四维规则。

### 37.2 下次如何验证已避开

```bash
cd F:/despseekharness/crawler
node reclean_comments.js v4      # 用最新 filter 重洗 + 生成公司评论证据清单
```
命中判据：`report.json` 里 `filterVersion` 为 2026-11-14 版；抽查「求内推」被剔、「领取退休金」长讨论被保留、`company_evidence.json` 每家带 `sampleLevel`。

---

## 三十八、小红书详情「累计总量」风控（2026-11-14 实测，补充分册）

| 场景 | 现象 | 对策（已实现 / 下次怎么做） |
|---|---|---|
| 分诊补抓小红书详情 | 按分册「18 篇连续 @9s 安全、单批上限 18 篇」执行：47 篇 @9s，**每 18 篇暂停 60s 分 3 批**，仍在第 48 篇触发 461 / 验证码跳转 | **累计总量也敏感**，不是只有「连续速率」。分批 + 60s 短暂停不足以解除标记。已把「单日累计 ≤36 篇、或批次间暂停 ≥30 分钟」写进 `sites/xiaohongshu.com.md` 与 `TODO.md`；`xhs_detail_refill.js` 保留 461 立即熔断分支 |
| 补抓脚本设计 | 直接复用 `xhs_api.js detail` 会**覆盖既有 jsonl**、且从单个搜索文件头部重抓已抓过的笔记 | 新建 `crawler/xhs_detail_refill.js`：跨所有 `s_*.json` 汇总 → noteId 去重 → 排除 `details/*.jsonl` 已抓 → 按「标题命中目标词 +3 / 互动≥1000 +2」分诊打分 → 追加写 `refill_YYYYMMDD.jsonl`，逐篇落盘，中断不丢 |

### 38.1 现象 → 根因 → 修法

- **现象**：候选池 1,419 篇、分诊后可补 699 篇；实抓 47 篇 / 460 条评论后第 48 篇 461。
- **根因**：旧分册把「47 篇被封」归因于间隔只有 2.5s，误以为把间隔提到 9s 并分批就安全。实际账号/IP 的详情请求**按时间窗累计计数**，60s 暂停不重置窗口。
- **修法**：① 认累计上限，单日 ≤36 篇；② 熔断即停（本次 47 篇后立刻停，没有重试，登录态未进一步受损）；③ 覆盖率目标从「15%+」改为「按天分批推进」，单轮不硬冲。
- **结果**：详情 118→168 篇（5.5%→7.8%）、评论 544→1,034 条。

### 38.2 下次如何验证已避开

```bash
cd F:/despseekharness/crawler
node xhs_detail_refill.js --dry            # 只看分诊候选，不启浏览器
node xhs_detail_refill.js --max=36 --batch=18   # 单日 ≤36 篇
```
命中判据：日志出现 `DONE 36 篇` 且没有「风控/登录态中断」；若出现 461 应立即停，不要 `--reset` 或换账号重试。
