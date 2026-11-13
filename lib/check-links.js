// 交付前内链自检：HTML 里的相对链接 / 本地资源是否真实存在（2026-11-13 新增）
//
// 为什么需要它：手写相对路径连出过两次 404——
//   1) 页面在 blogger-scoring/2026-11-11/，正文写 href="2026-11-12/"（当成同级目录）；
//   2) 图例里指向 02 专题写成 ../2026-11-11/（少一层 ../blogger-scoring/）。
// 这两类错误控制台不会报错、页面看起来正常，只有点进去才发现。必须机器化校验。
//
// 用法：
//   const { checkLinks, checkLinksInFiles } = require('./check-links');
//   checkLinks(html, { baseDir: 'F:/site/report' });         // 单份
//   checkLinksInFiles(['a.html', 'b.html']);                  // 多份 + 递归目录
// CLI：
//   node lib/check-links.js <file-or-dir> [...] [--json] [--ignore=path1,path2]
//
// 判定规则：
//   - 跳过 http/https/mailto/tel/javascript/#/data: 开头的地址；
//   - 相对地址按「所在文件目录」解析，`/` 开头按站点根（--root 指定，默认文件所在仓库根）解析；
//   - 目标存在即通过；目标是目录时要求其下有 index.html；
//   - 同时检查 <img src> / <script src> / <link href> 的本地资源；
//   - 存在性对大小写敏感问题不做特殊处理（Windows 上不敏感，GitHub Pages 上敏感），
//     额外给出「大小写不一致」提示，避免本地通过、线上 404。
const fs = require('fs');
const path = require('path');

const SKIP = /^(https?:|mailto:|tel:|javascript:|data:|#|\/\/)/i;

function collectHtml(target) {
  const out = [];
  const walk = (p) => {
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      for (const f of fs.readdirSync(p)) {
        if (f === 'node_modules' || f === '.git' || f === '_template') continue;   // 模板按「复制到专题目录后」解析，不按仓库位置
        walk(path.join(p, f));
      }
    } else if (/\.html?$/i.test(p)) out.push(p);
  };
  walk(target);
  return out;
}

function extractRefs(html) {
  const refs = [];
  // <a href> / <link href>
  for (const m of html.matchAll(/<(a|link)\b[^>]*?\bhref\s*=\s*["']([^"']+)["']/gi)) {
    refs.push({ tag: m[1].toLowerCase(), attr: "href", url: m[2] });
  }
  // <img src> / <script src> / <source src> / <iframe src>
  for (const m of html.matchAll(/<(img|script|source|iframe)\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi)) {
    refs.push({ tag: m[1].toLowerCase(), attr: "src", url: m[2] });
  }
  return refs;
}

/** 大小写敏感的存在性检查：返回真实存在的路径或 null（用于发现「本地能开、线上 404」） */
function existsCaseSensitive(abs) {
  const parts = path.resolve(abs).split(/[\\/]/);
  let cur = parts[0] + path.sep;
  for (let i = 1; i < parts.length; i++) {
    let entries;
    try { entries = fs.readdirSync(cur); } catch { return null; }
    const hit = entries.find(e => e === parts[i]) || entries.find(e => e.toLowerCase() === parts[i].toLowerCase());
    if (!hit) return null;
    cur = path.join(cur, hit);
  }
  return cur;
}

/**
 * @param {string} html
 * @param {{baseDir:string, root?:string, ignore?:string[]}} opts
 * @returns {{ok:boolean, checked:number, broken:Array, caseIssues:Array}}
 */
function checkLinks(html, opts) {
  const baseDir = path.resolve(opts.baseDir || '.');
  const root = opts.root ? path.resolve(opts.root) : baseDir;
  const ignore = opts.ignore || [];
  const broken = [], caseIssues = [];
  let checked = 0;

  for (const { tag, attr, url } of extractRefs(String(html))) {
    if (SKIP.test(url)) continue;
    if (url.includes("{{")) continue;   // 模板占位符，跳过
    const clean = url.split('#')[0].split('?')[0];
    if (!clean) continue;
    if (ignore.some(p => clean.includes(p))) continue;
    checked++;

    const abs = clean.startsWith('/') ? path.join(root, clean) : path.resolve(baseDir, clean);
    const real = existsCaseSensitive(abs);
    if (!real) {
      broken.push({ tag, attr, url, resolved: abs });
      continue;
    }
    // 目录必须带 index.html（GitHub Pages 行为）
    if (fs.statSync(real).isDirectory() && !fs.existsSync(path.join(real, 'index.html'))) {
      broken.push({ tag, attr, url, resolved: abs, reason: '目录下没有 index.html' });
      continue;
    }
    // 解析后的真实路径与请求路径大小写不一致 → 线上可能 404
    if (path.basename(real) !== path.basename(clean.replace(/\/$/, '')) && !clean.endsWith('/')) {
      caseIssues.push({ url, real: path.relative(baseDir, real) });
    }
  }
  return { ok: broken.length === 0, checked, broken, caseIssues };
}

/** 批量：文件或目录（递归找 .html） */
function checkLinksInFiles(targets, opts = {}) {
  const files = [];
  for (const t of targets) files.push(...(fs.statSync(t).isDirectory() ? collectHtml(t) : [t]));
  const results = [];
  for (const f of files) {
    const html = fs.readFileSync(f, 'utf8');
    const r = checkLinks(html, { baseDir: path.dirname(f), root: opts.root, ignore: opts.ignore });
    results.push({ file: f, ...r });
  }
  return {
    ok: results.every(r => r.ok),
    files: results.length,
    checked: results.reduce((s, r) => s + r.checked, 0),
    broken: results.flatMap(r => r.broken.map(b => ({ file: r.file, ...b }))),
    caseIssues: results.flatMap(r => r.caseIssues.map(c => ({ file: r.file, ...c }))),
    detail: results,
  };
}

module.exports = { checkLinks, checkLinksInFiles };

if (require.main === module) {
  const args = process.argv.slice(2);
  const targets = args.filter(a => !a.startsWith('--'));
  const json = args.includes('--json');
  const rootArg = (args.find(a => a.startsWith('--root=')) || '').split('=')[1];
  const ignoreArg = (args.find(a => a.startsWith('--ignore=')) || '').split('=')[1];
  if (!targets.length) {
    console.log('用法: node lib/check-links.js <file-or-dir> [...] [--json] [--root=<站点根>] [--ignore=a.html,b.html]');
    process.exit(0);
  }
  const r = checkLinksInFiles(targets, { root: rootArg, ignore: ignoreArg ? ignoreArg.split(',') : [] });
  if (json) {
    console.log(JSON.stringify(r, null, 2));
  } else {
    console.log(`检查 ${r.files} 个文件 / ${r.checked} 条本地链接`);
    for (const b of r.broken) console.log(`✗ ${b.file}\n    <${b.tag} ${b.attr || 'href'}="${b.url}">${b.reason ? ' → ' + b.reason : ''}`);
    for (const c of r.caseIssues) console.log(`⚠ ${c.file} 大小写不一致：${c.url}（实际 ${c.real}）`);
    console.log(r.ok ? '✓ 没有坏链' : `✗ 坏链 ${r.broken.length} 条，必须修完再交付`);
  }
  process.exit(r.ok ? 0 : 1);
}
