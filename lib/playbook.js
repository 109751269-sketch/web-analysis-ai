/**
 * playbook.js - 站点攻略（经验沉淀与自动复用）
 *
 * 目的：把每次成功抓取的配置与踩坑经验保存为「站点攻略」，
 * 下次执行同一站点时自动应用，避免反复试错。
 *
 * 存储：playbooks/<host>.json
 *   - 成功抓取后自动保存（带质量门槛：条数>=5、平均文本>=20字、字段填充>=50%）
 *   - 启动时自动加载并「补空缺」（不覆盖用户在任务里显式指定的配置）
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { ensureDir, writeJson, readJson } = require('./util');

const DIR = path.resolve(__dirname, '..', 'playbooks');

function hostKey(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'file:') return 'local';
    return u.hostname.replace(/^www\./, '');
  } catch (e) {
    return 'unknown';
  }
}

function playbookPath(host) {
  return path.join(DIR, host + '.json');
}

function loadPlaybook(url) {
  const p = playbookPath(hostKey(url));
  return readJson(p) || null;
}

function savePlaybook(url, data) {
  ensureDir(DIR);
  writeJson(playbookPath(hostKey(url)), data);
}

/**
 * 把攻略合并进任务（只补空缺，不覆盖显式配置）
 * 返回是否有应用到任何项
 */
function applyPlaybook(task, pb) {
  if (!pb) return false;
  let changed = false;
  // 2026-10-25 修复（A1）：改判 `_explicit`（用户是否显式提供），不再判归一化后的值
  // —— 归一化端恒填默认值，判值会让下面三条注入永远不生效。
  const ex0 = task._explicit || {};
  if (pb.antiBot) {
    if (pb.antiBot.headless != null && !ex0.headless) { task.headless = pb.antiBot.headless; changed = true; }
    if (pb.antiBot.verifyWaitTimeout && !ex0.verifyWaitTimeout) { task.verifyWaitTimeout = pb.antiBot.verifyWaitTimeout; changed = true; }
    // 2026-11-10 新增：站点节流参数 + 风控信号注入
    // （响应间隔 throttle，区别于滚动间隔 delayMinMs/delayMaxMs）
    if (pb.antiBot.throttle || pb.antiBot.riskSignals) {
      task.antiBot = Object.assign({}, task.antiBot);
      if (pb.antiBot.throttle) task.antiBot.throttle = pb.antiBot.throttle;
      if (pb.antiBot.riskSignals) task.antiBot.riskSignals = pb.antiBot.riskSignals;
      changed = true;
    }
  }
  const ex = task.extract = task.extract || {};
  // 多组采集任务（extract.pages）：顶层 module/fields/containerSelectors 等单组配置
  // 对分组无效，且会把旧攻略的字段注入分组任务导致 qualifies 误判 —— 跳过注入
  const multi = Array.isArray(ex.pages) && ex.pages.length > 0;
  if (pb.extract && !multi) {
    if (!ex.module && pb.extract.module) { ex.module = pb.extract.module; changed = true; }
    if (!ex.containerSelectors && pb.extract.containerSelectors) { ex.containerSelectors = pb.extract.containerSelectors; changed = true; }
    if (!ex.incremental && pb.extract.incremental) { ex.incremental = pb.extract.incremental; changed = true; }
    if ((!ex.fields || !ex.fields.length) && pb.extract.fields) { ex.fields = pb.extract.fields; changed = true; }
    if (!ex.detail && pb.extract.detail) { ex.detail = pb.extract.detail; changed = true; }
  }
  if (pb.interaction && pb.interaction.tabs && (!task.tabs || !task.tabs.length) && !multi) { task.tabs = pb.interaction.tabs; changed = true; }
  if (pb.pagination && task.pagination && !task.pagination.enabled && pb.pagination.enabled) {
    task.pagination = Object.assign({ enabled: true, maxPages: 10, waitMs: 2000 }, pb.pagination);
    changed = true;
  }
  if (pb.login && task.login && !ex0.loginIndicators) { task.login = Object.assign({}, task.login, pb.login); changed = true; }
  return changed;
}

// 从成功任务生成攻略
// 2026-11-10：保留手写经验字段（websiteRules / knownIssues / antiBot.throttle / 人工 notes），
// 避免自动学习把 sites/<host>.md 对应的人工沉淀冲掉。
function buildPlaybook(task, meta) {
  const ex = task.extract || {};
  const prev = (meta && meta.previous) || null;
  const fieldsMap = (fs = []) => (fs || []).map(f => ({
    name: f.name, patterns: f.patterns, regex: f.regex, group: f.group,
    richText: f.richText, tweetContent: f.tweetContent, fallback: f.fallback
  }));
  return {
    host: hostKey(task.url),
    updatedAt: new Date().toISOString(),
    source: task.name,
    // 保留人工 notes（meta.notes 优先，否则继承旧 playbook 的 notes）
    notes: (meta && meta.notes) || (prev && prev.notes) || '',
    // 自动学习记录独立字段，不混进 notes
    learnedAt: new Date().toISOString(),
    learnedSamples: (meta && meta.learnedSamples) || 0,
    antiBot: {
      headless: task.headless,
      verifyWaitTimeout: task.verifyWaitTimeout,
      // 保留手写节流与风控信号
      ...(prev && prev.antiBot && prev.antiBot.throttle ? { throttle: prev.antiBot.throttle } : {}),
      ...(prev && prev.antiBot && prev.antiBot.riskSignals ? { riskSignals: prev.antiBot.riskSignals } : {}),
    },
    // 保留手写的站点规则与已知坑
    ...(prev && prev.websiteRules ? { websiteRules: prev.websiteRules } : {}),
    ...(prev && prev.knownIssues ? { knownIssues: prev.knownIssues } : {}),
    login: task.login || {},
    extract: {
      module: ex.module || '',
      containerSelectors: ex.containerSelectors || [],
      incremental: !!ex.incremental,
      detail: ex.detail || null,
      fields: fieldsMap(ex.fields),
      // 多组采集配置（含每组独立 containerSelectors/fields）
      pages: (ex.pages || []).map(pd => ({
        name: pd.name,
        tabs: pd.tabs || [],
        limit: pd.limit,
        module: pd.module || '',
        containerSelectors: pd.containerSelectors || [],
        fields: fieldsMap(pd.fields)
      })),
      limit: ex.limit
    },
    interaction: { tabs: task.tabs || [] },
    pagination: task.pagination ? { enabled: !!task.pagination.enabled, buttonText: task.pagination.buttonText || '' } : null,
    scroll: task.scroll ? { rounds: task.scroll.rounds } : null
  };
}

// 质量门槛：是否值得保存为攻略
function qualifies(task, records) {
  if (!records || !records.length || records.length < 5) return false;
  const avgLen = records.reduce((a, r) => a + (r._text || '').length, 0) / records.length;
  if (avgLen < 20) return false;
  const fieldKeys = (task.extract && task.extract.fields || []).map(f => f.name);
  if (fieldKeys.length) {
    const filled = records.filter(r => fieldKeys.some(k => r[k] && String(r[k]).trim())).length;
    if (filled / records.length < 0.5) return false;
  }
  return true;
}

module.exports = { hostKey, loadPlaybook, savePlaybook, applyPlaybook, buildPlaybook, qualifies, DIR };
