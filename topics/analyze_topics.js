/**
 * analyze_topics.js —— 脉脉 / 牛客 / 小红书 三专题产出分析
 * 只做确定性统计，结论由 agent 基于统计写。
 * 输出：F:/despseekharness/crawler/output/_analysis/*.md + *.json
 */
const fs = require('fs');
const path = require('path');
const O = process.env.WA_OUT || 'F:/despseekharness/crawler/output';
const OUT = path.join(O, '_analysis');
fs.mkdirSync(OUT, { recursive: true });

const readJson = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const arr = j => Array.isArray(j) ? j : (j.data || j.posts || j.records || j.items);
const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
const pct = (x, n) => n ? (x / n * 100).toFixed(1) + '%' : '-';
const r1 = x => x == null ? '-' : Math.round(x * 10) / 10;

/** 解析「上午10点0分」「下午7点30分」→ 小时（小数） */
function parseHour(s) {
  if (!s) return null;
  const m = String(s).match(/(上午|下午|晚上|凌晨|中午)?\s*(\d{1,2})\s*点\s*(\d{1,2})?\s*分?/);
  if (!m) return null;
  let h = +m[2];
  const ap = m[1];
  if ((ap === '下午' || ap === '晚上') && h < 12) h += 12;
  if (ap === '中午' && h < 12) h += 12;
  if (ap === '凌晨' && h === 12) h = 0;
  const min = m[3] ? +m[3] : 0;
  return h + min / 60;
}

// ============ 1. 脉脉工时 ============
function analyzeWorktime() {
  const a = arr(readJson(path.join(O, 'maimai_topic_worktime/data.json')));
  const rows = [];
  let unparsed = 0;
  for (const r of a) {
    const inH = parseHour(r.上班时间), outH = parseHour(r.下班时间);
    if (inH == null || outH == null) { unparsed++; continue; }
    let hours = outH - inH;
    if (hours < 0) hours += 24;
    if (hours > 20) hours = null;
    rows.push({ company: (r.公司 || '').trim(), dept: (r.部门 || '').trim(), in: inH, out: outH, hours, fish: (r.摸鱼状态 || '').trim() });
  }
  const valid = rows.filter(r => r.hours != null);
  const byCo = {};
  for (const r of valid) { if (!r.company) continue; (byCo[r.company] ||= []).push(r.hours); }
  const companies = Object.entries(byCo).filter(([, v]) => v.length >= 30)
    .map(([k, v]) => ({ company: k, n: v.length, medianH: r1(median(v)), meanH: r1(mean(v)), over12: pct(v.filter(h => h >= 12).length, v.length), under9: pct(v.filter(h => h < 9).length, v.length) }))
    .sort((x, y) => y.medianH - x.medianH);
  const fish = {};
  for (const r of valid) { if (r.fish) fish[r.fish] = (fish[r.fish] || 0) + 1; }
  const fishList = Object.entries(fish).sort((a, b) => b[1] - a[1]);

  const summary = {
    rawRecords: a.length,
    parsed: valid.length,
    unparsed,
    parseRate: pct(valid.length, a.length),
    overallMedianH: r1(median(valid.map(r => r.hours))),
    overallMeanH: r1(mean(valid.map(r => r.hours))),
    over12Pct: pct(valid.filter(r => r.hours >= 12).length, valid.length),
    over14Pct: pct(valid.filter(r => r.hours >= 14).length, valid.length),
    companies
  };
  fs.writeFileSync(path.join(OUT, 'maimai-worktime.json'), JSON.stringify({ summary, fishList }, null, 1));

  let md = `# 脉脉「爆料各司工时强度」分析\n\n> 数据：\`output/maimai_topic_worktime/data.json\`，${a.length} 条原始记录\n> 解析：上班/下班时间成功 ${valid.length} 条（${summary.parseRate}），未解析 ${unparsed} 条\n> **口径**：工时 = 下班 − 上班（跨夜按 +24h），>20h 视为异常剔除；**自报数据，未经核实**\n\n## 一、总览\n\n| 指标 | 值 |\n|---|---|\n| 有效样本 | ${valid.length} |\n| 工时中位数 | **${summary.overallMedianH} 小时** |\n| 工时均值 | ${summary.overallMeanH} 小时 |\n| ≥12 小时占比 | ${summary.over12Pct} |\n| ≥14 小时占比 | ${summary.over14Pct} |\n\n## 二、公司工时排行（样本 ≥30）\n\n| 排名 | 公司 | 样本 | 工时中位数 | 均值 | ≥12h 占比 | <9h 占比 |\n|---|---|---|---|---|---|---|\n`;
  companies.forEach((c, i) => { md += `| ${i + 1} | ${c.company} | ${c.n} | **${c.medianH}h** | ${c.meanH}h | ${c.over12} | ${c.under9} |\n`; });
  md += `\n## 三、摸鱼状态分布\n\n| 状态 | 条数 | 占比 |\n|---|---|---|\n`;
  fishList.forEach(([k, v]) => { md += `| ${k} | ${v} | ${pct(v, valid.length)} |\n`; });
  fs.writeFileSync(path.join(OUT, 'maimai-worktime.md'), md);
  console.log('worktime ok, companies', companies.length);
  return { companies, summary };
}

// ============ 2. 脉脉薪资 ============
function analyzeSalary() {
  const a = arr(readJson(path.join(O, 'maimai_topic_salaryrank/data.json')));
  const rows = [];
  let unparsed = 0;
  for (const r of a) {
    const t = r.正文 || '';
    const co = (t.match(/公司：([^\n]+?)\s*(?:👷|💼|💰|$)/) || [])[1];
    const job = (t.match(/岗位：([^\n]+?)\s*(?:💼|💰|$)/) || [])[1];
    const level = (t.match(/职级：([^\n]+?)\s*(?:💰|$)/) || [])[1];
    const total = (t.match(/总年薪：([\d.]+)万/) || [])[1];
    if (!co || !total) { unparsed++; continue; }
    rows.push({ company: co.trim(), job: (job || '').trim(), level: (level || '').trim(), totalW: +total });
  }
  const byCo = {};
  for (const r of rows) (byCo[r.company] ||= []).push(r.totalW);
  const companies = Object.entries(byCo).filter(([, v]) => v.length >= 20)
    .map(([k, v]) => { const s = [...v].sort((a, b) => a - b); return { company: k, n: v.length, medianW: r1(median(v)), meanW: r1(mean(v)), p75: r1(s[Math.floor(v.length * 0.75)]), over50: pct(v.filter(x => x >= 50).length, v.length), over100: pct(v.filter(x => x >= 100).length, v.length) }; })
    .sort((x, y) => y.medianW - x.medianW);
  const byJob = {};
  for (const r of rows) { if (!r.job) continue; (byJob[r.job] ||= []).push(r.totalW); }
  const jobs = Object.entries(byJob).filter(([, v]) => v.length >= 50)
    .map(([k, v]) => ({ job: k, n: v.length, medianW: r1(median(v)), meanW: r1(mean(v)) }))
    .sort((x, y) => y.medianW - x.medianW);

  const summary = { rawRecords: a.length, parsed: rows.length, unparsed, parseRate: pct(rows.length, a.length), overallMedianW: r1(median(rows.map(r => r.totalW))), overallMeanW: r1(mean(rows.map(r => r.totalW))), companies, jobs };
  fs.writeFileSync(path.join(OUT, 'maimai-salary.json'), JSON.stringify(summary, null, 1));

  let md = `# 脉脉「职级薪资大揭秘」分析\n\n> 数据：\`output/maimai_topic_salaryrank/data.json\`，${a.length} 条原始记录\n> 解析成功 ${rows.length} 条（${summary.parseRate}），未解析 ${unparsed} 条\n> **口径**：总年薪 = 正文「总年薪：X万」字段；**自报数据，未经核实**\n\n## 一、总览\n\n| 指标 | 值 |\n|---|---|\n| 有效样本 | ${rows.length} |\n| 总年薪中位数 | **${summary.overallMedianW} 万** |\n| 总年薪均值 | ${summary.overallMeanW} 万 |\n\n## 二、公司薪资排行（样本 ≥20，按中位数）\n\n| 排名 | 公司 | 样本 | 中位数 | 均值 | P75 | ≥50万 | ≥100万 |\n|---|---|---|---|---|---|---|---|\n`;
  companies.forEach((c, i) => { md += `| ${i + 1} | ${c.company} | ${c.n} | **${c.medianW}万** | ${c.meanW}万 | ${c.p75}万 | ${c.over50} | ${c.over100} |\n`; });
  md += `\n## 三、岗位薪资排行（样本 ≥50）\n\n| 排名 | 岗位 | 样本 | 中位数 | 均值 |\n|---|---|---|---|---|\n`;
  jobs.forEach((c, i) => { md += `| ${i + 1} | ${c.job} | ${c.n} | **${c.medianW}万** | ${c.meanW}万 |\n`; });
  md += `\n> ⚠️ 样本偏差提醒：脉脉爆料者偏向互联网/高薪岗位，且自报年薪常含股票估值，勿当全行业薪酬基准。\n`;
  fs.writeFileSync(path.join(OUT, 'maimai-salary.md'), md);
  console.log('salary ok, companies', companies.length, 'jobs', jobs.length);
  return summary;
}

// ============ 3. 牛客 ============
function analyzeNowcoder() {
  const dir = path.join(O, 'nowcoder');
  const files = fs.readdirSync(dir).filter(f => f.startsWith('nc_') && f.endsWith('.json'));
  const rows = [];
  for (const f of files) {
    const j = readJson(path.join(dir, f));
    const tagMap = {};
    for (const t of j.tags || []) if (t.word !== '全部') tagMap[t.word] = t.count;
    rows.push({
      file: f, company: j.company, claimedTotal: j.total, fetched: j.records.length,
      coverage: pct(j.records.length, j.total),
      tags: tagMap,
      growth: tagMap['成长空间'], welfare: tagMap['公司福利'], intensity: tagMap['工作强度'],
      atmosphere: tagMap['公司氛围'], promotion: tagMap['晋升空间'], stability: tagMap['稳定性']
    });
  }
  fs.writeFileSync(path.join(OUT, 'nowcoder-summary.json'), JSON.stringify(rows, null, 1));

  let md = `# 牛客公司评价标签分析\n\n> 数据：\`output/nowcoder/nc_*.json\`，${rows.length} 家公司\n> **口径警告**：下表是**站点自报的标签计数**（全站统计），不是我们抓到的 ${rows.reduce((s, r) => s + r.fetched, 0)} 条评价的统计。两者不可混用。\n\n## 一、抓取覆盖率\n\n| 公司 | 站点声称总数 | 实抓条数 | 覆盖率 |\n|---|---|---|---|\n`;
  rows.slice().sort((a, b) => b.claimedTotal - a.claimedTotal).forEach(r => { md += `| ${r.company} | ${r.claimedTotal} | ${r.fetched} | ${r.coverage} |\n`; });

  md += `\n## 二、站点标签分布（% = 该标签数 / 该公司「全部」数）\n\n| 公司 | 全部 | 成长空间 | 公司福利 | 工作强度 | 公司氛围 | 晋升空间 | 稳定性 |\n|---|---|---|---|---|---|---|---|\n`;
  rows.slice().sort((a, b) => b.claimedTotal - a.claimedTotal).forEach(r => {
    const t = r.claimedTotal;
    const g = v => v == null ? '-' : `${v} (${pct(v, t)})`;
    md += `| ${r.company} | ${t} | ${g(r.growth)} | ${g(r.welfare)} | ${g(r.intensity)} | ${g(r.atmosphere)} | ${g(r.promotion)} | ${g(r.stability)} |\n`;
  });

  const withRate = rows.map(r => ({
    company: r.company, total: r.claimedTotal,
    intensityRate: r.intensity / r.claimedTotal, stabilityRate: r.stability / r.claimedTotal,
    growthRate: r.growth / r.claimedTotal, welfareRate: r.welfare / r.claimedTotal,
    promoteRate: r.promotion / r.claimedTotal
  })).filter(r => r.total >= 500);
  md += `\n## 三、极值（仅列站点声称 ≥500 条的公司，避免小样本噪声）\n\n### 工作强度提及率最高\n\n`;
  withRate.slice().sort((a, b) => b.intensityRate - a.intensityRate).slice(0, 5).forEach((r, i) => { md += `${i + 1}. **${r.company}** — ${(r.intensityRate * 100).toFixed(1)}%\n`; });
  md += `\n### 稳定性提及率最高\n\n`;
  withRate.slice().sort((a, b) => b.stabilityRate - a.stabilityRate).slice(0, 5).forEach((r, i) => { md += `${i + 1}. **${r.company}** — ${(r.stabilityRate * 100).toFixed(1)}%\n`; });
  md += `\n### 晋升空间提及率最高\n\n`;
  withRate.slice().sort((a, b) => b.promoteRate - a.promoteRate).slice(0, 5).forEach((r, i) => { md += `${i + 1}. **${r.company}** — ${(r.promoteRate * 100).toFixed(1)}%\n`; });

  fs.writeFileSync(path.join(OUT, 'nowcoder-summary.md'), md);
  console.log('nowcoder ok, companies', rows.length);
  return rows;
}

// ============ 4. 小红书 ============
function analyzeXhs() {
  const dir = path.join(O, 'xhs');
  const j = readJson(path.join(dir, '_finance_notes.json'));
  const a = Array.isArray(j) ? j : (j.data || j.items || []);
  const likes = a.map(x => parseInt(x.likes) || 0);
  const byKw = {};
  for (const x of a) (byKw[x._kw] ||= []).push(parseInt(x.likes) || 0);
  const kwStats = Object.entries(byKw).map(([k, v]) => ({ kw: k, n: v.length, medianLikes: r1(median(v)), maxLikes: Math.max(...v) })).sort((x, y) => y.n - x.n);
  const neg = /高利贷|诱导|骗|坑|投诉|维权|恶心|坑人|避雷|垃圾|黑|不建议|劝退/;
  const pos = /推荐|不错|值得|好评|真香|满意|福利好/;
  const topicHit = { negative: 0, positive: 0, overtime: 0, salary: 0 };
  for (const x of a) {
    const t = x.title || '';
    if (neg.test(t)) topicHit.negative++;
    if (pos.test(t)) topicHit.positive++;
    if (/加班|996|工时|卷/.test(t)) topicHit.overtime++;
    if (/薪|工资|待遇|年终/.test(t)) topicHit.salary++;
  }
  const summary = { total: a.length, medianLikes: r1(median(likes)), maxLikes: Math.max(...likes), kwStats, topicHit };
  fs.writeFileSync(path.join(OUT, 'xhs-summary.json'), JSON.stringify(summary, null, 1));

  let md = `# 小红书「携程金融线」笔记分析\n\n> 数据：\`output/xhs/_finance_notes.json\`，${a.length} 篇笔记（搜索结果，**未抓详情正文**）\n> **口径**：只有标题 + 作者 + 点赞数；正文/评论未采集，不能做内容情感判断，只能做标题层面归纳。\n\n## 一、总览\n\n| 指标 | 值 |\n|---|---|\n| 笔记总数 | ${a.length} |\n| 点赞中位数 | ${summary.medianLikes} |\n| 最高点赞 | ${summary.maxLikes} |\n\n## 二、按关键词\n\n| 关键词 | 篇数 | 点赞中位数 | 最高点赞 |\n|---|---|---|---|\n`;
  kwStats.forEach(k => { md += `| ${k.kw} | ${k.n} | ${k.medianLikes} | ${k.maxLikes} |\n`; });
  md += `\n## 三、标题倾向（关键词命中，非情感模型）\n\n| 类别 | 命中篇数 | 占比 |\n|---|---|---|\n`;
  md += `| 负面/维权 | ${topicHit.negative} | ${pct(topicHit.negative, a.length)} |\n`;
  md += `| 正面/推荐 | ${topicHit.positive} | ${pct(topicHit.positive, a.length)} |\n`;
  md += `| 加班/工时 | ${topicHit.overtime} | ${pct(topicHit.overtime, a.length)} |\n`;
  md += `| 薪资/待遇 | ${topicHit.salary} | ${pct(topicHit.salary, a.length)} |\n`;
  md += `\n> ⚠️ 标题倾向是正则粗筛，不是情感分析。「高利贷」类标题集中说明该产品有争议，但不代表全部笔记立场。\n`;
  fs.writeFileSync(path.join(OUT, 'xhs-summary.md'), md);
  console.log('xhs ok, notes', a.length);
  return summary;
}

const wt = analyzeWorktime();
const sal = analyzeSalary();
const nc = analyzeNowcoder();
const xhs = analyzeXhs();
console.log('\n=== 关键数字 ===');
console.log('脉脉工时 中位', wt.summary.overallMedianH, 'h / 样本', wt.summary.parsed);
console.log('脉脉薪资 中位', sal.overallMedianW, '万 / 样本', sal.parsed);
console.log('牛客 公司', nc.length, '/ 实抓总', nc.reduce((s, r) => s + r.fetched, 0));
console.log('小红书 笔记', xhs.total, '负面标题', xhs.topicHit.negative);
