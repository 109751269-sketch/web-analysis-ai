const fs = require('fs');
const path = require('path');

const { resolveRoot, resolveDataRoot } = require('./paths');
const ROOT = resolveRoot();
const DATA = resolveDataRoot();
const OUT_DIR = process.env.REPORT_OUT || path.join(ROOT, 'html');

const R = JSON.parse(fs.readFileSync(path.join(ROOT, 'final_v3.json'), 'utf8'));
const S = JSON.parse(fs.readFileSync(path.join(ROOT, 'sim_results.json'), 'utf8'));
const L = JSON.parse(fs.readFileSync(path.join(ROOT, 'ledger.json'), 'utf8'));

const ledgerOf = new Map(L.map(x => [x.screen, x]));
const simOf = new Map(S.map(x => [x.screen, x]));
const cfgKeys = ['8%/60d', '8%/90d', '15%/90d', '25%/120d'];

const pct = (v, d = 0) => (v == null ? '--' : (v * 100).toFixed(d) + '%');
const pt = (v) => (v == null ? '--' : (v > 0 ? '+' : '') + (v * 100).toFixed(0) + 'pt');
const money = (v) => (v == null ? '--' : Math.round(v).toLocaleString('en-US'));

// 稳健性分组
const pos = R.filter(r => r.stab === 'stable_pos').sort((a, b) => (b.verified || 0) - (a.verified || 0));
const neg = R.filter(r => r.stab === 'stable_neg').sort((a, b) => (a.excess ?? 9) - (b.excess ?? 9));
const uns = R.filter(r => r.stab === 'unstable');
const low = R.filter(r => r.stab === 'unknown' || r.verified < 5);

// 模拟交易排行（>=5笔）
const simRank = S.filter(x => x.nTrades >= 5).sort((a, b) => (b.medianRet ?? -9) - (a.medianRet ?? -9));
const bhRet = (() => {
  const px = JSON.parse(fs.readFileSync(path.join(DATA, 'btc_daily.json'), 'utf8')).filter(r => r.t >= '2026-01-01');
  return px[px.length - 1].c / px[0].c - 1;
})();

// 分类
const byType = {};
for (const r of R) (byType[r.type.code] = byType[r.type.code] || []).push(r);

const NODE_NAMES = ['2月大底 6W', '5月阶段顶 8W2', '7月大底 5W7', '10月阶段顶 8W7'];
const NODE_DATES = ['2026-02-06', '2026-05-06', '2026-07-01', '2026-09-21'];
const NODE_PRICES = [60000, 82850, 57800, 87396];

const CSS = `
:root{
  --bg:#080a0f; --panel:#11161f; --panel2:#151b26;
  --line:#1f2836; --line2:#2a3546;
  --txt:#e8edf5; --txt2:#9aa7bb; --txt3:#67748a;
  --acc:#f0b429; --acc2:#5b9dff; --up:#3ddc97; --dn:#ff5d6c;
  --mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace;
}
*{box-sizing:border-box;margin:0;padding:0}
body{
  background:var(--bg); color:var(--txt);
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
  line-height:1.7; -webkit-font-smoothing:antialiased; min-height:100vh;
  background-image:
    radial-gradient(900px 460px at 12% -8%,rgba(91,157,255,.12),transparent 62%),
    radial-gradient(760px 400px at 88% 4%,rgba(240,180,41,.07),transparent 66%);
}
.wrap{max-width:1100px;margin:0 auto;padding:0 24px}
header{padding:64px 0 40px;border-bottom:1px solid var(--line)}
.eyebrow{display:inline-flex;align-items:center;gap:8px;font-size:12px;letter-spacing:.16em;
  text-transform:uppercase;color:var(--acc);border:1px solid rgba(240,180,41,.28);
  background:rgba(240,180,41,.07);padding:6px 14px;border-radius:99px;margin-bottom:22px;font-weight:600}
.eyebrow .dot{width:6px;height:6px;border-radius:50%;background:var(--acc);box-shadow:0 0 12px var(--acc)}
h1{font-size:clamp(28px,4vw,40px);font-weight:800;letter-spacing:-.02em;margin-bottom:12px}
h1 .grad{background:linear-gradient(100deg,#fff,#9fc4ff 45%,#f0b429 85%);
  -webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}
.lede{color:var(--txt2);font-size:15px}
main{padding:36px 0 80px}
h2{font-size:20px;font-weight:700;margin:44px 0 8px;letter-spacing:-.01em}
h2:first-child{margin-top:0}
h3{font-size:15px;font-weight:650;margin:28px 0 10px;color:var(--txt)}
h2 .num{color:var(--acc);font-family:var(--mono);font-size:14px;margin-right:10px}
p{color:var(--txt2);font-size:14.5px;margin:10px 0}
p strong{color:var(--txt)}
.note{background:rgba(91,157,255,.06);border-left:3px solid var(--acc2);padding:12px 16px;border-radius:0 8px 8px 0;margin:14px 0;font-size:13.5px;color:var(--txt2)}
.warn{background:rgba(255,93,108,.07);border-left:3px solid var(--dn);padding:12px 16px;border-radius:0 8px 8px 0;margin:14px 0;font-size:13.5px;color:#ffb3ba}
table{width:100%;border-collapse:collapse;margin:14px 0;font-size:13px}
th{text-align:left;padding:10px 12px;border-bottom:1px solid var(--line2);color:var(--txt3);
  font-size:11px;letter-spacing:.08em;text-transform:uppercase;font-weight:600;white-space:nowrap}
td{padding:10px 12px;border-bottom:1px solid var(--line);vertical-align:top}
tr:hover td{background:rgba(255,255,255,.015)}
.mono{font-family:var(--mono);font-size:12.5px}
.pos{color:var(--up);font-weight:600}
.neg{color:var(--dn);font-weight:600}
.dim{color:var(--txt3)}
.badge{display:inline-block;font-size:11px;font-weight:700;padding:2px 8px;border-radius:5px;letter-spacing:.04em}
.b-s{background:rgba(61,220,151,.15);color:var(--up);border:1px solid rgba(61,220,151,.35)}
.b-a{background:rgba(91,157,255,.15);color:var(--acc2);border:1px solid rgba(91,157,255,.35)}
.b-b{background:rgba(240,180,41,.12);color:var(--acc);border:1px solid rgba(240,180,41,.3)}
.b-c{background:rgba(154,167,187,.1);color:var(--txt2);border:1px solid var(--line2)}
.b-d{background:rgba(103,116,138,.1);color:var(--txt3);border:1px solid var(--line)}
.b-neg{background:rgba(255,93,108,.12);color:var(--dn);border:1px solid rgba(255,93,108,.35)}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px;margin:18px 0}
.kpi{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:16px 18px}
.kpi .k{font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--txt3);margin-bottom:6px}
.kpi .v{font-size:24px;font-weight:750;font-family:var(--mono)}
.kpi .s{font-size:12px;color:var(--txt3);margin-top:4px}
.scroll{overflow-x:auto;border-radius:10px;border:1px solid var(--line)}
.scroll table{margin:0}
.scroll th{background:var(--panel)}
.quote{color:var(--txt3);font-size:12.5px;font-style:normal}
footer{border-top:1px solid var(--line);padding:24px 0 48px;font-size:12px;color:var(--txt3);font-family:var(--mono)}
a{color:var(--acc2)}
a.acct{color:inherit;text-decoration:none;border-bottom:1px solid rgba(91,157,255,.28);transition:color .15s ease,border-color .15s ease}
a.acct:hover{color:var(--acc2);border-bottom-color:var(--acc2)}
@media(max-width:640px){table{font-size:12px}td,th{padding:8px}}
`;

const H = [];
const P = (s = '') => H.push(s);
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// 账号名 → 推特主页链接（X handle 仅含 [A-Za-z0-9_]，可安全 encode）
const acct = (handle) =>
  `<a class="acct" href="https://x.com/${encodeURIComponent(handle)}" target="_blank" rel="noopener noreferrer">@${esc(handle)}</a>`;

const badge = (band) => {
  const m = { S: 'b-s', A: 'b-a', B: 'b-b', C: 'b-c', D: 'b-d' };
  const cls = band === '负分' || band === '负分档' ? 'b-neg' : (m[band.charAt(0)] || 'b-d');
  return `<span class="badge ${cls}">${esc(band)}</span>`;
};

P('<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">');
P('<meta name="viewport" content="width=device-width, initial-scale=1">');
P('<title>推特 BTC 博主预测能力评测 · 2026 全年</title>');
P(`<style>${CSS}</style></head><body><div class="wrap">`);

P('<header>');
P('<div class="eyebrow"><span class="dot"></span>BTC Research</div>');
P('<h1>推特 BTC 博主<span class="grad"> 预测能力评测</span></h1>');
P(`<p class="lede">2026-01-01 ~ 2026-11-11 ｜ ${R.length} 个博主 ｜ ${R.reduce((a, r) => a + r.predsCount, 0)} 条明确预测 ｜ 用真实 BTC 日线逐条验证</p>`);
P('</header><main>');

// ---------- 结论 ----------
P('<h2><span class="num">00</span>先说结论</h2>');
P('<div class="cards">');
P(`<div class="kpi"><div class="k">博主总数</div><div class="v">${R.length}</div><div class="s">有实质 BTC 数据的账号</div></div>`);
P(`<div class="kpi"><div class="k">明确预测</div><div class="v">${R.reduce((a, r) => a + r.predsCount, 0)}</div><div class="s">全部逐字核对原文</div></div>`);
P(`<div class="kpi"><div class="k">4 口径稳定为正</div><div class="v pos">${pos.length}</div><div class="s">其中样本≥5 的仅 ${pos.filter(r => r.verified >= 5).length} 个</div></div>`);
P(`<div class="kpi"><div class="k">模拟跑赢买入持有</div><div class="v">${simRank.filter(x => x.medianRet > bhRet).length} / ${simRank.length}</div><div class="s">买入持有基准 ${pct(bhRet, 1)}</div></div>`);
P('</div>');

P('<div class="note"><strong>核心方法：不能直接算胜率。</strong>2026 年 BTC 振幅极大（9.79万 → 5.78万 → 8.74万）。随机日期无脑喊「涨 8%」命中 <strong>67.1%</strong>，喊「跌 8%」命中 <strong>65.8%</strong>。所以必须用「超额胜率 = 实际命中 − 同日同向基准」，再做 4 口径稳健性检验。</div>');

P('<h3>两种口径的结论不同，都必须看</h3>');
P('<div class="scroll"><table><thead><tr><th>口径</th><th>衡量什么</th><th>结论</th></tr></thead><tbody>');
const bestSim = simRank[0];
P(`<tr><td><strong>严格口径</strong></td><td>预测方向是否在窗口内达标（要求高）</td><td>4 口径稳定为正且样本≥5 的只有 <strong>${pos.filter(r => r.verified >= 5).length}</strong> 个</td></tr>`);
P(`<tr><td><strong>模拟操作</strong></td><td>照着买卖能否赚钱（含 10% 止损、模糊容错）</td><td>跑赢买入持有（${pct(bhRet, 1)}）的有 <strong>${simRank.filter(x => x.medianRet > bhRet).length}</strong> 个，最好的是 @${esc(bestSim.screen)}，中位收益 ${pct(bestSim.medianRet, 1)}</td></tr>`);
P('</tbody></table></div>');
P('<div class="note"><strong>为什么两个结论不同？</strong>严格口径会把「抄底略早、短期磨一下、最终涨起来」判成错，对博主不公平；但模拟操作若不加止损，也会把「先亏 40% 再涨回来」当成赚。所以本报告同时给出两者：<strong>严格口径看预测能力，模拟操作看实战收益（已加 10% 止损）</strong>。</div>');

P('<h3>严格口径：4 口径稳定为正的账号</h3>');
if (pos.length) {
  P('<div class="scroll"><table><thead><tr><th>账号</th><th>8%/60d</th><th>8%/90d</th><th>15%/90d</th><th>25%/120d</th><th>原始胜率</th><th>可验证</th></tr></thead><tbody>');
  for (const r of pos) {
    const c = r.cells;
    P(`<tr><td><strong>${acct(r.screen)}</strong></td>` +
      cfgKeys.map(k => `<td class="mono ${(c[k]?.excess ?? 0) > 0 ? 'pos' : 'neg'}">${pt(c[k]?.excess)}</td>`).join('') +
      `<td class="mono">${pct(r.rawWinRate)}</td><td class="mono">${r.verified}</td></tr>`);
  }
  P('</tbody></table></div>');
  P('<p class="dim">样本 &lt;5 条的账号即便 4 口径同正也不应作为交易依据——统计上不具意义。</p>');
} else P('<p>无。</p>');

P('<h3>明确判定为「跌了看跌、涨了看涨」</h3>');
const followers = R.filter(x => x.trend.rate != null && x.trend.n >= 8 && x.trend.rate >= 0.72);
if (followers.length) {
  P('<div class="scroll"><table><thead><tr><th>账号</th><th>追涨杀跌率</th><th>样本</th><th>说明</th></tr></thead><tbody>');
  for (const r of followers) P(`<tr><td><strong>${acct(r.screen)}</strong></td><td class="neg mono">${pct(r.trend.rate)}</td><td class="mono">${r.trend.n} 次</td><td>${esc(r.reason || '')}</td></tr>`);
  P('</tbody></table></div>');
} else P('<p class="dim">无。</p>');

// ---------- 方法 ----------
P('<h2><span class="num">01</span>方法：三重校正</h2>');
P('<h3>① 基准校正</h3>');
P('<p>「未来 N 天内方向移动达阈值」直接算胜率会虚高。基准 = 该预测日 ±45 天邻域内、同方向、同规则的命中率。超额 = 实际 − 基准。</p>');
P('<h3>② 4 口径稳健性</h3>');
P('<p>±8%/60天、±8%/90天、±15%/90天、±25%/120天。只有 4 个口径<strong>同号且幅度 &gt;2pt</strong> 才认定「稳定」；口径间符号翻转 = 结论依赖行情噪音，不下判断。</p>');
P('<h3>③ 语义抽取 + 逐字审计</h3>');
P('<p>正则无法区分「预测」与「复盘」（"之前我说过会跌""果然如此"会被误判）。改用 LLM 逐条精读并强制结构化输出，要求 <span class="mono">quote</span> 逐字摘录；再用脚本把 quote 去空白后回原文 substring 校验。本次全部预测审计后 <strong>0 处编造</strong>。</p>');
P('<div class="warn"><strong>已修复的两个评分 bug：</strong>①「预测命中」与「基准」曾用不同标尺（前者按目标价、后者按固定幅度），导致给出远目标价的账号被系统性压低；② 追涨杀跌判定缺少方向多样性门，单边看空者在下跌年会被误判。</div>');

// ---------- 大周期节点 ----------
P('<h2><span class="num">02</span>关键大周期节点命中</h2>');
P('<p>四个真实节点，判定标准：节点前窗口内给出同方向预测，且目标价落在节点价 ±8% 内（强命中）；仅有顶/底措辞无价格为弱命中。</p>');
P('<div class="scroll"><table><thead><tr><th>节点</th><th>日期</th><th>真实价</th><th>强命中</th><th>弱命中</th></tr></thead><tbody>');
NODE_NAMES.forEach((nm, i) => {
  const strong = R.filter(r => r.nodes[i]?.hit).map(r => '@' + r.screen);
  const weak = R.filter(r => r.nodes[i]?.weakHit).map(r => '@' + r.screen);
  P(`<tr><td><strong>${nm}</strong></td><td class="mono">${NODE_DATES[i]}</td><td class="mono">${money(NODE_PRICES[i])}</td><td>${strong.join(', ') || '<span class="dim">无</span>'}</td><td class="dim">${weak.join(', ') || '—'}</td></tr>`);
});
P('</tbody></table></div>');
const maxHit = Math.max(...R.map(r => r.nodeHit));
P(`<p><strong>没有任何账号命中超过 ${maxHit} 个节点。</strong>这批博主对大周期顶底的判断普遍不可用。</p>`);

// ---------- 模拟操作 ----------
P('<h2><span class="num">03</span>模拟操作：如果照他说的时间点买卖</h2>');
P('<p>规则：按预测日收盘价入场；做多遇 −10% 止损、触及目标价止盈，否则 120 天平仓；做空反向。按<strong>中位收益</strong>排序（避免被单笔大赚拉偏）。</p>');
P(`<div class="note">2026 全年买入持有 = <strong class="${bhRet > 0 ? 'pos' : 'neg'}">${pct(bhRet, 1)}</strong>。下表只列交易笔数 ≥5 的账号。</p>`);
P('<div class="scroll"><table><thead><tr><th>#</th><th>账号</th><th>笔数</th><th>中位收益</th><th>均收益</th><th>胜率</th><th>止损率</th><th>模糊正确率</th></tr></thead><tbody>');
simRank.forEach((r, i) => {
  P(`<tr><td class="mono dim">${i + 1}</td><td><strong>${acct(r.screen)}</strong></td><td class="mono">${r.nTrades}</td>` +
    `<td class="mono ${r.medianRet > 0 ? 'pos' : 'neg'}">${pct(r.medianRet, 1)}</td>` +
    `<td class="mono ${r.avgRet > 0 ? 'pos' : 'neg'}">${pct(r.avgRet, 1)}</td>` +
    `<td class="mono">${pct(r.winRate)}</td>` +
    `<td class="mono">${pct(r.stopRate)}</td>` +
    `<td class="mono">${pct(r.fuzzyRate)}</td></tr>`);
});
P('</tbody></table></div>');
P('<p class="dim"><strong>模糊正确</strong> = 允许抄底略早（最大不利偏移 ≤8%）但后续确实走出 ≥5% 上升空间。这是对「长期看对、短期磨人」的宽松判定。</p>');

// ---------- 分类画像 ----------
P('<h2><span class="num">04</span>博主分类与画像</h2>');
P('<div class="scroll"><table><thead><tr><th>类型</th><th>含义</th><th>数量</th></tr></thead><tbody>');
const typeLabel = { A1: '有分析·有明确点位', A2: '有分析·偏宏观无点位', B: '模棱两可', C: '娱乐·瞎猜', D: '样本不足', E: '推广/喊单为主' };
for (const k of ['A1', 'A2', 'B', 'C', 'D', 'E']) {
  P(`<tr><td>${badge(k)}</td><td>${typeLabel[k]}</td><td class="mono">${(byType[k] || []).length}</td></tr>`);
}
P('</tbody></table></div>');

P('<h3>帖子构成占比（BTC 原创 ≥15 条）</h3>');
P('<div class="scroll"><table><thead><tr><th>账号</th><th>总推文</th><th>BTC分析</th><th>模棱两可</th><th>纯宏观</th><th>闲聊</th><th>推广</th><th>类型</th></tr></thead><tbody>');
const prof = R.filter(r => r.total_tweets >= 15 && r.cat).sort((a, b) => b.btc_tweets - a.btc_tweets);
for (const r of prof.slice(0, 28)) {
  const c = r.cat, t = r.total_tweets || 1;
  const f = (x) => ((x || 0) / t * 100).toFixed(0) + '%';
  P(`<tr><td><strong>${acct(r.screen)}</strong></td><td class="mono">${r.total_tweets}</td><td class="mono">${f(c.btc_analysis)}</td><td class="mono">${f(c.btc_vague)}</td><td class="mono">${f(c.macro_only)}</td><td class="mono">${f(c.commentary)}</td><td class="mono">${f(c.promo)}</td><td>${badge(r.type.code)}</td></tr>`);
}
P('</tbody></table></div>');

// ---------- 台账 ----------
P('<h2><span class="num">05</span>逐条预测台账</h2>');
P('<p>「预测日 · 当时价格 → 方向 目标价 · 后续 1/2/3 月涨跌 · 是否兑现」。这是最具体的证据。</p>');
const showList = ['_Checkmatey_', 'Billions_2022_', 'btc1368', 'biupa', 'liujia0224', 'Felix_Hsu', 'huangdaobtc', 'DrProfitCrypto'];
for (const screen of showList) {
  const a = ledgerOf.get(screen);
  if (!a) continue;
  const r = R.find(x => x.screen === screen) || {};
  const sim = simOf.get(screen) || {};
  const stabTxt = r.stab === 'stable_pos' ? '<span class="pos">稳定正</span>' : r.stab === 'stable_neg' ? '<span class="neg">稳定负</span>' : r.stab === 'unstable' ? '不稳定' : '样本不足';
  P(`<h3>${acct(screen)} ${badge(r.band)} <span class="dim" style="font-weight:400;font-size:13px">超额 ${pt(r.excess)} ｜ 原始胜率 ${pct(r.rawWinRate)} ｜ 可验证 ${r.verified} ｜ 稳健性 ${stabTxt}` +
    (sim.nTrades >= 5 ? ` ｜ 模拟中位 ${pct(sim.medianRet, 1)}` : '') + '</span></h3>');
  P('<div class="scroll"><table><thead><tr><th>日期</th><th>当时价格</th><th>预测</th><th>1月</th><th>2月</th><th>3月</th><th>结果</th></tr></thead><tbody>');
  for (const x of a.rows.slice(0, 12)) {
    const dir = x.dir === 'up' ? '看涨' : '看跌';
    const tgt = x.target ? money(x.target) : '—';
    const res = x.hit === null ? '<span class="dim">待观察</span>' : x.hit ? '<span class="pos">✓ 兑现</span>' : '<span class="neg">✗ 未兑现</span>';
    P(`<tr><td class="mono">${x.date}</td><td class="mono">${money(x.entry)}</td><td>${dir} ${tgt}</td>` +
      `<td class="mono ${(x.ret1m ?? 0) >= 0 ? 'pos' : 'neg'}">${pct(x.ret1m)}</td>` +
      `<td class="mono ${(x.ret2m ?? 0) >= 0 ? 'pos' : 'neg'}">${pct(x.ret2m)}</td>` +
      `<td class="mono ${(x.ret3m ?? 0) >= 0 ? 'pos' : 'neg'}">${pct(x.ret3m)}</td>` +
      `<td>${res}</td></tr>`);
  }
  P('</tbody></table></div>');
}

// ---------- 稳定负与不稳定 ----------
P('<h2><span class="num">06</span>稳定负与结论不稳定的账号</h2>');
P('<h3>4 口径全负（建议忽略）</h3>');
P('<div class="scroll"><table><thead><tr><th>账号</th><th>8%/60d</th><th>8%/90d</th><th>15%/90d</th><th>25%/120d</th><th>样本</th></tr></thead><tbody>');
for (const r of neg) {
  const c = r.cells;
  P(`<tr><td><strong>${acct(r.screen)}</strong></td>` + cfgKeys.map(k => `<td class="mono neg">${pt(c[k]?.excess)}</td>`).join('') + `<td class="mono">${r.verified}</td></tr>`);
}
P('</tbody></table></div>');

P(`<h3>不稳定（口径间符号翻转，共 ${uns.length} 个）</h3>`);
P('<p class="dim">这些账号时而准时而错，结论取决于用什么阈值衡量，<strong>不能作为交易依据</strong>。</p>');
P('<div class="scroll"><table><thead><tr><th>账号</th><th>8%/60d</th><th>8%/90d</th><th>15%/90d</th><th>25%/120d</th><th>样本</th></tr></thead><tbody>');
for (const r of uns.sort((a, b) => b.predsCount - a.predsCount).slice(0, 30)) {
  const c = r.cells;
  P(`<tr><td>${acct(r.screen)}</td>` + cfgKeys.map(k => `<td class="mono ${(c[k]?.excess ?? 0) >= 0 ? 'pos' : 'neg'}">${pt(c[k]?.excess)}</td>`).join('') + `<td class="mono">${r.verified}</td></tr>`);
}
P('</tbody></table></div>');

// ---------- 数据质量 ----------
P('<h2><span class="num">07</span>数据质量声明</h2>');
P('<div class="scroll"><table><thead><tr><th>项</th><th>说明</th></tr></thead><tbody>');
P('<tr><td>rektcapital</td><td>原抓 833 条，重抓时未做 merge 被覆盖为 241 条（仅剩 9 月后），其评分不可信</td></tr>');
P('<tr><td>节点覆盖</td><td>87 个账号中，覆盖 4 个关键节点窗口的仅 6 个，覆盖 ≥2 个的 34 个</td></tr>');
P('<tr><td>429 限流</td><td>抓取中辅助接口（ViewerBadgeCounts / GetPublicKeysQuery）持续 429，但核心 SearchTimeline 全部 200，不影响数据完整性</td></tr>');
P('<tr><td>预测审计</td><td>全部预测经 quote 逐字回原文校验，0 处编造</td></tr>');
P('</tbody></table></div>');

P('<h2><span class="num">08</span>怎么用这份报告</h2>');
P('<ol style="color:var(--txt2);font-size:14.5px;padding-left:22px">');
P('<li>只看「4 口径稳定为正」的账号，且样本 ≥5 的才可参考。</li>');
P('<li>稳定负的账号可作反向参考，但不要机械反向——他们错的方式不一定是可预测的。</li>');
P('<li>不稳定账号只能参考逻辑，不能跟单。</li>');
P('<li><strong>任何博主都必须配止损</strong>：最好的超额胜率也只有 +10~18pt，单次判断落空是常态。</li>');
P('<li>大周期顶底几乎没人能提前判断，不要指望博主帮你抓大底逃大顶。</li>');
P('</ol>');

P(`<footer>数据区间 2026-01-01 ~ 2026-11-11 ｜ 生成 ${new Date().toISOString().slice(0, 10)} ｜ ${R.length} 个博主 / ${R.reduce((a, r) => a + r.predsCount, 0)} 条预测</footer>`);
P('</main></div></body></html>');

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, 'index.html'), H.join('\n'), 'utf8');
console.log('HTML 生成:', path.join(OUT_DIR, 'index.html'));
console.log('大小:', Math.round(fs.statSync(path.join(OUT_DIR, 'index.html')).size / 1024), 'KB');
