/**
 * interact.js - 页面交互：tab 点击 / 滚动加载 / 等待
 *
 * 关键能力：用户给出 tab 栏位名称，脚本自动找到并点击，
 * 支持多种 tab 形态（role=tab、button、a、[class*=tab]、[data-tab] 等）。
 */
'use strict';

const { sleep } = require('./util');

/**
 * 在页面中查找 tab 元素（按文本）
 * 返回 null 或元素句柄
 */
async function findTabByText(page, name) {
  const handle = await page.evaluateHandle(text => {
    const norm = s => (s || '').replace(/\s+/g, '').trim();
    const target = norm(text);
    if (!target) return null;

    // 候选元素：优先可点击语义
    const isClickable = el => {
      const tag = el.tagName.toLowerCase();
      if (['button', 'a', 'summary', 'input', 'select'].includes(tag)) return true;
      const cls = (el.className && typeof el.className === 'string') ? el.className.toLowerCase() : '';
      const role = (el.getAttribute && el.getAttribute('role') || '').toLowerCase();
      if (['tab', 'menuitem', 'menuitemradio', 'option', 'checkbox', 'radio'].some(r => role.indexOf(r) !== -1)) return true;
      if (cls.indexOf('tab') !== -1 || cls.indexOf('tab-item') !== -1 || cls.indexOf('menu-item') !== -1) return true;
      if (el.getAttribute && (el.getAttribute('data-tab') || el.getAttribute('data-key') || el.getAttribute('data-type'))) return true;
      if (el.tagName === 'DIV' && el.children.length <= 3 && el.getAttribute('data-') !== null) return true;
      return false;
    };

    const all = Array.prototype.slice.call(document.querySelectorAll('body *'));
    const exact = [], contains = [];
    for (const el of all) {
      if (el.children.length > 8) continue; // 跳过容器
      const t = norm(el.textContent);
      if (!t || t.length > 50) continue;
      if (t === target) exact.push(el);
      else if (t.indexOf(target) !== -1 && t.length < target.length * 2 + 4) contains.push(el);
    }
    // 优先：文本完全匹配且可点击；其次完全匹配任意；再其次包含匹配
    const pick = list => {
      for (const el of list) if (isClickable(el)) return el;
      return list.length ? list[0] : null;
    };
    return pick(exact) || pick(contains) || null;
  }, name);

  const ok = await page.evaluate(h => {
    if (!h || h === null) return false;
    // 标记选中的 tab，方便调试与后续点击
    h.setAttribute('data-dsh-tab', '1');
    return true;
  }, handle);
  return ok ? handle : null;
}

/**
 * 依次点击指定名称的 tab（task.tabs: [{name, waitMs}]）
 * 返回 [{name, found, clicked}]
 */
async function clickTabs(page, tabs, log) {
  const results = [];
  const list = Array.isArray(tabs) ? tabs : (tabs ? [tabs] : []);
  for (const t of list) {
    const name = typeof t === 'string' ? t : t.name;
    const waitMs = (typeof t === 'object' && t.waitMs) || 1500;
    if (!name) continue;
    try {
      // 懒加载元素重试：最多 6 次 × 1.5s
      let el = null;
      for (let attempt = 0; attempt < 6; attempt++) {
        el = await findTabByText(page, name);
        if (el) break;
        if (attempt === 0) log('  等待 tab「' + name + '」渲染（懒加载）...');
        await sleep(1500);
      }
      if (!el) {
        log('  ✗ 未找到 tab「' + name + '」，尝试直接滚动等待');
        results.push({ name, found: false, clicked: false });
        await sleep(waitMs);
        continue;
      }
      if (typeof t === 'object' && t.dblclick) {
        // 双击元素（如 X「正在关注」tab：单击仅选中，双击才弹出排序菜单）
        await el.dblclick().catch(async () => { await el.evaluate(n => n.dblclick()); });
        log('  ✓ 已双击 tab「' + name + '」（弹出排序菜单），等待 ' + waitMs + 'ms');
      } else if (typeof t === 'object' && t.clickEdge) {
        // 点击元素右缘（如 tab 的排序下拉箭头）
        const box = await el.boundingBox().catch(() => null);
        if (box) {
          await page.mouse.click(box.x + box.width - 10, box.y + box.height / 2);
          log('  ✓ 已点击 tab「' + name + '」右缘（展开下拉），等待 ' + waitMs + 'ms');
        } else {
          await el.click().catch(() => {});
        }
      } else {
        await el.click().catch(async () => { await el.evaluate(n => n.click()); });
        log('  ✓ 已点击 tab「' + name + '」，等待内容加载 ' + waitMs + 'ms');
      }
      results.push({ name, found: true, clicked: true });
      await sleep(waitMs);
    } catch (e) {
      log('  ✗ tab「' + name + '」点击异常: ' + e.message.split('\n')[0]);
      results.push({ name, found: false, clicked: false });
    }
  }
  return results;
}

/**
 * 滚动加载更多（参考 Crawler-mm 经验）
 * rounds: 滚动轮数；连续 maxIdleRounds 轮高度不变则提前结束
 */
async function autoScroll(page, opts) {
  const rounds = opts.rounds || 0;
  const min = opts.delayMinMs || 1200;
  const max = opts.delayMaxMs || 2500;
  const maxIdle = opts.maxIdleRounds || 6;
  const log = opts.log || console.log;

  let idle = 0, lastHeight = 0;
  for (let i = 0; i < rounds; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
    const delay = min + Math.random() * (max - min);
    // 到底检测
    try {
      const h = await page.evaluate(() => document.body.scrollHeight);
      if (h === lastHeight) {
        idle++;
        if (idle >= maxIdle) {
          log('  [滚动到底，提前结束：第 ' + i + '/' + rounds + ' 轮]');
          return;
        }
      } else {
        idle = 0;
        lastHeight = h;
      }
    } catch (e) { /* 忽略 */ }
    await sleep(delay);
  }
}

/**
 * 等待页面出现指定文本（用于登录/内容加载确认）
 */
async function waitForText(page, text, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const found = await page.evaluate(t => document.body && document.body.innerText.indexOf(t) !== -1, text).catch(() => false);
    if (found) return true;
    await sleep(800);
  }
  return false;
}

/**
 * 点击「下一页 / 加载更多」按钮（分页采集）
 * 返回 true=已点击，false=未找到
 * opts: {buttonText: 自定义按钮文本或选择器, waitMs: 点击后等待}
 */
async function clickNextPage(page, opts) {
  const o = opts || {};
  // 支持自定义选择器
  if (o.selector) {
    const el = await page.$(o.selector).catch(() => null);
    if (el) {
      await el.click().catch(() => {});
      await sleep(o.waitMs || 2000);
      return true;
    }
    return false;
  }
  const patterns = (o.buttonText ? [String(o.buttonText)] : ['下一页', '下页', '加载更多', '查看更多', '>>', '»', '›']).map(s => String(s).replace(/\s+/g, ''));
  const found = await page.evaluateHandle(pts => {
    const norm = s => (s || '').replace(/\s+/g, '').trim();
    const targets = pts.filter(Boolean).map(norm);
    const all = document.querySelectorAll('body *');
    let best = null;
    for (const el of all) {
      const tag = el.tagName.toLowerCase();
      if (!['a', 'button', 'span', 'div', 'li'].includes(tag)) continue;
      if (el.children.length > 3) continue;
      const txt = norm(el.textContent);
      if (!txt || txt.length > 14) continue;
      if (targets.indexOf(txt) !== -1) {
        const score = (tag === 'a' || tag === 'button') ? 2 : 1;
        if (!best || score > best.score) best = { el, score };
      }
    }
    if (!best) return false;
    best.el.setAttribute('data-dsh-next', '1');
    return true;
  }, patterns);
  const ok = await page.evaluate(h => !!h, found);
  if (!ok) return false;
  await page.click('[data-dsh-next]').catch(() =>
    page.evaluate(() => { const el = document.querySelector('[data-dsh-next]'); if (el) el.click(); }));
  await page.evaluate(() => { const el = document.querySelector('[data-dsh-next]'); if (el) el.removeAttribute('data-dsh-next'); }).catch(() => {});
  await sleep(o.waitMs || 2000);
  return true;
}

module.exports = { findTabByText, clickTabs, autoScroll, waitForText, clickNextPage };
