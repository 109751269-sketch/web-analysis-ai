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
  if (pb.antiBot) {
    if (pb.antiBot.headless != null && task.headless == null) { task.headless = pb.antiBot.headless; changed = true; }
    if (pb.antiBot.verifyWaitTimeout && !task.verifyWaitTimeout) { task.verifyWaitTimeout = pb.antiBot.verifyWaitTimeout; changed = true; }
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
  if (pb.login && task.login && !task.login.successIndicators) { task.login = Object.assign({}, pb.login); changed = true; }
  return changed;
}

// 从成功任务生成攻略
function buildPlaybook(task, meta) {
  const ex = task.extract || {};
  const fieldsMap = (fs = []) => (fs || []).map(f => ({
    name: f.name, patterns: f.patterns, regex: f.regex, group: f.group,
    richText: f.richText, tweetContent: f.tweetContent, fallback: f.fallback
  }));
  return {
    host: hostKey(task.url),
    updatedAt: new Date().toISOString(),
    source: task.name,
    notes: (meta && meta.notes) || '',
    antiBot: {
      headless: task.headless,
      verifyWaitTimeout: task.verifyWaitTimeout
    },
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
