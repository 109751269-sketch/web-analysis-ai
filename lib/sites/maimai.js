'use strict';
/**
 * 脉脉采集器（RSC 方案，2026-11-09 改版后）
 * 依赖：CDP 挂载已登录的 Chromium
 */

const FARM_ACCOUNTS = null; // 由 research.js 统一过滤

function fixMojibake(s) {
  if (typeof s !== 'string' || !s) return s;
  if (/[一-鿿]/.test(s)) return s;
  if (!/[À-ÿŒœŠšŸŽž‘-„†-•…‰‹-›€™]/.test(s)) return s;
  const CP = { 0x20AC: 0x80, 0x201A: 0x82, 0x0192: 0x83, 0x201E: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x02C6: 0x88, 0x2030: 0x89, 0x0160: 0x8A, 0x2039: 0x8B, 0x0152: 0x8C, 0x017D: 0x8E, 0x2018: 0x91, 0x2019: 0x92, 0x201C: 0x93, 0x201D: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02DC: 0x98, 0x2122: 0x99, 0x0161: 0x9A, 0x203A: 0x9B, 0x0153: 0x9C, 0x017E: 0x9E, 0x0178: 0x9F };
  const bytes = [];
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (cp <= 0xFF) bytes.push(cp);
    else if (CP[cp] !== undefined) bytes.push(CP[cp]);
    else return s;
  }
  const dec = Buffer.from(bytes).toString('utf8');
  if (dec.includes('�') || !/[一-鿿]/.test(dec)) return s;
  return dec;
}

function extractObjects(text, anchor) {
  const out = [];
  let i = 0;
  while ((i = text.indexOf(anchor, i)) !== -1) {
    let depth = 0, j = i, inStr = false, esc = false;
    for (; j < text.length; j++) {
      const c = text[j];
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) { j++; break; } }
    }
    try { out.push(JSON.parse(text.slice(i, j))); } catch (e) { }
    i = j;
  }
  return out;
}

const unescapeRSC = t => t.replace(/\\"/g, '"');

const TOPICS = {
  impression: 'https://maimai.cn/community/topic-detail/12dLH8oC3/crtime',
  baoliao: 'https://maimai.cn/community/topic-detail/SxAXPZZ2/crtime',
  salary: 'https://maimai.cn/community/topic-detail/JFvwxmvD/crtime',
  worktime: 'https://maimai.cn/community/topic-detail/zfe4YoeG/crtime',
  gossip: 'https://maimai.cn/community/home/gossip',
  recommended: 'https://maimai.cn/community/home/recommended',
};

async function collectPosts(page, url, { scrolls = 30, waitMs = 1800 } = {}) {
  const chunks = [];
  const handler = async r => {
    if (!/maimai\.cn/.test(r.url())) return;
    const ct = (r.headers()['content-type'] || '');
    if (/image|font|css|javascript/.test(ct)) return;
    try { const t = await r.text(); if (t.length > 2000) chunks.push(t); } catch (e) { }
  };
  page.on('response', handler);   // 必须先挂再 goto
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => { });
  await new Promise(r => setTimeout(r, 5000));
  for (let i = 0; i < scrolls; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => { });
    await new Promise(r => setTimeout(r, waitMs));
  }
  page.off('response', handler);

  const raw = chunks.join('\n');
  let objs = extractObjects(unescapeRSC(raw), '{"author_info":');
  if (!objs.length) objs = extractObjects(raw, '{"author_info":');
  const byId = new Map();
  for (const o of objs) {
    if (!o.id) continue;
    const ai = o.author_info || {};
    byId.set(String(o.id), {
      id: String(o.id),
      egid: o.egid || '',
      text: fixMojibake(o.copy_text || ''),
      author: fixMojibake(ai.name || ''),
      identity: fixMojibake(ai.compos || ''),
      cmts: o.cmts || 0,
    });
  }
  return [...byId.values()];
}

async function collectComments(page, post) {
  const chunks = [];
  const handler = async r => {
    const u = r.url();
    if (!/maimai\.cn\/community/.test(u)) return;
    const ct = (r.headers()['content-type'] || '');
    if (/image|font|css|javascript/.test(ct)) return;
    try { const t = await r.text(); if (t.length > 1000) chunks.push(t); } catch (e) { }
  };
  page.on('response', handler);
  const url = `https://maimai.cn/community/gossip-detail/${post.id}?egid=${post.egid}&gid=${post.id}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => { });
  await new Promise(r => setTimeout(r, 4500));
  for (let s = 0; s < 4; s++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => { });
    await new Promise(r => setTimeout(r, 1500));
  }
  page.off('response', handler);

  const raw = chunks.join('\n');
  let objs = extractObjects(unescapeRSC(raw), '{"comments":');
  if (!objs.length) objs = extractObjects(raw, '{"comments":');
  const byId = new Map();
  for (const o of objs) {
    const lst = (o.comments && o.comments.lst) || [];
    for (const c of lst) {
      const u = c.u || {};
      const text = fixMojibake(c.rt || c.copy_text || '');
      if (!text) continue;
      byId.set(String(c.id || text.slice(0, 30)), {
        author: fixMojibake(u.name || ''),
        identity: fixMojibake(u.compos || ''),
        time: fixMojibake(c.time_str || ''),
        text,
        likes: c.likes || 0,
      });
    }
  }
  return { post: post.text, author: post.author, identity: post.identity, comments: [...byId.values()] };
}

module.exports = { name: 'maimai', TOPICS, collectPosts, collectComments, fixMojibake };
