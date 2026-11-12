/**
 * sim_trade.js —— 模拟操作 + 模糊正确判定
 *
 * 用户要求：抄底略早、短期还跌但跌幅有限（≤8%）、随后 N 周内筑底回升，也算预测正确。
 *
 * 规则：
 *   做多（dir=up 或 level=bottom）：入场价 = 当天收盘
 *     - 观察窗 H 天（默认 120）
 *     - 最大不利偏移 MAE = 最低价/入场 - 1
 *     - 最大有利偏移 MFE = 最高价/入场 - 1
 *     - 模糊正确 = MAE >= -TOL 且 MFE >= +GAIN
 *     - 收益 = 持有到「触及目标 / 或持有到期」的收益率
 *   做空（dir=down 或 level=top）反向。
 *
 * 同时输出：
 *   - 严格收益（固定持有 90 天）
 *   - 模拟交易收益（触目标止盈，否则 120 天平仓）
 *   - 模糊正确率
 */
const fs = require('fs');
const path = require('path');
const { resolveRoot, resolveDataRoot } = require('./paths');
const ROOT = resolveRoot();
const DATA = resolveDataRoot();
const PREDS = path.join(ROOT, 'preds');

const px = JSON.parse(fs.readFileSync(path.join(DATA, 'btc_daily.json'), 'utf8'))
  .filter(r => r.t >= '2026-01-01');
const idx = new Map(px.map((r, i) => [r.t, i]));

const TOL = 0.08;      // 允许的最大不利偏移（8%）
const GAIN = 0.05;     // 证明"看对"所需的最小有利偏移（5%）
const HOLD = 120;      // 最长持有天数

function simulate(p) {
  const i = idx.get(p.date);
  if (i === undefined) return null;
  const entry = px[i].c;
  const fut = px.slice(i + 1, i + 1 + HOLD);
  if (fut.length < 20) return null;

  const isLong = p.dir === 'up';
  const hi = Math.max(...fut.map(x => x.h));
  const lo = Math.min(...fut.map(x => x.l));

  // 最大不利 / 有利偏移
  const mae = isLong ? lo / entry - 1 : 1 - hi / entry;   // 负数表示亏损
  const mfe = isLong ? hi / entry - 1 : 1 - lo / entry;   // 正数表示浮盈

  // 模糊正确：回撤可控 且 最终有过明确浮盈
  const fuzzyHit = mae >= -TOL && mfe >= GAIN;

  // 模拟交易：有目标价则触目标止盈，否则持有到期
  // 模拟交易：先看止损，再看止盈，最后到期平仓（按日推进，先触谁算谁）
  const SL = 0.10;  // 止损 -10%
  let exitRet = null, exitDay = null, exitReason = '';
  for (let k = 0; k < fut.length; k++) {
    const b = fut[k];
    if (isLong) {
      if (b.l / entry - 1 <= -SL) { exitRet = -SL; exitDay = k + 1; exitReason = 'stoploss'; break; }
      if (p.target && b.h >= p.target) { exitRet = p.target / entry - 1; exitDay = k + 1; exitReason = 'target'; break; }
    } else {
      if (1 - b.h / entry <= -SL) { exitRet = -SL; exitDay = k + 1; exitReason = 'stoploss'; break; }
      if (p.target && b.l <= p.target) { exitRet = 1 - p.target / entry; exitDay = k + 1; exitReason = 'target'; break; }
    }
  }
  if (exitRet === null) {
    exitRet = isLong ? fut[fut.length-1].c/entry - 1 : 1 - fut[fut.length-1].c/entry;
    exitDay = fut.length; exitReason = 'hold';
  }

  // 严格判定（旧口径，仅作对比）
  const strictHit = isLong ? mfe >= 0.10 : mfe >= 0.10;

  return {
    date: p.date, dir: p.dir, target: p.target, level: p.level, quote: p.quote,
    entry: Math.round(entry),
    mae: +mae.toFixed(3), mfe: +mfe.toFixed(3),
    fuzzyHit, strictHit,
    exitRet: +exitRet.toFixed(3), exitDay, exitReason,
    hi: Math.round(hi), lo: Math.round(lo),
  };
}

// 载入（去重）
const byScreen = new Map();
for (const f of fs.readdirSync(PREDS).filter(x => x.endsWith('.json')).sort()) {
  const isRedo = /^batchB/.test(f);
  for (const a of JSON.parse(fs.readFileSync(path.join(PREDS, f), 'utf8')).accounts || []) {
    const prev = byScreen.get(a.screen);
    if (!prev) { byScreen.set(a.screen, { a, isRedo }); continue; }
    const pp = (prev.a.preds || []).length, cp = (a.preds || []).length;
    if (isRedo && !prev.isRedo) byScreen.set(a.screen, { a, isRedo });
    else if (isRedo === prev.isRedo && cp > pp) byScreen.set(a.screen, { a, isRedo });
  }
}

const results = [];
for (const { a } of byScreen.values()) {
  const trades = (a.preds || []).map(simulate).filter(Boolean);
  if (!trades.length) {
    results.push({
      screen: a.screen, n: 0, nTrades: 0,
      fuzzyRate: null, avgRet: null, winRate: null, totalRet: null,
      maxDD: null, details: [],
    });
    continue;
  }
  const fuzzyWins = trades.filter(t => t.fuzzyHit).length;
  const rets = trades.map(t => t.exitRet);
  const avgRet = rets.reduce((x, y) => x + y, 0) / rets.length;
  const winTrades = rets.filter(r => r > 0).length;
  // 复利总收益（等权分配，每笔独立资金）
  const totalRet = avgRet;
  const sorted = rets.slice().sort((x,y)=>x-y);
  const medianRet = sorted[Math.floor(sorted.length/2)];
  const stopRate = trades.filter(t => t.exitReason === 'stoploss').length / trades.length;
  const maxDD = Math.min(...trades.map(t => t.mae));

  results.push({
    screen: a.screen,
    n: (a.preds || []).length,
    nTrades: trades.length,
    fuzzyRate: +(fuzzyWins / trades.length).toFixed(3),
    avgRet: +avgRet.toFixed(3),
    winRate: +(winTrades / trades.length).toFixed(3),
    totalRet: +totalRet.toFixed(3),
    medianRet: +medianRet.toFixed(3),
    stopRate: +stopRate.toFixed(3),
    maxDD: +maxDD.toFixed(3),
    details: trades,
  });
}

// 只对交易数 >=5 的排版
const rankable = results.filter(r => r.nTrades >= 5)
  .sort((a, b) => (b.medianRet ?? -9) - (a.medianRet ?? -9));

results.sort((a, b) => b.avgRet - a.avgRet);
fs.writeFileSync(path.join(ROOT, 'sim_results.json'), JSON.stringify(results, null, 1));

console.log(`交易数>=5 的账号: ${rankable.length}\n`);
console.log('账号'.padEnd(18) + '笔数  中位收益  均收益  胜率   止损率  模糊正确');
console.log('-'.repeat(76));
for (const r of rankable) {
  console.log(
    r.screen.padEnd(18) +
    String(r.nTrades).padStart(4) +
    ((r.medianRet * 100).toFixed(1) + '%').padStart(10) +
    ((r.avgRet * 100).toFixed(1) + '%').padStart(9) +
    ((r.winRate * 100).toFixed(0) + '%').padStart(7) +
    ((r.stopRate * 100).toFixed(0) + '%').padStart(8) +
    ((r.fuzzyRate * 100).toFixed(0) + '%').padStart(10)
  );
}

// 基准：全年买入持有
const y0 = px[0].c, y1 = px[px.length - 1].c;
console.log(`\n基准：2026 全年买入持有 = ${((y1 / y0 - 1) * 100).toFixed(1)}%`);
