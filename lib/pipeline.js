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
const { resolveAuth, injectAuth, hasDomainCookies, saveSession, isLoggedIn } = require('./auth');
const { clickTabs, autoScroll, waitForText, clickNextPage } = require('./interact');
const { extractAll, locateModule, detectItems, pageStructureSummary } = require('./extract');
const { loadPlaybook, applyPlaybook, savePlaybook, buildPlaybook, qualifies } = require('./playbook');
const df = require('./datefilter');

// 安全验证页特征
const VERIFY_RE = /\/passport\/zp\/(verify|security)|verify\.html|security\.html|_security_check|geetest|nc_/i;

// ---------- 等待页面稳定（含人工安全验证等待） ----------
// 检测到验证页时暂停并等待用户在弹出的浏览器窗口中手动完成（滑块/点击/文字验证），
// 完成后自动继续；默认最长等待 task.verifyWaitTimeout（默认 10 分钟）。
async function waitPageStable(page, task, log) {
  const maxMs = task.verifyWaitTimeout || 600000;
  // 2026-10-25 加：正文长度阈值可配。
  // 原实现写死 `st.len > 120`：正文 ≤120 字的页面（内容稀疏页、本地测试 fixture）
  // 会**永远不满足**，于是静默等满 verifyWaitTimeout（默认 10 分钟）且期间不打任何日志，
  // 表现为"引擎假死"。现默认值不变（120），可用 task.minBodyChars 调低。
  const minChars = task.minBodyChars != null ? Number(task.minBodyChars) : 120;
  const start = Date.now();
  let sawVerify = false;
  let lastLog = 0;
  let warnedShort = false;
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
    if (st.url.indexOf('about:blank') === -1 && st.len > minChars) return true;
    // 非验证页却迟迟不稳定 → 明确告知原因，避免"假死"误判（只提示一次）
    if (!warnedShort && Date.now() - start > 10000) {
      warnedShort = true;
      log('⚠ 页面正文仅 ' + st.len + ' 字（判定阈值 ' + minChars + ' 字），等待页面渲染/加载中…');
      log('  → 若是内容稀疏页或本地 fixture，请把 task.minBodyChars 调低（如 40）；');
      log('  → 若是登录/验证页，请在浏览器窗口里手动完成后自动继续。等待上限 ' +
        Math.round(maxMs / 60000) + ' 分钟（task.verifyWaitTimeout）。');
    }
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
  // 2026-10-25 修复：相对链接的解析基准。
  // 原实现用 `location.origin` 拼绝对地址，但 **`file://` 页面下 origin 是字符串 "null"**
  // → 拼出 `null/xxx.html`，goto 必然失败、详情补充静默什么都不填（本地 fixture 实测）。
  // 改为以「列表页自身的 URL」为基准用 new URL() 解析（必须在循环前取，否则会被上一轮详情页 URL 污染）。
  const baseUrl = (() => {
    try { const u = page.url(); return (u && u !== 'about:blank') ? u : (task.url || ''); }
    catch (e) { return task.url || ''; }
  })();
  const origin = await page.evaluate(() => location.origin).catch(() => '');
  log('进入详情页补充「' + field + '」（最多 ' + max + ' 条）...');
  for (const rec of records) {
    if (done >= max) break;
    const link = rec._link;
    if (!link) continue;
    try {
      let abs = '';
      try { abs = new URL(link, baseUrl).href; } catch (e) { abs = ''; }
      if (!abs || abs === 'null') abs = /^https?:/.test(link) ? link : origin + (link[0] === '/' ? link : '/' + link);
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
  log('========================================');
  log('Web Analysis AI - 网页抓取');
  log('========================================');
  log('任务: ' + task.name + ' (' + task.title + ')');
  log('目标: ' + task.url);
  log('无头模式: ' + task.headless);
  log('');

  // 2026-10-25 修复（D4）：output/ 落点护栏。
  // 落点原本随 cwd 走；若有人在**技能目录内**执行 node，产物会写进技能实体
  // （~/.agents/skills/web-analysis-ai 是全 agent 共享真源），污染共享资产。
  const engineRoot = path.resolve(__dirname, '..');
  let outDir = path.resolve(task.outputDir || path.join('output', task.name));
  if (outDir === engineRoot || outDir.startsWith(engineRoot + path.sep)) {
    const fallback = path.resolve(process.cwd(), 'output', task.name);
    const fallbackBad = (fallback === engineRoot || fallback.startsWith(engineRoot + path.sep));
    const target = fallbackBad ? path.join(require('os').tmpdir(), 'wai-output', task.name) : fallback;
    log('⚠ 输出目录落在技能目录内：' + outDir);
    log('  → 技能目录是全 agent 共享实体，产物不应写入其中；已改写到 ' + target);
    outDir = target;
  }
  ensureDir(outDir);

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
      ? '✓ cookie 域名匹配（' + authRes.source + '，含 ' + authRes.auth.cookies.length + ' 个 cookie；注意：仅校验域名，不代表登录仍有效）'
      : '⚠ 会话来源: ' + authRes.source + '（cookie 域名与目标站不完全匹配，仍会注入，若未登录请检查）');
  } else {
    log('⚠ 未提供会话（cookiesText / authFile），以匿名模式抓取');
  }
  log('');

  // ---------- 浏览器上下文（两种模式） ----------
  //  模式 A：task.cdpUrl 指定时，挂到你「自己的主 Chrome」上（该 Chrome 需带 --remote-debugging-port 启动）。
  //          直接复用主浏览器的 cookie / localStorage / access_token / 设备指纹：
  //          不新建会话、不注入旧 cookie、不触发登录 —— 因此不会与主浏览器互相踢下线。
  //  模式 B：默认。独立持久化 profile（原有行为，需在该 profile 内登录过一次）。
  let context = null;
  let page = null;
  let cdpAttached = false;

  if (task.cdpUrl) {
    log('挂载模式(CDP): ' + task.cdpUrl + '（复用主 Chrome 登录态，保持主浏览器已登录）');
    // 系统级 HTTP_PROXY 会把 127.0.0.1 的 CDP 探测请求也代理掉（表现为 502/ECONNREFUSED），先豁免 loopback
    const cur = (process.env.NO_PROXY || process.env.no_proxy || '') + ',127.0.0.1,localhost';
    process.env.NO_PROXY = cur; process.env.no_proxy = cur;
    const browser = await chromium.connectOverCDP(task.cdpUrl, { timeout: 20000 });
    context = browser.contexts()[0];
    if (!context) context = await browser.newContext();
    cdpAttached = true;
    log('✓ 已挂载主 Chrome，登录态原样复用（本次抓取不产生新的登录会话）');
  } else {
    // 持久化浏览器目录：记住设备指纹 + localStorage + 缓存，避免每次被当作新设备重新弹安全验证
    const profileHost = (targetHost(task.url) || 'site').replace(/[^a-z0-9.-]/gi, '_');
    const userDataDir = task.profileDir
      ? path.resolve(task.profileDir)
      : path.resolve(__dirname, '..', 'profiles', profileHost);
    ensureDir(userDataDir);
    log('持久化目录: ' + userDataDir);

    context = await chromium.launchPersistentContext(userDataDir, {
      headless: task.headless,
      slowMo: task.headless ? 0 : 80,
      args: ['--disable-blink-features=AutomationControlled'],
      userAgent: task.userAgent,
      viewport: { width: 1440, height: 900 },
      locale: task.locale || 'zh-CN',
      timezoneId: 'Asia/Shanghai'
    });
  }
  // 反自动化伪装：隐藏 webdriver 标记（降低被反爬识别概率）
  await context.addInitScript(() => {
    try {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] });
    } catch (e) {}
  });
  // 模式 B 才注入 cookie；模式 A 用主 Chrome 自己的活会话，注入旧 cookie 反而可能把好会话顶掉
  if (authRes && !cdpAttached) await injectAuth(context, authRes.auth);

  page = await context.newPage();
  // 统一收尾：模式 A 只关本任务开的标签页，绝不关主 Chrome；模式 B 关掉整个自动化上下文
  const closeBrowser = async () => {
    try {
      if (cdpAttached) {
        if (page) await page.close().catch(() => {});
        log('✓ 已关闭本次抓取标签页（主 Chrome 保持打开）');
        return;
      }
      if (context) await context.close().catch(() => {});
    } catch (e) { /* 忽略收尾异常 */ }
  };
  try {
    log('打开页面: ' + task.url);
    await page.goto(task.url, { waitUntil: 'domcontentloaded', timeout: task.pageLoadTimeout }).catch(e => log('⚠ 首次导航: ' + e.message.split('\n')[0]));
    await sleep(2500);
    // 登录页检测（2026-09-12）：cookie 存在≠有效，被重定向到登录页时滚动只会空转（实测 53 分钟零产出）
    const onLoginPage = /\/platform\/login|\/passport|\/login\b/i.test(page.url() || '');
    if (onLoginPage) {
      log('⚠ 当前在登录页：' + page.url());
      log('  → 会话已失效，请在有头窗口里扫码/登录，登录后本任务会自动继续（等待上限 verifyWaitTimeout）');
    }
    // 登录态判定（2026-10-25 修复 A2：isLoggedIn 此前是死函数，login.successIndicators / pageIndicators 从未生效）
    const li = task.login || {};
    if (li.successIndicators && li.successIndicators.length) {
      const okLogin = await isLoggedIn(page, li).catch(() => null);
      if (okLogin === true) log('✓ 已确认登录态（命中 successIndicators）');
      else if (okLogin === false && !onLoginPage) log('⚠ 未命中任何 successIndicators（可能未登录或页面结构已变），仍继续尝试');
    } else if (onLoginPage && li.pageIndicators && li.pageIndicators.length) {
      log('  · 命中 pageIndicators：' + li.pageIndicators.join(', ') + '（来自站点攻略）');
    }
    const stable = await waitPageStable(page, task, log);
    if (!stable) {
      await closeBrowser();
      throw new Error('页面未稳定（安全验证未通过），请在有头模式下手动完成验证');
    }
    log('✓ 页面已加载');

    // 记住登录态：把本次会话（可能含刚通过的安全验证令牌）写回 authFile，下次直接复用，无需重新登录
    if (authRes && task.authFile) {
      const saved = await saveSession(context, task.authFile);
      log(saved ? '✓ 会话已回存，已记住登录态（设备指纹也已持久化）' : '⚠ 会话回存失败，下次可能仍需验证');
    }

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

    // ---------- 日期窗口 / 断点续抓（2026-09-10 新增） ----------
    //  task.extract.since / until      : 'YYYY-MM-DD'，只保留窗口内条目
    //  task.extract.stopBeforeDate     : 滚到「最老一条早于该日期」即停止（列表按时间倒序）
    //  task.extract.resumeFromCoverage : true → 读 output/<name>/coverage.json，自动把已覆盖最早日期设为 stopBeforeDate
    //  task.extract.appendExisting     : true → 与已有 data.json 合并（按 _text 去重），实现增量累积
    const winOpts = {
      field: extract.dateField || '时间',
      since: df.parseDay(extract.since),
      until: df.parseDay(extract.until),
      stopBefore: df.parseDay(extract.stopBeforeDate)
    };
    if (extract.resumeFromCoverage) {
      const cov = df.readCoverage(outDir);
      if (cov && cov.min) {
        const covDay = df.parseDay(cov.min);
        if (!winOpts.stopBefore || covDay < winOpts.stopBefore) winOpts.stopBefore = covDay;
        log('✓ 断点续抓：历史覆盖最早 ' + cov.min + '，本次滚到早于该日即停（覆盖 ' + Object.keys(cov.days || {}).length + ' 天）');
      } else {
        log('· 无历史覆盖台账，本次按目标条数/触底停止');
      }
    }
    if (winOpts.since || winOpts.until || winOpts.stopBefore) {
      log('· 日期窗口: since=' + (extract.since || '-') + ' until=' + (extract.until || '-') + ' stopBefore=' + (winOpts.stopBefore ? df.ymd(winOpts.stopBefore) : '-'));
    }
    if (extract.appendExisting) {
      const prevFile = path.join(outDir, 'data.json');
      try {
        const prev = JSON.parse(fs.readFileSync(prevFile, 'utf8'));
        let n = 0;
        for (const r of prev) {
          const key = (r._text || '').substring(0, 150);
          if (!seen.has(key)) { seen.add(key); allRecords.push(r); n++; }
        }
        log('✓ 增量累积：载入已有 ' + n + ' 条（共 ' + prev.length + '），新数据将合并去重');
      } catch (e) { log('· 无已有数据，按全新任务处理'); }
    } else {
      // 数据保留纪律（2026-09-10 用户要求）：同任务名已有数据时默认不覆盖，提示改用增量合并
      const prevFile = path.join(outDir, 'data.json');
      if (fs.existsSync(prevFile) && !task.overwrite) {
        log('⚠ 检测到已有数据 ' + prevFile + '，本次未开 appendExisting → 结果将覆盖旧数据！');
        log('  若要保留并与新数据合并去重，请在 extract 里加 "appendExisting": true（推荐）；确需覆盖请加 "overwrite": true');
      }
    }

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
          : extract.containerSelectors,
        // 2026-10-25：噪声过滤 / 字段清洗开关也必须透传，否则任务 JSON 里配了也不生效。
        // 本函数是 extractAll 的唯一入口（9 处调用全走它），补在这里即全局生效；per-group 可覆盖。
        dropNoise: pd.dropNoise !== undefined ? pd.dropNoise : extract.dropNoise,
        noisePatterns: pd.noisePatterns || extract.noisePatterns,
        tidyValues: pd.tidyValues !== undefined ? pd.tidyValues : extract.tidyValues
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
          // 增量模式（虚拟滚动）保持稳健下限：不受普通模式 400ms 默认下限影响（X 等虚拟滚动站点行为不变）
          const min = Math.max(Number(task.scroll.delayMinMs) || 1200, 1200);
          const max = task.scroll.delayMaxMs || 2500;
          const maxIdle = task.scroll.maxIdleRounds || 6;
          const maxRounds = task.scroll.maxRounds || 500;
          const target = pd.limit || 100;
          let idle = 0, heightStable = 0, lastHeight = 0, round = 0;
          let groupCount = () => allRecords.filter(r => r['来源'] === pd.name).length;

          // 2026-10-25 修复（D2）：去 X 硬编码。原先写死 `article` 与「查看新帖子」，
          // 其它虚拟滚动站只能吃 20s 超时兜底。现改为可配置，**默认值与旧行为完全一致**。
          const incOpts = Object.assign({
            waitSelector: 'article',
            waitSelectorTimeoutMs: 20000,
            newPostsButtonRe: '查看新帖子|新帖子',
            newPostsWaitMs: 3500
          }, task.extract.incrementalOptions || {});
          try {
            await page.waitForSelector(incOpts.waitSelector, { timeout: incOpts.waitSelectorTimeoutMs });
          } catch (e) {
            log('  ⚠ 等待 `' + incOpts.waitSelector + '` 渲染超时（' + Math.round(incOpts.waitSelectorTimeoutMs / 1000) + 's），尝试直接开始');
          }
          // 2) 若出现「查看新帖子」（有更新推文待加载，等价于手动刷新主页），点击加载最新
          const viewNew = await page.evaluate(reSrc => {
            const re = new RegExp(reSrc);
            const btns = Array.prototype.slice.call(document.querySelectorAll('[role="button"]'));
            const b = btns.find(x => re.test((x.textContent || '').replace(/\s+/g, '')));
            if (b) { b.click(); return true; }
            return false;
          }, incOpts.newPostsButtonRe).catch(() => false);
          if (viewNew) { log('  ✓ 检测到「' + incOpts.newPostsButtonRe + '」按钮，已点击加载最新内容'); await sleep(incOpts.newPostsWaitMs); }
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

        // ---------- 普通滚动（非分页）：自适应目标驱动采集（2026-08-16 升级） ----------
        //  - autoScroll 自适应调速（默认 400~2500ms），连续 maxIdle 轮高度无增长视为触底/停顿
        //  - 用 locateModule+detectItems 做条目计数（与最终提取同机制，计数准确），达标即提前停；
        //    否则滚到触底为止（不漏信息）；全程只提取一次（末尾），速度快
        if (!pag) {
          const target = pd.limit || extract.limit || 100;
          // 每批轮数：缩小批粒度让计数检查更频繁（小目标快速达标，大目标也及时止损）
          // 2026-10-25 修复（重要）：批轮数必须 ≥ 触底阈值 + 2。
          // 原因：autoScroll 的高度触底计数 `idle` 是**每次调用内部的局部变量**，每批都会重置；
          // 若 passRounds(=5~20) < maxIdleRounds(默认 12)，`idle >= maxIdle` **永远攒不满**
          // → 永不 stalled → 外层 `pass < 200` 空转（实测：module 关键词不匹配时静默空转 ~50 分钟）。
          const idleNeed = Math.max(1, Number(task.scroll.maxIdleRounds) || 12);
          const passRounds = Math.max(5, Math.min(40, Math.round((task.scroll.rounds || 60) / 3)), idleNeed + 2);
          const extOpt = extOpts(pd);
          // 触底判定用的条目计数函数（2026-09-14：与 autoScroll 共享，避免重复定位）
          const countNow = async () => {
            try {
              const mod = await locateModule(page, extOpt.module, extOpt);
              if (mod && mod.found) {
                const its = await detectItems(page);
                return its.length;
              }
            } catch (e) {}
            return -1;
          };
          let stall = false;
          // 重复内容检测（2026-09-12 用户要求）：连续多批「新增率」过低 → 判定内容已抓过，提前停止并汇报
          const dupCfg = Object.assign({ enabled: true, minNewRatio: 0.05, consecutive: 3 }, extract.dupStop || {});
          const seenDup = new Set();
          for (const r of allRecords) seenDup.add(String(r._text || '').slice(0, 150));
          let dupLow = 0, dupStopped = false;
          // 2026-10-25 修复：模块定位失败的「空转止损」。
          // 此前 module 关键词不匹配时：countNow 恒 -1（不触发计数触底）、没有 [data-dsh-module]
          // 标记导致 dupStop 也取不到样本，于是唯一的出口只剩"高度触底"——而它在批粒度下攒不满，
          // 结果静默空转到 pass<200。现在连续 5 批定位不到模块就停下并给出诊断。
          let noModule = 0;
          log('[分组「' + pd.name + '」] 自适应滚动加载（目标 ' + target + ' 条）...');
          for (let pass = 0; pass < 200 && !stall; pass++) {
            if (pass > 0) log('  [第 ' + (pass + 1) + ' 批] 继续滚动加载...');
            const sc = await autoScroll(page, Object.assign({ log, countFn: countNow }, task.scroll, { rounds: passRounds }))
              .catch(() => ({ stalled: true }));
            await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
            await sleep(400);
            // 条目计数（与 autoScroll 的 countFn 同机制）
            const n = await countNow();
            if (n >= 0) log('  · 条目计数 ' + n + '（第 ' + (pass + 1) + ' 批）');
            // 空转止损：连续多批定位不到模块 → 关键词/选择器大概率不对，别静默空转
            if (n < 0) {
              noModule++;
              if (noModule >= 5) {
                log('✗ 连续 ' + noModule + ' 批未定位到列表模块（条目计数始终失败），停止滚动。');
                log('  → 常见原因：extract.module 关键词在页面上不唯一/不匹配（页面上"出现该词"≠"该词所在元素是重复列表"）。');
                log('  → 处理：把 extract.module 留空走自动定位，或改用 extract.containerSelectors 显式指定容器后重跑。');
                const summary0 = await pageStructureSummary(page, 12);
                if (summary0 && summary0.length) {
                  log('  页面结构摘要（排查用）:');
                  summary0.forEach(s => log('    <' + s.sig + '> 重复 ' + s.rep + ' 次 · ' + s.sample));
                }
                stall = true;
                break;
              }
            } else { noModule = 0; }
            // 中间快照（2026-09-14 用户要求：长跑必须防丢）
            // 背景：dupStop 关闭后此分支无任何落盘点，79min 滚动成果在中断时全部丢失。
            if (pass > 0 && pass % 5 === 4) {
              try {
                const snap = await extractAll(page, extOpts(pd));
                if (snap && snap.records && snap.records.length) {
                  writeJson(path.join(outDir, 'data.partial.json'),
                    snap.records.map(r => Object.assign({}, r, { 来源: pd.name })));
                  log('  · 中间快照已保存 ' + snap.records.length + ' 条 → data.partial.json');
                }
              } catch (e) {
                log('  · 中间快照失败：' + (e.message || '').split('\n')[0]);
              }
            }
            if (n >= target + Math.max(30, Math.round(target * 0.05))) {
              log('  ✓ 条目计数 ' + n + ' ≥ 目标（' + target + '+裕量），停止滚动');
              break;
            }
            // 日期断点：列表时间倒序，最老一条已早于 stopBeforeDate → 已到达已覆盖区，停止（避免重复抓取）
            if (winOpts.stopBefore) {
              const tailText = await page.evaluate(() => {
                const root = document.querySelector('[data-dsh-module]');
                if (!root) return '';
                const kids = Array.prototype.slice.call(root.children).filter(e => ((e.innerText || '').trim().length > 20));
                const last = kids[kids.length - 1];
                return last ? (last.innerText || '').slice(0, 400) : '';
              }).catch(() => '');
              const d = df.parseDateText((tailText.match(/(\d{4}-\d{2}-\d{2}[ T]\d{1,2}:\d{2}(?::\d{2})?|\d{1,2}-\d{1,2}(?=[·\s])|刚刚|\d+\s*分钟前|\d+\s*小时(?:前|内)|\d+\s*天前|昨天|前天|今天)/) || [])[1]);
              if (d && d < winOpts.stopBefore) {
                log('  ✓ 已滚到已覆盖区间（末条日期 ' + df.ymd(d) + ' < ' + df.ymd(winOpts.stopBefore) + '），停止滚动');
                break;
              }
            }
            // 重复内容检测：本批新增率过低 → 累计；连续 N 批则判定已抓过，提前停
            if (dupCfg.enabled && pass >= 1) {
              const texts = await page.evaluate(() => {
                const root = document.querySelector('[data-dsh-module]');
                if (!root) return [];
                const all = Array.prototype.slice.call(root.children)
                  .map(e => (e.innerText || '').trim())
                  .filter(t => t.length > 20);
                // 2026-09-14 修复：必须取「列表尾部」样本。
                // 每批滚动后引擎会 scrollTo(0,0)，此时取前 400 条 = 早已见过的头部 → 新增率恒为 0 → 误判「内容已抓过」提前停止（这是历史多次「13 轮触底」的真凶）。
                return all.slice(-400);
              }).catch(() => []);
              if (texts.length) {
                let nw = 0;
                for (const t of texts) {
                  const k = t.slice(0, 150);
                  if (!seenDup.has(k)) { seenDup.add(k); nw++; }
                }
                const ratio = nw / texts.length;
                dupLow = ratio < dupCfg.minNewRatio ? dupLow + 1 : 0;
                log('  · 重复检测：本批 ' + texts.length + ' 条中新增 ' + nw +
                  '（新增率 ' + (ratio * 100).toFixed(1) + '%），连续低新增 ' + dupLow + '/' + dupCfg.consecutive);
                if (dupLow >= dupCfg.consecutive) {
                  log('  ⚠ 连续 ' + dupLow + ' 批新增率 < ' + (dupCfg.minNewRatio * 100) +
                    '% → 判定内容已抓过/重复，提前停止滚动');
                  dupStopped = true;
                  break;
                }
              }
            }
            if (sc && sc.stalled) {
              stall = true;
              log('  ⚠ 滚动触底/停顿，停止滚动（条目计数 ' + n + '）');
            }
          }
          if (dupStopped) {
            log('');
            log('[需向用户确认] 本次因「连续多批内容重复」提前停止：');
            log('  · 若确属该频道内容已抓完 → 结束即可；');
            log('  · 若怀疑是加载慢导致重复采样 → 调大 scroll.loadWaitMs（如 5000~8000）后重跑；');
            log('  · 可调阈值：extract.dupStop = {minNewRatio, consecutive}（默认 0.05 / 3）。');
          }
          await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
          await sleep(400);

          // 末尾一次性提取（容错：验证导航导致上下文销毁时，等待恢复后重试一次）
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
              log('  ✗ 重试仍失败，跳过该分组');
              result = null;
            }
          }
          if (!result) {
            log('  ✗ 提取失败，该分组结束');
            continue;
          }
          if (result.module && result.module.found) {
            if (!moduleInfo) {
              moduleInfo = result.module;
              log('✓ 模块已定位: <' + result.module.container.tag + '> ' +
                (result.module.container.cls || ('#' + result.module.container.id)) + ' | 模式: ' + result.module.mode);
            }
            let added = 0;
            let recs = result.records;
            if (winOpts.since || winOpts.until || winOpts.stopBefore) {
              const fr = df.filterRecords(recs, winOpts);
              if (fr.dropped.beforeSince || fr.dropped.afterUntil || fr.dropped.beforeStop) {
                log('  · 日期过滤：保留 ' + fr.kept.length + ' 条，丢弃 早于起点 ' + fr.dropped.beforeSince +
                  ' / 晚于终点 ' + fr.dropped.afterUntil + ' / 早于断点 ' + fr.dropped.beforeStop + ' 条');
              }
              recs = fr.kept;
            }
            for (const r of recs) {
              r['来源'] = pd.name;
              const key = (r._text || '').substring(0, 150);
              if (!seen.has(key)) { seen.add(key); allRecords.push(r); added++; }
            }
            const gc = allRecords.filter(r => r['来源'] === pd.name).length;
            log('  ✓ 提取 ' + result.records.length + ' 条（新增 ' + added + '），累计 ' + gc + '/' + target + ' 条');
            if (gc < target) log('  ⚠ 实际 ' + gc + ' 条 < 目标 ' + target + ' 条（滚动已触底/停顿，页面内容到此为止，未丢失）');
          } else {
            // 模块未定位：首分组抗反爬重试（原逻辑保留）
            if (!allRecords.length) {
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
                } else {
                  log('✗ 重试仍未定位到模块内容。');
                  const summary = await pageStructureSummary(page, 12);
                  if (summary && summary.length) {
                    log('  页面结构摘要（排查用）:');
                    summary.forEach(s => log('    <' + s.sig + '> 重复 ' + s.rep + ' 次 · ' + s.sample));
                  }
                  await closeBrowser();
                  throw new Error('未定位到模块内容');
                }
              } else {
                log('✗ 未定位到模块内容。请检查：模块关键词、tab 名称、是否需要登录/验证。');
                const summary = await pageStructureSummary(page, 12);
                if (summary && summary.length) {
                  log('  页面结构摘要（排查用）:');
                  summary.forEach(s => log('    <' + s.sig + '> 重复 ' + s.rep + ' 次 · ' + s.sample));
                }
                await closeBrowser();
                throw new Error('未定位到模块内容');
              }
            } else {
              log('  ✗ 未定位到模块，该分组结束');
            }
          }
          continue; // 非分页单列表：本分组结束
        }

        // ---------- 分页路径（原逻辑保留） ----------
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
            await closeBrowser();
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

    // ---------- 覆盖度台账（供下次断点续抓：先看日期到哪，再定位到对应日期开始） ----------
    try {
      const cov = df.coverage(records, winOpts.field);
      const merged = df.mergeCoverage(outDir, cov, {
        task: task.name, url: task.url, total: records.length,
        window: { since: extract.since || null, until: extract.until || null, stopBefore: extract.stopBeforeDate || null }
      });
      log('✓ 覆盖度: ' + merged.min + ' ~ ' + merged.max + '（' + Object.keys(merged.days || {}).length + ' 天，无法解析日期 ' + cov.undated + ' 条）');
      const dates = Object.keys(merged.days || {}).sort().reverse();
      if (dates.length) log('  台账已存: ' + df.coveragePath(outDir) + '（最近 5 天: ' + dates.slice(0, 5).map(d => d + '×' + merged.days[d]).join(', ') + '）');
      if (extract.resumeFromCoverage) {
        log('  下次续抓只差: ' + (cov.min ? '早于 ' + cov.min + ' 的日期' : '未知（本次未解析出日期）'));
      }
    } catch (e) { log('· 覆盖度台账写入失败: ' + (e.message || '').split('\n')[0]); }

    // ---------- 职位详情补充 ----------
    await enrichDetails(page, task, records, log);

    // ---------- 评论区采集（2026-10-25 新增：F1 从工作区脚本提升为引擎能力） ----------
    // 背景：SKILL.md Phase 3.4 一直声称"点开全部评论直到 DOM 不再增长"，但引擎零实现，
    // 工作区脚本自认"本版先取首层"（根本没展开）→ 用户硬性 P0 能力换机即失。
    // 现由 extract.comments.enabled 控制（默认关闭）；任何失败都不影响主数据。
    let commentResult = null;
    try {
      let cm = null;
      try { cm = require('./comments'); } catch (e) { cm = null; }
      // 只有显式启用评论采集时才提示缺模块，避免未用该功能的任务被无谓告警打扰
      const wantComments = !!(extract.comments && extract.comments.enabled);
      if (!cm) {
        if (wantComments) log('⚠ 评论区采集需要 lib/comments.js，但该文件不存在（引擎副本不完整？），本次跳过');
      } else if (wantComments) {
        const copts = cm.extendCommentOpts(cm.normalizeCommentOpts(extract), extract);
        // 产物里的 source 用任务 URL（契约里 collectDetailLinks 不携带任务语境，故在此注入）
        copts.source = copts.source || task.url;
        if (!moduleInfo || !moduleInfo.found) {
          log('· 评论区采集已开启，但本次未定位到列表模块，跳过');
        } else {
          const rawLinks = cm.collectDetailLinks(records, copts);
          const links = rawLinks.map(u => { try { return new URL(u, task.url).href; } catch (e) { return u; } });
          log('');
          log('[评论区] 列表记录 ' + records.length + ' 条 → 详情链接 ' + links.length + ' 个（上限 ' + copts.maxPosts + '）...');
          // P0（2026-11-09）：没有 _link 不再直接放弃 —— 脉脉这类「卡片无 href」的站点改走点卡片进详情
          const entry = String(copts.detailEntry || 'auto');
          const canClick = entry === 'click' || (entry === 'auto' && links.length === 0);
          if (!links.length && entry === 'link') {
            log('  ⚠ 记录里没有可用 `_link`，且 detailEntry=link（只走链接）→ 本次跳过');
            log('  → 若该站详情需要点卡片进入，把 extract.comments.detailEntry 设为 auto/click');
          } else {
            if (!links.length) {
              log('  · 条目里没有 `_link` → 走「点卡片进详情」（detailEntry=' + entry + '）');
              log('    · 卡片选择器: ' + (copts.clickCardSelector || (copts.containerSelectors[0] || '') || '[role=button]') +
                '｜等跳转 ' + (copts.clickWaitMs || 8000) + 'ms｜URL 判定 ' + (copts.detailUrlPattern || '(默认)'));
            }
            if (copts.refill) log('  · refill=on：已抓过但评论更全的记录会被原地刷新（不再一律跳过）');
            if (String(copts.sortBy || 'index') !== 'index') log('  · sortBy=' + copts.sortBy + '：按价值挑详情页，而不是列表前 N');
            const cr = await cm.harvestComments({ page, opts: copts, links, outDir, log });
            commentResult = cr;
            const total = cr.posts.reduce((s, r) => s + ((r.comments || []).length), 0);
            log('✓ 评论区采集完成: 帖子 ' + cr.posts.length + ' 篇 / 评论 ' + total +
              ' 条 / 展开点击 ' + ((cr.stats && cr.stats.expandClicks) || 0) + ' 次' +
              (cr.stats && cr.stats.coveragePct != null ? ' / 覆盖率 ' + cr.stats.coveragePct + '%' : '') +
              (cr.stats && cr.stats.refilled ? ' / 补抓 ' + cr.stats.refilled + ' 篇' : '') +
              ' → posts_with_comments.json');
          }
        }
      }
    } catch (e) {
      log('⚠ 评论区采集失败（不影响主数据）: ' + (e.message || '').split('\n')[0]);
    }

    // ---------- 保存 ----------
    // 数据保留兜底（2026-09-10）：未走增量合并时，先把旧 data.json 备份，避免误覆盖丢数据
    const mainFile = path.join(outDir, 'data.json');
    if (fs.existsSync(mainFile) && !extract.appendExisting && !task.overwrite) {
      const bak = path.join(outDir, 'data.bak.' + Date.now() + '.json');
      try { fs.copyFileSync(mainFile, bak); log('✓ 已备份旧数据: ' + path.basename(bak)); } catch (e) { log('⚠ 旧数据备份失败: ' + (e.message || '').split('\n')[0]); }
    }
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
        // 2026-11-10 修：旧逻辑每次运行都往 notes 追加「自动学习（N 条样本）」，
        // 累积成几十条噪声（maimai playbook 实测 38 条）。现在只保留人工 notes，
        // 自动学习信息改为单独字段 learnedAt/learnedSamples，不污染 notes。
        const prevNotes = (prevPb && prevPb.notes && !/^自动学习/.test(prevPb.notes)) ? prevPb.notes : '';
        savePlaybook(task.url, buildPlaybook(task, {
          notes: prevNotes,
          previous: prevPb,
          learnedSamples: records.length,
        }));
        log('✓ 已学习并保存站点攻略: playbooks/' + pbHost + '.json');
      } catch (e) { /* 忽略保存失败 */ }
    }

    records.slice(0, 3).forEach((r, i) => {
      log('  ' + (i + 1) + '. ' + JSON.stringify(r).substring(0, 180));
    });
    log('');
    log('抓取完成，共 ' + records.length + ' 条');
    return { records, module: moduleInfo, tabResults, outDir, files: dataFiles, comments: commentResult };
  } finally {
    await closeBrowser().catch(() => {});
  }
}

module.exports = { runCrawl };
