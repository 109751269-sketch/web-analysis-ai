# web-analysis-ai

> 📊 **能力盘点**（2026-11-14 快照，[唯一版本](https://109751269-sketch.github.io/web-analysis-ai/)）：源文件 `docs/index.html`（仓库内可读 `docs/CAPABILITY.md`）。2026-11-14 已把求职站的重复版本合并进来，旧地址 `career-report/skill-audit/` 只保留跳转。
> 含渠道矩阵、专题帖子量/评论量/时间范围、评论采集能力验证、数据健康度与 TODO 看板。

Agent 主导的网页抓取与分析工作流。引擎（Node + Playwright）自包含在本 skill 的 `lib/`，任务与产物落在独立工作区，两边分离。

核心思路：**每一步都裁决该用确定性脚本还是大模型判断**。能写成代码的（cookie 注入、滚动、翻页、字段提取、节流）交给脚本；需要语义判断的（这个选择器对不对、这批数据像不像被风控了、字段该归到哪一类）交给 agent。跑通一次的流程沉淀成 `sites/` 分册和 `playbooks/` 配置，第二次直接复用。

---

## 一、现在能做什么

### 1.1 支持的渠道

| 渠道 | 需登录 | 连接方式 | 反爬 | 状态 |
|---|---|---|---|---|
| **脉脉** maimai.cn | 是 | 持久化 profile + RSC 流拦截 | 中 | ✅ 主力，数据最丰富 |
| **牛客** nowcoder.com | **否** | 公开 HTTP API | 无 | ✅ 主力，免登录，优先抓 |
| **职友集** jobui.com | 否 | 纯 HTTP GET + ID 缓存 | 中高（**按 IP 累积，触发后全站**） | ⚠️ 需 preflight；执行前读 `sites/jobui.com.md` |
| **小红书** xiaohongshu.com | 是 | 持久化 profile + 有头模式 | **高** | ⚠️ 需限速，易触发风控 |
| **X / Twitter** x.com | 是 | Playwright + 分段搜索 | 中 | ✅ 时间线采集 |

每个渠道的节流参数、连接方式、风控信号、已知坑都写在 `sites/<host>.md` 分册里。**执行任何采集前先读对应分册**，不要临场发挥；没有分册的站点走探索模式，跑通后必须补建分册。

### 1.2 引擎能力

| 模块 | 能力 |
|---|---|
| `lib/crawl.js` | CLI 唯一入口，读任务 JSON 跑完整抓取 |
| `lib/pipeline.js` | 核心流程：加载 → 注入会话 → 交互 → 滚动 → 提取 → 落盘 |
| `lib/extract.js` | 三层自动识别（容器/条目/字段），噪声清洗，详情补充，广告过滤 |
| `lib/comments.js` | 评论区采集：循环展开直到 DOM 不再增长，逐条 `.jsonl` 追加（中断不丢） |
| `lib/interact.js` | tab 点击、滚动加载、等待策略 |
| `lib/datefilter.js` | 中文/绝对日期解析，`[since, until]` 过滤，覆盖度统计，支持断点续抓 |
| `lib/auth.js` | Cookie 两种格式兼容（storageState / Cookie-Editor JSON），自动规范化 |
| `lib/headed.js` | 有头浏览器启动器：有头防风控 + 窗口置底不打扰用户 |
| `lib/research.js` | 单入口调研：`--company=携程` 一条命令跑完脉脉+牛客+小红书 |
| `lib/probe.js` | 页面结构探测器，输出候选 tab / 输入框 / 重复结构 + 截图 |
| `lib/playbook.js` | 站点攻略自动复用：把成功配置与反爬参数存成 `playbooks/<host>.json` |
| `lib/handle-links.js` | HTML/Markdown 报告里 `@handle` 自动变可点主页链接（幂等，保护 style/script/已有 a/邮箱） |
| `lib/check-links.js` | 交付前内链自检：相对链接/资源是否存在、目录是否有 index.html、大小写是否一致 |
| `lib/sites/*.js` | 站点专用采集器（maimai / nowcoder / xiaohongshu / jobui） |
| `lib/util.js` | 时间戳、读写、HTML 转义、参数解析、数字解析 |

### 1.3 工作模式

**两段式（默认起手式）**

1. **探路**：用 browser-skill 插件操作真实已登录浏览器，观察 DOM，试出真实的交互方式、容器选择器、字段节点，抓 10~30 条验证。
2. **批量**：把探路结论写成任务 JSON，交给 `lib/crawl.js` 无人值守跑完。

反过来做会付出代价：直接盲跑引擎时只能看日志猜，看不见页面。X 时间线曾因为照抄错误的 `dblclick` 配置连跑两次都拿到热门混排，还误以为是数据源问题。

**API 优先原则**

能走 HTTP API 就不开浏览器。牛客全程公开 API，速度快一个数量级、零风控。如何发现 API、需要带哪些 header，见 `EXPERIENCE.md` §三十二。

**有头是默认**

headless Chrome 缺 GPU 渲染、`navigator.webdriver` 为 true，是多数站点的直接风控触发器。统一用 `lib/headed.js` 的 `launchHeaded()`：有头 + 窗口在屏幕内 + 立即置底。

---

## 二、做过什么

### 2.1 已采集数据

**脉脉 — 4 个专题，合计 42,298 条**

| 专题 | 条数 | 时间范围 |
|---|---|---|
| 公司印象大爆料 | 11,522 | 2025-10 ~ 2026-11 |
| 爆料各司工时强度 | 5,768 | 2025-10 ~ 2026-11 |
| 职级薪资大揭秘 | 10,452 | 2025-10 ~ 2026-11 |
| 我来爆个料 | 14,556 | 2025-10 ~ 2026-11 |

薪资条目 93% 可从正文正则提取出公司字段。

**牛客 — 15 家公司，7,001 条评价**

腾讯 / 阿里 / 百度 / 网易 / 京东 / 携程 / 美团 / 华为 / 滴滴 / 字节 / 大疆 / 小红书 / 拼多多 / 快手 / 蚂蚁。时间跨度 2019-01 ~ 2026-11。

**小红书 — 12 个关键词，1,995 条搜索笔记**

详情已抓 48 条（覆盖率 2.4%）。携程金融线专项 61 篇（32 篇有正文 / 146 条评论）。

**职友集 — 15 家公司 ID 已解析**

招聘趋势、薪酬区间、历年工资、人才结构。公司级平均薪资含骑手/客服岗，不能直接对标技术岗薪酬，须走岗位细分页。

### 2.2 已产出的分析

| 产物 | 内容 |
|---|---|
| `bigtech_compare.html` | 大厂横向对比报告 |
| `net_emotion_compare.html` | 跨公司净情绪对比 |
| `daji_report.html` | 大疆专项报告 |
| `report_bigtech_vs_dji.md` | 大厂 vs 大疆对照 |
| `topic_library.md` | 脉脉专题库索引 |
| `SITES.md` | 站点能力台账 |

图表用 ECharts，报告为单文件自包含 HTML，可直接发布到 GitHub Pages。

### 2.3 已沉淀的经验

`EXPERIENCE.md` 共 846 行、35 节（编号连续到三十五），覆盖：

- 反爬与安全验证的触发条件与规避方式
- 脉脉 RSC 流拦截方案（2026-11 改版后 DOM 里没有帖子链接，只能拦截响应体）
- 评论区入口破解、重复内容自动停、触底判定修复
- HTML 报告的字段校验与渲染自检
- 极性分析：子句级 + 词表补全
- 跨公司对比必须先统一分母
- 不能盲目相信站点自报数（牛客自报 703，实际 113）

### 2.4 已验证不推荐的渠道

| 渠道 | 原因 | 替代 |
|---|---|---|
| 看准网 kanzhun.com | SPA，首屏仅 3KB，内容全靠 JS，接口需登录 | 脉脉 |
| 拉勾 lagou.com | 企业级 WAF，拦截成本高于收益 | 职友集 |
| BOSS 直聘 zhipin.com | 设备指纹 + 行为风控，账号级封禁风险 | 职友集 `jobs/` |
| 猎聘 liepin.com | 强制登录且登录后仍限流 | 职友集 |
| 知乎 / 微博 | 反爬策略频繁变动，维护成本高 | 脉脉 + 小红书 |

完整的渠道台账（含独有数据、优先级、决策树）见 `sites/README.md`。

### 2.5 专题档案（`topics/`）

技能做过的每类分析都是一个**独立专题**，互不干扰，可随时接着上次进度继续跑：

| 专题 | 内容 | 状态 |
|---|---|---|
| `topics/btc-analyst/` | 推特 87 个博主 BTC 预测能力评测（含脚本、结论、4 口径方法论） | 🟢 一期完成，可复跑 |
| `topics/maimai-workplace/` | 脉脉四专题帖 + 评论，职场/公司评价 | 🟢 已采 42,298 条 |
| `topics/x-recent-opinion/` | 推特近 24h 帖子找市场观点，日更简报 | 🟢 多期已采 |
| `topics/company-reviews/` | 牛客 15 家 + 职友集薪资评价 | 🟡 口径待修 |
| `topics/xhs/` | 小红书关键词搜索与详情 | 🟡 详情覆盖率低 |

- **入口**：先读 [`topics/INDEX.md`](topics/INDEX.md)（索引）与 [`topics/LEDGER.json`](topics/LEDGER.json)（进度台账：做到哪、数据在哪、下一步）。
- **数据**：原始数据不进仓库，留在工作区，路径登记在台账里。

---

## 三、待办

本 skill 的待办清单维护在 **`TODO.md`**，开工前必读，做完即删。当前 4 项未完成：

| # | 事项 | 症结 |
|---|---|---|
| TODO-1 | 职友集剩余岗位细分薪资 | 34 个 ID / 29 条已采；**IP 被全站风控**，需 `jobui_preflight.js` 放行后再续采 |
| TODO-2 | 小红书详情覆盖率 5.5% | 2,162 条列表只抓了 118 篇；按标题/互动分诊、限速补抓 |
| TODO-3 | 脉脉长尾公司评论样本不足 | 139 帖 / 3,045 条有效评论，多数公司 <10 条，按规则不得给 A |
| TODO-4 | 数据源与结构缺口 | 公司主页 404、offer 选择专题无数据、内推软文污染、历史日期口径 |

已完成并移除：牛客裁员正则、growthScore 薪资口径、cloudflared 下线、脉脉评论链路、评论清洗过滤、职友集风控守卫。

### 在线发布

已确立的稳定方案：**GitHub Pages**（仓库 public，推静态页即得永久链接，不依赖本地进程）。
本仓库的 `docs/` 即从 `main` 发布的能力盘点页；求职专题另见 [career-report](https://109751269-sketch.github.io/career-report/)。
临时隧道方案（cloudflared / localtunnel）已证伪并下线，坑记录在 `EXPERIENCE.md`。

发布后必须用 Playwright 真实浏览器验证，不能只看 curl 状态码——localtunnel 曾出现「curl 返回 200，浏览器只看到密码页」。

---

## 四、快速开始

### 4.1 目录约定

| 项 | 位置 |
|---|---|
| 引擎 | 本 skill 基目录（`lib/` + `node_modules` + `package.json`） |
| 工作区 | `F:\despseekharness\crawler`（任务、输出、临时文件） |
| 产物 | 工作区 `output/<任务名>/` |
| 登录态 | `profiles/<host>`（持久化 profile）或 `cookies/<host>.json` |
| 站点分册 | `sites/<host>.md` |
| 站点攻略 | `playbooks/<host>.json` |

### 4.2 单站点抓取

```bash
cd F:\despseekharness\crawler
node "C:/Users/sun/.agents/skills/web-analysis-ai/lib/crawl.js" --task=tasks/demo.json
```

任务 JSON 字段（`url` / `authFile` / `tabs` / `scroll` / `extract` / `login`）见 `lib/crawl.js` 顶部注释。

### 4.3 多站点调研（一条命令）

```bash
# 先起 CDP 浏览器，在其中登录脉脉/小红书
chrome.exe --remote-debugging-port=9222 \
  --user-data-dir=C:\Users\sun\.agents\skills\web-analysis-ai\profiles\unified

node lib/research.js --company=携程
node lib/research.js --company=携程 --sites=maimai,nowcoder
node lib/research.js --company=携程 --skip-comments
```

### 4.4 探测新站点

```bash
node lib/probe.js --url=https://example.com --headless=false
```

输出页面标题、候选 tab、输入框、正文预览、重复结构摘要 + 截图。探明后写 `sites/<host>.md` 分册。

### 4.5 依赖

```bash
npm install        # playwright 1.62.1
```

`node_modules/`、`cookies/`、`profiles/` 已在 `.gitignore` 中排除，不会入库。

---

## 五、文件结构

```
web-analysis-ai/
├── SKILL.md              # 工作流主体：阶段、裁决表、站点专项
├── EXPERIENCE.md         # 踩坑经验与成功模式（35 节）
├── TODO.md               # 待办清单（开工前必读，做完即删）
├── README.md             # 本文档
├── lib/
│   ├── crawl.js          # CLI 唯一入口
│   ├── pipeline.js       # 核心流程
│   ├── extract.js        # 提取引擎
│   ├── comments.js       # 评论采集
│   ├── interact.js       # tab / 滚动 / 等待
│   ├── datefilter.js     # 日期窗口 / 断点续抓
│   ├── auth.js           # 会话处理
│   ├── headed.js         # 有头启动器
│   ├── research.js       # 多站点调研单入口
│   ├── probe.js          # 结构探测器
│   ├── playbook.js       # 站点攻略复用
│   ├── util.js           # 通用工具
│   └── sites/            # 站点专用采集器
├── playbooks/            # 站点攻略配置（<host>.json）
├── sites/                # 站点分册（<host>.md）+ 全渠道台账
├── references/           # Cookie 指南、X 时间线教训
├── test/                 # 自检脚本与 fixture
├── tools/                # CDP 启动脚本
└── topics/               # 专题档案（独立分支，互不干扰）
    ├── INDEX.md          # 专题索引（开工前先读）
    ├── LEDGER.json       # 专题状态台账（进度/数据路径/下一步）
    ├── btc-analyst/      # 推特博主预测能力评测（脚本 + 结论）
    ├── maimai-workplace/ # 脉脉职场评价
    ├── x-recent-opinion/ # 推特近期观点
    ├── company-reviews/  # 牛客 + 职友集公司评价
    └── xhs/              # 小红书
```

**专题数据不进仓库**：`topics/<slug>/` 只存档案（目标、流程、脚本、结论、状态），原始数据留在工作区（如 `F:\despseekharness\crawler\output\`、`crawler\topics-data\`），路径登记在 `topics/LEDGER.json`。这样技能仓库保持轻量、可跨机器继承分析与经验，同时不搬 200MB+ 原始数据。

---

## 六、边界

**风控是终止信号，不是重试信号。** 遇到验证码、登录墙、接口风控码、内容突然全空，立即停止并报告，不重试、不换账号、不换后端。风控基于账号+设备+IP 的行为累积，重试只会加深标记。

**不做的**：绕过验证码、批量注册账号、破解设备指纹。遇到硬风控就记录原因、找替代渠道，台账里已有一批「已验证不推荐」的站点供参考。

**数据边界**：采集内容涉及真实员工的薪资、工时评价，产物只落本地工作区，不外发。发布到公开网页前须自行核查脱敏。

---

## 七、参考

- [站点分册索引](sites/README.md) — 各渠道连接方式、节流参数、风控信号、渠道决策树
- [工作流主体](SKILL.md) — 完整阶段定义与裁决表
- [踩坑经验](EXPERIENCE.md) — 每次试错的具体根因与修法
- [能力盘点](https://109751269-sketch.github.io/web-analysis-ai/) — 唯一版本；源文件 [docs/index.html](docs/index.html) / [docs/CAPABILITY.md](docs/CAPABILITY.md)
- [待办](TODO.md) — 未完成项与阻塞原因
