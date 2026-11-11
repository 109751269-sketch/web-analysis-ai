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
 * 滚动加载更多（默认自适应调速，2026-08-16 升级）
 *  - adaptive（默认 true）：延迟按加载速率自动调速——高度有增长→延迟降到下限（快），
 *    高度无增长（空转）→延迟升到上限（给加载时间），连续 maxIdleRounds 轮高度不变视为触底/停顿提前结束。
 *  - adaptive: false 时退化为旧的固定随机延迟。
 * opts: {rounds, delayMinMs, delayMaxMs, maxIdleRounds, adaptive}
 */
async function autoScroll(page, opts) {
  const rounds = Math.max(0, Math.floor(Number(opts.rounds) || 0));
  const adaptive = opts.adaptive !== false;
  // 2026-09-12 机器层默认提速：adaptive 下限 400→300，上限 2500→1200
  const min = opts.delayMinMs != null ? opts.delayMinMs : (adaptive ? 300 : 1200);
  const max = opts.delayMaxMs != null ? opts.delayMaxMs : (adaptive ? 1500 : 2500);
  // 2026-10-25 加固（独立验证员 T4 发现）：非数字 maxIdleRounds 会让 `idle >= maxIdle` 恒为 false
  // （NaN/字符串比较）→ 高度触底永不触发。此处统一强制为 ≥1 的整数，非法值回落 12。
  const maxIdle = Math.max(1, Math.floor(Number(opts.maxIdleRounds)) || 12);
  // 2026-09-12 关键修正：慢的是「服务端加载」，不是我方延迟。
  // 缩短 sleep 只会让「页面还没加载完就判定高度未变」→ 连续 N 轮 → 误判触底提前收工（少拿数据）。
  // 正确做法：滚动后先轮询等待内容变高（最多 loadWaitMs），加载慢就多等，等到了立刻继续。
  const loadWait = opts.loadWaitMs != null ? opts.loadWaitMs : 3000;
  const log = opts.log || console.log;
  // 2026-09-14 修复：触底判定不能只看「高度」。
  // 站点可能已显示「没有更多内容/已加载全部」而 DOM 仍在重排（骨架屏、相对时间刷新、图片加载）→ 高度一直变 → 永远判不到触底。
  // 增加两路信号：① 页面文案出现「到底/无更多」标志；② 条目计数（由调用方通过 countFn 提供）。
  const endRe = opts.endMarkerRe ? new RegExp(opts.endMarkerRe)
    : /(没有更多内容|无更多内容|没有更多了|已加载全部|已经到底|到底了|没有啦|已到底部)/;
  let endHits = 0, lastCount = -1, sameCount = 0;
  const countFn = opts.countFn || null;

  async function waitGrow(prev) {
    const t0 = Date.now();
    while (Date.now() - t0 < loadWait) {
      await sleep(200);
      let h = prev;
      try { h = await page.evaluate(() => document.body.scrollHeight); } catch (e) { return false; }
      if (h > prev) return true;
    }
    return false;
  }

  let idle = 0, lastHeight = 0, delay = min;
  const step = Math.max(50, Math.round((max - min) / 8));
  for (let i = 0; i < rounds; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
    await waitGrow(lastHeight);          // 先等加载（慢就多等），而不是死等固定 delay
    await sleep(delay);                  // 加载完再给一个小间隔，供 adaptive 调速
    let h = lastHeight;
    try { h = await page.evaluate(() => document.body.scrollHeight); } catch (e) { /* 导航中忽略 */ }

    // ① 页面底部标志文案（连续 2 轮命中才算，避免列表中间的「加载更多」误触发）
    try {
      const tailTxt = await page.evaluate(() => (document.body ? document.body.innerText : '').slice(-400)).catch(() => '');
      if (tailTxt && endRe.test(tailTxt)) {
        endHits++;
        if (endHits >= 2) {
          log('  [滚动到底：页面出现「' + (tailTxt.match(endRe) || [''])[0] + '」标志（第 ' + (i + 1) + '/' + rounds + ' 轮）]');
          return { stalled: true, reason: 'end-marker' };
        }
      } else endHits = 0;
    } catch (e) {}

    // ② 条目计数连续不变（高度易受重排干扰，计数更可信）
    if (countFn) {
      try {
        const c = await countFn();
        if (typeof c === 'number' && c >= 0) {
          sameCount = c === lastCount ? sameCount + 1 : 0;
          lastCount = c;
          if (sameCount >= 4 && c > 0) {
            log('  [滚动到底：条目计数连续 ' + sameCount + ' 轮保持 ' + c + ' 条不变（第 ' + (i + 1) + '/' + rounds + ' 轮）]');
            return { stalled: true, reason: 'count-stable' };
          }
        }
      } catch (e) {}
    }

    if (h > lastHeight) {
      idle = 0;
      if (adaptive) delay = Math.max(min, delay - step);
    } else {
      idle++;
      if (adaptive) delay = Math.min(max, delay + step);
      if (idle >= maxIdle) {
        log('  [滚动触底/停顿：连续 ' + idle + ' 轮高度未变化，提前结束（第 ' + (i + 1) + '/' + rounds + ' 轮）]');
        return { stalled: true };
      }
    }
    lastHeight = h;
  }
  return { stalled: false };
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
