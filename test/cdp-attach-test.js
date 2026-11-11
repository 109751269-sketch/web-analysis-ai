// CDP 挂载机制自测：连到带 --remote-debugging-port 启动的 Chrome，复用其会话开新标签页抓取
// 用法: node test/cdp-attach-test.js http://127.0.0.1:9223 https://maimai.cn/community/hot-rank
const { chromium } = require('playwright');

(async () => {
  const cdpUrl = process.argv[2] || 'http://127.0.0.1:9223';
  const url = process.argv[3] || 'https://example.com';
  const browser = await chromium.connectOverCDP(cdpUrl, { timeout: 20000 });
  const contexts = browser.contexts();
  console.log('contexts:', contexts.length);
  const ctx = contexts[0] || await browser.newContext();
  console.log('existing pages:', ctx.pages().length, ctx.pages().map(p => p.url()));

  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);
  const title = await page.title();
  const text = (await page.evaluate(() => document.body.innerText)).slice(0, 200).replace(/\n+/g, ' | ');
  console.log('TITLE:', title);
  console.log('TEXT:', text);
  const cookies = await ctx.cookies();
  console.log('cookies for maimai.cn:', cookies.filter(c => /maimai/.test(c.domain)).length);
  const ls = await page.evaluate(() => {
    try { return Object.keys(localStorage).filter(k => /token|user|uid/i.test(k)).slice(0, 10); } catch (e) { return ['ERR:' + e.message]; }
  }).catch(() => []);
  console.log('localStorage keys(token-ish):', ls);
  await page.close();            // 只关本标签页，不关浏览器
  await browser.close().catch(() => {}); // 注：connectOverCDP 下 close 会断开连接（自测用）
  console.log('DONE');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
