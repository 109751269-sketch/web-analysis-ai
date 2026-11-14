/**
 * signals.js —— 信号扫描器（BTC 日线，1000 天）
 *
 * 用法：
 *   node signals.js --scan     扫描信号库，输出 output/signals/scan_<asof>.json
 *   node signals.js --build    生成 btc-report/signals/index.html
 *   node signals.js --status   只看当前有哪些信号处于触发状态
 *
 * 方法论（与 02 专题一致，避免自欺）：
 *   1. 每个信号都是「当日可观测」的二值条件，不看未来数据
 *   2. 命中率必须扣「同方向基准」——2024-2026 市场整体偏涨，
 *      看涨信号不扣基准等于白给
 *   3. 分片一致性：把样本按时间三等分，三段超额同号才算稳定
 *   4. 样本 < 30 不给建议，< 9 不算一致性
 *   5. 多信号同时扫描存在多重比较，单条「显著」不等于真有效；
 *      只有「三段同号 + 样本够 + 超额幅度大」才标「可用」
 */
const fs = require('fs');
const path = require('path');

const ROOT = process.env.BTC_CRAWLER_ROOT || 'F:/despseekharness/crawler';
const SITE = process.env.BTC_SITE || path.join(ROOT, 'repo', 'btc-report');
const OUT = path.join(ROOT, 'output', 'signals');
const API = 'https://data-api.binance.vision/api/v3/klines';
const HORIZONS = [7, 14, 30];
const args = process.argv.slice(2);
const has = f => args.includes(f);
const todayUTC = () => new Date().toISOString().slice(0, 10);

/* ---------- 数据 ---------- */
async function fetchK(sym) {
  const cache = path.join(ROOT, 'state', `${sym.toLowerCase()}_full.json`);
  try {
    const r = await fetch(`${API}?symbol=${sym}&interval=1d&limit=1000`, { signal: AbortSignal.timeout(25000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const a = await r.json();
    const px = a.map(k => ({
      t: new Date(k[0]).toISOString().slice(0, 10),
      o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5], qv: +k[7],
    }));
    fs.writeFileSync(cache, JSON.stringify({ fetchedAt: new Date().toISOString(), px }), 'utf8');
    return px;
  } catch (e) {
    if (!fs.existsSync(cache)) throw e;
    console.warn(`⚠ ${sym} 实时失败，用缓存：`, e.message);
    return JSON.parse(fs.readFileSync(cache, 'utf8')).px;
  }
}

/* ---------- 指标 ---------- */
const sma = (cs, n) => {
  const o = Array(cs.length).fill(null); let s = 0;
  for (let i = 0; i < cs.length; i++) { s += cs[i]; if (i >= n) s -= cs[i - n]; if (i >= n - 1) o[i] = s / n; }
  return o;
};
const stdev = (cs, n) => {
  const o = Array(cs.length).fill(null);
  for (let i = n - 1; i < cs.length; i++) {
    const seg = cs.slice(i - n + 1, i + 1);
    const m = seg.reduce((a, b) => a + b, 0) / n;
    o[i] = Math.sqrt(seg.reduce((a, b) => a + (b - m) ** 2, 0) / n);
  }
  return o;
};
function rsi(cs, n) {
  const o = Array(cs.length).fill(null);
  let g = 0, l = 0;
  for (let i = 1; i <= n && i < cs.length; i++) { const d = cs[i] - cs[i - 1]; if (d > 0) g += d; else l -= d; }
  g /= n; l /= n;
  if (n < cs.length) o[n] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  for (let i = n + 1; i < cs.length; i++) {
    const d = cs[i] - cs[i - 1];
    g = (g * (n - 1) + (d > 0 ? d : 0)) / n;
    l = (l * (n - 1) + (d < 0 ? -d : 0)) / n;
    o[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  return o;
}
function atr(px, n) {
  const tr = px.map((r, i) => i === 0 ? r.h - r.l
    : Math.max(r.h - r.l, Math.abs(r.h - px[i - 1].c), Math.abs(r.l - px[i - 1].c)));
  return sma(tr, n);
}

/* ---------- 信号库 ----------
 * dir: +1 看涨 / -1 看跌；fn(px, ind) 返回与 px 等长的布尔数组（null/false = 不触发）
 */
function buildSignals(px, eth) {
  const c = px.map(r => r.c), h = px.map(r => r.h), l = px.map(r => r.l), v = px.map(r => r.v);
  const ma20 = sma(c, 20), ma50 = sma(c, 50), ma200 = sma(c, 200);
  const r14 = rsi(c, 14), r2 = rsi(c, 2);
  const sd20 = stdev(c, 20), atr14 = atr(px, 14), vol20 = sma(v, 20);
  const ret = c.map((x, i) => i === 0 ? 0 : x / c[i - 1] - 1);
  const dd20 = c.map((x, i) => { let mx = 0; for (let j = Math.max(0, i - 19); j <= i; j++) mx = Math.max(mx, h[j]); return mx ? x / mx - 1 : 0; });
  const newLow20 = l.map((x, i) => { if (i < 20) return false; let mn = Infinity; for (let j = i - 19; j <= i; j++) mn = Math.min(mn, l[j]); return x <= mn; });
  const newHigh20 = h.map((x, i) => { if (i < 20) return false; let mx = -Infinity; for (let j = i - 19; j <= i; j++) mx = Math.max(mx, h[j]); return x >= mx; });
  const ethMap = {}; for (const r of eth) ethMap[r.t] = r.c;
  const ethRet = Array(px.length).fill(null);
  for (let i = 1; i < px.length; i++) {
    const a = ethMap[px[i].t], b = ethMap[px[i - 1].t];
    if (a && b) ethRet[i] = a / b - 1;
  }
  const relDiff = ret.map((x, i) => ethRet[i] === null ? null : (ethRet[i] - x) * 100);
  const cum = (n) => c.map((x, i) => i < n ? null : x / c[i - n] - 1);
  const cumEth = (n) => Array(px.length).fill(null).map((_, i) => {
    if (i < n) return null;
    const a = ethMap[px[i].t], b = ethMap[px[i - n].t];
    return a && b ? a / b - 1 : null;
  });
  const btc3 = cum(3), eth3 = cumEth(3), btc10 = cum(10), eth10 = cumEth(10);

  const S = [];
  const add = (key, name, dir, desc, fn) => S.push({ key, name, dir, desc, fn });

  /* --- 均值回归类 --- */
  add('rsi14_low', 'RSI14 < 30', 1, '日线 RSI14 跌破 30，超卖', (i) => r14[i] !== null && r14[i] < 30);
  add('rsi14_high', 'RSI14 > 70', -1, '日线 RSI14 升破 70，超买', (i) => r14[i] !== null && r14[i] > 70);
  add('rsi2_extreme', 'RSI2 < 10', 1, '两日 RSI 极低，短期恐慌', (i) => r2[i] !== null && r2[i] < 10);
  add('rsi2_hot', 'RSI2 > 90', -1, '两日 RSI 极高，短期过热', (i) => r2[i] !== null && r2[i] > 90);
  add('dd20_deep', '距 20 日高点回撤 > 15%', 1, '深跌，博反弹', (i) => dd20[i] < -0.15);
  add('dd20_nearhigh', '距 20 日高点 < 3%', -1, '贴近阶段高点，追高风险', (i) => i >= 20 && dd20[i] > -0.03);

  /* --- 趋势跟随类 --- */
  add('newlow20', '创 20 日新低', -1, '跌破近 20 日最低点', (i) => newLow20[i]);
  add('newhigh20', '创 20 日新高', 1, '突破近 20 日最高点', (i) => newHigh20[i]);
  add('above_ma200', '收盘 > MA200', 1, '长期趋势向上', (i) => ma200[i] !== null && c[i] > ma200[i]);
  add('below_ma200', '收盘 < MA200', -1, '长期趋势向下', (i) => ma200[i] !== null && c[i] < ma200[i]);
  add('ma20_above_ma50', 'MA20 > MA50', 1, '中期均线多头排列', (i) => ma20[i] !== null && ma50[i] !== null && ma20[i] > ma50[i]);
  add('ma20_below_ma50', 'MA20 < MA50', -1, '中期均线空头排列', (i) => ma20[i] !== null && ma50[i] !== null && ma20[i] < ma50[i]);

  /* --- 波动率 / 通道类 --- */
  add('bb_lower', '收盘 < 布林下轨', 1, '跌破 20 日 -2σ，超跌', (i) => sd20[i] !== null && c[i] < ma20[i] - 2 * sd20[i]);
  add('bb_upper', '收盘 > 布林上轨', -1, '突破 20 日 +2σ，超涨', (i) => sd20[i] !== null && c[i] > ma20[i] + 2 * sd20[i]);
  add('atr_squeeze', 'ATR14 处 60 日低位 20%', 1, '波动率压缩，常 precede 变盘', (() => {
    const pct = atr14.map((x, i) => {
      if (x === null || i < 60) return null;
      const seg = atr14.slice(i - 59, i + 1).filter(y => y !== null).sort((a, b) => a - b);
      if (!seg.length) return null;
      return seg.filter(y => y <= x).length / seg.length;
    });
    return (i) => pct[i] !== null && pct[i] <= 0.2;
  })());

  /* --- 量能类 --- */
  add('volspike_down', '放量下跌（量 > 2×20 日均量 且收跌）', 1, '恐慌抛售，常见短期底', (i) => vol20[i] && v[i] > 2 * vol20[i] && ret[i] < 0);
  add('volspike_up', '放量上涨（量 > 2×20 日均量 且收涨）', 1, '资金进场', (i) => vol20[i] && v[i] > 2 * vol20[i] && ret[i] > 0);
  add('vol_dry', '缩量（量 < 0.5×20 日均量）', 1, '成交萎缩，观望', (i) => vol20[i] && v[i] < 0.5 * vol20[i]);

  /* --- 连续涨跌 --- */
  add('down3', '连续 3 日下跌', 1, '短期连跌，博反弹', (i) => i >= 3 && ret[i] < 0 && ret[i - 1] < 0 && ret[i - 2] < 0);
  add('up3', '连续 3 日上涨', -1, '短期连涨，博回落', (i) => i >= 3 && ret[i] > 0 && ret[i - 1] > 0 && ret[i - 2] > 0);
  add('down5', '连续 5 日下跌', 1, '持续下跌', (i) => i >= 5 && [0, 1, 2, 3, 4].every(k => ret[i - k] < 0));

  /* --- ETH 相对强度（用户本人发现的范式） --- */
  // 单日口径：BTC 与 ETH 同日都跌，且 ETH 跌幅更小
  const dailyRet = ret, ethDaily = ethRet;
  add('eth_s1', 'ETH 单日抗跌（两者都跌 且 ETH 跌幅更小）', 1,
    '下跌中 ETH 跌得比 BTC 少，判断底部阶段',
    (i) => dailyRet[i] < 0 && ethDaily[i] !== null && ethDaily[i] < 0 && ethDaily[i] > dailyRet[i]);

  const ethTurn = Array(px.length).fill(null).map((_, i) => {
    if (btc3[i] === null || eth3[i] === null || btc10[i] === null || eth10[i] === null) return null;
    const weak10 = (eth10[i] - btc10[i]) < 0;
    const strong3 = (eth3[i] - btc3[i]) > 0;
    return { weak10, strong3, btcDown3: btc3[i] < 0 };
  });
  add('eth_turn', 'ETH 先弱后抗跌（10 日弱于 BTC + 3 日转为抗跌 + BTC 3 日下跌）', 1,
    '下跌中 ETH 更弱属正常；一旦转为抗跌，判断转折',
    (i) => ethTurn[i] && ethTurn[i].weak10 && ethTurn[i].strong3 && ethTurn[i].btcDown3);
  add('eth_strong3', '近 3 日 ETH 累计强于 BTC（且 BTC 下跌）', 1,
    '三日尺度 ETH 相对强度',
    (i) => ethTurn[i] && ethTurn[i].strong3 && ethTurn[i].btcDown3);
  add('eth_weak3', '近 3 日 ETH 累计弱于 BTC（且 BTC 下跌）', -1,
    '三日尺度 ETH 相对弱势',
    (i) => ethTurn[i] && !ethTurn[i].strong3 && ethTurn[i].btcDown3);

  return S;
}

/* ---------- 回测 ---------- */
function scan(px, eth) {
  const S = buildSignals(px, eth);
  const n = px.length;
  const c = px.map(r => r.c);
  const fwd = {}; // fwd[h][i] = 前向收益率
  for (const h of HORIZONS) {
    fwd[h] = c.map((x, i) => i + h < n ? c[i + h] / x - 1 : null);
  }
  // 基准：预热期之后的全部交易日（与信号样本同一区间，避免样本期偏差）
  const START = 200;
  const baseline = {};
  for (const h of HORIZONS) {
    const arr = [];
    for (let i = START; i < n - 1; i++) if (fwd[h][i] !== null) arr.push(fwd[h][i]);
    baseline[h] = {
      up: arr.filter(x => x > 0).length / arr.length,
      down: arr.filter(x => x < 0).length / arr.length,
      mean: arr.reduce((a, b) => a + b, 0) / arr.length,
      n: arr.length,
    };
  }

  const results = S.map(sig => {
    const hitIdx = [];
    for (let i = 200; i < n; i++) { // 跳过指标预热期
      let on = false;
      try { on = sig.fn(i); } catch { on = false; }
      if (on) hitIdx.push(i);
    }
    const byH = {};
    for (const h of HORIZONS) {
      const vals = hitIdx.map(i => fwd[h][i]).filter(x => x !== null);
      if (!vals.length) { byH[h] = { n: 0 }; continue; }
      const win = vals.filter(x => (x * sig.dir) > 0).length / vals.length;
      const base = sig.dir > 0 ? baseline[h].up : baseline[h].down;
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
      byH[h] = {
        n: vals.length,
        win: +(win * 100).toFixed(1),
        base: +(base * 100).toFixed(1),
        edge: +((win - base) * 100).toFixed(1),
        mean: +(mean * 100).toFixed(2),
        meanAdj: +((sig.dir * mean) * 100).toFixed(2),
      };
    }
    // 分片一致性（用最长周期 30 日；样本按时间三等分）
    const h = 30;
    const vals = hitIdx.map(i => ({ i, v: fwd[h][i] })).filter(x => x.v !== null);
    let stable = null, thirds = [];
    if (vals.length >= 9) {
      const size = Math.floor(vals.length / 3);
      for (let k = 0; k < 3; k++) {
        const seg = vals.slice(k * size, k === 2 ? vals.length : (k + 1) * size);
        if (!seg.length) { thirds.push(null); continue; }
        const w = seg.filter(x => x.v * sig.dir > 0).length / seg.length;
        const b = sig.dir > 0 ? baseline[h].up : baseline[h].down;
        thirds.push(+((w - b) * 100).toFixed(1));
      }
      // stable = 三段都有正超额（≥1pt），不是「同号」。
      // 旧版用「同号」，导致 [0.6, 23.4, 18.8] 这种前段≈0 的信号被算成稳定。
      const valid = thirds.filter(x => x !== null);
      stable = valid.length === 3 && valid.every(x => x >= 1);
    }
    const edge30 = byH[30].edge ?? 0;
    const minThird = thirds.length === 3 ? Math.min(...thirds) : null;
    const score = byH[30].n >= 30
      ? Math.round(50 + edge30 * 4 * (stable === true ? 1 : stable === false ? 0.5 : 0.7)
          + (minThird !== null ? Math.min(minThird, 10) * 0.8 : 0))
      : null;
    return {
      key: sig.key, name: sig.name, dir: sig.dir, desc: sig.desc,
      n: hitIdx.length, byH, thirds, stable, score,
      verdict: byH[30].n < 30 ? '样本不足'
        : score >= 80 && stable ? '可用'
        : edge30 >= 5 ? '观察'
        : '无效',
    };
  });

  results.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));

  // 当前触发状态
  const last = n - 1;
  const active = S.map(s => {
    let on = false; try { on = s.fn(last); } catch { }
    return on ? { key: s.key, name: s.name, dir: s.dir } : null;
  }).filter(Boolean);

  return {
    asof: todayUTC(),
    window: { from: px[0].t, to: px[n - 1].t, days: n, lastClose: c[n - 1] },
    horizons: HORIZONS,
    baseline,
    signals: results,
    active,
    note: '同一批扫描 25 个信号 × 3 个周期，存在多重比较；只有「三段超额同号 + 样本 ≥30 + 超额 ≥5pt」才标可用。',
  };
}

/* ---------- 页面 ---------- */
const esc = s => String(s ?? '').replace(/[&<>"]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
const fmt = n => typeof n === 'number' ? n.toLocaleString('en-US') : n;
const signed = n => n > 0 ? '+' + n : String(n);

function build(r) {
  const rows = r.signals.map(s => {
    const h = s.byH[30];
    const vCls = s.verdict === '可用' ? 'good' : s.verdict === '观察' ? 'neg' : s.verdict === '样本不足' ? 'gray' : 'warn';
    const dirTag = s.dir > 0 ? '<span class="tag bull">看涨</span>' : '<span class="tag bear">看跌</span>';
    const stab = s.stable === true ? '<span class="tag good">三段同号</span>'
      : s.stable === false ? '<span class="tag warn">符号翻转</span>'
      : '<span class="tag gray">样本不足</span>';
    return `<tr>
      <td><strong>${esc(s.name)}</strong><div class="small">${esc(s.desc)}</div></td>
      <td>${dirTag}</td>
      <td class="num">${s.n}</td>
      <td class="num">${h.n ? h.win + '%' : '—'}</td>
      <td class="num">${h.n ? h.base + '%' : '—'}</td>
      <td class="num ${h.edge > 0 ? 'rise' : h.edge < 0 ? 'fall' : ''}">${h.n ? signed(h.edge) + 'pt' : '—'}</td>
      <td class="num">${h.n ? signed(h.meanAdj) + '%' : '—'}</td>
      <td>${stab}</td>
      <td class="num">${s.score ?? '—'}</td>
      <td><span class="tag ${vCls}">${esc(s.verdict)}</span></td>
    </tr>`;
  }).join('');

  const detail = r.signals.filter(s => s.n >= 5).map(s => {
    const cells = r.horizons.map(hh => {
      const x = s.byH[hh];
      if (!x.n) return `<td class="num">—</td>`;
      return `<td class="num">${x.win}% <span class="small">(${x.base}%)</span><div class="small ${x.edge > 0 ? 'rise' : 'fall'}">${signed(x.edge)}pt</div></td>`;
    }).join('');
    const thirds = s.thirds.map(x => x === null ? '—' : signed(x) + 'pt').join(' / ');
    return `<tr><td><strong>${esc(s.name)}</strong></td><td class="num">${s.n}</td>${cells}<td class="small">${thirds}</td></tr>`;
  }).join('');

  const active = r.active.length
    ? r.active.map(a => `<li><strong>${esc(a.name)}</strong> ${a.dir > 0 ? '<span class="tag bull">看涨</span>' : '<span class="tag bear">看跌</span>'}</li>`).join('')
    : '<li>今日无信号触发</li>';

  const usable = r.signals.filter(s => s.verdict === '可用').length;
  const watch = r.signals.filter(s => s.verdict === '观察').length;

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>预测信号库 · BTC 研究站</title>
<link rel="stylesheet" href="../assets/report.css">
<style>
  .sig-detail td{font-size:12px}
  .sig-detail .small{font-size:10.5px;color:var(--txt3)}
  .sig-detail .rise{font-size:11px}
</style>
</head>
<body>
<div class="wrap">
  <div class="crumb"><a href="../">首页</a><span>/</span>05 预测信号库</div>
  <div class="series">TOPIC 05</div>
  <h1>预测信号库</h1>
  <div class="sub">把「人工观察到的规律」变成可回测的信号｜${r.window.from} ~ ${r.window.to}（${r.window.days} 天）｜基准已扣</div>

  <div class="grid">
    <div class="kpi"><div class="n">${r.signals.length}</div><div class="l">扫描信号数</div></div>
    <div class="kpi"><div class="n rise">${usable}</div><div class="l">判定「可用」</div></div>
    <div class="kpi"><div class="n plain">${watch}</div><div class="l">观察中</div></div>
    <div class="kpi"><div class="n">${r.active.length}</div><div class="l">今日触发</div></div>
  </div>

  <div class="callout"><strong>一句话结论：</strong>多数「看起来有效」的信号扣掉基准后就没有超额；本页只把「三段同号 + 样本 ≥30 + 超额 ≥5pt」标为可用，其余一律降级。</div>

  <h2>一、怎么读这张表</h2>
  <div class="card">
    <table>
      <tr><th style="width:130px">字段</th><th>含义</th></tr>
      <tr><td><strong>样本 n</strong></td><td>这个信号在 ${r.window.days} 天里一共触发多少次。少于 30 次不给结论。</td></tr>
      <tr><td><strong>命中率</strong></td><td>信号出现后第 30 天，价格按预期方向（看涨=涨、看跌=跌）走的比例。</td></tr>
      <tr><td><strong>基准</strong></td><td>不挑信号、随便哪天进场，同方向走对的概率。2024-2026 偏涨，看涨基准约 ${(r.baseline[30].up * 100).toFixed(0)}%、看跌约 ${(r.baseline[30].down * 100).toFixed(0)}%。</td></tr>
      <tr><td><strong>超额 = 命中 − 基准</strong></td><td><strong>唯一有意义的指标。</strong>等于 0 说明这个信号等于没看；负数是反指。</td></tr>
      <tr><td><strong>平均收益</strong></td><td>按信号方向调整后的 30 日平均涨跌幅（看跌信号已翻转符号，正数=信号有效）。</td></tr>
      <tr><td><strong>三段同号</strong></td><td>把样本按时间三等分，三段的超额是否同为正。全对才算稳定，否则可能是某一段行情造出来的。</td></tr>
      <tr><td><strong>打分</strong></td><td><code>50 + 超额 × 4 × 稳定系数</code>。稳定系数：三段同号=1、符号翻转=0.5、样本不足=0.7。50 分 = 无优势。</td></tr>
    </table>
  </div>

  <h2>二、信号总表（按 30 日打分排序）</h2>
  <table>
    <tr><th style="min-width:230px">信号</th><th>方向</th><th class="num">样本</th><th class="num">30 日命中</th><th class="num">基准</th><th class="num">超额</th><th class="num">平均收益</th><th>稳定性</th><th class="num">打分</th><th>判定</th></tr>
    ${rows}
  </table>

  <h2>三、分周期明细</h2>
  <table class="sig-detail">
    <tr><th style="min-width:200px">信号</th><th class="num">样本</th>
      ${r.horizons.map(h => `<th class="num">${h} 日命中<br><span class="small">（基准）/ 超额</span></th>`).join('')}
      <th>三段超额（30 日）</th></tr>
    ${detail}
  </table>
  <p class="small">括号内为同周期基准。超额 = 命中 − 基准。</p>

  <h2>四、今日触发</h2>
  <div class="card">
    <p class="small" style="margin-top:0">行情截至 ${r.window.to}（UTC 日线），收盘 ${fmt(r.window.lastClose)}。</p>
    <ul>${active}</ul>
  </div>

  <h2>五、方法与局限</h2>
  <div class="card">
    <table>
      <tr><th style="width:150px">项目</th><th>说明</th></tr>
      <tr><td>数据</td><td>Binance BTCUSDT / ETHUSDT 日线（UTC 00:00 收），${r.window.days} 根。成交量取 quote volume。</td></tr>
      <tr><td>信号定义</td><td>全部只用「当日及之前」的收盘数据，不看未来。指标预热期（前 200 天）不参与统计。</td></tr>
      <tr><td>多重比较</td><td><strong>本页扫了 ${r.signals.length} 个信号 × 3 个周期。</strong>纯随机也可能有 1-2 个看起来 +10pt，所以必须要求三段同号，且不因单条信号就下重注。</td></tr>
      <tr><td>样本期偏差</td><td>${r.window.from} 至今包含一轮熊市和一段震荡，牛市单边样本不足。跨周期有效性未知。</td></tr>
      <tr><td>未覆盖</td><td>链上数据、资金费率、ETF 流向、宏观事件均未纳入。这些需要额外数据源。</td></tr>
      <tr><td>不构成投资建议</td><td>本页是统计检验，不是交易策略；未计入手续费、滑点与仓位管理。</td></tr>
    </table>
  </div>

  <div class="foot">
    生成 ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC｜扫描脚本 <code>signals.js</code>｜<a href="../">返回首页</a><br>
    信号库持续扩充；新增信号会重跑全量回测，历史结论不追改。
  </div>
</div>
</body>
</html>`;

  const outDir = path.join(SITE, 'signals');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'index.html'), html, 'utf8');
  console.log('→ 页面', path.join(outDir, 'index.html'));
}

/* ---------- main ---------- */
(async () => {
  if (has('--build')) {
    const f = path.join(OUT, `scan_${todayUTC()}.json`);
    const src = fs.existsSync(f) ? f : (() => {
      const dir = fs.existsSync(OUT) ? fs.readdirSync(OUT).filter(x => /^scan_.*\.json$/.test(x)).sort() : [];
      if (!dir.length) throw new Error('没有扫描结果，先跑 --scan');
      return path.join(OUT, dir[dir.length - 1]);
    })();
    build(JSON.parse(fs.readFileSync(src, 'utf8')));
    return;
  }

  const [btc, eth] = await Promise.all([fetchK('BTCUSDT'), fetchK('ETHUSDT')]);
  const r = scan(btc, eth);

  if (has('--status')) {
    console.log(`行情至 ${r.window.to}｜收盘 ${fmt(r.window.lastClose)}`);
    console.log(r.active.length ? '\n今日触发：' : '\n今日无信号触发');
    for (const a of r.active) console.log(`  ${a.dir > 0 ? '看涨' : '看跌'}｜${a.name}`);
    return;
  }

  fs.mkdirSync(OUT, { recursive: true });
  const f = path.join(OUT, `scan_${r.asof}.json`);
  fs.writeFileSync(f, JSON.stringify(r, null, 1), 'utf8');

  console.log(`扫描 ${r.signals.length} 个信号｜${r.window.from} ~ ${r.window.to}（${r.window.days} 天）`);
  console.log(`基准 30 日：看涨 ${(r.baseline[30].up * 100).toFixed(1)}%／看跌 ${(r.baseline[30].down * 100).toFixed(1)}%\n`);
  console.log('判定      分  样本  30日命中  超额   信号');
  for (const s of r.signals) {
    const h = s.byH[30];
    console.log(`${s.verdict.padEnd(6)} ${String(s.score ?? '—').padStart(4)} ${String(s.n).padStart(5)} ${h.n ? (h.win + '%').padStart(8) : '       —'} ${h.n ? (signed(h.edge) + 'pt').padStart(7) : '      —'}  ${s.name}`);
  }
  console.log(`\n今日触发：${r.active.length ? r.active.map(a => a.name).join('、') : '无'}`);
  console.log(`→ ${f}`);
})();
