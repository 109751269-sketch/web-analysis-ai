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

/**
 * 从条目中提取字段
 * hints: [{name, patterns: [pattern,...]}]  pattern 匹配：
 *   a) 文本标签形式：pattern[:：]值
 *   b) class/title/aria-label/data-field 属性含 pattern 的元素文本
 *   c) pattern 为 '*' 时取条目标题（第一个标题元素或第一行）
 * 无 hints 时自动提取「标签：值」对
 */
function extractFieldsFromItems(items, hints) {
  // 清理捕获值：去首尾 emoji（含 ZWJ 连接符）/空白、截掉互动尾缀
  const clean = v => String(v == null ? '' : v)
    .replace(/(查看更多|展开全文|展开|回复|分享|点赞|收藏|举报).*$/g, '')
    .replace(/(赞|评论|转发|顶)\s*\d*\s*$/g, '')
    .replace(/^[\s\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{200C}-\u{200F}]+/u, '')
    .replace(/[\s\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{200C}-\u{200F}]+$/u, '')
    .trim();
  // 所有提示词的并集（长度降序），用于「下一个标签」前瞻截断；
  // 同时匹配任意「短中文标签：」作为通用截断（避免吞掉未请求的标签如 💰薪资：）；
  // 仅中文通用标签，防止把 URL 值（https://）等误截断
  const allPatterns = [];
  (hints || []).forEach(h => (h.patterns || [h.pattern]).forEach(p => {
    if (p && p !== '*') allPatterns.push(p);
  }));
  allPatterns.sort((a, b) => b.length - a.length);
  const lookahead = allPatterns.length
    ? '(?=\\s*(?:' + allPatterns.map(escReg).join('|') + '|[\\u4e00-\\u9fa5]{1,8})\\s*[:：]|$)'
    : '(?=\\s*[\\u4e00-\\u9fa5]{1,8}\\s*[:：]|$)';

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
 * 返回 { module, items, records }
 */
async function extractAll(page, opts) {
  const keyword = (opts && opts.module) || '';
  const limit = (opts && opts.limit) || 500;
  const hints = (opts && opts.fields) || [];

  const module = await locateModule(page, keyword, opts);
  if (!module || !module.found) {
    return { module, items: [], records: [], message: '未定位到模块内容' };
  }
  let items = await detectItems(page);
  if (items.length > limit) items = items.slice(0, limit);
  const records = extractFieldsFromItems(items, hints);
  return { module, items, records };
}

module.exports = { locateModule, detectItems, extractFieldsFromItems, extractAll, pageStructureSummary };
