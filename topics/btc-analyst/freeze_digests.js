const fs = require('fs');
const path = require('path');
const ROOT = require('./paths').resolveRoot();  // 运行目录 data/<date>/
const RAW = path.join(ROOT, 'raw');
const FROZEN = path.join(ROOT, 'frozen');
fs.mkdirSync(FROZEN, { recursive: true });

const BTC = /btc|bitcoin|比特币|大饼|\$btc|₿/i;
const files = fs.readdirSync(RAW).filter(f => f.endsWith('.json') && !f.endsWith('.w.json'));

const manifest = [];
for (const f of files) {
  const d = JSON.parse(fs.readFileSync(path.join(RAW, f), 'utf8'));
  const tw = (d.tweets || []).filter(t => BTC.test(t.text));
  if (!tw.length) continue;
  tw.sort((a, b) => Date.parse(a.created) - Date.parse(b.created));
  // 只保留原创（去掉纯转推），保留回复中的实质分析
  const keep = tw.filter(t => !t.isRT);
  if (!keep.length) continue;
  const body = keep
    .map(t => {
      const d10 = new Date(t.created).toISOString().slice(0, 10);
      const txt = t.text.replace(/\s+/g, ' ').slice(0, 900);
      return `[${d10}]${t.isReply ? '(回复)' : ''} ${txt}`;
    })
    .join('\n');
  const out = path.join(FROZEN, d.screen + '.txt');
  fs.writeFileSync(out, `账号 @${d.screen}\n原创BTC推文 ${keep.length} 条\n${body}\n`);
  const ds = keep.map(t => new Date(t.created).toISOString().slice(0, 10)).sort();
  manifest.push({
    screen: d.screen,
    n: keep.length,
    chars: body.length,
    from: ds[0],
    to: ds[ds.length - 1],
    file: 'output/x_btc_2026/frozen/' + d.screen + '.txt',
  });
}
manifest.sort((a, b) => b.n - a.n);
fs.writeFileSync(path.join(ROOT, 'frozen_manifest.json'), JSON.stringify(manifest, null, 1));
console.log('frozen accounts', manifest.length);
console.log('total chars', manifest.reduce((a, m) => a + m.chars, 0));
console.log('--- >=15 tweets ---');
manifest.filter(m => m.n >= 15).forEach((m, i) =>
  console.log(`${i + 1}. ${m.screen} n=${m.n} ${m.from}..${m.to} ${Math.round(m.chars / 1000)}k`)
);
