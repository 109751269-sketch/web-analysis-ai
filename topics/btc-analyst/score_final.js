/**
 * score_final.js —— 唯一权威打分脚本
 *
 * 修正历史 bug：此前「预测命中」用目标价判定、「基准」用固定幅度判定，两者标尺不同，
 * 导致给出远目标价的账号被系统性压低。现统一为：
 *   命中 = 方向正确 且 窗口内朝该方向移动达到阈值
 *   基准 = 同一日期邻域内、同方向的相同规则命中率
 * 目标价不参与命中判定，只用于：① 关键节点命中分析 ② 点位明确度分类。
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

const CONFIGS = [
  { name: '8%/60d', th: 0.08, h: 60 },
  { name: '8%/90d', th: 0.08, h: 90 },
  { name: '15%/90d', th: 0.15, h: 90 },
  { name: '25%/120d', th: 0.25, h: 120 },
];
const MAIN = '8%/90d';

function movedEnough(dir, i, th, h) {
  const fut = px.slice(i + 1, i + 1 + h);
  if (fut.length < 20) return null;
  const e = px[i].c;
  return dir === 'up'
    ? Math.max(...fut.map(x => x.h)) / e - 1 >= th
    : 1 - Math.min(...fut.map(x => x.l)) / e >= th;
}

function baseline(i, dir, th, h) {
  let hit = 0, n = 0;
  for (let k = Math.max(0, i - 45); k <= Math.min(px.length - 1, i + 45); k++) {
    const m = movedEnough(dir, k, th, h);
    if (m === null) continue;
    n++;
    if (m) hit++;
  }
  return n ? hit / n : null;
}

const NODES = [
  { key: '2026-02 大底 6W', date: '2026-02-06', price: 60000, type: 'bottom', win: ['2026-01-01', '2026-02-15'], tol: 0.08 },
  { key: '2026-05 阶段顶 8W2', date: '2026-05-06', price: 82850, type: 'top', win: ['2026-03-15', '2026-05-15'], tol: 0.08 },
  { key: '2026-07 大底 5W7', date: '2026-07-01', price: 57800, type: 'bottom', win: ['2026-05-20', '2026-07-12'], tol: 0.08 },
  { key: '2026-10 阶段顶 8W7', date: '2026-09-21', price: 87396, type: 'top', win: ['2026-08-01', '2026-10-25'], tol: 0.08 },
];

function judgeNodes(preds) {
  return NODES.map(n => {
    const inWin = preds.filter(p => p.date >= n.win[0] && p.date <= n.win[1]);
    const dirOk = inWin.filter(p => n.type === 'bottom'
      ? (p.dir === 'up' || p.level === 'bottom')
      : (p.dir === 'down' || p.level === 'top'));
    const strong = dirOk.filter(p => {
      if (!p.target) return false;
      const ratio = p.target / n.price;
      if (Math.abs(ratio - 1) > n.tol) return false;
      return n.type === 'bottom' ? ratio >= 0.92 : ratio <= 1.08;
    });
    const weak = dirOk.filter(p => !strong.includes(p) && p.level === n.type);
    return {
      node: n.key, realDate: n.date, realPrice: n.price,
      hit: strong.length > 0, weakHit: strong.length === 0 && weak.length > 0,
      strongEvidence: strong.slice(0, 2).map(p => ({ date: p.date, target: p.target, quote: p.quote })),
      weakEvidence: weak.slice(0, 2).map(p => ({ date: p.date, quote: p.quote })),
      candidateCount: dirOk.length,
    };
  });
}

function trendFollow(preds) {
  const up = preds.filter(p => p.dir === 'up').length;
  const dn = preds.filter(p => p.dir === 'down').length;
  const variety = preds.length ? Math.min(up, dn) / preds.length : 0;
  let same = 0, n = 0;
  for (const p of preds) {
    const i = idx.get(p.date);
    if (i === undefined || i < 21) continue;
    const r = px[i].c / px[i - 21].c - 1;
    if (Math.abs(r) < 0.05) continue;
    n++;
    if (p.dir === (r > 0 ? 'up' : 'down')) same++;
  }
  if (variety < 0.2) return { rate: null, n, variety: +variety.toFixed(2), biased: true };
  return n ? { rate: +(same / n).toFixed(3), n, variety: +variety.toFixed(2), biased: false }
           : { rate: null, n: 0, variety: +variety.toFixed(2), biased: false };
}

function classify(a) {
  const total = a.total_tweets || 1;
  const c = a.cat || {};
  const preds = a.preds || [];
  const promo = (c.promo || 0) / total;
  const bothish = (c.btc_vague || 0) / Math.max(1, (c.btc_analysis || 0) + (c.btc_vague || 0));
  const withPrice = preds.filter(p => p.target).length;
  const priceShare = preds.length ? withPrice / preds.length : 0;
  if (promo > 0.3) return { code: 'E', label: '推广/喊单为主' };
  if (a.btc_tweets < 10 || preds.length < 3) return { code: 'D', label: '样本不足' };
  if (bothish > 0.5 && priceShare < 0.25) return { code: 'B', label: '模棱两可' };
  if (priceShare >= 0.4) return { code: 'A1', label: '有分析·有明确点位' };
  return { code: 'A2', label: '有分析·偏宏观无点位' };
}

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
const accounts = [...byScreen.values()].map(x => x.a);
console.log('去重后账号', accounts.length);

const results = [];
const sensRows = [];
for (const a of accounts) {
  const preds = a.preds || [];
  const cells = {};
  for (const c of CONFIGS) {
    let ex = 0, cnt = 0, wins = 0;
    for (const p of preds) {
      const i = idx.get(p.date);
      if (i === undefined) continue;
      const m = movedEnough(p.dir, i, c.th, c.h);
      if (m === null) continue;
      const b = baseline(i, p.dir, c.th, c.h);
      if (b === null) continue;
      cnt++;
      if (m) wins++;
      ex += (m ? 1 : 0) - b;
    }
    cells[c.name] = cnt ? { excess: +(ex / cnt).toFixed(3), n: cnt, rawWin: +(wins / cnt).toFixed(3) } : null;
  }
  const main = cells[MAIN];
  const nodes = judgeNodes(preds);
  const nodeHit = nodes.filter(n => n.hit).length;
  const nodeWeak = nodes.filter(n => n.weakHit).length;
  const trend = trendFollow(preds);
  const type = classify(a);

  const vals = CONFIGS.map(c => cells[c.name]?.excess).filter(v => v != null);
  let stab = 'unknown';
  if (vals.length === 4) {
    if (vals.every(v => v > 0.02)) stab = 'stable_pos';
    else if (vals.every(v => v < -0.02)) stab = 'stable_neg';
    else stab = 'unstable';
  }

  results.push({
    screen: a.screen,
    total_tweets: a.total_tweets, btc_tweets: a.btc_tweets, cat: a.cat,
    predsCount: preds.length,
    verified: main ? main.n : 0,
    rawWinRate: main ? main.rawWin : null,
    excess: main ? main.excess : null,
    cells, stab, nodes, nodeHit, nodeWeak,
    coveredNodes: nodes.filter(n => n.candidateCount > 0).length,
    trend, type,
    withPrice: preds.filter(p => p.target).length,
  });
  sensRows.push({ screen: a.screen, n: preds.length, cells });
}

for (const r of results) {
  let s = 0, parts = [];
  if (r.trend.rate != null && r.trend.n >= 8 && r.trend.rate >= 0.72) {
    r.score = -2; r.band = '负分档'; r.reason = `追涨杀跌 ${(r.trend.rate * 100).toFixed(0)}%（${r.trend.n}次）`;
    continue;
  }
  if (r.verified < 5) { r.score = 0; r.band = '样本不足'; r.reason = `可验证 ${r.verified} 条`; continue; }
  const ex = r.excess ?? 0;
  s += Math.round(ex * 20); parts.push(`超额 ${(ex * 100).toFixed(0)}pt`);
  s += r.nodeHit * 2 + r.nodeWeak * 1;
  if (r.nodeHit) parts.push(`节点${r.nodeHit}/4`);
  if (r.predsCount && r.withPrice / r.predsCount >= 0.4) { s += 1; parts.push('点位明确'); }
  if (r.trend.rate != null && r.trend.n >= 8 && r.trend.rate >= 0.6) { s -= 1; parts.push('趋势跟随-1'); }
  s = Math.max(-3, Math.min(10, s));
  r.score = s;
  r.band = s >= 7 ? 'S' : s >= 5 ? 'A' : s >= 3 ? 'B' : s >= 1 ? 'C' : s >= 0 ? 'D' : '负分';
  r.reason = parts.join('；');
}

results.sort((a, b) => b.score - a.score || (b.excess ?? -9) - (a.excess ?? -9) || b.predsCount - a.predsCount);
fs.writeFileSync(path.join(ROOT, 'final_v3.json'), JSON.stringify(results, null, 1));
fs.writeFileSync(path.join(ROOT, 'sensitivity.json'), JSON.stringify(sensRows, null, 1));

const pos = results.filter(r => r.stab === 'stable_pos');
const neg = results.filter(r => r.stab === 'stable_neg');
console.log('\n稳健正:', pos.map(x => `${x.screen}(${Object.values(x.cells).map(c => c ? (c.excess * 100).toFixed(0) : '-').join('/')})`).join(', ') || '无');
console.log('稳健负:', neg.length, '个:', neg.map(x => x.screen).join(', '));
console.log('不稳定:', results.filter(r => r.stab === 'unstable').length, '个');
console.log('样本不足/未知:', results.filter(r => r.stab === 'unknown').length, '个');
