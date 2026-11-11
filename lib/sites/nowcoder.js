'use strict';
/**
 * 牛客采集器（公开 API，无需登录）
 * 端点：gw-c.nowcoder.com/api/sparta
 */

const BASE = 'https://gw-c.nowcoder.com/api/sparta';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const HDR = { 'User-Agent': UA, Referer: 'https://www.nowcoder.com/', 'x-requested-with': 'XMLHttpRequest', Accept: 'application/json, text/plain, */*', 'accept-language': 'zh-CN' };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function get(url) {
  const r = await fetch(url, { headers: HDR });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

// 公司名 → companyId（POST，GET 会 400）
async function findCompany(name) {
  const r = await fetch(`${BASE}/pc/search`, {
    method: 'POST',
    headers: { ...HDR, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: name, type: 'all', page: 1 }),
  });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const res = await r.json();
  const cos = ((res.data && res.data.records) || []).filter(x => x.rc_type === 205);
  for (const c of cos) {
    const cn = (c.data && c.data.companyName) || '';
    if (cn === name || cn.replace(/[（(].*/, '') === name) return { companyId: c.entityDataId, companyName: cn };
  }
  return cos.length ? { companyId: cos[0].entityDataId, companyName: (cos[0].data && cos[0].data.companyName) || name } : null;
}

async function collectEvaluations(companyId, maxPages = 80) {
  const tags = (await get(`${BASE}/experience/company/evaluation/tag?id=${companyId}`)).data.result || [];
  const byId = new Map();
  const dimOf = new Map();
  for (const t of tags) {
    const qs = t.id === 0 ? '' : `&tagId=${t.id}`;
    let pageNo = 1, totalPage = 1;
    do {
      const d = (await get(`${BASE}/experience/company/evaluation/list?companyId=${companyId}&pageNo=${pageNo}${qs}`)).data;
      totalPage = d.totalPage || 1;
      for (const rec of d.records || []) {
        if (!byId.has(rec.contentId)) byId.set(rec.contentId, rec);
        const s = new Set(dimOf.get(rec.contentId) || []);
        if (t.id !== 0) s.add(t.word);
        dimOf.set(rec.contentId, s);
      }
      pageNo++;
      await sleep(280);
    } while (pageNo <= totalPage && pageNo <= maxPages);
  }
  return [...byId.values()].map(r => ({ ...r, _dims: [...(dimOf.get(r.contentId) || [])] }));
}

async function collectComments(contentId, entityType = 250) {
  const out = [];
  let pageNo = 1, totalPage = 1;
  do {
    const j = await get(`${BASE}/comment/list-by-page?entityId=${contentId}&entityType=${entityType}&order=2&pageNo=${pageNo}&toCommentId=0`);
    if (!j.success || !j.data) break;
    totalPage = j.data.totalPage || 1;
    for (const c of j.data.records || []) {
      out.push({
        author: (c.userBrief && c.userBrief.nickname) || '',
        identity: (c.userBrief && c.userBrief.authDisplayInfo) || '',
        text: c.content || '',
        likes: c.likeCnt || 0,
        time: c.createTime || '',
      });
    }
    pageNo++;
    await sleep(260);
  } while (pageNo <= totalPage && pageNo <= 30);
  return out;
}

const text = r => {
  const cd = r.contentData || {};
  return ((cd.title || '') + '。' + (cd.content || '')).replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
};

module.exports = { name: 'nowcoder', findCompany, collectEvaluations, collectComments, text };
