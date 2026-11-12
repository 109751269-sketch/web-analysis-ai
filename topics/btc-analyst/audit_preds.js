const fs = require('fs');
const path = require('path');
const ROOT = require('./paths').resolveRoot();
const PREDS = path.join(ROOT, 'preds');
const FROZEN = path.join(ROOT, 'frozen');

let totalAcc = 0, totalPred = 0, badQuote = 0, badCat = 0, badDate = 0;
const problems = [];

for (const f of fs.readdirSync(PREDS).filter(x => x.endsWith('.json'))) {
  const j = JSON.parse(fs.readFileSync(path.join(PREDS, f), 'utf8'));
  const accs = j.accounts || [];
  totalAcc += accs.length;
  for (const a of accs) {
    const srcF = path.join(FROZEN, a.screen + '.txt');
    if (!fs.existsSync(srcF)) {
      problems.push(`${a.screen}: frozen 文件缺失`);
      continue;
    }
    // 规范化原文：压空白，去掉零宽字符
    const src = fs.readFileSync(srcF, 'utf8')
      .replace(/[​-‏﻿]/g, '')
      .replace(/\s+/g, ' ');
    const srcNoSpace = src.replace(/\s+/g, '');

    const catSum = Object.values(a.cat || {}).reduce((x, y) => x + y, 0);
    if (catSum !== a.total_tweets) {
      badCat++;
      problems.push(`${a.screen}: cat 和=${catSum} != total=${a.total_tweets}`);
    }

    for (const p of a.preds || []) {
      totalPred++;
      const q = (p.quote || '').replace(/\s+/g, '');
      if (!q) { badQuote++; problems.push(`${a.screen} ${p.date}: quote 为空`); continue; }
      // 逐字（忽略空白差异）是否出现在原文
      if (!srcNoSpace.includes(q)) {
        badQuote++;
        problems.push(`${a.screen} ${p.date}: quote 未命中 | ${p.quote.slice(0, 60)}`);
      }
      // 日期必须出现在原文
      if (!src.includes(p.date)) {
        badDate++;
        problems.push(`${a.screen} ${p.date}: 日期不在原文`);
      }
    }
  }
}

console.log(`账号 ${totalAcc} | 预测 ${totalPred}`);
console.log(`quote 未命中: ${badQuote} | cat 不平: ${badCat} | 日期异常: ${badDate}`);
if (problems.length) {
  console.log('\n--- 问题明细 (前 40) ---');
  problems.slice(0, 40).forEach(p => console.log('  ' + p));
  console.log(`\n共 ${problems.length} 条问题`);
} else {
  console.log('全部校验通过');
}
