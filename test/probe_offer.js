'use strict';
const path = require('path');
const { chromium } = require('playwright');
const SKILL = path.resolve(__dirname, '..');
const URL_TARGET = process.argv[2] || 'https://maimai.cn/web/search_center?type=gossip&query=offer&highlight=true';

(async () => {
  const userDataDir = path.join(SKILL, 'profiles', 'maimai.cn');
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    slowMo: 80,
    args: ['--disable-blink-features=AutomationControlled'],
    viewport: { width: 1440, height: 900 },
    locale: 'zh-CN'
  });
  const page = await ctx.newPage();
  await page.goto(URL_TARGET, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(e => console.log('nav:', e.message.split('\n')[0]));
  await page.waitForTimeout(5000);

  const info = await page.evaluate(() => {
    const out = {};
    out.title = document.title;
    out.url = location.href;
    // 候选容器
    const cands = Array.from(document.querySelectorAll('div,ul,li')).filter(el => {
      const t = (el.innerText || '').trim();
      if (t.length < 80 || t.length > 6000) return false;
      const kids = el.querySelectorAll(':scope > *').length;
      return kids >= 2 && kids <= 30;
    });
    out.candidateCount = cands.length;
    out.candidates = cands.slice(0, 12).map(el => {
      const style = el.getAttribute('class') || '';
      return { tag: el.tagName.toLowerCase(), cls: style.slice(0, 90), kids: el.children.length, text: (el.innerText || '').replace(/\s+/g, ' ').slice(0, 220) };
    });
    // 评论相关按钮/文案
    const btnPats = /查看全部\d*条评论|展开评论|共\d+条评论|查看\d+条回复|全部评论|查看更多|条评论|回复/;
    const btns = Array.from(document.querySelectorAll('button,a,span,div')).filter(el => {
      const t = ((el.innerText || el.textContent) || '').replace(/\s+/g, '').trim();
      return t.length > 0 && t.length <= 20 && btnPats.test(t);
    });
    out.commentButtons = btns.slice(0, 25).map(el => ({
      tag: el.tagName.toLowerCase(),
      cls: (el.getAttribute('class') || '').slice(0, 70),
      text: ((el.innerText || el.textContent) || '').replace(/\s+/g, ' ').trim().slice(0, 40)
    }));
    return out;
  });
  console.log('=== PAGE ===');
  console.log('title:', info.title);
  console.log('url:', info.url);
  console.log('candidateCount:', info.candidateCount);
  console.log('\n=== CANDIDATES ===');
  info.candidates.forEach((c, i) => console.log(`[${i}] <${c.tag}> kids=${c.kids} cls="${c.cls}"\n    ${c.text}\n`));
  console.log('=== COMMENT-ISH ELEMENTS ===');
  info.commentButtons.forEach((c, i) => console.log(`[${i}] <${c.tag}> cls="${c.cls}" :: ${c.text}`));

  await page.screenshot({ path: 'offer_probe.png', fullPage: false }).catch(() => {});
  console.log('\nscreenshot: offer_probe.png');
  await ctx.close();
})().catch(e => { console.log('ERR', e.message); process.exit(1); });
