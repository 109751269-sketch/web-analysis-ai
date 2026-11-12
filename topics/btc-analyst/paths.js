/**
 * paths.js —— 统一数据目录解析
 *
 * 目录约定：
 *   data/btc_daily.json        共享行情（跨期复用，不按日期归档）
 *   data/<YYYY-MM-DD>/         每次运行的数据（preds / frozen / 各类结果 json）
 *
 * 解析优先级：
 *   1. 命令行参数   node xxx.js <runDir>
 *   2. 环境变量     BTC_RUN=<runDir>  或  BTC_ROOT=<data根>
 *   3. 自动探测     data/ 下最新的日期目录
 *
 * 数据默认外置在工作区（技能仓库只存代码/文档，不存 1.6MB 数据）：
 *   BTC_DATA_DIR 环境变量 > F:\despseekharness\crawler\topics-data\btc-analyst > 本目录 data/
 */
const path = require('path');
const fs = require('fs');

const EXTERNAL_DATA = 'F:\\despseekharness\\crawler\\topics-data\\btc-analyst';
const DATA_ROOT = (() => {
  if (process.env.BTC_DATA_DIR && fs.existsSync(process.env.BTC_DATA_DIR)) return path.resolve(process.env.BTC_DATA_DIR);
  if (fs.existsSync(EXTERNAL_DATA)) return EXTERNAL_DATA;
  return path.join(__dirname, 'data');
})();

/** 列出 data/ 下的日期目录，按名称倒序（最新在前） */
function listRunDirs() {
  if (!fs.existsSync(DATA_ROOT)) return [];
  return fs.readdirSync(DATA_ROOT, { withFileTypes: true })
    .filter(d => d.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(d.name))
    .map(d => d.name)
    .sort()
    .reverse();
}

/** 本次运行的目录（含 preds / frozen / 结果 json） */
function resolveRun() {
  const arg = process.argv[2];
  if (arg && fs.existsSync(arg)) return path.resolve(arg);
  if (process.env.BTC_RUN && fs.existsSync(process.env.BTC_RUN)) return path.resolve(process.env.BTC_RUN);

  // BTC_ROOT 兼容旧行为：若指向的目录里直接有 preds/，当作运行目录
  if (process.env.BTC_ROOT && fs.existsSync(process.env.BTC_ROOT)) {
    const r = path.resolve(process.env.BTC_ROOT);
    if (fs.existsSync(path.join(r, 'preds'))) return r;
  }

  const runs = listRunDirs();
  if (!runs.length) {
    throw new Error(`data/ 下没有日期目录（形如 2026-11-11）。请先建一个并放入 preds/、frozen/。`);
  }
  return path.join(DATA_ROOT, runs[0]);
}

/** 共享数据根（btc_daily.json 所在处） */
function resolveDataRoot() {
  if (process.env.BTC_DATA && fs.existsSync(process.env.BTC_DATA)) return path.resolve(process.env.BTC_DATA);
  return DATA_ROOT;
}

/** 兼容旧调用：只返回运行目录 */
const resolveRoot = resolveRun;

module.exports = { resolveRun, resolveDataRoot, resolveRoot, listRunDirs, DATA_ROOT };
