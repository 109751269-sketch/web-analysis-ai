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
    scroll: Object.assign({ rounds: 5, delayMinMs: 1200, delayMaxMs: 2500, maxIdleRounds: 6 }, t.scroll || {}),
    pagination: Object.assign({ enabled: false, maxPages: 10, waitMs: 2000 }, t.pagination || {}),
    extract: Object.assign({ module: '', fields: [], limit: 500 }, t.extract || {}),
    // extract.pages: [{name, tabs, limit, module, fields}]  多组采集（每组独立 tab + 条数）
    // extract.detail: {enabled, maxItems, selectors, waitMs, field}  职位详情补充
    login: Object.assign({ successIndicators: [], pageIndicators: [] }, t.login || {}),
    userAgent: t.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    pageLoadTimeout: t.pageLoadTimeout || 40000,
    verifyWaitTimeout: t.verifyWaitTimeout || 600000,
    outputDir: t.outputDir || ''
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
