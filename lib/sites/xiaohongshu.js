'use strict';
/**
 * 小红书采集器（关键词驱动，需登录态）
 * 关键：笔记链接必须带 xsec_token，否则 404。token 只能从搜索 API 拿。
 * API: POST so.xiaohongshu.com/api/sns/web/v2/search/notes
 */

const sleep = ms => new Promise(r => setTimeout(r, ms));
const SEARCH_API = /so\.xiaohongshu\.com\/api\/sns\/web\/v2\/search\/notes/;

// ---------- 风控熔断（2026-11-10 新增）----------
// 依据：headless + 高频请求触发账号级风控后，搜索 API 返回 461，首页 302 到验证码页。
// 原则：风控是终止信号，不是重试信号（借 agent-reach 的 PLATFORM_BLOCKED 语义）。
const RISK = {
  blockedStatus: [461],
  captchaUrl: /website-login\/captcha/,
  rateLimitCode: 40006,
};
const THROTTLE = { searchMs: 10000, detailMs: 9000 };

class RiskControlError extends Error {
  constructor(msg, evidence) {
    super(msg);
    this.name = 'RiskControlError';
    this.evidence = evidence;
    this.requiresHuman = true; // 需要用户在官方页面处理，agent 不得绕过
  }
}

// 统一风控检查：URL 跳验证码 / 响应状态码 461
function attachRiskWatch(page) {
  const hits = [];
  const onResp = r => {
    if (RISK.blockedStatus.includes(r.status()) && /xiaohongshu\.com/.test(r.url())) {
      hits.push({ status: r.status(), url: r.url().slice(0, 120) });
    }
  };
  page.on('response', onResp);
  return {
    hits,
    async assertClean(stage) {
      const cur = page.url();
      if (RISK.captchaUrl.test(cur)) {
        throw new RiskControlError(
          `小红书风控（${stage}）：页面跳转到验证码，需要本人用小红书 APP 扫码`,
          { stage, url: cur.slice(0, 160) });
      }
      if (hits.length) {
        throw new RiskControlError(
          `小红书风控（${stage}）：接口返回 ${hits[0].status}，账号已被标记为机器流量`,
          { stage, hits: hits.slice(0, 3) });
      }
    },
    detach() { page.off('response', onResp); },
  };
}

async function searchKeyword(page, kw, { scrolls = 8, waitMs = 2000 } = {}) {
  const captured = [];
  const handler = async r => {
    if (!SEARCH_API.test(r.url())) return;
    try {
      const j = JSON.parse(await r.text());
      if (j.data && j.data.items) captured.push(...j.data.items);
    } catch (e) { }
  };
  const watch = attachRiskWatch(page);
  page.on('response', handler);

  await page.goto(`https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(kw)}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await sleep(5500);
  await watch.assertClean('search');
  if (await page.evaluate(() => /登录后查看/.test(document.body.innerText))) {
    watch.detach();
    page.off('response', handler);
    throw new Error('小红书未登录：请先在 CDP 浏览器里登录 xiaohongshu.com');
  }
  for (let i = 0; i < scrolls; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => { });
    await sleep(waitMs);
  }
  page.off('response', handler);
  await watch.assertClean('search-scroll');
  watch.detach();

  const byId = new Map();
  for (const it of captured) {
    if (!it.id) continue;
    const nc = it.note_card || {};
    const u = nc.user || {};
    const ii = nc.interact_info || {};
    byId.set(it.id, {
      id: it.id,
      xsec_token: it.xsec_token || '',
      title: nc.display_title || '',
      author: u.nickname || u.nick_name || '',
      likes: ii.liked_count || '',
      url: `https://www.xiaohongshu.com/explore/${it.id}?xsec_token=${it.xsec_token || ''}`,
    });
  }
  return [...byId.values()];
}

async function noteDetail(page, note) {
  const watch = attachRiskWatch(page);
  await page.goto(note.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await sleep(5000);
  await watch.assertClean('detail');
  for (let i = 0; i < 5; i++) {
    await page.evaluate(() => {
      const t = [...document.querySelectorAll('div,span,button')].find(e => {
        const s = (e.innerText || '').trim();
        return /^(展开\d*条?评论|查看更多评论|加载更多|点击展开)/.test(s) && s.length < 25;
      });
      if (t) t.click();
      window.scrollTo(0, document.body.scrollHeight);
    }).catch(() => { });
    await sleep(1500);
  }
  return page.evaluate(() => {
    const g = s => { const e = document.querySelector(s); return e ? (e.innerText || '').trim() : ''; };
    const timeRe = /(\d+\s*天前|\d+\s*小时前|\d+\s*分钟前|\d+\s*秒前|刚刚|昨天|前天|\d{1,2}-\d{1,2})/;
    let best = null, bestN = 0;
    for (const el of document.querySelectorAll('div')) {
      const kids = Array.from(el.children);
      if (kids.length < 2 || kids.length > 300) continue;
      const n = kids.filter(k => timeRe.test(k.innerText || '')).length;
      if (n > bestN) { bestN = n; best = el; }
    }
    const comments = [];
    if (best && bestN >= 1) {
      for (const k of Array.from(best.children)) {
        const t = (k.innerText || '').replace(/\s+/g, ' ').trim();
        if (t.length > 3 && t.length < 800) comments.push(t);
      }
    }
    return {
      content: g('#detail-desc') || g('.note-content') || g('[class*=note-text]') || '',
      comments,
    };
  });
}

module.exports = { name: 'xiaohongshu', searchKeyword, noteDetail };
