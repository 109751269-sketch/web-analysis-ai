/**
 * util.js - 通用工具函数
 * 时间戳 / 文件读写 / HTML 转义 / 命令行参数解析 / 数字解析
 */
'use strict';

const fs = require('fs');
const path = require('path');

// ---------- 时间戳 ----------
function ts() {
  const d = new Date();
  const p = n => (n < 10 ? '0' : '') + n;
  return '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) +
    '_' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ---------- 文件 ----------
function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(file) {
  try {
    // 2026-10-25 加固（B7，超出 A1–A4/B6/D9 范围，纯防御性）：
    // 去掉 UTF-8 BOM。Windows 上用 PowerShell（[Text.Encoding]::UTF8、Set-Content -Encoding UTF8）
    // 或记事本「UTF-8 with BOM」保存的任务 JSON 会带 \uFEFF 前缀 → JSON.parse 必抛
    // `Unexpected token ''`；而本函数吞异常只返回 null，外层只能报「任务文件解析失败」，极难排查。
    const txt = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(txt);
  } catch (e) {
    return null;
  }
}

function writeJson(file, obj) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
}

function writeFile(file, content) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, content, 'utf8');
}

// 只写最新引用文件 data.json（输出文件夹按任务名唯一命名，不再生成时间戳批次文件）
function saveBatch(dir, baseName, ext, content) {
  ensureDir(dir);
  const latestFile = path.join(dir, baseName + ext);
  if (typeof content === 'string') fs.writeFileSync(latestFile, content, 'utf8');
  else writeJson(latestFile, content);
  return { batchFile: '', latestFile };
}

// ---------- HTML 转义 ----------
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ---------- 命令行参数 ----------
// 支持 --key=value 与 --key（无值视为 true）
function parseArgs(argv) {
  const out = {};
  (argv || process.argv.slice(2)).forEach(arg => {
    if (!/^--/.test(arg)) return;
    const eq = arg.indexOf('=');
    if (eq === -1) { out[arg.slice(2)] = true; return; }
    out[arg.slice(2, eq)] = arg.slice(eq + 1);
  });
  return out;
}

// ---------- 数字解析 ----------
// 解析带单位的中文/英文数值："63.0万" -> 630000；"¥129.00" -> 129；"1.2k" -> 1200；"4.8%" -> 4.8
function parseNumber(v) {
  if (v == null) return null;
  const s = String(v).replace(/,/g, '').trim();
  if (!s) return null;
  const m = s.match(/(\d+(?:\.\d+)?)\s*(万亿|万|亿|千|k|w|K|W|%|％)?/);
  if (!m) return null;
  let n = parseFloat(m[1]);
  const u = m[2] || '';
  if (u === '万') n *= 10000;
  else if (u === '亿') n *= 100000000;
  else if (u === '万亿') n *= 1000000000000;
  else if (u === '千' || u === 'k' || u === 'K') n *= 1000;
  else if (u === 'w' || u === 'W') n *= 10000;
  return n;
}

// 数字友好显示：自动换算万/亿
function fmtNum(n) {
  if (n == null || !isFinite(n)) return '-';
  const abs = Math.abs(n);
  if (abs >= 100000000) return (Math.round(n / 10000000) / 10) + '亿';
  if (abs >= 10000) return (Math.round(n / 1000) / 10) + '万';
  return String(Math.round(n * 100) / 100);
}

// 保留 1 位小数
function fmt1(n) {
  if (n == null || !isFinite(n)) return '-';
  return String(Math.round(n * 10) / 10);
}

// ---------- 正则转义 ----------
function escReg(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------- 主域名 ----------
function targetHost(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'file:') return 'localhost';
    const parts = u.hostname.split('.');
    if (parts.length >= 2) return parts.slice(-2).join('.');
    return u.hostname;
  } catch (e) {
    return null;
  }
}

module.exports = { ts, sleep, ensureDir, readJson, writeJson, writeFile, saveBatch, esc, parseArgs, parseNumber, fmtNum, fmt1, escReg, targetHost };
