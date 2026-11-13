/**
 * verify_calls.js —— 观点承诺台账的机械判定器
 *
 * 用法：
 *   node verify_calls.js               判定 + 打报告（并写回台账 status）
 *   node verify_calls.js --status      只看台账概览，不判定
 *   node verify_calls.js --dry         只判定不写回
 *
 * 判据（写死在代码里，避免事后解释）：
 *   down   : 窗口内 min(low) <= level          → hit；过期未达 → miss
 *   up     : 窗口内 max(high) >= level         → hit；过期未达 → miss
 *   bottom : min(low) < level*(1-tol)          → miss（底被跌破）；过期未破 → hit
 *   hold   : 同 bottom（支撑守住）
 *   observe: 不计分，只观察
 *
 * 窗口：[startDate, min(today, settleBy)]，只用 startDate 之后的行情，不用当日已发生行情倒推。
 */
const fs = require('fs');
const path = require('path');

// 路径可覆盖，便于在技能仓库/其它工作区复用
const CRAWLER = process.env.BTC_CRAWLER_ROOT || (fs.existsSync(path.join(__dirname, "state", "calls_ledger.json")) ? __dirname : "F:/despseekharness/crawler");
const LEDGER = process.env.BTC_LEDGER || path.join(CRAWLER, 'state', 'calls_ledger.json');
const OUTDIR = process.env.BTC_VERIFY_OUT || path.join(CRAWLER, 'output', 'x_btc_20261113');
const args = process.argv.slice(2);
const isStatus = args.includes('--status');
const isDry = args.includes('--dry');

const today = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);

async function loadPx() {
  // 优先拉实时日线；失败则用本地快照
  try {
    const r = await fetch('https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=1d&limit=120', { signal: AbortSignal.timeout(15000) });
    const a = await r.json();
    return a.map(k => ({ t: new Date(k[0]).toISOString().slice(0, 10), h: +k[2], l: +k[3], c: +k[4] }));
  } catch (e) {
    console.warn('⚠ 实时行情拉取失败，用本地快照：', e.message);
    const f = path.join(OUTDIR, 'market_1113_v2.json');
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    return j.daily.map(d => ({ t: d.t, h: d.h, l: d.l, c: d.c }));
  }
}

function judge(c, px) {
  if (c.type === 'observe') return { status: 'observe', detail: '条件式/无点位，不计分' };
  const win = px.filter(r => r.t >= c.startDate && r.t <= (c.settleBy < today() ? c.settleBy : today()));
  if (!win.length) return { status: 'pending', detail: `等 ${c.startDate} 起的行情` };

  const lo = Math.min(...win.map(r => r.l));
  const hi = Math.max(...win.map(r => r.h));
  const last = win[win.length - 1].c;
  const expired = today() > c.settleBy;
  const tol = c.tolerance || 0;
  const base = { lo: Math.round(lo), hi: Math.round(hi), last: Math.round(last), days: win.length };

  switch (c.type) {
    case 'down':
      if (lo <= c.level) return { status: 'hit', detail: `最低 ${Math.round(lo)} 已触及 ${c.level}`, ...base };
      return expired
        ? { status: 'miss', detail: `到期未跌到 ${c.level}，最低仅 ${Math.round(lo)}（差 ${Math.round(lo - c.level)}）`, ...base }
        : { status: 'pending', detail: `现最低 ${Math.round(lo)}，距 ${c.level} 还差 ${Math.round(lo - c.level)}`, ...base };
    case 'up':
      if (hi >= c.level) return { status: 'hit', detail: `最高 ${Math.round(hi)} 已达 ${c.level}`, ...base };
      return expired
        ? { status: 'miss', detail: `到期未涨到 ${c.level}，最高仅 ${Math.round(hi)}（差 ${Math.round(c.level - hi)}）`, ...base }
        : { status: 'pending', detail: `现最高 ${Math.round(hi)}，距 ${c.level} 还差 ${Math.round(c.level - hi)}`, ...base };
    case 'reject': {
      // 「某价位难成支撑/阻力」型：连续 2 日收盘站上 level → 他说错
      let streak = 0, maxStreak = 0;
      for (const r of win) { if (r.c > c.level) { streak++; maxStreak = Math.max(maxStreak, streak); } else streak = 0; }
      if (maxStreak >= 2) return { status: 'miss', detail: `连续 ${maxStreak} 日收盘站上 ${c.level}，「难成持久支撑」不成立`, ...base };
      return expired
        ? { status: 'hit', detail: `窗口内未连续 2 日站上 ${c.level}`, ...base }
        : { status: 'pending', detail: `尚未连续 2 日站上 ${c.level}（当前 ${Math.round(last)}）`, ...base };
    }
    case 'bottom':
    case 'hold': {
      const line = c.level * (1 - tol);
      if (lo < line) return { status: 'miss', detail: `最低 ${Math.round(lo)} 已跌破 ${Math.round(line)}（${c.level}×${(1 - tol).toFixed(2)}），「底/支撑」不成立`, ...base };
      return expired
        ? { status: 'hit', detail: `到 ${c.settleBy} 未跌破 ${Math.round(line)}，最低 ${Math.round(lo)}`, ...base }
        : { status: 'pending', detail: `暂未跌破 ${Math.round(line)}，最低 ${Math.round(lo)}`, ...base };
    }
    default:
      return { status: 'pending', detail: '未知类型' };
  }
}

function advice(c) {
  if (c.status === 'hit') return '保持/升级';
  if (c.status === 'miss') {
    if (/看底|看多/.test(c.camp)) return '降级（喊底/看多被证伪，累计 2 次 → 拉黑）';
    if (/极端看空/.test(c.camp)) return '拉黑（极端点位未兑现）';
    return '降级观察';
  }
  return '—';
}

(async () => {
  const ledger = JSON.parse(fs.readFileSync(LEDGER, 'utf8'));
  if (isStatus) {
    const g = {};
    for (const c of ledger.calls) g[c.status] = (g[c.status] || 0) + 1;
    console.log(`台账：${ledger.calls.length} 条 / ${new Set(ledger.calls.map(c => c.screen)).size} 个账号`);
    console.log('状态分布', JSON.stringify(g));
    const pend = ledger.calls.filter(c => c.status === 'pending' && c.type !== 'observe');
    console.log(`\n待判定（有硬判据）：${pend.length} 条`);
    for (const c of pend) console.log(`  ${c.id} @${c.screen} ${c.type} ${c.level} by ${c.settleBy}｜${c.claim.slice(0, 40)}`);
    return;
  }

  const px = await loadPx();
  console.log(`行情 ${px[0].t} ~ ${px[px.length - 1].t}（${px.length} 根日线），判定日 ${today()}\n`);

  let changed = 0;
  for (const c of ledger.calls) {
    const r = judge(c, px);
    if (r.status !== c.status) changed++;
    c.status = r.status;
    c.result = r;
    c.advice = advice(c);
  }
  ledger.lastVerifiedAt = new Date().toISOString();
  ledger.priceThrough = px[px.length - 1].t;

  if (!isDry) fs.writeFileSync(LEDGER, JSON.stringify(ledger, null, 1), 'utf8');

  const groups = { hit: [], miss: [], pending: [], observe: [] };
  for (const c of ledger.calls) groups[c.status === 'observe' ? 'observe' : c.status].push(c);

  console.log(`判定完成：命中 ${groups.hit.length}｜打脸 ${groups.miss.length}｜待定 ${groups.pending.length}｜观察 ${groups.observe.length}（本次状态变化 ${changed} 条）\n`);
  if (groups.miss.length) {
    console.log('=== 已判错（建议处理）===');
    for (const c of groups.miss) console.log(`  ${c.id} @${c.screen} [${c.camp}] ${c.result?.detail ?? ""}\n      → ${c.advice}`);
    console.log();
  }
  if (groups.hit.length) {
    console.log('=== 已命中 ===');
    for (const c of groups.hit) console.log(`  ${c.id} @${c.screen} [${c.camp}] ${c.result?.detail ?? ""}`);
    console.log();
  }
  if (groups.pending.length) {
    console.log('=== 待定 ===');
    for (const c of groups.pending) console.log(`  ${c.id} @${c.screen} ${c.type}${c.level ? ' ' + c.level : ''} by ${c.settleBy}｜${c.result?.detail ?? ""}`);
  }

  // 写 markdown 报告
  const md = [];
  md.push(`# 观点台账验证报告 · ${today()}`);
  md.push('');
  md.push(`> 事件：${ledger.event}`);
  md.push(`> 行情截至：${ledger.priceThrough}｜台账 ${ledger.calls.length} 条 / ${new Set(ledger.calls.map(c => c.screen)).size} 个账号`);
  md.push(`> 判定：命中 ${groups.hit.length}｜打脸 ${groups.miss.length}｜待定 ${groups.pending.length}｜观察 ${groups.observe.length}`);
  md.push('');
  const table = (title, arr) => {
    if (!arr.length) return;
    md.push(`## ${title}`, '', '| ID | 博主 | 派系 | 主张 | 判据 | 结果 | 建议 |', '|---|---|---|---|---|---|---|');
    for (const c of arr) md.push(`| ${c.id} | @${c.screen} | ${c.camp} | ${c.claim.replace(/\|/g, '／')} | ${c.type}${c.level ? ' ' + c.level : ''} by ${c.settleBy} | ${c.result?.detail || '—'} | ${c.advice || '—'} |`);
    md.push('');
  };
  table('已判错（建议降级/拉黑）', groups.miss);
  table('已命中', groups.hit);
  table('待定', groups.pending);
  table('观察项（不计分）', groups.observe);
  md.push('## 验证时间表（到期后再跑一次 `node verify_calls.js`）', '');
  const byDate = {};
  for (const c of ledger.calls) {
    if (c.type === 'observe') continue;
    (byDate[c.settleBy] = byDate[c.settleBy] || []).push(c);
  }
  md.push('| 到期日 | 条数 | 涉及博主 | 看点 |', '|---|---:|---|---|');
  for (const d of Object.keys(byDate).sort()) {
    const arr = byDate[d];
    const screens = [...new Set(arr.map(c => '@' + c.screen))].join('、');
    const focus = arr.filter(c => c.camp.includes('看底') || c.camp.includes('看多')).length && arr.filter(c => c.camp.includes('看空')).length
      ? '多空双方同时结算，胜负分明'
      : arr.filter(c => c.camp.includes('看底') || c.camp.includes('看多')).length ? '看底/看多派成败' : '看空派目标位是否兑现';
    md.push(`| ${d} | ${arr.length} | ${screens} | ${focus} |`);
  }
  md.push('');

  md.push('## 拉黑规则（写死在台账 rules）', '');
  md.push('- 极端看空（≤60k）到期未跌到、且已反弹站上 70k → 拉黑');
  md.push('- 看底派在窗口内被跌破 level×(1−3%) → 降级；累计 2 次 → 拉黑');
  md.push('- 同一人同期给出方向相反的硬目标（如既喊 49k 又喊 75k）→ 标注，单独判');

  const out = path.join(OUTDIR, `calls_verification_${today().replace(/-/g, '')}.md`);
  fs.writeFileSync(out, md.join('\n'), 'utf8');
  console.log(`\n→ 报告 ${out}`);
  console.log(`→ 台账 ${LEDGER}`);
})();
