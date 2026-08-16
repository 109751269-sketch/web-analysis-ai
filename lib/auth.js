/**
 * auth.js - 会话（Cookie）处理
 *
 * 兼容两种输入：
 *  1. Playwright storageState：{ cookies: [...], origins: [...] }（脚本自动生成）
 *  2. Cookie-Editor 扩展导出的裸 JSON 数组：[{name, value, domain, ...}, ...]
 *
 * 自动规范化 sameSite / expires / path，并可通过 addCookies 注入浏览器。
 * （参考 Crawler-mm skill 的会话处理经验：No_restriction->Lax、session->-1、path 默认 /）
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { targetHost, escReg } = require('./util');

// Cookie-Editor 的 sameSite -> Playwright 枚举
function normalizeSameSite(v) {
  const s = String(v == null ? '' : v).toLowerCase();
  if (s === 'strict') return 'Strict';
  if (s === 'none') return 'None';
  return 'Lax';
}

// 规范化一条 cookie
function normalizeCookie(c) {
  if (!c || !c.name || !c.domain) return null;
  const sameSite = normalizeSameSite(c.sameSite);
  // SameSite=None 必须配 secure，否则浏览器会丢弃（skill 踩坑经验）
  let secure = !!c.secure;
  if (sameSite === 'None' && !secure) secure = true;
  // Cookie-Editor 用 expirationDate，storageState 用 expires
  const exp = typeof c.expires === 'number' ? c.expires
    : (typeof c.expirationDate === 'number' ? c.expirationDate : -1);
  return {
    name: c.name,
    value: String(c.value == null ? '' : c.value),
    domain: c.domain,
    path: c.path || '/',
    expires: exp > 0 ? exp : -1,
    httpOnly: !!c.httpOnly,
    secure,
    sameSite
  };
}

// 读取会话文件（storageState 或 Cookie-Editor 裸数组），返回 { cookies, origins } 或 null
function loadAuthFile(file) {
  if (!file || !fs.existsSync(file)) return null;
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return null;
  }
  return normalizeAuth(raw);
}

// 解析 Cookie-Editor 粘贴的 JSON 文本
function parseCookiesText(text) {
  if (!text || !text.trim()) return null;
  try {
    const raw = JSON.parse(text.trim());
    return normalizeAuth(raw);
  } catch (e) {
    return null;
  }
}

// 规范化任意会话结构
function normalizeAuth(raw) {
  let cookies, origins = [];
  if (Array.isArray(raw)) {
    cookies = raw; // Cookie-Editor 裸数组
  } else if (raw && Array.isArray(raw.cookies)) {
    cookies = raw.cookies;
    origins = Array.isArray(raw.origins) ? raw.origins : [];
  } else {
    return null;
  }
  const cleaned = cookies.map(normalizeCookie).filter(Boolean);
  return { cookies: cleaned, origins };
}

// 会话是否包含目标站点的 cookie
function hasDomainCookies(auth, host) {
  if (!auth || !auth.cookies || !auth.cookies.length) return false;
  if (!host) return auth.cookies.length > 0;
  return auth.cookies.some(c =>
    c.domain && (c.domain.indexOf(host) !== -1 || host.indexOf(c.domain) !== -1));
}

// 保存当前浏览器上下文会话到文件（storageState 是写入方法）
async function saveSession(context, file) {
  try {
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    await context.storageState({ path: path.resolve(file) });
    return true;
  } catch (e) {
    console.error('✗ 会话保存失败: ' + e.message);
    return false;
  }
}

// 把 auth 注入 context（addCookies 是加载方法；storageState 也可在 newContext 时加载）
async function injectAuth(context, auth) {
  if (!auth || !auth.cookies || !auth.cookies.length) return 0;
  await context.addCookies(auth.cookies);
  return auth.cookies.length;
}

// 汇总任务中的会话来源（authFile 优先，其次 cookiesText）
function resolveAuth(task) {
  if (task.authFile) {
    const a = loadAuthFile(task.authFile);
    if (a) return { auth: a, source: 'authFile: ' + task.authFile };
    console.warn('⚠ 会话文件无效或不存在: ' + task.authFile + '，尝试其他来源');
  }
  if (task.cookiesText) {
    const a = parseCookiesText(task.cookiesText);
    if (a) return { auth: a, source: 'cookiesText (Cookie-Editor)' };
    console.warn('⚠ cookiesText 解析失败');
  }
  return null;
}

// 判断页面是否已登录（出现任一 successIndicators 且 URL 不含 pageIndicators）
async function isLoggedIn(page, loginConfig) {
  const opts = loginConfig || { successIndicators: [], pageIndicators: [] };
  return page.evaluate(o => {
    const url = location.href;
    const text = document.body ? document.body.innerText : '';
    for (const s of o.successIndicators || []) {
      if (text.indexOf(s) !== -1) return true;
    }
    for (const p of o.pageIndicators || []) {
      if (url.indexOf(p) !== -1) return false;
    }
    return false;
  }, opts);
}

module.exports = {
  normalizeSameSite, normalizeCookie, loadAuthFile, parseCookiesText,
  normalizeAuth, hasDomainCookies, saveSession, injectAuth, resolveAuth, isLoggedIn
};
