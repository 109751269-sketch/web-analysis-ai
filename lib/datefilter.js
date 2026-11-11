// 日期窗口 / 断点续抓（2026-09-10 新增，用户要求）
// 能力：① 从条目文本解析中文/绝对日期 ② 按 [since, until] 过滤 ③ 覆盖度统计（供增量续抓定位）
const fs = require('fs');
const path = require('path');

function pad(n) { return n < 10 ? '0' + n : '' + n; }
function ymd(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }

// 解析单条日期文本 → Date；失败返回 null
function parseDateText(raw, now) {
  if (!raw) return null;
  const t = String(raw).trim();
  const N = now || new Date();
  // 绝对日期 2026-09-03 / 2026-09-03 11:50:14
  let m = t.match(/(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  // MM-DD（无年份：>当前月+1 视为去年）；排除「1-3年」「2-5个月」这类年限/月限区间
  m = t.match(/(?:^|[^\d])(\d{1,2})-(\d{1,2})(?![年个月周天日])(?=[^\d]|$)/);
  if (m) {
    const mo = +m[1], da = +m[2];
    if (mo >= 1 && mo <= 12 && da >= 1 && da <= 31) {
      let y = N.getFullYear();
      if (mo > N.getMonth() + 1) y -= 1;
      return new Date(y, mo - 1, da);
    }
  }
  if (/刚刚|刚才|秒前/.test(t)) return new Date(N.getTime());
  m = t.match(/(\d+)\s*分钟前/); if (m) return new Date(N.getTime() - (+m[1]) * 60000);
  m = t.match(/(\d+)\s*小时(?:前|内)/); if (m) return new Date(N.getTime() - (+m[1]) * 3600000);
  if (/今天/.test(t)) return new Date(N.getFullYear(), N.getMonth(), N.getDate());
  if (/昨天/.test(t)) return new Date(N.getTime() - 86400000);
  if (/前天/.test(t)) return new Date(N.getTime() - 2 * 86400000);
  m = t.match(/(\d+)\s*天前/); if (m) return new Date(N.getTime() - (+m[1]) * 86400000);
  m = t.match(/(\d+)\s*(?:周|星期)前/); if (m) return new Date(N.getTime() - (+m[1]) * 7 * 86400000);
  m = t.match(/(\d+)\s*个?月前/); if (m) { const d = new Date(N); d.setMonth(d.getMonth() - (+m[1])); return d; }
  m = t.match(/(\d+)\s*年前/); if (m) { const d = new Date(N); d.setFullYear(d.getFullYear() - (+m[1])); return d; }
  return null;
}

// 从条目取日期：优先 record['时间']，其次 _text 前缀
function dateOf(rec, field) {
  if (!rec) return null;
  const f = field || '时间';
  if (rec[f]) { const d = parseDateText(rec[f]); if (d) return d; }
  const head = String(rec._text || '').slice(0, 120);
  const m = head.match(/(\d{4}-\d{2}-\d{2}[ T]\d{1,2}:\d{2}(?::\d{2})?|\d{1,2}-\d{1,2}(?=[·\s])|刚刚|\d+\s*分钟内|\d+\s*分钟前|\d+\s*小时(?:前|内)|\d+\s*天前|\d+\s*周前|昨天|前天|今天)/);
  return m ? parseDateText(m[1]) : null;
}

function inRange(d, since, until) {
  if (!d) return true; // 日期不可解析 → 保守保留
  if (since && d < since) return false;
  if (until && d > until) return false;
  return true;
}

// 过滤：范围 + 断点（早于 stopBefore 的一律丢弃）
function filterRecords(records, opts) {
  const { field, since, until, stopBefore } = opts || {};
  const kept = [], dropped = { beforeSince: 0, afterUntil: 0, beforeStop: 0 };
  for (const r of records) {
    const d = dateOf(r, field);
    if (stopBefore && d && d < stopBefore) { dropped.beforeStop++; continue; }
    if (since && d && d < since) { dropped.beforeSince++; continue; }
    if (until && d && d > until) { dropped.afterUntil++; continue; }
    kept.push(r);
  }
  return { kept, dropped };
}

// 覆盖度：按天直方图 + 最早/最晚
function coverage(records, field) {
  const days = {};
  let min = null, max = null, undated = 0;
  for (const r of records) {
    const d = dateOf(r, field);
    if (!d) { undated++; continue; }
    const k = ymd(d);
    days[k] = (days[k] || 0) + 1;
    if (!min || d < min) min = d;
    if (!max || d > max) max = d;
  }
  return { min: min ? ymd(min) : null, max: max ? ymd(max) : null, undated, days };
}

// 读写覆盖台账（跨轮累积，供下次断点续抓）
function coveragePath(outDir) { return path.join(outDir, 'coverage.json'); }
function readCoverage(outDir) {
  try { return JSON.parse(fs.readFileSync(coveragePath(outDir), 'utf8')); } catch (e) { return null; }
}
function mergeCoverage(outDir, cov, meta) {
  const prev = readCoverage(outDir) || { days: {}, runs: [] };
  for (const [k, v] of Object.entries(cov.days || {})) prev.days[k] = (prev.days[k] || 0) + v;
  const dates = Object.keys(prev.days).sort();
  prev.min = dates[0] || null;
  prev.max = dates[dates.length - 1] || null;
  prev.runs = (prev.runs || []).concat([Object.assign({ at: new Date().toISOString() }, meta || {})]).slice(-20);
  prev.updated = new Date().toISOString();
  fs.writeFileSync(coveragePath(outDir), JSON.stringify(prev, null, 1));
  return prev;
}

function parseDay(s) {
  if (!s) return null;
  const m = String(s).match(/(\d{4})-(\d{2})-(\d{2})/);
  return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
}

module.exports = { parseDateText, dateOf, inRange, filterRecords, coverage, readCoverage, mergeCoverage, coveragePath, ymd, parseDay };
