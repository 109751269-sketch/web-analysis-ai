// 职友集（jobui.com）采集器
// 风控等级：中（搜索接口有验证码，公司页无风控）
// 连接方式：纯 HTTP GET，无需登录、无需浏览器
//
// 关键区别：
//   搜索 /cmp?keyword=  → 易触发验证码，必须带完整浏览器头（含 Referer）
//   公司页 /company/<id>/ → 直连稳定，无限取
//
// 可用维度：
//   - 招聘趋势（历年职位数、同比增减）→ 稳定性
//   - 薪酬区间分布 → 薪资验证（对照脉脉自报）
//   - 历年工资变化 → 薪资趋势
//   - 学历/经验/地区分布 → 人才结构
//   - 公司排名/荣誉 → 行业地位
'use strict';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9',
  'Referer': 'https://www.jobui.com/',
};

// 实测：搜索接口连续调用 2 次即触发验证码，冷却约 40s 可恢复。
// 对策：searchMs 提到 20s；并把公司 ID 缓存到磁盘，避免重复搜索。
const THROTTLE = { searchMs: 20000, companyMs: 2500, jobMs: 12000 };

const RISK = {
  captchaTitle: /验证码验证|系统检测到访问异常/,
  captchaBody: /请输入下方验证码/,
};

class RiskControlError extends Error {
  constructor(msg, evidence) {
    super(msg);
    this.name = 'RiskControlError';
    this.evidence = evidence;
    this.requiresHuman = true;
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function get(url, opts = {}) {
  const res = await fetch(url, { headers: { ...HEADERS, ...(opts.headers || {}) }, redirect: 'follow' });
  const text = await res.text();
  if (RISK.captchaTitle.test(text) || RISK.captchaBody.test(text)) {
    throw new RiskControlError('职友集返回验证码页', { url, status: res.status, len: text.length });
  }
  return { status: res.status, text, url: res.url };
}

function stripHtml(h) {
  return String(h)
    .replace(/<script[\s\S]*?<\/script>/g, ' ')
    .replace(/<style[\s\S]*?<\/style>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#\w+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// 搜索公司 -> [{id, name}]
async function searchCompany(keyword) {
  const url = 'https://www.jobui.com/cmp?keyword=' + encodeURIComponent(keyword);
  const { text } = await get(url);
  const out = [];
  const blocks = text.split('class="company-logo-link ').slice(1);
  for (const b of blocks) {
    const id = (b.match(/data-companyID="(\d+)"/) || [])[1];
    const name = (b.match(/alt="([^"]+) logo"/) || [])[1];
    if (!id || !name) continue;
    out.push({ id, name: name.replace(/\s*logo$/, '').trim() });
  }
  return out;
}

// 公司主页 -> 结构化字段
async function companyProfile(id) {
  const url = `https://www.jobui.com/company/${id}/`;
  const { text: h } = await get(url);
  const t = stripHtml(h);

  const pick = (re) => { const m = t.match(re); return m ? m[1].trim() : null; };

  const out = {
    id, url,
    name: pick(/「([^」]+)怎么样」/),
    fullName: pick(/全称[：:]\s*([^。]+)/),
    scale: pick(/规模[：:]\s*([0-9]+人以上|[0-9-]+人)/),
    founded: pick(/成立[：:]\s*(\d+年)/),
    nature: pick(/性质[：:]\s*([^\s。]+)/),
    industry: pick(/行业[：:]\s*([^。]+)/),
    hiringTrend: {},
    salary: {},
    requirement: {},
  };

  // 招聘：2026年较2025年下降14%
  const hire = t.match(/招聘[：:]\s*(\d{4})年较(\d{4})年(增长|下降)(\d+)%/);
  if (hire) out.hiringTrend = { year: +hire[1], vs: +hire[2], dir: hire[3], pct: +hire[4] };

  // 历年招聘数：2021年 2051个 2022年 2576个 ...
  const hist = t.match(/历年招聘[：:]([\s\S]{0,500}?)(?:公司介绍|新闻|融资|$)/);
  if (hist) {
    const series = [...hist[1].matchAll(/(20\d\d)年\s*(\d+)个/g)];
    if (series.length) out.hiringTrend.series = series.map(m => ({ year: +m[1], count: +m[2] }));
  }
  const need = t.match(/(\d+)\s*个在线职位/);
  if (need) out.hiringTrend.openings = +need[1];

  // 工资
  const salPct = t.match(/(\d+)%的岗位拿([\d-]+K)/);
  if (salPct) out.salary.mainRange = { pct: +salPct[1], range: salPct[2] };
  const salYoY = t.match(/(\d{4})年较去年(增长|下降)(\d+)%/);
  if (salYoY) out.salary.yoy = { year: +salYoY[1], dir: salYoY[2], pct: +salYoY[3] };
  const salBand = t.match(/薪酬区间[：:]?\s*[￥¥]?([\d.]+K)\s*-\s*([\d.]+K)/);
  if (salBand) out.salary.band = { min: salBand[1], max: salBand[2] };

  const eduSal = {};
  for (const m of t.matchAll(/(本科|硕士|博士|大专|应届生)工资[￥¥]?([\d.]+K)/g)) eduSal[m[1]] = m[2];
  if (Object.keys(eduSal).length) out.salary.byEducation = eduSal;

  const citySal = {};
  for (const m of t.matchAll(/(上海|北京|深圳|杭州|广州|成都)工资[￥¥]?([\d.]+K)/g)) citySal[m[1]] = m[2];
  if (Object.keys(citySal).length) out.salary.byCity = citySal;

  // 要求
  const eduMax = t.match(/学历[：:]\s*(\S{1,4})最多[，,]?\s*占?([\d.]+)%/);
  if (eduMax) out.requirement.topEducation = { level: eduMax[1], pct: +eduMax[2] };
  const expMax = t.match(/经验[：:]\s*([\d-]+年)最多[，,]?\s*占?([\d.]+)%/);
  if (expMax) out.requirement.topExperience = { range: expMax[1], pct: +expMax[2] };

  return out;
}

// 岗位细分薪资页 -> 单岗位画像
// path 用职友集拼音：java / suanfa / toufang / chanpinjingli / analyst ...
async function jobSalary(id, jobPath) {
  const url = `https://www.jobui.com/company/${id}/salary/j/${jobPath}/`;
  const { text: h } = await get(url);
  const t = stripHtml(h);

  const out = { id, jobPath, url, found: null, band: null, mainRange: null, byExp: {}, byEdu: {}, byCity: {}, market: {} };

  // 岗位名（标题里「携程 投放 招聘」）
  const nameM = t.match(/「?([^」]{2,10})\s+([^\s]{1,10})\s+招聘（工资待遇要求）/);
  if (nameM) out.name = nameM[2];

  const band = t.match(/薪酬区间[:：]?\s*([\d.]+K)\s*-\s*([\d.]+K)/);
  if (band) out.band = { min: band[1], max: band[2] };

  const main = t.match(/(\d+\.?\d*)%的岗位拿[￥¥]?([\d-]+K)/);
  if (main) out.mainRange = { pct: +main[1], range: main[2] };

  const samples = t.match(/取自近一年\s*(\d+)\s*个相关岗位/);
  if (samples) out.samples = +samples[1];

  // 按经验：应届生 ￥3.8K / 1-3年 ￥25.0K / 3-5年 ￥32.5K
  for (const m of t.matchAll(/(应届生|1-3年|3-5年|5-10年|10年以上|不限)\s*[￥¥]([\d.]+)K/g)) {
    out.byExp[m[1]] = +m[2];
  }
  // 按学历
  for (const m of t.matchAll(/(本科|硕士|博士|大专|实习)\s*[￥¥]([\d.]+)K/g)) {
    out.byEdu[m[1]] = +m[2];
  }
  // 按城市：上海 ￥29.4K 87.5%(21)
  for (const m of t.matchAll(/(上海|北京|深圳|杭州|广州|成都|南京|武汉)\s*[￥¥]([\d.]+)K/g)) {
    out.byCity[m[1]] = +m[2];
  }
  // 市场对比：26% 与同地区比 / 12% 与同行比 + 该地区该岗位平均工资
  const cmp = t.match(/(-?\d+)%\s*与同地区比\s*(-?\d+)%?\s*与同行比/);
  if (cmp) out.market.vsRegion = +cmp[1], out.market.vsIndustry = +cmp[2];
  const mk = t.match(/([一-龥]{2,6})\s+([一-龥\/]{2,12})\s+([一-龥]{1,6})\s+平均工资[￥¥](\d+)/);
  if (mk) out.market.regionAvg = { city: mk[1], industry: mk[2], job: mk[3], avg: +mk[4] };

  out.found = !!(out.band || out.byExp && Object.keys(out.byExp).length);
  return out;
}

// 薪资页 -> 历年工资变化
async function salaryHistory(id) {
  const url = `https://www.jobui.com/company/${id}/salary/`;
  const { text: h } = await get(url);
  const t = stripHtml(h);

  const out = { id, url, series: [], band: null };

  const band = t.match(/薪酬区间[:：]?\s*[￥¥]?([\d.]+K)\s*-\s*([\d.]+K)/);
  if (band) out.band = { min: band[1], max: band[2] };

  const seg = t.match(/历年工资变化([\s\S]{0,800}?)(?:说明|数据取决于)/);
  if (seg) {
    for (const m of seg[1].matchAll(/[￥¥]([\d.]+)k[^0-9￥¥]{0,8}(20\d\d)年/g)) {
      out.series.push({ year: +m[2], avgK: +m[1] });
    }
  }
  out.series.sort((a, b) => a.year - b.year);
  return out;
}

module.exports = { searchCompany, companyProfile, salaryHistory, jobSalary, stripHtml, RiskControlError, THROTTLE };
