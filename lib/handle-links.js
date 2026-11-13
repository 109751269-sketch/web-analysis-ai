// HTML 报告里的推特博主名自动加主页链接（2026-11-13 新增，用户硬性规范）
//
// 需求：任何 HTML 交付物中提到推特博主，名字都要能点进 https://x.com/<handle>。
// 用法：
//   const { linkHandles, linkHandlesInFile } = require('./handle-links');
//   const out = linkHandles(html);                       // 纯字符串处理
//   const stat = linkHandlesInFile('report.html');       // 原地写回 + 返回统计
// CLI：
//   node lib/handle-links.js <a.html> [b.html ...] [--css-only] [--dry]
//
// 设计要点（踩坑记录）：
//   1. 幂等：已带 class="handle" 的链接、已在 <a> 里的文本一律跳过，重复跑不会嵌套；
//   2. 保护代码块：<code>@handle</code> 这种纯 handle，用 <a class="handle"><code>..</code></a>
//      包住（保留 code 视觉，仍可点击）；其余 <code>…</code> 整段跳过；
//   3. 不误伤：只匹配 [A-Za-z0-9_]{1,15}（X handle 上限 15），中文标点/邮箱/@media 不受影响；
//   4. 样式不破坏排版：color:inherit + 虚线下划线，hover 才变主题色。
const fs = require('fs');
const path = require('path');

// X handle：字母或下划线开头，最长 15 位。数字开头不是合法 handle。
const HANDLE_RE = /(?<![\w@/])@([A-Za-z_][A-Za-z0-9_]{0,14})(?![\w@])/g;

// CSS at-rule / Less-Sass 指令黑名单：即使出现在正文（或未加 <style> 的片段）也不当 handle
const RESERVED = new Set([
  'media', 'keyframes', 'supports', 'font-face', 'import', 'charset', 'page', 'namespace',
  'layer', 'container', 'apply', 'use', 'forward', 'mixin', 'include', 'extend',
  'screen', 'document', 'property', 'scope', 'starting-style', 'view-transition',
  'font-feature-values', 'counter-style', 'position-try', 'tailwind', 'each', 'if', 'else', 'return',
]);

const CSS = `
  /* handle-links: 博主名可点击，不破坏排版 */
  a.handle{color:inherit;text-decoration:none;border-bottom:1px dashed currentColor;white-space:nowrap}
  a.handle:hover{color:var(--accent,#2a5bd7);border-bottom-style:solid}
  a.handle code{background:inherit;border:0;padding:0}
`;

function anchor(h) {
  return `<a class="handle" href="https://x.com/${h}" target="_blank" rel="noopener noreferrer">`;
}

/**
 * @param {string} html
 * @param {{injectCss?:boolean, baseUrl?:string}} [opts]
 * @returns {{html:string, linked:number, handles:string[]}}
 */
function linkHandles(html, opts) {
  const o = Object.assign({ injectCss: true }, opts || {});
  let s = String(html);

  if (o.injectCss && !/a\.handle\{/.test(s) && /<\/style>/i.test(s)) {
    s = s.replace(/<\/style>/i, CSS + '</style>');
  }

  const store = [];
  const stash = (m) => { store.push(m); return `\u0000${store.length - 1}\u0000`; };

  // 0) 先整段保护 <style> / <script>：否则 CSS 的 @media / @keyframes / @supports
  //    会被 HANDLE_RE 当成 handle 替换成 <a href="x.com/media">，直接搞坏样式（2026-11-13 实测踩到）
  s = s.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, stash);
  s = s.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, stash);

  // 1) 先保护已有 <a>…</a>：必须在 <code> 处理之前，否则「已经链接好的
  //    <a><code>@handle</code></a>」会被再次包一层，且占位符残留进链接文字
  //    （2026-11-13 实测踩到：13 处博主名被写成 "\u0000N\u0000"）
  s = s.replace(/<a\b[^>]*>[\s\S]*?<\/a>/gi, stash);

  // 2) <code>@handle</code> → 链接包 code（保留 code 外观；此时已排除链接内的 code）
  s = s.replace(/<code>\s*(@[A-Za-z0-9_]{1,15})\s*<\/code>/g, (m, h) =>
    stash(`${anchor(h.slice(1))}<code>${h}</code></a>`));

  // 3) 保护剩余 <code>…</code>
  s = s.replace(/<code>[\s\S]*?<\/code>/gi, stash);

  // 3) 全局替换 @handle
  const seen = new Set();
  s = s.replace(HANDLE_RE, (m, h) => {
    if (RESERVED.has(h.toLowerCase())) return m;   // @media / @keyframes 等原样保留
    seen.add(h);
    return anchor(h) + '@' + h + '</a>';
  });

  // 4) 还原：占位符里可能还嵌着占位符（stash 的字符串内部含上一层占位符），
  //    单次 replace 不会重扫替换结果，必须循环解析到稳定，否则会漏出 "\u0000N\u0000"
  let guard = 0;
  while (/\u0000\d+\u0000/.test(s) && guard++ < 12) {
    s = s.replace(/\u0000(\d+)\u0000/g, (m, i) => (store[+i] === undefined ? '' : store[+i]));
  }
  s = s.replace(/\u0000\d+\u0000/g, '');   // 兜底：绝不把占位符漏进交付物

  return { html: s, linked: seen.size, handles: [...seen] };
}

/**
 * Markdown 版：[@handle](https://x.com/handle)
 * 保护 ``` 代码块、行内 `code`、已有 [..](..) 链接，避免破坏语法。
 */
function linkHandlesMarkdown(md) {
  let s = String(md);
  const store = [];
  const stash = (m) => { store.push(m); return `\u0000${store.length - 1}\u0000`; };

  s = s.replace(/```[\s\S]*?```/g, stash);          // 围栏代码块
  s = s.replace(/`[^`\n]*`/g, stash);                // 行内 code
  s = s.replace(/\[[^\]\n]*\]\([^)\n]*\)/g, stash);  // 已有链接

  const seen = new Set();
  s = s.replace(HANDLE_RE, (m, h) => {
    if (RESERVED.has(h.toLowerCase())) return m;
    seen.add(h);
    return `[@${h}](https://x.com/${h})`;
  });

  let guard = 0;
  while (/\u0000\d+\u0000/.test(s) && guard++ < 12) {
    s = s.replace(/\u0000(\d+)\u0000/g, (m, i) => (store[+i] === undefined ? '' : store[+i]));
  }
  s = s.replace(/\u0000\d+\u0000/g, '');
  return { html: s, linked: seen.size, handles: [...seen] };
}

/** 原地处理文件，返回统计（含浏览器无关的链接计数） */
function linkHandlesInFile(file, opts) {
  const p = path.resolve(file);
  const before = fs.readFileSync(p, 'utf8');
  const isMd = /\.(md|markdown)$/i.test(p);
  const r = isMd ? linkHandlesMarkdown(before) : linkHandles(before, opts);
  const hrefCount = isMd
    ? (r.html.match(/\]\(https:\/\/x\.com\//g) || []).length
    : (r.html.match(/href="https:\/\/x\.com\//g) || []).length;
  fs.writeFileSync(p, r.html, 'utf8');
  return { file: p, handles: r.linked, hrefs: hrefCount, changed: r.html !== before };
}

/** 交付前自查：返回 HTML 里 x.com 链接数与去重 handle 数，供 Phase 8 验收对比 */
function auditHandles(html) {
  // 先剥掉 <style>/<script>，否则 CSS 里的 @media 会被算成「漏链的博主」
  const body = String(html)
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  const hrefs = body.match(/href="https:\/\/x\.com\/([A-Za-z0-9_]{1,15})/g) || [];
  const uniq = new Set(hrefs.map(h => h.split('/').pop()));
  const mentions = new Set((body.match(HANDLE_RE) || [])
    .map(m => m.slice(1))
    .filter(h => !RESERVED.has(h.toLowerCase())));
  return { hrefs: hrefs.length, linkedHandles: uniq.size, mentionedHandles: mentions.size, missing: [...mentions].filter(m => !uniq.has(m)) };
}

module.exports = { linkHandles, linkHandlesMarkdown, linkHandlesInFile, auditHandles };

if (require.main === module) {
  const args = process.argv.slice(2);
  const files = args.filter(a => !a.startsWith('--'));
  const dry = args.includes('--dry');
  if (!files.length) { console.log('用法: node lib/handle-links.js <a.html> [...] [--css-only] [--dry]'); process.exit(0); }
  for (const f of files) {
    const isMd = /\.(md|markdown)$/i.test(f);
    if (dry) {
      const src = fs.readFileSync(f, 'utf8');
      const r = isMd ? linkHandlesMarkdown(src) : linkHandles(src, { injectCss: false });
      console.log(`${f} → 可加链接 handle ${r.linked} 个（${isMd ? 'markdown' : 'html'} 模式）`);
    } else {
      const r = linkHandlesInFile(f);
      console.log(`${r.file} → handle ${r.handles} 个，x.com 链接 ${r.hrefs} 条${r.changed ? '' : '（无变化）'}`);
    }
  }
}
