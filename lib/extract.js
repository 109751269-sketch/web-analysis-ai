/**
 * extract.js - 内容提取引擎（页面内自动定位 + 结构化提取）
 *
 * 三层自动识别：
 *  1. locateModule  —— 按用户给的模块关键词，自动找到「重复卡片结构」的容器
 *  2. detectItems   —— 在容器内识别重复条目（卡片/表格行/列表项）
 *  3. extractFields —— 按字段提示（关键词）从每条目中提取字段值
 *
 * 所有启发式都在页面内执行（page.evaluate），返回纯数据。
 */
'use strict';

const { escReg } = require('./util');

// ---------- 页面内工具（字符串化后注入） ----------

const IN_PAGE = {
  // 元素签名：tag + id + 排序后的类名（用于识别重复结构）
  sig(el) {
    let s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    if (el.className && typeof el.className === 'string') {
      const cls = el.className.split(/\s+/).filter(Boolean).sort().slice(0, 8).join('.');
      if (cls) s += '.' + cls;
    }
    return s;
  },
  // 重复评分：直接子元素中，同一签名出现的最大次数
  repCount(el) {
    const counts = new Map();
    for (const ch of el.children) {
      const s = this.sig(ch);
      counts.set(s, (counts.get(s) || 0) + 1);
    }
    let best = 0;
    counts.forEach(c => { if (c > best) best = c; });
    return best;
  },
  depthOf(el) {
    let d = 0, cur = el;
    while (cur.parentElement) { d++; cur = cur.parentElement; }
    return d;
  }
};

/**
 * 定位模块容器（按关键词 或 显式容器选择器）
 * opts.containerSelectors: 优先使用（列表容器 CSS 选择器数组），命中即用
 * 返回值：{ found, container: {tag,id,cls,sig,itemCount,text}, mode }
 * 页面内会把容器标记为 [data-dsh-module]
 */
async function locateModule(page, keyword, opts) {
  const selectors = (opts && opts.containerSelectors) || [];

  // 清除上一轮定位残留的标记（同一页面多分组时，detectItems 会取 DOM 中第一个
  // [data-dsh-module]，若不清理会误用上一组的容器）
  await page.evaluate(() => {
    document.querySelectorAll('[data-dsh-module]').forEach(el => el.removeAttribute('data-dsh-module'));
  }).catch(() => {});

  // 显式容器选择器（确定性，优先）
  if (selectors.length) {
    const hit = await page.evaluate(sels => {
      const contains = (root, nodes) => {
        let c = 0;
        for (const n of nodes) { if (root === n || root.contains(n)) c++; }
        return c;
      };
      for (const s of sels) {
        let nodes;
        try { nodes = Array.prototype.slice.call(document.querySelectorAll(s)); } catch (e) { continue; }
        nodes = nodes.filter(el => (el.textContent || '').replace(/\s+/g, '').trim());
        if (nodes.length < 2) continue;
        // 向上找到包含最多命中节点的祖先（处理「每个条目独立包裹」的结构）
        let root = nodes[0];
        for (let up = 0; up < 12 && root && root.parentElement; up++) {
          if (contains(root, nodes) >= Math.max(2, Math.ceil(nodes.length * 0.5))) break;
          root = root.parentElement;
        }
        if (!root) continue;
        root.setAttribute('data-dsh-module', '1');
        return {
          found: true,
          container: {
            tag: root.tagName.toLowerCase(), id: root.id || '',
            cls: typeof root.className === 'string' ? root.className : '',
            itemCount: contains(root, nodes),
            text: (root.textContent || '').trim().substring(0, 1500)
          },
          mode: 'selector:' + s
        };
      }
      return { found: false };
    }, selectors);
    if (hit && hit.found) return hit;
  }

  return locateModuleByKeyword(page, keyword);
}

/**
 * 关键词 + 重复结构自动定位（带文本丰富度评分，避免页脚/导航等短文本容器误命中）
 */
async function locateModuleByKeyword(page, keyword) {
  if (!keyword) {
    // 无关键词：直接取 body 尝试找重复结构
    const info = await page.evaluate(() => {
      const root = document.body;
      if (!root) return { found: false };
      const sig = el => {
        let s = el.tagName.toLowerCase();
        if (el.id) s += '#' + el.id;
        if (el.className && typeof el.className === 'string') {
          const cls = el.className.split(/\s+/).filter(Boolean).sort().slice(0, 8).join('.');
          if (cls) s += '.' + cls;
        }
        return s;
      };
      const repCount = el => {
        const counts = new Map();
        for (const ch of el.children) {
          const s = sig(ch);
          counts.set(s, (counts.get(s) || 0) + 1);
        }
        let best = 0;
        counts.forEach(c => { if (c > best) best = c; });
        return best;
      };
      let bestEl = null, bestScore = 0, bestRep = 0;
      const all = document.querySelectorAll('body *');
      for (const el of all) {
        if (el.children.length < 2) continue;
        const r = repCount(el);
        if (r < 2) continue;
        // 文本丰富度：重复子元素的平均文本长度（页脚/导航等短文本容器不命中）
        const lens = Array.prototype.map.call(el.children, ch => (ch.textContent || '').trim().length).filter(l => l > 0);
        const avgLen = lens.length ? lens.reduce((a, b) => a + b, 0) / lens.length : 0;
        if (avgLen < 8) continue;
        const score = r * Math.min(avgLen, 200);
        if (score > bestScore) { bestScore = score; bestEl = el; bestRep = r; }
      }
      if (!bestEl) return { found: false };
      bestEl.setAttribute('data-dsh-module', '1');
      return {
        found: true,
        container: {
          tag: bestEl.tagName.toLowerCase(), id: bestEl.id || '',
          cls: typeof bestEl.className === 'string' ? bestEl.className : '',
          itemCount: bestRep,
          text: (bestEl.textContent || '').trim().substring(0, 1500)
        },
        mode: 'repeated'
      };
    });
    return info;
  }

  const result = await page.evaluate(kw => {
    const sig = el => {
      let s = el.tagName.toLowerCase();
      if (el.id) s += '#' + el.id;
      if (el.className && typeof el.className === 'string') {
        const cls = el.className.split(/\s+/).filter(Boolean).sort().slice(0, 8).join('.');
        if (cls) s += '.' + cls;
      }
      return s;
    };
    const repCount = el => {
      const counts = new Map();
      for (const ch of el.children) {
        const s = sig(ch);
        counts.set(s, (counts.get(s) || 0) + 1);
      }
      let best = 0;
      counts.forEach(c => { if (c > best) best = c; });
      return best;
    };
    const depthOf = el => {
      let d = 0, cur = el;
      while (cur.parentElement) { d++; cur = cur.parentElement; }
      return d;
    };
    // 找重复根：从候选元素向下走到「重复评分」最高的子孙
    const repRoot = el => {
      let cur = el;
      for (;;) {
        let bestChild = null, bestRep = 0;
        for (const ch of cur.children) {
          const r = repCount(ch);
          if (r > bestRep) { bestRep = r; bestChild = ch; }
        }
        if (bestChild && bestRep > repCount(cur)) cur = bestChild;
        else break;
      }
      return cur;
    };

    const keyword = String(kw || '').trim();
    const all = document.querySelectorAll('body *');
    let best = null; // {el, root, rep, dist, score}
    for (const el of all) {
      if (el.children.length === 0) continue;
      const txt = el.textContent || '';
      if (txt.indexOf(keyword) === -1) continue;
      const root = repRoot(el);
      const rep = repCount(root);
      if (rep < 2) continue;
      // 文本丰富度评分（避免页脚/导航等短文本误命中）
      const lens = Array.prototype.map.call(root.children, ch => (ch.textContent || '').trim().length).filter(l => l > 0);
      const avgLen = lens.length ? lens.reduce((a, b) => a + b, 0) / lens.length : 0;
      if (avgLen < 8) continue;
      const dist = depthOf(root) - depthOf(el);
      const score = rep * Math.min(avgLen, 200) - dist * 10 - depthOf(el);
      if (!best || score > best.score) best = { el, root, rep, dist, score };
    }

    if (!best) {
      // 降级：找包含关键词的最浅元素（内容不是重复列表）
      let fallback = null;
      for (const el of all) {
        if (el.children.length === 0) continue;
        const txt = (el.textContent || '').trim();
        if (txt.indexOf(keyword) === -1) continue;
        if (!fallback || txt.length < fallback.txt.length) fallback = { el, txt };
      }
      if (fallback) {
        fallback.el.setAttribute('data-dsh-module', '1');
        return {
          found: true,
          container: {
            tag: fallback.el.tagName.toLowerCase(), id: fallback.el.id || '',
            cls: typeof fallback.el.className === 'string' ? fallback.el.className : '',
            itemCount: fallback.el.children.length,
            text: fallback.txt.substring(0, 1500)
          },
          mode: 'fallback'
        };
      }
      return { found: false, container: null, mode: 'none' };
    }

    best.root.setAttribute('data-dsh-module', '1');
    return {
      found: true,
      container: {
        tag: best.root.tagName.toLowerCase(), id: best.root.id || '',
        cls: typeof best.root.className === 'string' ? best.root.className : '',
        itemCount: best.rep,
        text: (best.root.textContent || '').trim().substring(0, 1500)
      },
      mode: 'repeated'
    };
  }, keyword);

  return result;
}

/**
 * 检测容器内的条目
 * 返回 [{idx, text, html}]
 */
async function detectItems(page) {
  return page.evaluate(() => {
    const sig = el => {
      let s = el.tagName.toLowerCase();
      if (el.id) s += '#' + el.id;
      if (el.className && typeof el.className === 'string') {
        const cls = el.className.split(/\s+/).filter(Boolean).sort().slice(0, 8).join('.');
        if (cls) s += '.' + cls;
      }
      return s;
    };
    const root = document.querySelector('[data-dsh-module]') || document.body;
    let items = [];

    // 1) 表格：取行
    const table = root.querySelector('table') || (root.tagName === 'TABLE' ? root : null);
    if (table) {
      const rows = table.querySelectorAll('tbody tr, tr');
      rows.forEach((r, i) => {
        if (r.closest('thead')) return;
        items.push(r);
      });
    }

    // 2) 直接子元素重复签名
    if (!items.length) {
      const counts = new Map();
      for (const ch of root.children) {
        const s = sig(ch);
        counts.set(s, (counts.get(s) || 0) + 1);
      }
      let bestSig = '', bestCount = 0;
      counts.forEach((c, s) => { if (c > bestCount) { bestCount = c; bestSig = s; } });
      if (bestCount >= 2) {
        for (const ch of root.children) {
          if (sig(ch) === bestSig) items.push(ch);
        }
      }
    }

    // 3) 列表标签
    if (!items.length) {
      const lis = root.querySelectorAll('li');
      if (lis.length >= 2) lis.forEach(li => items.push(li));
    }

    // 4) 常规语义标签
    if (!items.length) {
      const tags = ['article', 'tr', '.card', '.item', '[data-id]'];
      for (const t of tags) {
        const els = root.querySelectorAll(t);
        if (els.length >= 2) { els.forEach(el => items.push(el)); break; }
      }
    }

    // 5) 最后兜底：直接子元素（非空文本）
    if (!items.length) {
      for (const ch of root.children) {
        if ((ch.textContent || '').trim()) items.push(ch);
      }
    }

    // 去重（相同文本的条目只留一个）
    const seen = new Set();
    const out = [];
    items.forEach((el, i) => {
      const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!text) return;
      const key = text.substring(0, 80);
      if (seen.has(key)) return;
      seen.add(key);
      // 条目链接（详情页补充用）：优先匹配职位/详情类 href
      let link = '';
      const links = el.querySelectorAll('a[href]');
      for (const a of links) {
        const href = a.getAttribute('href') || '';
        if (!href || href === '#' || href.startsWith('javascript:') || href.startsWith('data:')) continue;
        if (/job_detail|\/job\/|\.html|\/geek\/job/.test(href)) { link = href; break; }
      }
      if (!link && links.length) {
        const href = links[0].getAttribute('href') || '';
        if (href && href !== '#' && !href.startsWith('javascript:')) link = href;
      }
      out.push({
        idx: out.length + 1,
        text: text.substring(0, 4000),
        html: (el.outerHTML || '').substring(0, 6000),
        link
      });
    });
    return out;
  });
}

// ---------- 装饰性符号 / emoji 区间（`clean()` 首尾修剪共用） ----------
// 2026-10-25 补强（本轮 B 项）：原区间为 `1F000-1FAFF / 2600-27BF / 2B00-2BFF / FE00-FE0F / 200C-200F`，
// 漏了 `⏰`(U+23F0)、`⌛`(U+231B)、`⏳`(U+23F3) 所在的 `2300-23FF`（实测 `公司="字节跳动 ⏰"` 的尾巴清不掉），
// 也漏了箭头区 `2190-21FF`。国旗区 `1F1E6-1F1FF`、扩展符号区 `1F900-1F9FF` 本就被 `1F000-1FAFF` 覆盖，
// 为便于日后维护仍显式列出。
// 安全性：本区间**只**通过 `DECOR_TRIM_RE` 的 `^...` / `...$` 锚点使用 → 绝不会命中值中间的正常字符。
const DECOR_CHARS =
  '\\u{1F1E6}-\\u{1F1FF}' +   // 国旗（区域指示符，成对渲染为 🇨🇳 等）
  '\\u{1F900}-\\u{1F9FF}' +   // 扩展符号（🤖 🦊 …）
  '\\u{1F000}-\\u{1FAFF}' +   // emoji 主区（表情/手势/物件）
  '\\u{2300}-\\u{23FF}' +     // 技术符号：⏰ ⏳ ⌛（此前遗漏）
  '\\u{2600}-\\u{27BF}' +     // 杂项符号/装饰：☀ ✓ ✗
  '\\u{2B00}-\\u{2BFF}' +     // 杂项符号与箭头：⬆
  '\\u{2190}-\\u{21FF}' +     // 箭头：← →（此前遗漏）
  '\\u{FE00}-\\u{FE0F}' +     // 变体选择符
  '\\u{200C}-\\u{200F}';      // 零宽连接符（ZWJ/ZWNJ）等
// 首尾修剪：一次性去掉「行首/行尾的空白 + 装饰符号」。用 replace（非 test）故 g 标志无 lastIndex 副作用。
const DECOR_TRIM_RE = new RegExp('^[\\s' + DECOR_CHARS + ']+|[\\s' + DECOR_CHARS + ']+$', 'gu');

// ---------- extract.tidyValues=true 时的强清洗 ----------
// 只做「空白压缩」与「值尾孤立标点」两件事，不动值中间的字词/符号 → 不改变语义。
function tidyValue(s) {
  return String(s == null ? '' : s)
    // 连续空白 + 全角空格 U+3000 → 单个普通空格
    .replace(/[\s\u3000]+/g, ' ')
    // 值尾孤立标点（可多轮，如 "abc · ," → "abc"）；`u` 标志仅为与上方区间风格一致
    .replace(/(?:[\s\u3000]*[·、,，;；:]+)+[\s\u3000]*$/u, '')
    .trim();
}

// ---------- 条目级广告/噪声过滤（内置，默认关闭） ----------
// 2026-10-25 新增（本轮 E4）：把「广告/推广噪声」过滤内置进引擎，不再甩给 agent 事后清理。
//
// 为什么默认关闭（`extract.dropNoise` 默认 false）：
//   过滤会改变**产出条数**。既有已沉淀的 playbook/任务与历史 data.json 的条数口径
//   都建立在「全量保留」之上，一旦默认开启，老任务会在无声无息中变少、增量去重口径也会变，
//   属于「静默改变既有行为」→ 因此必须显式 opt-in（`extract.dropNoise: true`）。
//
// 关于 `Ad\b` 的收紧（与任务书的一致性说明）：
//   任务书给的写法是 `Ad\b`。该写法**没有前置词边界**，在 `i` 标志下会命中 read / thread /
//   download / head 等正常英文词的结尾 "ad" → 恰恰会造成「误杀正常帖子」。
//   故此处收紧为 `\bAds?\b`（前后都要词边界），语义等价于「独立出现的 Ad / Ads」，
//   比原写法更克制、更准确；其余内置词与任务书一致。
//   （`Ads` 一并覆盖：真实站点上广告标记大量以 "Ads" 出现，而 `Ad\b` 本身匹配不到它。）
const BUILTIN_NOISE_PATTERNS = [
  '广告', '推广', '赞助', '品牌合作', '商务合作', 'Sponsored', 'Promoted', '\\bAds?\\b'
];

// 编译内置 + 自定义噪声正则。非法正则不抛异常、也不静默吞掉，收集进 invalidPatterns 由调用方上报。
function buildNoiseMatchers(extraPatterns) {
  const matchers = [];
  const invalid = [];
  for (const raw of BUILTIN_NOISE_PATTERNS.concat(extraPatterns || [])) {
    if (raw == null || String(raw).trim() === '') continue;
    const src = String(raw);
    try { matchers.push({ src, re: new RegExp(src, 'i') }); }
    catch (e) { invalid.push(src); }
  }
  return { matchers, invalid };
}

/**
 * 按噪声模式过滤记录（条目级）。
 * 匹配对象是 `_text`（detectItems 已把整张卡片压成一行文本），故「条目级」语义成立。
 * 返回值：{ records: 保留的记录, droppedRecords, dropped: {noise, patterns, invalidPatterns} }
 * 注：正则不带 g 标志，`test()` 无 lastIndex 状态，可安全复用。
 */
function filterNoiseRecords(records, extraPatterns) {
  const { matchers, invalid } = buildNoiseMatchers(extraPatterns);
  const kept = [];
  const droppedRecords = [];
  const hitPatterns = [];
  for (const r of records || []) {
    const text = (r && r._text) || '';
    const hit = matchers.find(m => m.re.test(text));
    if (!hit) { kept.push(r); continue; }
    droppedRecords.push(r);
    if (hitPatterns.indexOf(hit.src) === -1) hitPatterns.push(hit.src);
  }
  return {
    records: kept,
    droppedRecords,
    dropped: { noise: droppedRecords.length, patterns: hitPatterns, invalidPatterns: invalid }
  };
}

/**
 * 从条目中提取字段
 * opts（可选）: { tidyValues: boolean }  —— 见文件头 extract.tidyValues 说明
 * hints: [{name, patterns: [pattern,...]}]  pattern 匹配：
 *   a) 文本标签形式：pattern[:：]值
 *   b) class/title/aria-label/data-field 属性含 pattern 的元素文本
 *   c) pattern 为 '*' 时取条目标题（第一个标题元素或第一行）
 * 无 hints 时自动提取「标签：值」对
 */
function extractFieldsFromItems(items, hints, opts) {
  // 清理捕获值：去首尾 emoji（含 ZWJ 连接符）/空白、截掉互动尾缀
  // 2026-10-25 修复（A3）：词表补 `查看全文`（此前只有 `展开全文`，实测漏出 `岗位="招聘 查看全文 赞12"`）；
  // 长的放前面，避免被短的先匹配掉。抽成常量便于日后统一维护。
  const TRUNC_WORDS = '查看全文|查看更多|展开全文|展开全部|展开更多|展开|回复|分享|点赞|收藏|举报';
  // 2026-10-25 补强（本轮 B 项）：首尾装饰符号区间统一走模块级 DECOR_CHARS / DECOR_TRIM_RE
  // （补 ⏰ 所在 2300-23FF、箭头 2190-21FF，显式列出 1F1E6-1F1FF 国旗区与 1F900-1F9FF 扩展符号区）。
  // 必须保持 `^`/`$` 锚定语义 → 值中间字符（含 `A⏰B`、`·`）不受影响。
  // extract.tidyValues（默认 false）：仅在此之后追加「空白压缩 + 值尾孤立标点」强清洗。
  const tidy = !!(opts && opts.tidyValues);
  const clean = v => {
    const s = String(v == null ? '' : v)
      .replace(new RegExp('(' + TRUNC_WORDS + ').*$', 'g'), '')
      .replace(/(赞|评论|转发|顶)\s*\d*\s*$/g, '')
      .replace(DECOR_TRIM_RE, '')
      .trim();
    return tidy ? tidyValue(s) : s;
  };
  // 所有提示词的并集（长度降序），用于「下一个标签」前瞻截断；
  // 同时匹配任意「短中文标签：」作为通用截断（避免吞掉未请求的标签如 💰薪资：）；
  // 仅中文通用标签，防止把 URL 值（https://）等误截断
  const allPatterns = [];
  (hints || []).forEach(h => (h.patterns || [h.pattern]).forEach(p => {
    if (p && p !== '*') allPatterns.push(p);
  }));
  allPatterns.sort((a, b) => b.length - a.length);
  // 2026-10-25 修复（A4）：允许标签前带 1~3 个符号/emoji 前缀。
  // 此前前瞻只认 `[\u4e00-\u9fa5]{1,8}[:：]`，遇到 `⏰工作强度：` 无法在此处截断，
  // 懒匹配会多吃掉一个 `⏰` → 实测漏出 `公司="字节跳动 ⏰"`。
  // 注意：本正则由字符串构造、不带 u 标志，故只能用 BMP 符号区 + 代理对区间，不能用 \u{...} 写法。
  const SYM_PREFIX = '[\\u2000-\\u2BFF\\uFE0F\\u2190-\\u21FF\\uD83C-\\uDBFF\\uDC00-\\uDFFF]{1,3}';
  const CN_LABEL = '[\\u4e00-\\u9fa5]{1,8}';
  const labelTail = allPatterns.length
    ? '(?:' + allPatterns.map(escReg).join('|') + '|' + CN_LABEL + ')'
    : CN_LABEL;
  const lookahead = '(?=\\s*' + labelTail + '\\s*[:：]|\\s*' + SYM_PREFIX + '\\s*' + labelTail + '\\s*[:：]|$)';

  const extractOne = (item, patterns, hint) => {
    const text = item.text || '';
    for (const p of patterns || []) {
      if (!p) continue;
      if (p === '*') {
        // 标题猜测
        const m = text.match(/^(.{1,80})/);
        return m ? clean(m[1]) : '';
      }
      // a) 文本标签（值截止到下一个字段标签，避免 inline span 吞值）
      const re = new RegExp(escReg(p) + '\\s*[:：]\\s*([^\\n；;]{1,200}?)' + lookahead);
      let m = text.match(re);
      if (m) return clean(m[1]);
      // b) 属性含关键词的元素文本（含 data-testid 等现代框架属性）
      const re2 = new RegExp('(?:class|title|aria-label|data-field|data-label|data-testid)="[^"]*' + escReg(p) + '[^"]*"[^>]*>([^<]{1,200})', 'i');
      m = (item.html || '').match(re2);
      if (m) {
        let val = clean(m[1]);
        // richText：富文本元素（内容为嵌套 span），取该元素起的所有文本
        if (hint && hint.richText && item.html) {
          const idx = item.html.indexOf('data-testid="' + p + '"');
          if (idx !== -1) {
            const seg = item.html.substring(idx).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
            const endIdx = seg.search(/(回复|转发|次赞|浏览|更多|显示更多|翻译)/);
            val = clean(endIdx > 0 ? seg.substring(0, endIdx) : seg.substring(0, 500));
          }
        }
        return val;
      }
    }
    return '';
  };

  const autoExtract = text => {
    const rec = {};
    // 与提示词模式一致的截断：值懒匹配，截止到下一个「标签：」或行尾（避免吞掉后面的标签）
    const re = /([\u4e00-\u9fa5A-Za-z0-9]{1,12})\s*[:：]\s*([^\n；;]{1,120}?)(?=\s*(?:[\u4e00-\u9fa5A-Za-z0-9]{1,12})\s*[:：]|$)/g;
    let m, seen = {};
    while ((m = re.exec(text))) {
      const key = m[1].trim();
      if (!key || seen[key]) continue;
      seen[key] = true;
      rec[key] = clean(m[2]);
    }
    return rec;
  };

  const records = [];
  for (const item of items) {
    // 只保留 _idx/_text：_text 已涵盖条目全部内容，不再输出冗余的 _title
    const rec = { _idx: item.idx, _text: item.text };
    // 2026-10-25 修复（关键集成缺口）：把 detectItems 已经抽好的 item.link 写进 record。
    // 此前这里漏了映射 → `rec._link` 永远是 undefined，导致两个功能**静默失效**：
    //   ① pipeline.enrichDetails（extract.detail 职位详情补充）—— `if (!link) continue` 直接跳过全部条目；
    //   ② pipeline 的评论区采集（collectDetailLinks 读 `_link`）→ 详情链接恒为 0。
    // 只在确实有链接时写入，避免给无链接站点凭空加字段。
    if (item.link) rec._link = item.link;
    if (hints && hints.length) {
      for (const h of hints) {
        let v = '';
        // 推文内容模式（X/微博等：去掉作者行/翻译行/尾部互动数，取正文）
        if (h.tweetContent) {
          let t = item.text || '';
          t = t.replace(/^[\u4e00-\u9fa5A-Za-z0-9_ ]{1,40}\s+@[A-Za-z0-9_]+\s*·\s*(刚刚|[0-9]+分钟|[0-9]+小时|[0-9]+秒|[0-9]+月[0-9]+日)\s*/g, '');
          t = t.replace(/翻译自[^\n]{0,12}\s*显示原文\s*/g, '');
          t = t.replace(/^(广告|文章|置顶|媒体|转推)\s*/g, '');
          t = t.replace(/\s+[\d,.]+[万亿]?\s+[\d,.]+[万亿]?\s+[\d,.]+[万亿]?\s+[\d,.]+[万亿]?\s*$/g, '');
          t = t.replace(/\s+(?:引用|转推)[\s\S]*$/g, '');
          v = clean(t).substring(0, 1000);
        }
        // 正则模式：直接在整个条目文本中匹配（支持 group 指定捕获组）
        if (!v && h.regex) {
          try {
            const m = (item.text || '').match(new RegExp(h.regex));
            if (m) v = clean(m[h.group || 1] || m[0]);
          } catch (e) { v = ''; }
        }
        if (!v) {
          v = extractOne(item, h.patterns || [h.pattern], h);
        }
        // fallback：匹配不到时用条目全文兜底
        if (!v && h.fallback) v = clean(item.text).substring(0, 2000);
        rec[h.name] = v;
      }
    } else {
      Object.assign(rec, autoExtract(item.text));
    }
    records.push(rec);
  }
  return records;
}

/**
 * 页面结构摘要（模块未定位时输出，便于排查）
 * 返回 [{sig, repSig, rep, sample}] 按重复次数降序
 */
async function pageStructureSummary(page, limit) {
  return page.evaluate(l => {
    const sig = el => {
      let s = el.tagName.toLowerCase();
      if (el.id) s += '#' + el.id;
      if (el.className && typeof el.className === 'string') {
        const cls = el.className.split(/\s+/).filter(Boolean).sort().slice(0, 8).join('.');
        if (cls) s += '.' + cls;
      }
      return s;
    };
    const bySig = new Map();
    const all = document.querySelectorAll('body *');
    for (const el of all) {
      if (el.children.length < 2) continue;
      const counts = new Map();
      for (const ch of el.children) {
        const s = sig(ch);
        counts.set(s, (counts.get(s) || 0) + 1);
      }
      let best = 0, bestSig = '';
      counts.forEach((c, s) => { if (c > best) { best = c; bestSig = s; } });
      if (best < 2) continue;
      const key = sig(el);
      const cur = bySig.get(key);
      if (!cur || best > cur.rep) {
        bySig.set(key, { sig: key.slice(0, 80), repSig: bestSig.slice(0, 80), rep: best, sample: (el.textContent || '').trim().substring(0, 60) });
      }
    }
    return Array.from(bySig.values()).sort((a, b) => b.rep - a.rep).slice(0, l || 12);
  }, limit || 12);
}

/**
 * 一次性执行完整提取（crawl 主流程调用）
 * 返回 { module, items, records, dropped }
 *
 * 任务选项（task.extract.*）：
 *   extract.dropNoise      : boolean  默认 false —— 条目级广告/噪声过滤开关
 *   extract.noisePatterns  : string[] 可选 —— 在内置词表之外追加自定义正则（大小写不敏感）
 *   extract.tidyValues     : boolean  默认 false —— 字段值强清洗（空白压缩 + 值尾孤立标点）
 *
 * 【覆盖范围说明（extract.pages 多组采集）】
 *   `extractAll` 是引擎**唯一**的采集出口：pipeline.js 的普通滚动 / 增量滚动 / 翻页 /
 *   中间快照 / 重试等所有分支都只调它，`extract.pages` 多组采集的每一组也是走同一个
 *   `extractAll(page, extOpts(pd))`。因此本节新增的 dropNoise / noisePatterns / tidyValues
 *   在多组路径上**天然覆盖**（天然覆盖的前提是这三个键出现在传给 extractAll 的 opts 里）。
 *   ⚠ 注意：pipeline.js 的 extOpts(pd) 目前只透传 module/fields/limit/containerSelectors，
 *   尚未透传这三个新键（本文件无 pipeline.js 写权限，未越界修改）；要让任务 JSON 里的
 *   extract.dropNoise 端到端生效，需在 extOpts 中补透传（一行三键）。直连 extractAll 的
 *   调用方（含自测）不受影响。
 *
 * 【不得静默丢数据】
 *   返回值恒带 `dropped = {noise, patterns, invalidPatterns}`：
 *     noise           —— 被丢弃的条目数
 *     patterns        —— 实际命中的噪声模式（去重）
 *     invalidPatterns —— 非法（编译失败）的自定义正则，已忽略但不吞掉
 *   若传入 opts.log 函数，会同时把上述统计写进日志。
 */
async function extractAll(page, opts) {
  const keyword = (opts && opts.module) || '';
  const limit = (opts && opts.limit) || 500;
  const hints = (opts && opts.fields) || [];
  const dropNoise = !!(opts && opts.dropNoise);              // 默认 false：不改变既有产出
  const noisePatterns = (opts && opts.noisePatterns) || [];
  const tidyValues = !!(opts && opts.tidyValues);            // 默认 false：不改变既有产出
  const log = (opts && typeof opts.log === 'function') ? opts.log : null;
  const NO_DROP = { noise: 0, patterns: [], invalidPatterns: [] };

  const module = await locateModule(page, keyword, opts);
  if (!module || !module.found) {
    return { module, items: [], records: [], dropped: NO_DROP, message: '未定位到模块内容' };
  }
  let items = await detectItems(page);
  if (items.length > limit) items = items.slice(0, limit);
  let records = extractFieldsFromItems(items, hints, { tidyValues });

  // 条目级噪声过滤：必须在 records 产出之后、返回之前（保持「先提取后过滤」，过滤只减少条数）
  let dropped = NO_DROP;
  if (dropNoise) {
    const f = filterNoiseRecords(records, noisePatterns);
    records = f.records;
    dropped = f.dropped;
    if (f.droppedRecords.length) {
      // items 与 records 同源一一对应（extractFieldsFromItems 不改序、不筛除），
      // 按 _idx 同步剔除，避免返回的 items 里残留已被判为噪声的条目（如 detail 补采会误跟广告详情）
      const droppedIdx = new Set(f.droppedRecords.map(r => r._idx));
      items = items.filter(it => !droppedIdx.has(it.idx));
    }
    if (log) {
      log('· 噪声过滤(dropNoise): 丢弃 ' + dropped.noise + '/' + (dropped.noise + records.length) + ' 条'
        + (dropped.patterns.length ? '（命中: ' + dropped.patterns.join(', ') + '）' : '（未命中任何模式）'));
      if (dropped.invalidPatterns.length) {
        log('⚠ 噪声正则非法，已忽略: ' + dropped.invalidPatterns.join(', '));
      }
    }
  }
  return { module, items, records, dropped };
}

module.exports = {
  locateModule, detectItems, extractFieldsFromItems, extractAll, pageStructureSummary,
  // 以下为过滤/清洗的细粒度出口，便于单测与外部复用（新增，未改动既有导出）
  filterNoiseRecords, buildNoiseMatchers, tidyValue, BUILTIN_NOISE_PATTERNS
};

