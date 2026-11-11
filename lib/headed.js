'use strict';
/**
 * headed.js — 统一的有头浏览器启动器（2026-11-10）
 *
 * 目标：有头模式（防风控）但界面不打扰用户。
 *   1. 有头：headless:false —— headless 是小红书/脉脉的直接风控触发器
 *   2. 可见：窗口放在屏幕内（默认右下角），任务栏能点出来
 *   3. 不抢焦点：启动后立即压到 Z 序最底层，不覆盖用户当前窗口
 *
 * 关键区分：自动化浏览器窗口标题含 "Google Chrome for Testing"，
 * 与用户主浏览器 "Google Chrome" 分开，置底不会误伤主浏览器。
 */
const path = require('path');
const { execFile } = require('child_process');

const BOT_TITLE = 'Google Chrome for Testing';
const BOTTOM_SCRIPT = path.join(__dirname, 'win_bottom.ps1');

/**
 * 把自动化浏览器窗口压到最底层（不最小化、不抢焦点）
 * 失败不阻断采集，仅告警。
 */
function sendToBottom(timeoutMs = 8000) {
  return new Promise(resolve => {
    execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-File', BOTTOM_SCRIPT, '-TitlePart', BOT_TITLE],
      { timeout: timeoutMs, windowsHide: true },
      (err, stdout) => {
        if (err) return resolve({ ok: false, error: err.message.slice(0, 120) });
        resolve({ ok: true, out: (stdout || '').trim() });
      });
  });
}

/**
 * 有头模式的标准参数（防风控 + 不打扰）
 * @param {object} opts
 * @returns {object} launchPersistentContext 的 options
 */
function headedOptions({ profile, width = 1200, height = 800, x = 700, y = 200 } = {}) {
  return {
    headless: false,
    args: [
      '--disable-blink-features=AutomationControlled',
      `--window-size=${width},${height}`,
      `--window-position=${x},${y}`,
      '--no-first-run',
      '--no-default-browser-check',
    ],
    viewport: { width, height },
    locale: 'zh-CN',
    userDataDir: profile,
  };
}

/**
 * 启动有头浏览器并立即置底。
 * @param {import('playwright').BrowserType} chromium
 * @param {object} opts { profile, width, height, x, y }
 * @returns {Promise<{ctx, bottom}>}
 */
async function launchHeaded(chromium, opts = {}) {
  const ctx = await chromium.launchPersistentContext(opts.profile, headedOptions(opts));
  const bottom = await sendToBottom();
  return { ctx, bottom };
}

module.exports = { launchHeaded, headedOptions, sendToBottom, BOT_TITLE };
