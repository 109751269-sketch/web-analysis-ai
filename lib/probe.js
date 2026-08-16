/**
 * probe.js - 页面结构探测器（有头模式便于观察）
 * 用法: node lib/probe.js --url=https://... [--cookies=tasks/auth-xxx.json] [--headless=false]
 * 输出: 页面标题/URL、候选 tab、输入框、正文预览、重复结构摘要 + 截图
 */
'use strict';

const path = require('path');
const { chromium } = require('playwright');
const { parseArgs, writeJson } = require('./util');
const { loadAuthFile, injectAuth } = require('./auth');
const { pageStructureSummary } = require('./extract');

async function main() {
  const args = parseArgs();
  const url = args.url;
  if (!url) { console.error('✗ 缺少 --url='); process.exit(1); }
  const headless = args.headless === 'true';
  const auth = args.cookies ? loadAuthFile(path.resolve(args.cookies)) : null;

  const browser = await chromium.launch({ headless, slowMo: 120 });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 }
  });
  if (auth) {
    const n = await injectAuth(context, auth);
    console.log('✓ 已注入 ' + n + ' 个 cookie');
  }
  const page = await context.newPage();
  // 通用响应日志：只打印目标站点域名的响应（任何站点适用，非 zhipin 专属）
  const hostFilter = (() => {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return ''; }
  })();
  page.on('response', r => {
    const u = r.url();
    if (u.indexOf('about:') !== -1) return;
    if (hostFilter && u.indexOf(hostFilter) !== -1) {
      console.log('  [resp] ' + r.status() + ' ' + u.substring(0, 120));
    }
  });
  page.on('pageerror', e => console.log('  [pageerror] ' + e.message));
  page.on('console', m => { if (m.type() === 'error') console.log('  [console.error] ' + m.text().substring(0, 150)); });
  try {
    console.log('打开: ' + url);
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(e => console.log('首次导航异常: ' + e.message.split('\n')[0]));
    console.log('导航响应: ' + (resp ? resp.status() + ' ' + resp.url() : 'null'));

    // 等待页面稳定：跳过安全验证（可能自动完成或需要人工），等待 URL 非 about:blank 且正文非空
    const waitStable = async (maxMs) => {
      const start = Date.now();
      let stable = false;
      while (Date.now() - start < maxMs) {
        try {
          const st = await page.evaluate(() => ({
            url: location.href,
            len: document.body ? document.body.innerText.length : 0,
            title: document.title
          }));
          if (st.url.indexOf('about:blank') === -1 && st.len > 200) { stable = true; break; }
          console.log('  [wait] url=' + st.url.substring(0, 90) + ' len=' + st.len);
        } catch (e) { /* 导航中，忽略 */ }
        await new Promise(r => setTimeout(r, 2000));
      }
      return stable;
    };
    const ok = await waitStable(60000);
    console.log(ok ? '✓ 页面已稳定' : '⚠ 60s 内未稳定（可能卡在安全验证，请在弹出的浏览器窗口手动完成）');
    await new Promise(r => setTimeout(r, 3000));

    const info = await page.evaluate(() => {
      const out = {};
      out.title = document.title;
      out.url = location.href;
      // 候选 tab / 按钮
      const cands = [];
      const all = document.querySelectorAll('body button, body a, [role=tab], [class*=tab]');
      const seen = new Set();
      for (const el of all) {
        const t = (el.textContent || '').replace(/\s+/g, '').trim();
        if (!t || t.length > 16 || t.length < 1) continue;
        const tag = el.tagName.toLowerCase();
        const cls = (el.className && typeof el.className === 'string') ? el.className.split(/\s+/).slice(0, 2).join(' ') : '';
        const key = t + '|' + tag + '|' + cls;
        if (seen.has(key)) continue;
        seen.add(key);
        cands.push(t + ' <' + tag + (cls ? ' .' + cls : '') + '>');
      }
      out.tabs = cands.slice(0, 60);
      // 输入框
      out.inputs = Array.prototype.slice.call(document.querySelectorAll('input')).slice(0, 10).map(i => ({
        placeholder: i.placeholder || '', cls: i.className || '', type: i.type
      }));
      // 正文预览（判断是否登录/验证页）
      const body = document.body ? document.body.innerText : '';
      out.bodyPreview = body.replace(/\n+/g, ' | ').substring(0, 1800);
      out.bodyLen = body.length;
      return out;
    });
    console.log('标题: ' + info.title);
    console.log('URL : ' + info.url);
    console.log('正文长度: ' + info.bodyLen);
    console.log('正文预览: ' + info.bodyPreview.substring(0, 600));
    console.log('');
    console.log('候选 tab/按钮 (' + info.tabs.length + '):');
    info.tabs.slice(0, 40).forEach(t => console.log('  ' + t));
    console.log('');
    console.log('输入框 (' + info.inputs.length + '):');
    info.inputs.forEach(i => console.log('  placeholder="' + i.placeholder + '" cls=' + i.cls));
    console.log('');
    const summary = await pageStructureSummary(page, 15);
    console.log('重复结构摘要:');
    summary.forEach(s => console.log('  <' + s.sig + '> ×' + s.rep + ' | ' + s.sample));
    console.log('');
    await page.screenshot({ path: path.resolve('output', '_probe_' + Date.now() + '.png'), fullPage: false });
    writeJson(path.resolve('output', '_probe.json'), info);
    console.log('✓ 截图已保存到 output/_probe_*.png');
  } catch (e) {
    console.error('✗ 探测失败: ' + e.message);
  } finally {
    await browser.close();
  }
}

main();
