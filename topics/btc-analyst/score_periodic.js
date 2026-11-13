// 02 专题「周期快照」评分器（2026-11-13 新增）
//
// 设计前提（用户 2026-11-13 定的口径）：
//   1. 大周期（两三个月的顶底/趋势）准度权重最高，短期命中率只是辅助；
//   2. 日报类数据不能直接换来能力分：必须累计到「可结算 + 样本达标」才出榜；
//   3. 证据不足的账号不排名，只标「样本不足」，不允许用 1~2 条预测封神。
//
// 输入：
//   output/x_btc_2026/preds/*.json   历史全量预测（LLM 逐条精读，含 horizon）
//   state/calls_ledger.json          每日观点承诺台账（增量，按 settlement 到期）
// 输出：
//   output/scorecard/scorecard_<asof>.json
//   output/scorecard/scorecard_<asof>.md
//
// 用法：
//   node score_periodic.js                        # asof=今天，滚动 365 天
//   node score_periodic.js --asof=2026-11-30 --window=365 --min-n=8
//   node score_periodic.js --asof=2026-11-30 --reasons   # 打印每个账号的入榜/落榜原因
const fs = require('fs');
const path = require('path');

// 路径可通过环境变量覆盖，便于在技能仓库中复用
const CRAWLER = process.env.BTC_CRAWLER_ROOT || 'F:/despseekharness/crawler';
const ROOT = process.env.BTC_PREDS_ROOT || path.join(CRAWLER, 'output/x_btc_2026');
const LEDGER = process.env.BTC_LEDGER || path.join(CRAWLER, 'state/calls_ledger.json');
const OUTDIR = process.env.BTC_SCORECARD_DIR || path.join(CRAWLER, 'output/scorecard');
const CFG_PATH = process.env.BTC_SCORING_CONFIG || (fs.existsSync(path.join(__dirname, 'scoring.config.json')) ? path.join(__dirname, 'scoring.config.json') : path.join(CRAWLER, 'scoring.config.json'));

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  return m ? [m[1], m[2] === undefined ? true : m[2]] : [a, true];
}));
const ASOF = args.asof || new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
const WINDOW = +(args.window || 365);
const CFG = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
const g = CFG.gate || {};
const MIN_N = +(args.minN || args['min-n'] || g.minSettledCycle || 8);
const OBS_MIN = +(args.obsMin || args['obs-min'] || g.observeMinSettled || 3);   // 观察榜门槛（样本不足但可看趋势）

// ---------- 行情：全年日线 + 今日最新 ----------
const px = JSON.parse(fs.readFileSync(path.join(ROOT, 'btc_daily.json'), 'utf8'))
  .filter(r => r.t >= '2026-01-01')
  .map(r => ({ t: String(r.t).slice(0, 10), h: r.h, l: r.l, c: r.c }));
for (const f of ['output/x_btc_20261112/market.json', 'output/x_btc_20261113/market_1113_v2.json']) {
  const p = path.join(CRAWLER, f);
  if (!fs.existsSync(p)) continue;
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  for (const d of (j.daily || [])) {
    const t = String(d.t).slice(0, 10);
    if (!px.some(r => r.t === t)) px.push({ t, h: d.h, l: d.l, c: d.c });
  }
}
px.sort((a, b) => a.t.localeCompare(b.t));
const idx = new Map(px.map((r, i) => [r.t, i]));
const pxAsOf = px.filter(r => r.t <= ASOF);            // 只用 asof 之前的行情，避免偷看未来
console.log(`行情 ${px[0].t} ~ ${px[px.length - 1].t}；asof=${ASOF} 可用 ${pxAsOf.length} 根`);

// ---------- 历史预测（去重口径与 score_final.js 一致） ----------
const byScreen = new Map();
const PREDS = path.join(ROOT, 'preds');
for (const f of fs.readdirSync(PREDS).filter(x => x.endsWith('.json')).sort()) {
  const isRedo = /^batchB/.test(f);
  for (const a of (JSON.parse(fs.readFileSync(path.join(PREDS, f), 'utf8')).accounts || [])) {
    const prev = byScreen.get(a.screen);
    if (!prev) { byScreen.set(a.screen, { a, isRedo }); continue; }
    const pp = (prev.a.preds || []).length, cp = (a.preds || []).length;
    if (isRedo && !prev.isRedo) byScreen.set(a.screen, { a, isRedo });
    else if (isRedo === prev.isRedo && cp > pp) byScreen.set(a.screen, { a, isRedo });
  }
}

const predsBy = new Map();       // screen -> [{date,dir,horizon,target,level,quote,src}]
for (const { a } of byScreen.values()) predsBy.set(a.screen, (a.preds || []).map(p => ({ ...p, src: 'year' })));

// ---------- 增量：观点承诺台账 → 预测记录 ----------
// 台账按「可机械判定」写，这里换算成方向 + 周期：settleBy - date 决定 horizon 档
if (fs.existsSync(LEDGER)) {
  const L = JSON.parse(fs.readFileSync(LEDGER, 'utf8'));
  const DIR = { down: 'down', up: 'up', bottom: 'up', reject: 'down' };
  let added = 0;
  for (const c of (L.calls || [])) {
    const start = c.startDate || c.date;
    if (!start) continue;
    const days = c.settleBy ? Math.round((Date.parse(c.settleBy) - Date.parse(start)) / 86400000) : 30;
    const horizon = days <= 14 ? 'weeks' : days <= 60 ? 'months' : 'quarters';
    const list = predsBy.get(c.screen) || [];
    if (list.some(p => p.date === start && (p.quote || '').slice(0, 24) === (c.claim || '').slice(0, 24))) continue;
    list.push({ date: start, dir: DIR[c.type] || 'down', horizon, level: c.level || null, quote: c.claim || '', src: 'ledger', claimId: c.id });
    predsBy.set(c.screen, list);
    added++;
  }
  console.log(`台账并入 ${added} 条（台账共 ${(L.calls || []).length} 条）`);
}

// ---------- 结算 ----------
const HDAYS = (CFG.judge && CFG.judge.horizonDays) || { months: 60, quarters: 90 };
const H_OF = h => HDAYS[h] || HDAYS.months || 60;
const TH = (CFG.judge && CFG.judge.directionThreshold) || 0.10;
const SHORT_TOUCH = (CFG.judge && CFG.judge.short && CFG.judge.short.touchThreshold) || 0.08;

function cycleHit(p) {
  const H = H_OF(p.horizon);
  const i = idx.get(p.date);
  if (i === undefined) return null;
  if (i + H >= pxAsOf.length) return { pending: true, H };
  const e = px[i].c, ret = px[i + H].c / e - 1;
  return { pending: false, H, ret: +ret.toFixed(4), hit: p.dir === 'up' ? ret >= TH : ret <= -TH };
}

function cycleBaseline(dateStr, dir) {
  const H = 60;
  const i = idx.get(dateStr);
  if (i === undefined) return null;
  let hit = 0, n = 0;
  const NB = (CFG.baseline && CFG.baseline.neighborDays) || 45;
  for (let k = Math.max(0, i - NB); k <= Math.min(pxAsOf.length - 1, i + NB); k++) {
    if (k + H >= pxAsOf.length) continue;
    const ret = px[k + H].c / px[k].c - 1;
    n++;
    if (dir === 'up' ? ret >= TH : ret <= -TH) hit++;
  }
  return n >= 20 ? hit / n : null;
}

function shortHit(p) {
  const i = idx.get(p.date);
  if (i === undefined) return null;
  const fut = pxAsOf.slice(i + 1, i + 1 + ((CFG.judge.short && CFG.judge.short.windowDays) || 90));
  if (fut.length < 20) return null;
  const e = px[i].c;
  return p.dir === 'up' ? Math.max(...fut.map(x => x.h)) / e - 1 >= SHORT_TOUCH : 1 - Math.min(...fut.map(x => x.l)) / e >= SHORT_TOUCH;
}

// 大顶/大底「提前预判」：拐点前 7~90 天给出同方向 + 点位接近
const NODES = CFG.nodes || [];
function nodeScore(preds) {
  let sum = 0, covered = 0;
  for (const nd of NODES) {
    let best = 0;
    for (const p of preds) {
      const want = nd.type === 'bottom' ? 'up' : 'down';
      if (p.dir !== want) continue;
      const lead = Math.round((Date.parse(nd.date) - Date.parse(p.date)) / 86400000);
      const LMIN=(CFG.nodeRule&&CFG.nodeRule.leadDaysMin)||7, LMAX=(CFG.nodeRule&&CFG.nodeRule.leadDaysMax)||90;
      if (!(lead >= LMIN && lead <= LMAX)) continue;
      let v = 0.5;
      if (p.target) {
        const err = Math.abs(p.target - nd.price) / nd.price;
        const full=(CFG.nodeRule&&CFG.nodeRule.priceToleranceFull)||0.03, part=(CFG.nodeRule&&CFG.nodeRule.priceTolerancePartial)||0.08;
        if (err <= full) v = 1; else if (err <= part) v = 0.7;
      } else if (p.level === nd.type) v = 0.6;
      best = Math.max(best, v);
    }
    if (best > 0) { sum += best; covered++; }
  }
  // 机会归一：覆盖少但全中不能封神
  return covered ? +(0.6 * Math.min(1, sum / 4) + 0.4 * Math.min(1, sum / covered)).toFixed(3) : 0;
}

// ---------- 汇总 ----------
const rows = [];
for (const [screen, all] of predsBy) {
  const from = new Date(Date.parse(ASOF) - WINDOW * 86400000).toISOString().slice(0, 10);
  const preds = all.filter(p => p.date >= from && p.date <= ASOF);
  const cyc = preds.filter(p => p.horizon === 'months' || p.horizon === 'quarters');
  const sht = preds.filter(p => p.horizon === 'weeks');

  const settled = [], pending = [];
  for (const p of cyc) { const r = cycleHit(p); if (!r) continue; r.pending ? pending.push(p) : settled.push({ ...p, ...r }); }
  for (const p of sht) { const h = shortHit(p); if (h !== null) settled.push({ ...p, hit: h, short: true }); }

  const cycSettled = settled.filter(r => !r.short);
  const cycHit = cycSettled.filter(r => r.hit).length;
  const baseList = cycSettled.map(r => cycleBaseline(r.date, r.dir)).filter(x => x !== null);
  const cycRate = cycSettled.length ? cycHit / cycSettled.length : null;
  const base = baseList.length ? baseList.reduce((s, x) => s + x, 0) / baseList.length : null;
  const cycAdj = (cycRate !== null && base !== null) ? cycRate - base : null;

  const shortSettled = settled.filter(r => r.short);
  const shortRate = shortSettled.length ? shortSettled.filter(r => r.hit).length / shortSettled.length : null;
  const shortBase = shortSettled.length
    ? shortSettled.map(r => {
        const i = idx.get(r.date); if (i === undefined) return null;
        let h = 0, n = 0;
        for (let k = Math.max(0, i - 45); k <= Math.min(pxAsOf.length - 1, i + 45); k++) {
          const f = pxAsOf.slice(k + 1, k + 1 + 90); if (f.length < 20) continue;
          const e = px[k].c; n++;
          if (r.dir === 'up' ? Math.max(...f.map(x => x.h)) / e - 1 >= SHORT_TOUCH : 1 - Math.min(...f.map(x => x.l)) / e >= SHORT_TOUCH) h++;
        }
        return n >= 20 ? h / n : null;
      }).filter(x => x !== null).reduce((s, x, _, arr) => s + x / arr.length, 0)
    : null;
  const shortAdj = (shortRate !== null && shortBase !== null) ? shortRate - shortBase : null;

  // 分季度一致性：几个月/季度样本里，各季度超额方向是否一致
  const byQ = {};
  for (const r of cycSettled) {
    const q = r.date.slice(0, 4) + 'Q' + (Math.floor((+r.date.slice(5, 7) - 1) / 3) + 1);
    (byQ[q] ??= []).push(r.hit ? 1 : 0);
  }
  const qRates = Object.values(byQ).map(v => v.reduce((a, b) => a + b, 0) / v.length);
  const consistency = qRates.length >= 2
    ? (Math.max(...qRates) - Math.min(...qRates) <= 0.34 ? 'stable' : 'unstable')
    : 'insufficient';

  const node = nodeScore(preds);

  // 证据门槛：months+quarters 可结算 ≥ MIN_N，且跨越 ≥60 天
  const span = cycSettled.length
    ? Math.round((Date.parse(cycSettled.map(r => r.date).sort().slice(-1)[0]) - Date.parse(cycSettled.map(r => r.date).sort()[0])) / 86400000)
    : 0;
  const qualified = cycSettled.length >= MIN_N && span >= (g.minSpanDays || 60);
  const observe = !qualified && cycSettled.length >= OBS_MIN && span >= (g.observeMinSpanDays || 30);   // 观察榜：样本不够但能看趋势

  // 综合分：大周期 60 / 顶底预判 20 / 短期 8（≤5 分）/ 一致性修正
  let score = null;
  if ((qualified || observe) && cycAdj !== null) {
    const W = CFG.weights || {};
    const c = Math.max(-1, Math.min(1, cycAdj)) * (W.cycle || 60);
    const n = node * (W.node || 20);
    const sRaw = shortAdj === null ? 0 : Math.max(-1, Math.min(1, shortAdj)) * (W.short || 8);
    const s = Math.max(-(W.shortCap || 5), Math.min(W.shortCap || 5, sRaw));
    const adj = consistency === 'unstable' ? -(W.unstablePenalty || 5) : 0;
    score = Math.round(c + n + s + adj);
  }

  rows.push({
    screen, cycSettled: cycSettled.length, cycHit, cycRate, base, cycAdj, pending: pending.length,
    shortSettled: shortSettled.length, shortRate, shortAdj, node, consistency,
    spanDays: span, qualified, observe, score,
    tier: !qualified && !observe ? '样本不足' : (score >= (CFG.tierCut?.A ?? 45) ? 'A' : score >= (CFG.tierCut?.B ?? 25) ? 'B' : score >= (CFG.tierCut?.C ?? 10) ? 'C' : 'D') + (observe ? '·初' : ''),
    evidence: cycSettled.slice(-3).map(r => `${r.date} ${r.dir} ${r.horizon} → ${r.hit ? '对' : '错'}(${(r.ret * 100).toFixed(1)}%)`),
  });
}

rows.sort((a, b) => (b.score ?? -999) - (a.score ?? -999) || b.cycSettled - a.cycSettled);

// ---------- 输出 ----------
fs.mkdirSync(OUTDIR, { recursive: true });
const meta = {
  asof: ASOF, windowDays: WINDOW, minN: MIN_N, obsMin: OBS_MIN,
  pxRange: [px[0].t, pxAsOf[pxAsOf.length - 1].t],
  accounts: rows.length, qualified: rows.filter(r => r.qualified).length, observing: rows.filter(r => r.observe).length,
  rule: {
    version: CFG.version,
    horizonJudge: 'months=60天 / quarters=90天，终点涨跌≥10% 才算方向兑现（不看窗口内触及）',
    baseline: '同日 ±45 天、同方向的随机命中率（消除趋势红利）',
    weight: '大周期 60 / 顶底提前预判 20 / 短期 8（上限 5 分）/ 口径不稳定 −5',
    gate: `months+quarters 可结算 ≥${MIN_N} 条且跨越 ≥60 天才入榜，否则标「样本不足」`,
  },
  generatedAt: new Date().toISOString(),
};
fs.writeFileSync(path.join(OUTDIR, `scorecard_${ASOF}.json`), JSON.stringify({ meta, rows }, null, 1), 'utf8');

const pct = v => v === null || v === undefined ? '  --' : (v * 100).toFixed(0).padStart(3) + '%';
const pt = v => v === null || v === undefined ? '  --' : (v * 100).toFixed(0).padStart(4) + 'pt';
const md = [];
md.push(`# 博主预测能力·周期快照 ${ASOF}`, '');
md.push(`窗口：预测日在 ${ASOF} 前 ${WINDOW} 天内｜行情截至 ${meta.pxRange[1]}｜样本门槛：大周期可结算 ≥${MIN_N} 条`, '');
md.push(`入榜 ${meta.qualified} / ${meta.accounts} 个账号（其余标「样本不足」，不排名）`, '');
md.push('| # | 账号 | 综合分 | 档 | 大周期(对/结算) | 命中率 | 基准 | 超额 | 顶底预判 | 短期超额 | 一致性 |');
md.push('|---|---|---|---|---|---|---|---|---|---|---|');
rows.filter(r => r.qualified).forEach((r, i) => {
  md.push(`| ${i + 1} | [@${r.screen}](https://x.com/${r.screen}) | **${r.score}** | ${r.tier} | ${r.cycHit}/${r.cycSettled} | ${pct(r.cycRate)} | ${pct(r.base)} | ${pt(r.cycAdj)} | ${r.node.toFixed(2)} | ${pt(r.shortAdj)} | ${r.consistency} |`);
});
md.push('', `## 观察榜（大周期可结算 ${OBS_MIN}~${MIN_N - 1} 条，仅供参考，不作结论）`, '');
md.push('| 账号 | 综合分 | 大周期(对/结算) | 超额 | 顶底预判 | 一致性 |');
md.push('|---|---|---|---|---|---|');
rows.filter(r => r.observe).forEach(r => {
  md.push(`| [@${r.screen}](https://x.com/${r.screen}) | ${r.score} | ${r.cycHit}/${r.cycSettled} | ${pt(r.cycAdj)} | ${r.node.toFixed(2)} | ${r.consistency} |`);
});
md.push('', `## 样本不足（不排名，仅列大周期可结算条数）`, '');
md.push('| 账号 | 大周期可结算 | 待结算 | 顶底预判 |');
md.push('|---|---|---|---|');
rows.filter(r => !r.qualified && !r.observe).slice(0, 30).forEach(r => {
  md.push(`| [@${r.screen}](https://x.com/${r.screen}) | ${r.cycSettled} | ${r.pending} | ${r.node.toFixed(2)} |`);
});
md.push('', `共 ${rows.filter(r => !r.qualified && !r.observe).length} 个账号样本不足（大周期可结算 <${OBS_MIN} 条）。`, '');
md.push('## 口径', '');
for (const [k, v] of Object.entries(meta.rule)) md.push(`- **${k}**：${v}`);
fs.writeFileSync(path.join(OUTDIR, `scorecard_${ASOF}.md`), md.join('\n'), 'utf8');

// ---------- 控制台 ----------
console.log(`\n入榜 ${meta.qualified} / ${rows.length} 个账号（门槛：大周期可结算 ≥${MIN_N} 条、跨越 ≥60 天）`);
console.log('账号'.padEnd(20) + '分  档 大周期    命中  基准  超额  顶底 短期超额 一致');
for (const r of rows.filter(r => r.qualified).slice(0, 15)) {
  console.log('@' + r.screen.padEnd(19) + String(r.score).padStart(3) + ' ' + r.tier +
    ` ${r.cycHit}/${r.cycSettled}`.padEnd(8) + pct(r.cycRate) + ' ' + pct(r.base) + pt(r.cycAdj) +
    ' ' + r.node.toFixed(2) + ' ' + pt(r.shortAdj) + ' ' + r.consistency);
}
if (args.reasons) {
  console.log('\n=== 落榜原因（大周期可结算不足）===');
  for (const r of rows.filter(x => !x.qualified && !x.observe)) {
    console.log('@' + r.screen.padEnd(19), `大周期可结算 ${r.cycSettled} 条（<${OBS_MIN}）, 跨度 ${r.spanDays} 天, 待结算 ${r.pending}`);
  }
}
console.log(`\n观察榜 ${meta.observing} 个账号（${OBS_MIN}~${MIN_N - 1} 条），样本不足 ${rows.filter(r => !r.qualified && !r.observe).length} 个`);
console.log(`\n→ ${path.join(OUTDIR, 'scorecard_' + ASOF + '.json')}`);
console.log(`→ ${path.join(OUTDIR, 'scorecard_' + ASOF + '.md')}`);
