/**
 * my_journal.js —— 本人 BTC 观点台账：校验 / 机械结算 / 生成报告页
 *
 * 用法：
 *   node my_journal.js --check     校验字段完整性 + UTC 口径 + 必填项
 *   node my_journal.js --settle    拉 Binance 日线，按窗口内最高/最低价机械结算，写回台账
 *   node my_journal.js --status    终端查看待验证队列
 *   node my_journal.js --build     生成 btc-report/my-calls/index.html
 *
 * 判据（写死，不做事后解释）：
 *   up   : 窗口内 max(high) >= target  → hit；到期未达 → miss
 *   down : 窗口内 min(low)  <= target  → hit；到期未达 → miss
 *   窗口 : [date+1, min(today, settleBy)]，不拿记录当日已发生行情倒推
 *   过期未达 → miss；未过期 → pending
 *
 * 台账：F:/despseekharness/crawler/state/my_calls.json（可用 BTC_MY_LEDGER 覆盖）
 * 本台账只记观点，不记仓位与资金。
 */
const fs = require('fs');
const path = require('path');

const ROOT = process.env.BTC_CRAWLER_ROOT || 'F:/despseekharness/crawler';
const LEDGER = process.env.BTC_MY_LEDGER || path.join(ROOT, 'state', 'my_calls.json');
const SITE = process.env.BTC_SITE || path.join(ROOT, 'repo', 'btc-report');
const PX_CACHE = path.join(ROOT, 'state', 'btc_daily_my.json');

const API = 'https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=1d&limit=1000';
const args = process.argv.slice(2);
const has = f => args.includes(f);
const todayUTC = () => new Date().toISOString().slice(0, 10);

function load() { return JSON.parse(fs.readFileSync(LEDGER, 'utf8')); }
function save(o) { fs.writeFileSync(LEDGER, JSON.stringify(o, null, 2) + '\n', 'utf8'); }

async function loadPx() {
  try {
    const r = await fetch(API, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const a = await r.json();
    const px = a.map(k => ({
      t: new Date(k[0]).toISOString().slice(0, 10),
      o: +k[1], h: +k[2], l: +k[3], c: +k[4],
    }));
    fs.writeFileSync(PX_CACHE, JSON.stringify({ fetchedAt: new Date().toISOString(), px }), 'utf8');
    return px;
  } catch (e) {
    console.warn('⚠ 实时行情失败，用本地缓存：', e.message);
    if (!fs.existsSync(PX_CACHE)) throw new Error('无本地缓存 ' + PX_CACHE);
    return JSON.parse(fs.readFileSync(PX_CACHE, 'utf8')).px;
  }
}

/* ---------- 校验 ---------- */
const REQUIRED = ['id', 'date', 'pxAtRecord', 'direction', 'target', 'settleBy', 'basis', 'invalidation', 'expect'];
const DIRS = ['up', 'down'];

function check(ledger) {
  const errs = [], warns = [];
  const ids = new Set();
  for (const c of ledger.calls) {
    const at = `[${c.id || '?'}]`;
    if (ids.has(c.id)) errs.push(`${at} id 重复`);
    ids.add(c.id);
    for (const k of REQUIRED) {
      if (c[k] === undefined || c[k] === null || c[k] === '') errs.push(`${at} 缺字段 ${k}`);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(c.date || '')) errs.push(`${at} date 必须是 YYYY-MM-DD（UTC）`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(c.settleBy || '')) errs.push(`${at} settleBy 必须是 YYYY-MM-DD（UTC）`);
    if (c.date && c.settleBy && c.settleBy <= c.date) errs.push(`${at} settleBy 必须晚于 date`);
    if (!DIRS.includes(c.direction)) errs.push(`${at} direction 只能是 up / down`);
    if (c.direction === 'up' && c.target <= c.pxAtRecord) errs.push(`${at} up 的 target(${c.target}) 应高于记录价(${c.pxAtRecord})`);
    if (c.direction === 'down' && c.target >= c.pxAtRecord) errs.push(`${at} down 的 target(${c.target}) 应低于记录价(${c.pxAtRecord})`);
    if (!Array.isArray(c.basis) || !c.basis.length) errs.push(`${at} basis 不能为空`);
    if (!c.invalidation || c.invalidation.length < 4) errs.push(`${at} invalidation 必须可机械观测`);

    // 软疑虑
    const bad = (c.basis || []).filter(b => b.verdict === '无效');
    if (bad.length) warns.push(`${at} 有 ${bad.length} 条依据经回测判定为「无效」，已在页面标注`);
    const primary = (c.basis || []).filter(b => b.role === 'primary');
    if (!primary.length) warns.push(`${at} 没有 primary 依据`);
    if (primary.every(b => b.verdict === '无效')) warns.push(`${at} 全部 primary 依据均无效，方向即使对也不可归因`);
    const kol = (c.basis || []).filter(b => b.type === 'kol').length;
    if (kol && kol / c.basis.length > 0.5) warns.push(`${at} kol 类依据占比 ${Math.round(kol / c.basis.length * 100)}%（02 结论：无人跑赢基准）`);
    if (!/<\s*\d|<|大于|小于|跌破|站上|收盘/.test(c.invalidation || '')) warns.push(`${at} invalidation 未见明确数值/条件，可能不可机械判定`);
  }
  return { errs, warns };
}

/* ---------- 结算 ---------- */
function judge(c, px, today) {
  const start = c.date, end = c.settleBy < today ? c.settleBy : today;
  const win = px.filter(r => r.t > start && r.t <= end);
  if (!win.length) {
    // 窗口还没开始：结算仍待定，但把当前价带上供展示
    const last = px[px.length - 1];
    return {
      status: 'pending',
      detail: `等 ${start} 之后的行情（现价 ${Math.round(last.c)}）`,
      last: Math.round(last.c), lo: null, hi: null, through: last.t,
    };
  }

  const lo = Math.min(...win.map(r => r.l));
  const hi = Math.max(...win.map(r => r.h));
  const expired = today >= c.settleBy;
  const last = win[win.length - 1];
  const base = { lo: Math.round(lo), hi: Math.round(hi), last: Math.round(last.c), days: win.length, through: last.t };

  if (c.direction === 'up') {
    if (hi >= c.target) {
      const hit = win.find(r => r.h >= c.target);
      return { status: 'hit', hitDate: hit.t, detail: `最高 ${Math.round(hi)} 已达 ${c.target}（${hit.t} 触达）`, ...base };
    }
    return expired
      ? { status: 'miss', detail: `到期未达 ${c.target}，窗口最高仅 ${Math.round(hi)}（差 ${Math.round(c.target - hi)}）`, ...base }
      : { status: 'pending', detail: `窗口最高 ${Math.round(hi)}，距 ${c.target} 还差 ${Math.round(c.target - hi)}`, ...base };
  }
  if (c.direction === 'down') {
    if (lo <= c.target) {
      const hit = win.find(r => r.l <= c.target);
      return { status: 'hit', hitDate: hit.t, detail: `最低 ${Math.round(lo)} 已达 ${c.target}（${hit.t} 触达）`, ...base };
    }
    return expired
      ? { status: 'miss', detail: `到期未跌到 ${c.target}，窗口最低仅 ${Math.round(lo)}（差 ${Math.round(lo - c.target)}）`, ...base }
      : { status: 'pending', detail: `窗口最低 ${Math.round(lo)}，距 ${c.target} 还差 ${Math.round(lo - c.target)}`, ...base };
  }
  return { status: 'pending', detail: '未知 direction' };
}

/* ---------- 页面 ---------- */
const esc = s => String(s ?? '').replace(/[&<>"]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
const fmt = n => typeof n === 'number' ? n.toLocaleString('en-US') : n;
const VERDICT = { '有效': ['good', '有效'], '弱': ['warn', '弱'], '无效': ['warn', '无效'], '部分': ['gray', '部分'] };

function build(ledger) {
  const calls = [...ledger.calls].sort((a, b) => b.date.localeCompare(a.date));
  const today = todayUTC();
  const settled = calls.filter(c => c.status === 'hit' || c.status === 'miss');
  const hits = settled.filter(c => c.status === 'hit').length;
  const pend = calls.filter(c => c.status === 'pending');
  const winRate = settled.length ? Math.round(hits / settled.length * 100) : null;
  // 依据审查：取最近一条记录的 audits，无则空
  const audits = calls.length && Array.isArray(calls[0].audits) ? calls[0].audits : [];

  const card = c => {
    const r = c.result || {};
    const dirLabel = c.direction === 'up' ? '看涨' : '看跌';
    const dirCls = c.direction === 'up' ? 'rise' : 'fall';
    const st = c.status === 'hit' ? ['ok', '已验证：命中']
      : c.status === 'miss' ? ['bad', '已验证：未中']
      : ['', `待验证 · ${r.detail || ''}`];
    const basisRows = (c.basis || []).map(b => {
      const v = VERDICT[b.verdict] || ['gray', b.verdict || '未审'];
      const role = b.role === 'primary' ? '<span class="tag neg">主依据</span>' : '<span class="tag gray">辅助</span>';
      return `<tr>
        <td>${role}</td>
        <td>${esc(b.summary || b.ref)}${b.quant ? `<div class="quant">${String(b.quant).split('｜').map(x => `<div>${esc(x.trim())}</div>`).join('')}</div>` : ''}${b.ref && b.summary ? `<div class="small" style="margin-top:3px">${esc(b.ref)}</div>` : ''}</td>
        <td><span class="tag ${v[0]}">${esc(v[1])}</span></td>
      </tr>${b.audit ? `<tr><td></td><td colspan="2" class="small">审查：${esc(b.audit)}</td></tr>` : ''}`;
    }).join('');
    const basisText = (c.basis || []).filter(b => b.role === 'primary')
      .map(b => b.summary || b.ref).join('；') || '—';

    return `<div class="call ${c.status}">
      <div class="ch">
        <span class="cid">${esc(c.id)}</span>
        <span class="cdate">${esc(c.date)}</span>
        <span class="${dirCls}">${dirLabel}</span>
        <span class="arrow">→</span>
        <span class="tgt">${fmt(c.target)}</span>
        <span class="st ${c.status}">${c.status === 'hit' ? '命中' : c.status === 'miss' ? '未中' : '待验证'}</span>
      </div>
      <div class="meta">
        <span>记录时价 <b>${fmt(c.pxAtRecord)}</b></span>
        ${c.lowAtRecord ? `<span>当日低点 <b>${fmt(c.lowAtRecord)}</b></span>` : ''}
        <span>结算日 <b>${esc(c.settleBy)}</b></span>
        ${r.through ? `<span>行情至 <b>${esc(r.through)}</b></span>` : ''}
      </div>
      <div class="expect">${esc(c.expect)}</div>
      <table class="basis">
        <tr><th style="width:78px">类型</th><th>依据</th><th style="width:64px">回测判定</th></tr>
        ${basisRows}
      </table>
      <div class="inv"><b>失效条件：</b>${esc(c.invalidation)}</div>
      ${r.detail ? `<div class="status-line ${c.status}">${esc(r.detail)}</div>` : ''}
    </div>`;
  };

  const queue = pend.map(c => {
    const r = c.result || {};
    const daysLeft = Math.round((new Date(c.settleBy) - new Date(today)) / 864e5);
    const basisText = (c.basis || []).filter(b => b.role === 'primary')
      .map(b => b.summary || b.ref).join('；') || '—';
    return `<tr>
      <td class="num">${esc(c.id)}</td>
      <td>${esc(c.date)}</td>
      <td class="${c.direction === 'up' ? 'rise' : 'fall'}">${c.direction === 'up' ? '看涨' : '看跌'}</td>
      <td class="num">${fmt(c.target)}</td>
      <td>${esc(basisText)}</td>
      <td class="num">${r.last ? fmt(r.last) : '—'}</td>
      <td class="num">${r.hi ? fmt(r.hi) : '—'}</td>
      <td class="num">${r.lo ? fmt(r.lo) : '—'}</td>
      <td>${esc(c.settleBy)}</td>
      <td class="num">${daysLeft >= 0 ? 'D-' + daysLeft : '已过期'}</td>
    </tr>`;
  }).join('');

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>我的观点与预测 · BTC 研究站</title>
<link rel="stylesheet" href="../assets/report.css">
<style>
  .call{background:var(--panel);border:1px solid var(--line);border-radius:11px;padding:15px 17px;margin:13px 0}
  .call.hit{border-color:rgba(61,220,151,.28)}
  .call.miss{border-color:rgba(242,85,90,.28)}
  .ch{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:9px}
  .cid{font-family:var(--mono);font-size:12px;color:var(--acc);background:rgba(240,180,41,.09);
    border:1px solid rgba(240,180,41,.22);border-radius:6px;padding:1px 8px}
  .cdate{font-family:var(--mono);font-size:12px;color:var(--txt3)}
  .ch>span:not(.cid):not(.cdate){font-size:13px;font-weight:600}
  .arrow{color:var(--txt3);font-size:13px}
  .tgt{font-family:var(--mono);font-size:15px;color:var(--txt)!important}
  .st{margin-left:auto;font-size:11px;padding:2px 9px;border-radius:20px;font-weight:500}
  .st.pending{background:rgba(240,180,41,.1);color:#e0a72a}
  .st.hit{background:rgba(61,220,151,.12);color:var(--fall)}
  .st.miss{background:rgba(242,85,90,.12);color:var(--rise)}
  .meta{display:flex;gap:16px;flex-wrap:wrap;font-size:11.5px;color:var(--txt3);margin-bottom:9px}
  .meta b{color:var(--txt2);font-family:var(--mono);font-weight:500}
  .expect{font-size:13px;color:var(--txt);background:var(--panel2);border-radius:8px;padding:9px 12px;margin:9px 0;line-height:1.7}
  table.basis{margin:9px 0;font-size:12px}
  table.basis td{vertical-align:top}
  .inv{font-size:12px;color:var(--txt2);margin-top:8px}
  .status-line{font-size:11.5px;color:var(--txt3);margin-top:8px;padding-top:8px;border-top:1px dashed var(--line)}
  .status-line.hit{color:var(--fall)} .status-line.miss{color:var(--rise)}
  .empty{color:var(--txt3);font-size:13px;padding:20px;text-align:center}
  .quant{font-family:var(--mono);font-size:11px;color:var(--acc2);background:rgba(91,157,255,.07);
    border-left:2px solid rgba(91,157,255,.35);border-radius:4px;padding:4px 8px;margin:6px 0;line-height:1.7}
</style>
</head>
<body>
<div class="wrap">
  <div class="crumb"><a href="../">首页</a><span>/</span>04 我的观点与预测</div>
  <div class="series">TOPIC 04</div>
  <h1>我的观点与预测</h1>
  <div class="sub">只记判断，不记仓位｜UTC 日线机械结算｜记录后不修改，靠时间验证</div>

  <div class="grid">
    <div class="kpi"><div class="n">${calls.length}</div><div class="l">累计观点</div></div>
    <div class="kpi"><div class="n plain">${pend.length}</div><div class="l">待验证</div></div>
    <div class="kpi"><div class="n ${winRate !== null && winRate >= 50 ? 'rise' : 'fall'}">${winRate === null ? '—' : winRate + '%'}</div><div class="l">已结算命中率（${hits}/${settled.length}）</div></div>
    <div class="kpi"><div class="n">${today}</div><div class="l">行情截至（UTC）</div></div>
  </div>

  <div class="callout"><strong>判定规则：</strong>方向为「看涨」时，窗口内最高价触及目标即命中；「看跌」时最低价触及即命中。<strong>触及即刻结算，不必等到窗口到期</strong>；到 <code>settleBy</code> 仍未触及才判未中。窗口从记录日次日算起。<strong>记录后的原话不改</strong>，判错也留档。</div>
  <p class="small">当前无自动化定时任务。命中与未中的判定由 <code>my_journal.js --settle</code> 驱动，需在会话中手动触发——每次你说到 BTC，我会先跑一次并报告状态。</p>

  <h2>一、待验证队列</h2>
  ${queue ? `<table>
    <tr><th>ID</th><th>记录日</th><th>方向</th><th class="num">目标</th><th style="min-width:200px">判断依据</th><th class="num">现价</th><th class="num">窗口最高</th><th class="num">窗口最低</th><th>结算日</th><th class="num">剩余</th></tr>
    ${queue}
  </table>` : `<div class="card"><div class="empty">暂无待验证观点</div></div>`}

  <h2>二、观点时间线</h2>
  ${calls.length ? calls.map(card).join('') : `<div class="card"><div class="empty">暂无记录</div></div>`}

  <h2>三、依据审查与统计</h2>
  <div class="card">
    <p class="small" style="margin-top:0">我的判断依据会先做回测检验，再写进台账。检验不过的依据照样留档，标「无效」——这样事后能分清<strong>方向对</strong>和<strong>依据对</strong>。</p>
    <div class="note" style="margin:10px 0 14px">
      <strong style="color:var(--txt)">怎么读下面这张表</strong>
      <ul class="small" style="margin:8px 0 0">
        <li><strong>样本 N 次</strong>：历史上这个信号一共触发过多少次。样本越少，结论越不可靠。</li>
        <li><strong>N 日上涨 x%</strong>：信号出现后第 N 天，BTC 收盘价高于信号当日收盘价的比例。只要求「涨了」，涨多少都算。</li>
        <li><strong>N 日触及 y%</strong>：信号出现后 N 天内，BTC <em>任意一天的最高价</em>曾涨到目标幅度（本次为 +11.85%，即 67,057 → 75,000）的比例。这个要求比「上涨」高得多。</li>
        <li><strong>基准 z%</strong>：不看信号、随便挑一天进场的同口径命中率。2024-2026 年市场整体偏涨，所以基准本身就有 51%~54%。</li>
        <li><strong>超额 = 信号 − 基准</strong>。只有超额为正，信号才有价值；等于基准说明这个依据等于没看。</li>
      </ul>
    </div>
    ${audits.length ? `<table>
      <tr>
        <th style="width:170px">检验口径</th>
        <th style="width:44px">方向</th>
        <th class="num" style="width:60px">样本</th>
        <th class="num" style="width:88px">7 日</th>
        <th class="num" style="width:88px">14 日</th>
        <th class="num" style="width:88px">30 日</th>
        <th style="width:110px">三段一致性</th>
        <th style="width:76px">判定</th>
      </tr>
      ${audits.map(a => {
        const cell = h => h && !Number.isNaN(h.win)
          ? `<td class="num">${h.win.toFixed(1)}%<div class="small">基准 ${h.base.toFixed(1)}%</div><div class="small ${h.edge >= 0 ? 'rise' : 'fall'}">${h.edge >= 0 ? '+' : ''}${h.edge.toFixed(1)}pt</div></td>`
          : `<td class="num small">—</td>`;
        const byH = {}; for (const h of (a.horizons || [])) byH[h.d] = h;
        const th = a.thirds;
        const thCell = Array.isArray(th)
          ? th.map(x => `<span class="${x >= 0 ? 'rise' : 'fall'}">${x >= 0 ? '+' : ''}${x}pt</span>`).join(' / ')
          : '<span class="small">—</span>';
        const vTag = /^无效|劣于|无预测/.test(a.verdict) ? 'warn' : a.verdict === '观察' ? 'neg' : a.verdict === '样本不足' ? 'gray' : 'good';
        const n = byH[30]?.n ?? byH[14]?.n ?? byH[7]?.n ?? '—';
        return `<tr>
          <td>${esc(a.claim)}${a.note ? `<div class="small" style="margin-top:4px">${esc(a.note)}</div>` : ''}</td>
          <td>${a.dir === 'up' ? '<span class="tag bull">看涨</span>' : '<span class="tag bear">看跌</span>'}</td>
          <td class="num">${n}</td>
          ${cell(byH[7] || { win: NaN, base: NaN, edge: NaN })}
          ${cell(byH[14] || { win: NaN, base: NaN, edge: NaN })}
          ${cell(byH[30] || { win: NaN, base: NaN, edge: NaN })}
          <td class="small">${thCell}</td>
          <td><span class="tag ${vTag}">${esc(a.verdict)}</span></td>
        </tr>`;
      }).join('')}
    </table>` : `<div class="empty">暂无审查记录</div>`}
    <p class="small" style="margin-bottom:0">全样本基准 = 同期任意交易日的同口径命中率（不挑信号）。1000 天日线，2024-02-19 ~ ${today}。超额 = 信号命中 − 基准，正才算有效。</p>
  </div>

  <h2>四、方法与局限</h2>
  <div class="card">
    <ul class="small">
      <li><strong>价格来源</strong>：Binance BTCUSDT 日线（UTC 00:00 收）。不同交易所低点可能差几十美元，以本条为准。</li>
      <li><strong>窗口从记录日次日算起</strong>，不拿当天已发生的行情倒推，避免「事后诸葛」。</li>
      <li><strong>只判方向是否触及目标</strong>，不判路径、不判中间波动。触及即命中，到期未触及即未中。</li>
      <li><strong>已知偏差</strong>：单根日线内「先破后达」无法区分；样本不足时胜率不可外推。</li>
      <li>本页不记录仓位、资金规模与盈亏，不构成投资建议。</li>
    </ul>
  </div>

  <div class="foot">
    生成 ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC｜台账 <code>state/my_calls.json</code>｜
    结算脚本 <code>my_journal.js</code>｜<a href="../">返回首页</a><br>
    观点记录后不修改；口径变更会升版本并注明。
  </div>
</div>
</body>
</html>`;

  const outDir = path.join(SITE, 'my-calls');
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, 'index.html');
  fs.writeFileSync(out, html, 'utf8');
  console.log('→ 页面', out);
}

/* ---------- main ---------- */
(async () => {
  const ledger = load();

  if (has('--check')) {
    const { errs, warns } = check(ledger);
    console.log(`台账 ${ledger.calls.length} 条｜版本 ${ledger.version}\n`);
    if (errs.length) { console.log('❌ 硬错误（必须修）：'); errs.forEach(e => console.log('  ' + e)); }
    else console.log('✅ 字段与口径校验通过');
    if (warns.length) { console.log('\n⚠ 软疑虑（仅供参考）：'); warns.forEach(w => console.log('  ' + w)); }
    process.exit(errs.length ? 1 : 0);
  }

  if (has('--status')) {
    const px = await loadPx();
    const today = todayUTC();
    console.log(`行情至 ${px[px.length - 1].t}｜今日 ${today}\n`);
    for (const c of ledger.calls) {
      const r = judge(c, px, today);
      const mark = r.status === 'hit' ? '✅' : r.status === 'miss' ? '❌' : '⏳';
      console.log(`${mark} ${c.id} ${c.date} ${c.direction} → ${fmt(c.target)} by ${c.settleBy}`);
      console.log(`   ${r.detail}`);
    }
    return;
  }

  if (has('--settle')) {
    const px = await loadPx();
    const today = todayUTC();
    let changed = 0;
    for (const c of ledger.calls) {
      const r = judge(c, px, today);
      if (r.status !== c.status) changed++;
      c.status = r.status; c.result = r;
    }
    ledger.lastSettledAt = new Date().toISOString();
    ledger.priceThrough = px[px.length - 1].t;
    save(ledger);
    const g = ledger.calls.reduce((a, c) => (a[c.status] = (a[c.status] || 0) + 1, a), {});
    console.log(`结算完成：状态变化 ${changed} 条｜${JSON.stringify(g)}`);
    return;
  }

  if (has('--build')) { build(ledger); return; }

  console.log('用法：--check | --settle | --status | --build');
})();
