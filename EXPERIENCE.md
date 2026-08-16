# EXPERIENCE.md - 踩坑经验与成功模式（下次直接照做，避免重复试错）

> 本文件记录 Web Analysis AI 在真实站点（maimai / BOSS直聘 / X.com）实战中总结的经验。
> 新站点分析前先读本文件 + 查看 `playbooks/` 是否已有该站点攻略。

---

## 一、反爬与安全验证（最重要的坑）

| 站点 | 行为 | 经验 |
|------|------|------|
| maimai.cn | headless 会被退回登录页 | **必须 headless=false**（有头）；会话用 Cookie-Editor JSON 或 storageState |
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

## 三、分析（agent 读数据自行推理）

- 引擎只负责抓取落盘（data.json），**分析由 agent 直接读数据完成**（不再有 analyze.js / lib/stats.js / lib/llm.js 脚本链，已移除）。
- 统计类数字结论必须用脚本/工具核对 data.json（如 node -e 聚合），禁止凭印象编造数字。
- 大样本时抽样读（脚本/工具过滤聚合），不要整包塞给模型。

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
