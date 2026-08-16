/**
 * pipeline.js - 核心流程（可编程调用，供 CLI 共用）
 *
 *  runCrawl(task, onLog)    -> 抓取网页，返回 {records, module, tabResults, outDir, files}
 *
 * 支持：
 *  - tab 点击 / 滚动加载 / 自动翻页（下一页）
 *  - 多组采集：task.extract.pages = [{name, tabs, limit, module, fields}]（每组独立 tab + 独立条数，记录带「来源」标记）
 *  - 职位详情补充：task.extract.detail = {enabled, maxItems, selectors, waitMs}（从列表链接进详情页抓描述类字段）
 *  - 安全验证等待（反爬 verify/security 页，等待人工完成或自动通过）
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { ensureDir, writeJson, saveBatch, targetHost, sleep } = require('./util');
const { resolveAuth, injectAuth, hasDomainCookies } = require('./auth');
const { clickTabs, autoScroll, waitForText, clickNextPage } = require('./interact');
const { extractAll, pageStructureSummary } = require('./extract');
const { loadPlaybook, applyPlaybook, savePlaybook, buildPlaybook, qualifies } = require('./playbook');

// 安全验证页特征
const VERIFY_RE = /\/passport\/zp\/(verify|security)|verify\.html|security\.html|_security_check|geetest|nc_/i;

// ---------- 等待页面稳定（含人工安全验证等待） ----------
// 检测到验证页时暂停并等待用户在弹出的浏览器窗口中手动完成（滑块/点击/文字验证），
// 完成后自动继续；默认最长等待 task.verifyWaitTimeout（默认 10 分钟）。
async function waitPageStable(page, task, log) {
  const maxMs = task.verifyWaitTimeout || 600000;
  const start = Date.now();
  let sawVerify = false;
  let lastLog = 0;
  while (Date.now() - start < maxMs) {
    let st = null;
    try {
      st = await page.evaluate(() => ({
        url: location.href,
        len: document.body ? document.body.innerText.length : 0
      }));
    } catch (e) { /* 导航中 */ }
    if (!st) { await sleep(1500); continue; }
    if (VERIFY_RE.test(st.url)) {
      if (!sawVerify) {
        sawVerify = true;
        log('⏳ 检测到安全验证（反爬）。请在浏览器窗口中完成验证（滑块/点击/文字等），');
        log('   完成后将自动继续抓取。正在等待人工验证（最多 ' + Math.round(maxMs / 60000) + ' 分钟）...');
      } else if (Date.now() - lastLog > 30000) {
        log('   ⏳ 仍在等待验证完成...（已等待 ' + Math.round((Date.now() - start) / 1000) + 's）');
        lastLog = Date.now();
      }
      await sleep(3000);
      continue;
    }
    if (st.url.indexOf('about:blank') === -1 && st.len > 120) return true;
    await sleep(2000);
  }
  if (sawVerify) log('✗ 安全验证超时（' + Math.round(maxMs / 60000) + ' 分钟），未通过验证');
  return false;
}

// ---------- 职位详情补充 ----------
async function enrichDetails(page, task, records, log) {
  const cfg = task.extract && task.extract.detail;
  if (!cfg || !cfg.enabled) return records;
  const max = cfg.maxItems || 8;
  const selectors = cfg.selectors || ['.job-sec-text', '.job-detail-section-text', '.job-primary-text', '.job-detail', '.description', '[class*=job-detail]', '[class*=description]'];
  const field = cfg.field || '职位描述';
  let done = 0;
  const origin = await page.evaluate(() => location.origin).catch(() => '');
  log('进入详情页补充「' + field + '」（最多 ' + max + ' 条）...');
  for (const rec of records) {
    if (done >= max) break;
    const link = rec._link;
    if (!link) continue;
    try {
      const abs = /^https?:/.test(link) ? link : origin + (link[0] === '/' ? link : '/' + link);
      await page.goto(abs, { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {});
      await sleep(cfg.waitMs || 1800);
      const desc = await page.evaluate(sel => {
        const pick = s => {
          try {
            const el = document.querySelector(s);
            return el ? (el.innerText || el.textContent || '').trim() : '';
          } catch (e) { return ''; }
        };
        for (const s of sel) {
          const t = pick(s);
          if (t && t.length > 10) return t.replace(/\s*\n\s*/g, '\n').trim();
        }
        const body = document.body ? document.body.innerText : '';
        const m = body.match(/职位描述\s*[\s\S]{1,3000}/);
        if (m) return m[0].replace(/^\s*职位描述\s*/, '').trim();
        return '';
      }, selectors);
      if (desc && desc.length > 10) {
        rec[field] = desc.substring(0, 3000);
        done++;
        log('  ✓ ' + done + '/' + max + ' 条: ' + String(rec._text || '').substring(0, 24) + '（' + desc.length + ' 字）');
      } else {
        log('  ⚠ 未提取到' + field + ': ' + String(rec._text || '').substring(0, 24));
      }
    } catch (e) {
      log('  ⚠ 详情抓取失败: ' + (e.message || '').split('\n')[0]);
    }
    await page.goBack({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
    await sleep(cfg.waitMs || 1200);
    // 返回后若触发验证，等待
    await waitPageStable(page, task, log).catch(() => {});
  }
  log('详情补充完成（' + done + ' 条）');
  return records;
}

// ---------- 抓取 ----------
async function runCrawl(task, onLog) {
  const log = (...m) => { console.log(...m); if (onLog) onLog(m.join(' ')); };
  const outDir = path.resolve(task.outputDir || path.join('output', task.name));
  ensureDir(outDir);

  log('========================================');
  log('Web Analysis AI - 网页抓取');
  log('========================================');
  log('任务: ' + task.name + ' (' + task.title + ')');
  log('目标: ' + task.url);
  log('无头模式: ' + task.headless);
  log('');

  // ---------- 站点攻略：自动应用（避免重复试错） ----------
  const pb = loadPlaybook(task.url);
  if (pb && applyPlaybook(task, pb)) {
    log('✓ 已应用站点攻略: ' + pb.host + (pb.notes ? '（' + pb.notes + '）' : ''));
  }

  // ---------- 会话 ----------
  const authRes = resolveAuth(task);
  const host = targetHost(task.url);
  if (authRes) {
    const ok = hasDomainCookies(authRes.auth, host);
    log(ok
      ? '✓ 会话有效（' + authRes.source + '，含 ' + authRes.auth.cookies.length + ' 个 cookie）'
      : '⚠ 会话来源: ' + authRes.source + '（cookie 域名与目标站不完全匹配，仍会注入，若未登录请检查）');
  } else {
    log('⚠ 未提供会话（cookiesText / authFile），以匿名模式抓取');
  }
  log('');

  const browser = await chromium.launch({
    headless: task.headless,
    slowMo: task.headless ? 0 : 80,
    args: ['--disable-blink-features=AutomationControlled']
  });
  const context = await browser.newContext({
    userAgent: task.userAgent,
    viewport: { width: 1440, height: 900 },
    locale: task.locale || 'zh-CN',
    timezoneId: 'Asia/Shanghai'
  });
  // 反自动化伪装：隐藏 webdriver 标记（降低被反爬识别概率）
  await context.addInitScript(() => {
    try {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] });
    } catch (e) {}
  });
  if (authRes) await injectAuth(context, authRes.auth);

  const page = await context.newPage();
  try {
    log('打开页面: ' + task.url);
    await page.goto(task.url, { waitUntil: 'domcontentloaded', timeout: task.pageLoadTimeout }).catch(e => log('⚠ 首次导航: ' + e.message.split('\n')[0]));
    await sleep(2500);
    const stable = await waitPageStable(page, task, log);
    if (!stable) {
      await browser.close();
      throw new Error('页面未稳定（安全验证未通过），请在有头模式下手动完成验证');
    }
    log('✓ 页面已加载');

    if (task.login && task.login.successIndicators && task.login.successIndicators.length) {
      const loggedIn = await waitForText(page, task.login.successIndicators[0], 8000).catch(() => false);
      log(loggedIn ? '✓ 检测到登录态特征' : '⚠ 未检测到登录特征，继续尝试抓取');
    }

    // ---------- 多组采集 ----------
    const extract = task.extract || {};
    const pageDefs = (extract.pages && extract.pages.length)
      ? extract.pages
      : [{ name: '默认', tabs: task.tabs, limit: extract.limit || 100, module: extract.module || '', fields: extract.fields || [] }];

    const allRecords = [];
    const seen = new Set();
    const tabResults = [];
    let moduleInfo = null;

    for (const pd of pageDefs) {
      // 分组入口：优先 pd.url（直接访问搜索页等），否则点击 tab
      if (pd.url) {
        log('');
        log('[分组「' + pd.name + '」] 打开: ' + pd.url);
        await page.goto(pd.url, { waitUntil: 'domcontentloaded', timeout: task.pageLoadTimeout }).catch(e => log('⚠ 导航: ' + e.message.split('\n')[0]));
        await sleep(2000);
        const okStable = await waitPageStable(page, task, log);
        if (!okStable) { log('✗ 分组「' + pd.name + '」页面未稳定（可能被反爬拦截）'); continue; }
        // SPA 渲染等待（搜索/列表内容异步加载）
        await sleep(task.postNavigateWaitMs || 6000);
      }
      const pdTabs = pd.tabs || [];
      if (pdTabs.length) {
        log('');
        log('[分组「' + pd.name + '」] 切换 tab:');
        const tr = await clickTabs(page, pdTabs, log);
        tabResults.push({ group: pd.name, results: tr });
        await sleep(1000);
      }

      const pag = task.pagination && task.pagination.enabled ? task.pagination : null;
      const maxPages = pag ? (pag.maxPages || 10) : 1;
      let lastUrl = page.url();
      const extOpts = pd => ({
        module: pd.module !== undefined ? pd.module : extract.module,
        fields: pd.fields || extract.fields,
        limit: pd.limit || extract.limit || 100,
        // 每组可独立指定容器选择器（如热榜 ul 与帖子流是不同容器），缺省用全局 extract.containerSelectors
        containerSelectors: (pd.containerSelectors && pd.containerSelectors.length)
          ? pd.containerSelectors
          : extract.containerSelectors
      });

      for (let p = 0; p < maxPages; p++) {
        if (p > 0) {
          log('[分组「' + pd.name + '」] 翻页：点击「下一页」...');
          const clicked = await clickNextPage(page, pag);
          if (!clicked) {
            log('  ✗ 未找到「下一页/加载更多」，该分组结束');
            break;
          }
          const nowUrl = page.url();
          if (nowUrl !== lastUrl) {
            lastUrl = nowUrl;
            await waitPageStable(page, task, log).catch(() => {});
          }
          await sleep(pag.waitMs || 2000);
        }

        // ---------- 增量滚动采集（虚拟滚动列表，如 X 时间线：DOM 只保留视口附近条目） ----------
        if (task.extract.incremental && p === 0) {
          // 自适应增量采集（2026-08-16 重构，满足"按顺序、不遗漏、可接受慢"）：
          //  - 无固定轮次上限：边采边计数，直到达到目标条数或真正触底才停（页面全程不关闭）
          //  - 第 0 轮从顶部（0,0）开始（先采最新推文），之后每次小步向下 0.6×视口：
          //    相邻两轮提取窗口重叠，任何条目至少被提取一次，不遗漏
          //  - 触底判定：连续 maxIdle 轮无新增 且 页面高度不再变化（防加载停顿误判提前停）
          //  - maxRounds（默认 500）仅作防死循环安全上限，不是采集目标
          const min = task.scroll.delayMinMs || 1200;
          const max = task.scroll.delayMaxMs || 2500;
          const maxIdle = task.scroll.maxIdleRounds || 6;
          const maxRounds = task.scroll.maxRounds || 500;
          const target = pd.limit || 100;
          let idle = 0, heightStable = 0, lastHeight = 0, round = 0;
          let groupCount = () => allRecords.filter(r => r['来源'] === pd.name).length;

          // 采集前准备（2026-08-16 加，防"点击 tab 后文章未渲染导致模块误定位"的竞态）：
          // 1) 等待时间线文章渲染（最长 20s）
          try {
            await page.waitForSelector('article', { timeout: 20000 });
          } catch (e) {
            log('  ⚠ 等待文章渲染超时（20s），尝试直接开始');
          }
          // 2) 若出现「查看新帖子」（有更新推文待加载，等价于手动刷新主页），点击加载最新
          const viewNew = await page.evaluate(() => {
            const btns = Array.prototype.slice.call(document.querySelectorAll('[role="button"]'));
            const b = btns.find(x => /查看新帖子|新帖子/.test((x.textContent || '').replace(/\s+/g, '')));
            if (b) { b.click(); return true; }
            return false;
          }).catch(() => false);
          if (viewNew) { log('  ✓ 检测到「查看新帖子」，已点击加载最新推文'); await sleep(3500); }
          // 3) 回到顶部开始采集
          await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});

          for (; round < maxRounds; round++) {
            if (round === 0) {
              await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
            } else {
              const step = await page.evaluate(() => Math.floor(window.innerHeight * 0.6)).catch(() => 600);
              await page.evaluate(dy => window.scrollBy(0, dy), step).catch(() => {});
            }
            await sleep(min + Math.random() * (max - min));
            let result = null;
            try { result = await extractAll(page, extOpts(pd)); } catch (e) { result = null; }
            if (result && result.module && result.module.found) {
              if (!moduleInfo) {
                moduleInfo = result.module;
                log('✓ 模块已定位: <' + result.module.container.tag + '> ' +
                  (result.module.container.cls || ('#' + result.module.container.id)) + ' | 模式: ' + result.module.mode);
              }
              let added = 0;
              for (const rec of result.records) {
                rec['来源'] = pd.name;
                const key = (rec._text || '').substring(0, 150);
                if (!seen.has(key)) { seen.add(key); allRecords.push(rec); added++; }
              }
              log('  ⏳ 采集第 ' + (round + 1) + ' 轮：新增 ' + added + ' 条，累计 ' + groupCount() + '/' + target + ' 条');
              if (groupCount() >= target) { log('  ✓ 已达目标条数（' + target + ' 条），停止'); break; }
              const h = await page.evaluate(() => document.body.scrollHeight).catch(() => lastHeight);
              if (added === 0) { idle++; heightStable = (h === lastHeight) ? heightStable + 1 : 0; }
              else { idle = 0; heightStable = 0; }
              lastHeight = h;
              if (idle >= maxIdle && heightStable >= maxIdle) {
                log('  [已到底部（高度不再变化且无新增），结束]');
                break;
              }
              // 空转止损：一条都没采到且连续 maxIdle 轮无新增 → 模块误定位（如 X 未渲染时间线），
              // 继续空转无意义，报错退出而不是跑到 maxRounds
              if (groupCount() === 0 && idle >= maxIdle) {
                log('  ✗ 已 ' + (round + 1) + ' 轮未采到任何条目（疑似模块误定位：' + (result.module.mode || '?') + '），停止');
                round = maxRounds; // 跳出循环标记
                break;
              }
            } else {
              idle++;
              if (idle >= 3) { log('  ⚠ 连续 ' + idle + ' 轮未提取到内容，停止'); break; }
            }
          }
          log('增量采集完成，累计 ' + groupCount() + '/' + target + ' 条（' + (round + 1) + ' 轮）');
          if (groupCount() === 0) {
            log('✗ 一条都未采到：模块可能误定位或页面未渲染时间线。建议有头模式人工确认页面状态（可先双击「主页」刷新），再重试。');
          } else if (groupCount() < target) {
            log('⚠ 已达底部或安全上限，实际 ' + groupCount() + ' 条 < 目标 ' + target + ' 条（页面内容到此为止，未丢失）');
          }
          // 增量模式单页结束（不进入普通提取）
          if (!pag) break;
          continue;
        }

        // 每页滚动（容错）
        const rounds = p === 0 ? task.scroll.rounds : Math.min(2, task.scroll.rounds);
        if (rounds > 0) {
          log('[分组「' + pd.name + '」] 滚动加载（第 ' + (p + 1) + ' 页，' + rounds + ' 轮）...');
          await autoScroll(page, Object.assign({ log }, task.scroll, { rounds })).catch(() => {});
          await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
          await sleep(500);
        }

        // 提取本页（容错：验证导航导致上下文销毁时，等待恢复后重试一次）
        let result = null;
        try {
          result = await extractAll(page, extOpts(pd));
        } catch (e) {
          log('⚠ 提取中断（' + (e.message || '').split('\n')[0] + '），等待页面恢复后重试...');
          await sleep(8000);
          await waitPageStable(page, task, log);
          try {
            result = await extractAll(page, extOpts(pd));
          } catch (e2) {
            log('  ✗ 重试仍失败，跳过该页');
            result = null;
          }
        }
        if (!result) break;

        if (!result.module || !result.module.found) {
          if (p === 0 && !allRecords.length) {
            // 若为搜索 URL 且未定位到内容，可能被反爬拦截（重定向/验证未过），
            // 等待人工验证或自动恢复后重试一次
            if (pd.url && !pd._retried) {
              pd._retried = true;
              log('⚠ 未定位到模块内容（可能被反爬拦截）。如需验证请在弹出的浏览器窗口中完成，等待 30s 后重试...');
              await sleep(30000);
              await waitPageStable(page, task, log);
              const retry = await extractAll(page, extOpts(pd)).catch(() => ({ module: null, records: [] }));
              if (retry.module && retry.module.found) {
                moduleInfo = retry.module;
                log('✓ 重试后模块已定位: <' + retry.module.container.tag + '> ' +
                  (retry.module.container.cls || ('#' + retry.module.container.id)) + ' | ' + retry.records.length + ' 条');
                for (const r of retry.records) {
                  r['来源'] = pd.name;
                  const key = (r._text || '').substring(0, 80);
                  if (!seen.has(key)) { seen.add(key); allRecords.push(r); }
                }
                continue;
              }
            }
            log('✗ 未定位到模块内容。请检查：模块关键词、tab 名称、是否需要登录/验证。');
            const summary = await pageStructureSummary(page, 12);
            if (summary && summary.length) {
              log('  页面结构摘要（排查用）:');
              summary.forEach(s => log('    <' + s.sig + '> 重复 ' + s.rep + ' 次 · ' + s.sample));
            }
            await browser.close();
            throw new Error('未定位到模块内容');
          }
          log('  ✗ 第 ' + (p + 1) + ' 页未定位到模块，该分组结束');
          break;
        }
        if (p === 0 && !moduleInfo) {
          moduleInfo = result.module;
          log('✓ 模块已定位: <' + result.module.container.tag + '> ' +
            (result.module.container.cls || ('#' + result.module.container.id)) + ' | 模式: ' + result.module.mode);
        }

        let added = 0;
        for (const r of result.records) {
          r['来源'] = pd.name;
          const key = (r._text || '').substring(0, 80);
          if (!seen.has(key)) { seen.add(key); allRecords.push(r); added++; }
        }
        log('  ✓ 第 ' + (p + 1) + ' 页提取 ' + result.records.length + ' 条（新增 ' + added + '），分组累计 ' +
          allRecords.filter(r => r['来源'] === pd.name).length + ' 条');
        if (allRecords.filter(r => r['来源'] === pd.name).length >= (pd.limit || 100)) {
          log('  ✓ 分组「' + pd.name + '」已达目标条数，停止');
          break;
        }
        if (!pag) break;
      }

      // 逐组保存（防止后续分组失败导致数据丢失）
      saveBatch(outDir, 'data', '.json', allRecords);
      log('  [已保存中间结果，累计 ' + allRecords.length + ' 条]');
    }

    const records = allRecords;
    log('');
    log('✓ 共提取条目 ' + records.length + ' 条');

    // ---------- 职位详情补充 ----------
    await enrichDetails(page, task, records, log);

    // ---------- 保存 ----------
    const dataFiles = saveBatch(outDir, 'data', '.json', records);
    writeJson(path.join(outDir, 'snapshot.json'), {
      task: { name: task.name, title: task.title, url: task.url },
      module: moduleInfo,
      tabResults
    });
    log('✓ 数据已保存: ' + dataFiles.latestFile);

    // ---------- 自动学习：成功后保存站点攻略（真实站点 + 质量门槛，避免垃圾数据污染） ----------
    const pbHost = require('./playbook').hostKey(task.url);
    if (pbHost !== 'local' && pbHost !== 'unknown' && qualifies(task, records)) {
      try {
        // 保留已有手工经验 notes（避免自动学习覆盖人工沉淀）
        const prevPb = loadPlaybook(task.url);
        const prevNotes = (prevPb && prevPb.notes && !/^自动学习/.test(prevPb.notes)) ? prevPb.notes : '';
        const notes = [prevNotes, '自动学习（' + records.length + ' 条样本）'].filter(Boolean).join('；');
        savePlaybook(task.url, buildPlaybook(task, { notes }));
        log('✓ 已学习并保存站点攻略: playbooks/' + pbHost + '.json');
      } catch (e) { /* 忽略保存失败 */ }
    }

    records.slice(0, 3).forEach((r, i) => {
      log('  ' + (i + 1) + '. ' + JSON.stringify(r).substring(0, 180));
    });
    log('');
    log('抓取完成，共 ' + records.length + ' 条');
    return { records, module: moduleInfo, tabResults, outDir, files: dataFiles };
  } finally {
    await browser.close().catch(() => {});
  }
}

module.exports = { runCrawl };
