# web-analysis-ai 待办任务

> 建立于 2026-11-10。执行完的项目**立即删除**，不要留已完成条目。
> 下次开始工作前先读本文件，确认哪些还没做。

---

## 待执行

### TODO-1　职友集：剩余公司 ID 未解析

**现状**：已完成 15 家大厂（腾讯/阿里/字节/美团/网易/百度/京东/携程/华为/滴滴/大疆/小红书/拼多多/快手/蚂蚁/联想）。

**阻塞原因**：搜索接口 `/cmp?keyword=` 连续调用 2 次即触发验证码页，冷却约 40s。

**已确认的正确做法**：
- 搜索结果**按相关度排序，第一条就是主体公司**，不要加任何过滤规则。加过滤反而会选错——实测「字节跳动」正确结果是第一条「北京抖音信息服务有限公司」，被过滤规则排除了 4 次
- 搜索间隔 ≥25s，遇验证码冷却 60s 重试
- ID 一旦确认写进 `output/jobui/_ids.json` 永久复用，不再搜索

**执行方式**：
```bash
cd F:\despseekharness\crawler
node jobui_dump_candidates.js    # 导出候选（人工看首条）
node jobui_collect.js <公司名>    # 用缓存 ID 采集
```

**注意**：`_ids.json` 里已有 15 家的正确 ID，不要覆盖。

---

### TODO-2　牛客「裁员」词被污染

**现象**：统计裁员提及率时，滴滴 40%、拼多多 64%，明显异常。

**根因**：正则 `/裁员|优化|毕业/` 里的「优化」命中了「优化简历」「优化代码」「性能优化」等无关用法。

**修法**：
```js
if (/裁员|被裁|裁掉/.test(t)) cnt++;
// 「优化」必须带裁员语境
if (/优化.{0,6}(员工|人员|团队|hc|名额)|人员优化|组织优化/.test(t)) cnt++;
```

**影响**：牛客侧「稳定性」信号目前不可用。修好后可加入 growthScore 或独立维度。

---

### TODO-3　职友集公司级平均薪资不能对标技术岗

**现象**：美团平均 16.1K、滴滴 18.3K、京东 17K，远低于脉脉自报。

**根因**：职友集按**全部在招岗位**算均值，骑手/客服/仓储岗大量招聘拉低均值。不是数据错误，是统计口径问题。

**正确用法**：走岗位细分页 `/company/<id>/salary/j/<岗位拼音>/`。

实测携程投放岗：91.7% 拿 20-50K，按经验 1-3年 25K / 3-5年 32.5K，与同地区比 +26%。

**待做**：`rank_v3.js` 里 growthScore 的薪资部分改用岗位细分数据，或明确标注为「招聘结构指标」而非「薪酬水平」。

---

### TODO-4　在线发布仍不稳定（进程易被会话清理）

**现状**：cloudflared 免费临时隧道。已用 `publish_site.js` 分离进程解决「会话结束进程被杀」问题，但 URL 每次重启都会变，且无 uptime 保证。

**已修（两轮）**：
1. 换掉 localtunnel —— 它要求访问者输入公网 IP，浏览器只看到密码页，curl 却返回 200
2. 后台进程改用 `spawn(detached:true).unref()` —— 之前的 `run_in_background` 和 `cmd start` 都会在会话结束时被杀

**坑记录**：
- `run_in_background` 起的进程是会话子进程，会话结束即被清理
- `.cmd` 文件里写中文 REM 注释会因 GBK/UTF-8 编码冲突导致语法错误，必须纯 ASCII
- Git Bash 的 `timeout` 覆盖了 Windows 的 `timeout /t`，`.cmd` 里不能用它
- Node 24 禁止直接 `spawn('npx.cmd')`，报 EINVAL，必须经 `cmd.exe /c`

**启动/停止**：
```bash
cd F:\despseekharness\crawler
node publish_site.js        # 启动
node publish_site.js stop   # 停止
```

**待做**：
- 长期稳定走 `gh auth login` + GitHub Pages，或 cloudflared 命名隧道（需 Cloudflare 账号）
- 发布后**必须用 Playwright 真实浏览器验证**，不能只看 curl 状态码

**验证脚本模式**：
```js
const {chromium}=require('<skill>/node_modules/playwright');
const b=await chromium.launch({headless:true});
const p=await b.newPage();
const r=await p.goto(url,{waitUntil:'domcontentloaded'});
console.log(r.status(), await p.title(), await p.textContent('h1'));
```

---

### TODO-5　小红书详情覆盖率仅 2.4%

**现状**：1,995 条列表搜索，只抓了 48 篇详情。

**已确认策略**：两阶段（列表扫描 → 按标题筛选 → 详情），已写入 `sites/xiaohongshu.com.md`。

**待做**：
- 按分诊规则补抓：标题命中「携程/裁员/加班/金融」的优先，互动数 ≥1000 的次之
- 安全速率：18 篇连续 @9s 不触发；47 篇 @2.5s 直接 461
- 每批抓完检查 `RiskControlError`，触发即停

---

### TODO-6　职友集岗位细分薪资未批量采集

**现状**：`lib/sites/jobui.js` 已实现 `jobSalary(id, jobPath)`，只测过携程 3 个岗位，第 3 个就触发验证码。

**待做**：
- 岗位页也要节流，`THROTTLE.jobMs = 12000` 已设但批量脚本未使用
- 优先岗位：投放、算法、产品经理、数据分析
- 优先公司：携程（12078481）

---

## 已完成（执行完请删除对应条目）

无。上面 6 项全部未完成。
