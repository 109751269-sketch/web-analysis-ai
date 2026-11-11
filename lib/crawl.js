/**
 * crawl.js - 网页抓取（CLI，引擎唯一入口）
 * 用法: node lib/crawl.js --task=tasks/demo.json [--url=...] [--module=...] [--tabs=a,b] [--rounds=5] [--cookies=...] [--headless=true]
 *
 * 任务加载/规范化（原 lib/task.js，仅此入口使用，已合并）：
 *   loadTask(taskFile)    读取并规范化任务 JSON
 *   normalizeTask(raw)    纯对象规范化（无文件）
 */
'use strict';

const path = require('path');
const { readJson, parseArgs } = require('./util');
const { runCrawl } = require('./pipeline');

// ---------- 任务加载与规范化（原 lib/task.js） ----------

// 任务文件（tasks/*.json）字段：
// {
//   "name": "任务名（目录名）",
//   "title": "报告标题",
//   "url": "目标网址",
//   "authFile": "会话文件路径（storageState 或 Cookie-Editor JSON）",
//   "cookiesText": "或直接粘贴 Cookie-Editor 导出的 JSON 文本",
//   "headless": true,
//   "tabs": [{"name": "tab 名称", "waitMs": 1500}],
//   "scroll": {"rounds": 5, "delayMinMs": 1200, "delayMaxMs": 2500, "maxIdleRounds": 6},
//   "extract": {
//     "module": "模块关键词（页面中要分析的模块）",
//     "fields": [{"name": "字段名", "patterns": ["匹配词1", "class名"]}],
//     "limit": 500
//   },
//   "login": {"successIndicators": [...], "pageIndicators": [...]}
// }
// 搜索类 URL 判定：这类页面受「搜索频率」风控（≤1次/30min、≤4次/24h），
// 必须保持保守慢参，禁止套用提速默认（用户 2026-09-11 明确红线）
function isSearchUrl(u) {
  return /search_center/i.test(String(u || ''));
}

function normalizeTask(raw, taskFile) {
  const t = raw || {};
  const name = t.name || (taskFile ? path.basename(taskFile, '.json') : 'task');
  const baseDir = taskFile ? path.dirname(path.resolve(taskFile)) : process.cwd();

  return {
    name,
    title: t.title || name,
    url: t.url || '',
    authFile: t.authFile ? path.resolve(baseDir, t.authFile) : '',
    cookiesText: t.cookiesText || '',
    headless: t.headless !== false,
    tabs: Array.isArray(t.tabs) ? t.tabs : (t.tabs ? [t.tabs] : []),
    // 2026-09-12 提速（用户硬性要求，机器层默认）：话题页/频道页一律快参；
    // 搜索类（search_center）仍走保守慢参——搜索风控看的是频率与行为，不提速（见 Phase 2.6/2.7）。
    scroll: isSearchUrl(t.url)
      ? Object.assign({ rounds: 60, delayMinMs: 1200, delayMaxMs: 2500, maxIdleRounds: 8, adaptive: false }, t.scroll || {})
      : Object.assign({ rounds: 800, delayMinMs: 300, delayMaxMs: 1200, maxIdleRounds: 12, adaptive: true }, t.scroll || {}),
    pagination: Object.assign({ enabled: false, maxPages: 10, waitMs: 2000 }, t.pagination || {}),
    extract: Object.assign({ module: '', fields: [], limit: 500 }, t.extract || {}),
    // extract.pages: [{name, tabs, limit, module, fields}]  多组采集（每组独立 tab + 条数）
    // extract.detail: {enabled, maxItems, selectors, waitMs, field}  职位详情补充
    login: Object.assign({ successIndicators: [], pageIndicators: [] }, t.login || {}),
    userAgent: t.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    pageLoadTimeout: t.pageLoadTimeout || 40000,
    verifyWaitTimeout: t.verifyWaitTimeout || 600000,
    // 2026-10-25 加：页面稳定判定的正文长度阈值（默认 120，与旧行为一致）。
    // 注意 normalizeTask 是白名单式返回，**不在这里显式透传的顶层键会被丢弃**
    // —— 这类"任务 JSON 里配了但引擎收不到"的坑，本轮已出现两次（另一次是 extOpts）。
    minBodyChars: t.minBodyChars != null ? Number(t.minBodyChars) : 120,
    // 2026-10-25 修复（A1）：记录「用户是否显式提供」而非只看值。
    // 原因：上面 headless 恒为布尔、verifyWaitTimeout 恒为 600000、login.successIndicators 恒为 []，
    // 导致 playbook.js 里 `task.headless == null` / `!task.verifyWaitTimeout` / `!task.login.successIndicators`
    // 三个条件恒为假 → 站点攻略的 antiBot.* / login 永远注入不进去（maimai 攻略的 headless:false 成了死配置）。
    _explicit: {
      headless: t.headless !== undefined,
      verifyWaitTimeout: t.verifyWaitTimeout != null,
      loginIndicators: !!(t.login && (
        (t.login.successIndicators && t.login.successIndicators.length) ||
        (t.login.pageIndicators && t.login.pageIndicators.length)))
    },
    outputDir: t.outputDir || '',
    // 模式 A（CDP 挂载主 Chrome）/ 自定义 profile 目录 —— 必须透传，否则 pipeline 拿不到
    cdpUrl: t.cdpUrl || '',
    profileDir: t.profileDir || ''
  };
}

function loadTask(taskFile) {
  const raw = readJson(taskFile);
  if (!raw) throw new Error('任务文件解析失败: ' + taskFile);
  return normalizeTask(raw, taskFile);
}

// ---------- CLI 入口 ----------
async function main() {
  const args = parseArgs();
  const taskFile = args.task ? path.resolve(args.task) : null;
  const task = taskFile ? loadTask(taskFile) : normalizeTask({});

  if (args.url) task.url = args.url;
  if (args.module) task.extract.module = args.module;
  if (args.tabs) task.tabs = String(args.tabs).split(',').filter(Boolean).map(n => ({ name: n }));
  if (args.rounds) task.scroll.rounds = parseInt(args.rounds, 10) || 5;
  if (args.limit) task.extract.limit = parseInt(args.limit, 10) || 100;
  if (args.pagination) task.pagination.enabled = args.pagination === 'true' || args.pagination === '1';
  if (args.pages) task.pagination.maxPages = parseInt(args.pages, 10) || 10;
  if (args.headless) task.headless = args.headless === 'true';
  if (args.cookies) task.authFile = path.resolve(args.cookies);
  if (args.out) task.outputDir = args.out;

  if (!task.url) {
    console.error('✗ 缺少目标网址：使用 --task=tasks/xxx.json 或 --url=https://...');
    process.exit(1);
  }

  await runCrawl(task);
  console.log('完成。数据已保存至 output/<任务名>/data.json（分析由 agent 读取数据后进行）');
}

main().catch(e => { console.error('✗ 抓取失败: ' + e.message); process.exit(1); });
