'use strict';
/**
 * research.js — 职场口碑调研单入口
 *
 * 一条命令跑完所有渠道：脉脉专题 + 脉脉评论 + 牛客评价 + 牛客评论 + 小红书笔记/评论
 *
 * 用法:
 *   node lib/research.js --company=携程 [--out=output/xxx] [--cdp=http://127.0.0.1:9222]
 *   node lib/research.js --company=携程 --sites=maimai,nowcoder    # 只跑指定渠道
 *   node lib/research.js --company=携程 --skip-comments            # 不抓评论
 *
 * 前置:
 *   1. 启动 CDP 浏览器（统一 profile，所有站点登录一次即可）:
 *      chrome.exe --remote-debugging-port=9222 \\
 *        --user-data-dir=C:\Users\sun\.agents\skills\web-analysis-ai\profiles\unified
 *   2. 在该浏览器里登录 脉脉 / 小红书（牛客不需要）
 */

const fs = require('fs');
const path = require('path');
let chromium;
try { ({ chromium } = require('playwright')); } catch (e) { ({ chromium } = require('C:/Users/sun/.agents/skills/web-analysis-ai/node_modules/playwright')); }

const maimai = require('./sites/maimai.js');
const nowcoder = require('./sites/nowcoder.js');
const xhs = require('./sites/xiaohongshu.js');
const { loadPlaybook } = require('./playbook.js');

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- 分站点节流（2026-11-10 新增）----------
// 从 playbooks/<host>.json 读 riskLevel + antiBot.throttle。
// 设计原则：风控严的站放慢，无风控的站快抓 —— 不要一刀切。
const SITE_HOSTS = {
  maimai: 'maimai.cn',
  nowcoder: 'nowcoder.com',
  xiaohongshu: 'xiaohongshu.com',
};
// 兜底值：playbook 缺失时用，宁可慢不可封
const FALLBACK_THROTTLE = {
  maimai: { firstScreenMs: 5000, scrollMs: 1800, commentMs: 3000 },
  nowcoder: { evalPageMs: 280, commentPageMs: 260, postMs: 200 },
  xiaohongshu: { searchMs: 10000, detailMs: 9000 },
};

function throttleFor(site) {
  const host = SITE_HOSTS[site];
  let pb = null;
  try { pb = host ? loadPlaybook('https://' + host + '/') : null; } catch (e) { }
  const t = (pb && pb.antiBot && pb.antiBot.throttle) || {};
  return {
    ...FALLBACK_THROTTLE[site],
    ...t,
    riskLevel: (pb && pb.riskLevel) || 'unknown',
  };
}

// ---------- 参数 ----------
const argv = process.argv.slice(2);
const arg = (k, d) => {
  const p = argv.find(a => a.startsWith(`--${k}=`));
  return p ? p.slice(k.length + 3) : d;
};
const flag = k => argv.includes(`--${k}`);

const company = arg('company');
if (!company) {
  console.error('usage: node lib/research.js --company=携程 [--out=DIR] [--cdp=URL] [--sites=a,b] [--skip-comments]');
  process.exit(1);
}

const OUT = arg('out', path.join(process.cwd(), 'output', `research_${company}_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`));
// 每站点可用独立 CDP 端口（不同 profile 各占一个），默认全用 --cdp
// 例：--cdp-maimai=http://127.0.0.1:9222 --cdp-xhs=http://127.0.0.1:9223
const CDP = arg('cdp', 'http://127.0.0.1:9222');
const cdpFor = site => {
  const key = site === 'xiaohongshu' ? 'cdp-xhs' : site === 'maimai' ? 'cdp-maimai' : `cdp-${site}`;
  return arg(key, CDP);
};
const sites = (arg('sites', 'maimai,nowcoder,xiaohongshu')).split(',').map(s => s.trim());
const skipComments = flag('skip-comments');
const XHS_KEYWORDS = arg('xhs-keywords', `${company} 工作体验,${company} 加班,${company} 值得去吗`).split(',').map(s => s.trim());
const MM_SCROLLS = parseInt(arg('mm-scrolls', '30'), 10);
const XHS_DETAIL_N = parseInt(arg('xhs-detail', '15'), 10);

fs.mkdirSync(OUT, { recursive: true });
const log = (...a) => console.log('[research]', ...a);

// 启动时打印各站节流档位，便于确认风控策略已生效
for (const s of sites) {
  const t = throttleFor(s);
  log(`节流[${s}] riskLevel=${t.riskLevel}`, JSON.stringify(
    Object.fromEntries(Object.entries(t).filter(([k]) => k !== 'riskLevel'))));
}

(async () => {
  const report = {
    company,
    generatedAt: new Date().toISOString(),
    config: { sites, cdp: CDP, skipComments, xhsKeywords: XHS_KEYWORDS },
    data: { maimai: null, nowcoder: null, xiaohongshu: null },
    errors: [],
  };

  // ---------- 牛客（不需要浏览器）----------
  if (sites.includes('nowcoder')) {
    try {
      log('牛客: 搜索公司…');
      const co = await nowcoder.findCompany(company);
      if (!co) {
        report.errors.push('nowcoder: 未找到公司');
      } else {
        log(`牛客: ${co.companyName} (id=${co.companyId})，抓评价…`);
        const evals = await nowcoder.collectEvaluations(co.companyId);
        log(`牛客: ${evals.length} 条评价`);
        let cmts = [];
        if (!skipComments) {
          const targets = evals.slice(0, 90).filter(r => (r.frequencyData || {}).commentCnt > 0);
          log(`牛客: 抓 ${targets.length} 帖评论…`);
          const ncThrottle = throttleFor('nowcoder');
          for (const r of targets) {
            try {
              const c = await nowcoder.collectComments(r.contentId);
              if (c.length) cmts.push({ contentId: r.contentId, title: (r.contentData || {}).title || '', comments: c });
            } catch (e) { }
            // 牛客无风控，按分册可快抓
            await sleep(ncThrottle.postMs || 200);
          }
          log(`牛客: ${cmts.reduce((a, b) => a + b.comments.length, 0)} 条评论`);
        }
        report.data.nowcoder = { companyId: co.companyId, companyName: co.companyName, evaluations: evals, commentPosts: cmts };
        fs.writeFileSync(path.join(OUT, 'nowcoder.json'), JSON.stringify(report.data.nowcoder, null, 1), 'utf8');
      }
    } catch (e) {
      report.errors.push('nowcoder: ' + e.message);
      log('牛客失败:', e.message);
    }
  }

  // ---------- 需要浏览器的渠道：每站点独立 CDP 连接 ----------
  const conns = new Map();   // site -> { browser, page }
  async function conn(site) {
    if (conns.has(site)) return conns.get(site);
    const url = cdpFor(site);
    log(`连接 CDP[${site}]: ${url}`);
    const browser = await chromium.connectOverCDP(url, { timeout: 20000 });
    const ctx = browser.contexts()[0] || await browser.newContext();
    const page = await ctx.newPage();
    const c = { browser, page };
    conns.set(site, c);
    return c;
  }

  // ---------- 脉脉 ----------
  if (sites.includes('maimai')) {
    let page = null;
    try { page = (await conn('maimai')).page; }
    catch (e) {
      report.errors.push('maimai CDP 失败: ' + e.message);
      log('脉脉 CDP 失败:', e.message);
    }
    try {
      report.data.maimai = { topics: {}, comments: [] };
      for (const [key, url] of Object.entries(maimai.TOPICS)) {
        log(`脉脉: ${key}…`);
        const posts = await maimai.collectPosts(page, url, { scrolls: MM_SCROLLS });
        const hit = posts.filter(p => p.text.includes(company));
        log(`脉脉 ${key}: ${posts.length} 帖，含「${company}」${hit.length} 帖`);
        report.data.maimai.topics[key] = { url, total: posts.length, hit: hit.length, posts: hit };
        fs.writeFileSync(path.join(OUT, `maimai_${key}.json`), JSON.stringify(report.data.maimai.topics[key], null, 1), 'utf8');
      }

      if (!skipComments && report.data.maimai) {
        const withCmts = [];
        for (const t of Object.values(report.data.maimai.topics)) {
          for (const p of t.posts) if (p.cmts > 0) withCmts.push(p);
        }
        const uniq = [...new Map(withCmts.map(p => [p.id, p])).values()].slice(0, 40);
        log(`脉脉: 抓 ${uniq.length} 帖评论…`);
        const mmThrottle = throttleFor('maimai');
        for (const p of uniq) {
          try {
            const c = await maimai.collectComments(page, p);
            if (c.comments.length) report.data.maimai.comments.push(c);
            log(`  [${report.data.maimai.comments.length}/${uniq.length}] ${c.comments.length} 评论`);
          } catch (e) { }
          await sleep(mmThrottle.commentMs || 3000);
        }
        fs.writeFileSync(path.join(OUT, 'maimai_comments.json'), JSON.stringify(report.data.maimai.comments, null, 1), 'utf8');
      }
    } catch (e) {
      report.errors.push('maimai: ' + e.message);
      log('脉脉失败:', e.message);
    }
  }

  // ---------- 小红书 ----------
  if (sites.includes('xiaohongshu')) {
    const xhsThrottle = throttleFor('xiaohongshu');
    let page = null;
    try { page = (await conn('xiaohongshu')).page; }
    catch (e) {
      report.errors.push('xiaohongshu CDP 失败: ' + e.message);
      log('小红书 CDP 失败:', e.message);
    }
    if (page) try {
      report.data.xiaohongshu = { keywords: {} };
      for (const kw of XHS_KEYWORDS) {
        log(`小红书: 「${kw}」…`);
        const notes = await xhs.searchKeyword(page, kw);
        log(`小红书 「${kw}」: ${notes.length} 笔记`);
        const details = [];
        const take = notes.slice(0, XHS_DETAIL_N);
        for (let i = 0; i < take.length; i++) {
          try {
            const d = await xhs.noteDetail(page, take[i]);
            details.push({ ...take[i], ...d });
            log(`  [${i + 1}/${take.length}] ${take[i].title.slice(0, 24)} 评论${d.comments.length}`);
          } catch (e) {
            // 风控是终止信号：抛出到外层，停止整个小红书任务（不换账号、不重试）
            if (e.name === 'RiskControlError') {
              report.errors.push('xiaohongshu 风控中断: ' + e.message);
              log('⛔ 风控中断，停止小红书采集:', e.message);
              throw e;
            }
          }
          // 节流：按分册（xiaohongshu.com.md），详情页 ≥9 秒
          await sleep(xhsThrottle.detailMs || 9000);
        }
        report.data.xiaohongshu.keywords[kw] = { count: notes.length, notes, details };
        fs.writeFileSync(path.join(OUT, `xhs_${kw.replace(/[\\/:*?"<>|]/g, '_')}.json`), JSON.stringify({ keyword: kw, notes, details }, null, 1), 'utf8');
        // 关键词之间按分册（默认 10 秒）
        await sleep(xhsThrottle.searchMs || 10000);
      }
    } catch (e) {
      report.errors.push('xiaohongshu: ' + e.message);
      log('小红书失败:', e.message);
    }
  }

  // 关闭所有站点的连接（只关自己开的 page 与连接，不杀用户浏览器）
  for (const [site, c] of conns) {
    try { await c.page.close(); } catch (e) { }
    try { await c.browser.close(); } catch (e) { }
    log(`已断开 CDP[${site}]`);
  }

  fs.writeFileSync(path.join(OUT, 'research.json'), JSON.stringify(report, null, 1), 'utf8');
  log('完成 ->', OUT);
  if (report.errors.length) log('错误:', report.errors.join(' | '));
})().catch(e => { console.error('ERR', e.message, e.stack); process.exit(1); });
