const fs = require('fs');
const path = require('path');

const { resolveRoot, resolveDataRoot } = require('./paths');
const ROOT = resolveRoot();
const DATA = resolveDataRoot();
const px = JSON.parse(fs.readFileSync(path.join(DATA, 'btc_daily.json'), 'utf8'))
  .filter(r => r.t >= '2026-01-01');
const idx = new Map(px.map((r, i) => [r.t, i]));

function fmt(v) { return v === null || v === undefined ? '-' : Math.round(v).toLocaleString('en-US'); }

function trace(p) {
  const i = idx.get(p.date);
  if (i === undefined) return null;
  const entry = px[i].c;
  const after = (d) => (i + d < px.length ? px[i + d].c : null);
  const fut = px.slice(i + 1, i + 1 + 90);
  const hi = fut.length ? Math.max(...fut.map(x => x.h)) : null;
  const lo = fut.length ? Math.min(...fut.map(x => x.l)) : null;
  const hiDate = fut.length ? fut.find(x => x.h === hi).t : null;
  const loDate = fut.length ? fut.find(x => x.l === lo).t : null;

  let hit = null, hitDate = null;
  if (p.dir === 'up' && p.target) {
    const f = fut.find(x => x.h >= p.target * 0.995);
    hit = !!f; hitDate = f ? f.t : null;
  } else if (p.dir === 'down' && p.target) {
    const f = fut.find(x => x.l <= p.target * 1.005);
    hit = !!f; hitDate = f ? f.t : null;
  } else {
    const end = after(90);
    if (end !== null) hit = p.dir === 'up' ? (end / entry - 1) >= 0.08 : (end / entry - 1) <= -0.08;
  }

  return {
    date: p.date, dir: p.dir, target: p.target, level: p.level, quote: p.quote,
    entry: Math.round(entry),
    ret1m: after(30) !== null ? +(after(30) / entry - 1).toFixed(3) : null,
    ret2m: after(60) !== null ? +(after(60) / entry - 1).toFixed(3) : null,
    ret3m: after(90) !== null ? +(after(90) / entry - 1).toFixed(3) : null,
    futureHigh: hi ? Math.round(hi) : null, futureHighDate: hiDate,
    futureLow: lo ? Math.round(lo) : null, futureLowDate: loDate,
    hit, hitDate,
  };
}

const PREDS = path.join(ROOT, 'preds');
// 按账号去重：重抽批次 batchB* 优先，其次 preds 多者优先
const byScreen = new Map();
for (const f of fs.readdirSync(PREDS).filter(x => x.endsWith('.json')).sort()) {
  const j = JSON.parse(fs.readFileSync(path.join(PREDS, f), 'utf8'));
  const isRedo = /^batchB/.test(f);
  for (const a of j.accounts || []) {
    const prev = byScreen.get(a.screen);
    if (!prev) { byScreen.set(a.screen, { a, isRedo }); continue; }
    const pp = (prev.a.preds || []).length;
    const cp = (a.preds || []).length;
    if (isRedo && !prev.isRedo) byScreen.set(a.screen, { a, isRedo });
    else if (isRedo === prev.isRedo && cp > pp) byScreen.set(a.screen, { a, isRedo });
  }
}
const accounts = [...byScreen.values()].map(x => x.a);

const finals = JSON.parse(fs.readFileSync(path.join(ROOT, 'final_v3.json'), 'utf8'));
const rank = new Map(finals.map((r, i) => [r.screen, i + 1]));
const scoreOf = new Map(finals.map(r => [r.screen, r]));

const out = [];
for (const a of accounts) {
  const rows = (a.preds || []).map(trace).filter(Boolean);
  if (!rows.length) continue;
  const s = scoreOf.get(a.screen) || {};
  out.push({
    screen: a.screen,
    rank: rank.get(a.screen) || 999,
    band: s.band, score: s.score, winRate: s.rawWinRate ?? null,
    verdict: a.verdict, nodeHit: s.nodeHit, nodeWeak: s.nodeWeak,
    type: s.type ? s.type.label : '',
    rows,
  });
}
out.sort((x, y) => x.rank - y.rank);
fs.writeFileSync(path.join(ROOT, 'ledger.json'), JSON.stringify(out, null, 1));

for (const a of out.slice(0, 12)) {
  console.log('\n' + '='.repeat(80));
  console.log(`#${a.rank} @${a.screen}  [${a.band}${a.score}]  胜率=${a.winRate === null ? '-' : (a.winRate * 100).toFixed(0) + '%'}  预测${a.rows.length}条  节点${a.nodeHit}/4+${a.nodeWeak || 0}  ${a.type}`);
  console.log('='.repeat(80));
  for (const r of a.rows) {
    const dirTxt = r.dir === 'up' ? '看涨' : '看跌';
    const tgt = r.target ? `目标 ${fmt(r.target)}` : '无目标价';
    const outcome = r.hit === null ? '待观察' : r.hit ? `兑现${r.hitDate ? '(' + r.hitDate + ')' : ''}` : '未兑现';
    const moves = [
      r.ret1m !== null ? `1月${(r.ret1m * 100).toFixed(0)}%` : null,
      r.ret2m !== null ? `2月${(r.ret2m * 100).toFixed(0)}%` : null,
      r.ret3m !== null ? `3月${(r.ret3m * 100).toFixed(0)}%` : null,
    ].filter(Boolean).join(' ');
    console.log(`\n  ${r.date} 现价${fmt(r.entry)} → ${dirTxt} ${tgt}  [${outcome}]`);
    console.log(`     后续: ${moves || '-'}  区间 最高${fmt(r.futureHigh)}(${r.futureHighDate}) 最低${fmt(r.futureLow)}(${r.futureLowDate})`);
    console.log(`     原文: ${r.quote.slice(0, 100)}`);
  }
}
