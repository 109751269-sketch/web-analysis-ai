/**
 * comments.js — 评论区采集（引擎能力）
 *
 * 契约：F:\despseekharness\wai-capability-audit\comments-module-spec.md（8 个导出，签名/默认值固定）
 * 定位：把工作区一次性脚本（crawler/harvest_comments.js，脉脉专用且自认"本版先取首层"）
 *       提升为换机可用的引擎能力；**核心增量是 expandComments 真的"点到 DOM 不再增长"**。
 *
 * 硬约束（契约 §0）：
 *  1. 本文件**不得 require('playwright')** —— page 由调用方传入（可离线单测、可复用引擎会话）；
 *  2. 只依赖 Node 内置模块（fs / path）；
 *  3. 所有等待走可注入的 sleep（默认内部实现，opts.sleep 覆盖）→ 单测可压到秒级。
 *
 * 与契约的差异（仅"新增"，无改名/删减）：
 *  · expandComments 的 stats 除 {rounds, clicks, grewBy, stoppedBy} 外**额外**返回 errors / clickFails
 *    计数，用于满足契约 §1.3"异常要 catch 并计入统计"；不影响按名取值的集成方。
 *  · harvestComments 的 files 返回 {json, jsonl} 两个绝对路径（契约只说"写了哪些文件"，未定形状）。
 *  · harvestComments 的 stats.stoppedBy 取值：linksExhausted | maxPosts | dupStop | dupRatio。
 *  · 支持可选注入 opts.sleep（函数）与 opts.source（写进产物的 source 字段），二者不在默认值里。
 *
 * 2026-10-25 修复（task-7，Lead 实测到的静默漏评论）：
 *  症状：多级展开页面（点一次后同一个按钮换文案/id，再点还能加载）第 2 轮自报"点击 1 个"并打上
 *        data-dsh-comment-expanded 标记，但 click 压根没落到按钮上（页面 stage 不变）→ 第 3 轮被标记
 *        排除 → 误判收敛 → 少抓评论且零警告。
 *  根因（探针 clickedByEngine 实证：["BUTTON#more1", "DIV#toolbar"]）：
 *   ① 标记只按"元素身份"记：页面把同一个节点从「查看全部12条评论」改成「展开更多」（新一级），
 *      仍带着上一轮的标记 → 被当成"已点过"永久跳过；
 *   ② 最内层过滤只认"候选"，控件被排除后，包着它的祖先 div（innerText 恰好也是短文案）反而成了
 *      叶子被点 —— 而 click 不会从祖先向下冒泡到按钮，于是"点了但没生效"，还照样计数+打标记。
 *  修法：① 标记改按"元素+状态文案"记，文案变了就是新控件、重新可点；② 最内层判定对所有文案匹配的
 *      元素做（不看标记/可见性），祖先永不作为替身被点；③ 点击后用一次性捕获监听校验 click 确实
 *      到达该元素，没到达则计入 stats.errors/clickFails 且**不打标记**；④ 终态文案（已展开/收起/
 *      没有更多…）直接跳过。
 *
 * 2026-10-25 修复（task-8，字段语序覆盖不全 —— 与 task-7 同源的"只认一种写法"毛病）：
 *  · likes 原来只认「3 赞」；现同时覆盖「赞 3 / 点赞 3」「3 likes / likes 3」「1.2万赞」（万→×10000）。
 *    一个都没命中 → 空串，不编造。
 *  · author 原来只认"块内首行"；单行块「昵称 · 时间 · 赞 N 正文」的昵称必然落空。现补"时间戳之前
 *    最后一段"的取法（并剥掉可能混入的赞数），多行/单行两种结构都能取到。
 *  · time 字段补 秒/周/月/年 与「刚才」（契约的密度正则一字未动，只扩展字段值）。
 *  · 正文剥离同步支持新语序：单行块的 text 不再残留「· 时间 · 赞 N」这类元信息。
 */
'use strict';

const fs = require('fs');
const path = require('path');

// ---------- 展开控件文案正则（契约 §1.3） ----------
// 三处已实测通过的正则并集（只读复用，来源已记入注释，便于日后统一维护）：
//   probe_channel_comments.js:40  /查看全部\d*条评论|全部评论|\d+\s*条评论|^评论$|评论\s*\d+|查看\d+条回复|展开/
//   probe_detail_dji.js:43        /(查看全部\s*\d*\s*条评论|全部评论|加载更多|条回复|展开|更多)/
//   harvest_search_dji.js:55      /(查看全部\s*\d*\s*条评论|全部评论|加载更多|查看\s*\d+\s*条回复|展开|更多评论)/
// 以字符串形式保存：注入页面上下文时不能闭包引用外部常量，必须当参数传进去。
const EXPANDER_SRC =
  '查看全部\\s*\\d*\\s*条评论|全部评论|查看\\s*\\d+\\s*条回复|加载更多|更多评论|展开|^\\d+\\s*条评论$';
const COMMENT_EXPANDERS = new RegExp(EXPANDER_SRC); // 非 global：多处 .test() 无 lastIndex 副作用

// "终态/收起"文案：这类文字会命中上面的正则（如「已展开」含「展开」），但它已经加载完，或是
// "收起"一类反向开关，点了没有意义（甚至会把已展开的内容收起来）→ 一律跳过。task-7 新增。
const EXPANDER_EXHAUSTED_SRC =
  '已\\s*展开|已\\s*加载|已\\s*显示|已\\s*全部|收起|没有更多|无更多|暂无更多|加载完毕|已到底|已到末';

// 相对时间正则（复用 harvest_comments.js:32 已验证写法）
// ★ 这个"契约正则"只用于评论容器的**时间密度判定**，语义不动（改它会影响容器识别）。
const TIME_ALT =
  '\\d+\\s*天前|\\d+\\s*小时前|\\d+\\s*分钟前|刚刚|昨天|前天|今天|\\d{1,2}-\\d{1,2}';
const TIME_SRC = '(' + TIME_ALT + ')';

// 抽取 time **字段**时补上契约遗漏的量级（task-8：同类"覆盖不全"缺陷）。
// 只影响字段值，不影响容器判定 —— 检测仍走上面的契约正则。
const TIME_EXT_ALT =
  TIME_ALT + '|\\d+\\s*秒前|\\d+\\s*周前|\\d+\\s*月前|\\d+\\s*年前|刚才';

// 赞数语序（task-8）：真实站点「3 赞」「赞 3」都常见，另有英文「3 likes」「likes 3」，
// 中文还有「1.2万赞」。按顺序匹配，命中即取数字；「万」做 ×10000 换算（不臆造：一个都没命中就留空串）。
// 每条模式只含 1 个捕获组，取纯数字最稳。
const LIKE_PATTERNS = [
  '(\\d+(?:\\.\\d+)?)\\s*万\\s*个?\\s*赞',   // 1.2万 赞
  '(\\d+(?:\\.\\d+)?)\\s*个?\\s*赞',          // 3 赞 / 3个赞
  '赞\\s*(\\d+(?:\\.\\d+)?)\\s*万?',          // 赞 3 / 点赞 1.2万
  '(\\d+(?:\\.\\d+)?)\\s*likes?',             // 3 likes
  'likes?\\s*(\\d+(?:\\.\\d+)?)'              // likes 3
];
// 剥正文时用来吃掉"赞数 token"（把各模式的捕获组降级为非捕获组；不能直接删括号，
// 否则正则括号不平衡 → new RegExp 抛错 → 整个 scrape 静默返回空结果，2026-10-25 踩过）
const LIKES_STRIP_SRC = LIKE_PATTERNS.map(p => p.replace(/^\(/, '(?:')).join('|');

// 每轮最多点几个展开控件（沿用 harvest_search_dji.js:60 的 n>=5 上限，防点到正文/死循环）
const PER_ROUND_CLICK_CAP = 5;

const DEFAULT_SLEEP = ms => new Promise(r => setTimeout(r, ms));

// ---------- 默认配置（契约 §1.1，键集合必须与契约完全一致） ----------
const defaultOpts = Object.freeze({
  enabled: false,
  maxPosts: 50,
  delayMs: 1800,
  detailWaitMs: 2500,
  expandIdleRounds: 3,
  expandMaxRounds: 20,
  include: '',
  exclude: '',
  minText: 4,
  maxText: 600,
  maxCommentsPerPost: 60,
  containerSelectors: [],
  dupStop: Object.freeze({ enabled: true, consecutive: 2, minNewRatio: 0.1 }),
  appendExisting: false
});

// ---------- 扩展配置（2026-11-09 P0/P1/P2） ----------
// 为什么单列：契约 §1.1 把 normalizeCommentOpts 的键集合钉死为 14 个（自测 deepStrictEqual 守着），
// 新增能力不能塞进去，否则契约测试与下游按名取值都会炸。做法是「契约 14 键不动 + 扩展键白名单」：
//   · 任务里写在 extract.comments.<key>，由 extendCommentOpts() 挑出来并到 normalize 结果上；
//   · 默认值放在 EXT_DEFAULTS，由 withDefaults 兜底 —— 所以不配这些键时行为与旧版逐字一致。
const EXT_DEFAULTS = Object.freeze({
  // P0：详情页入口。auto = 有 _link 走链接、没有就点卡片；link = 只走链接；click = 只点卡片
  detailEntry: 'auto',
  // 点卡片后等 URL 变成什么样才算"进了详情页"（脉脉是 gossip-detail / feed-detail）
  detailUrlPattern: '(gossip-detail|feed-detail|/detail/|/status/|/note/|/p/|/post/)',
  clickWaitMs: 8000,       // 点卡片后等 URL 变化的上限
  clickCardSelector: '',   // 卡片选择器；留空则用 containerSelectors[0] → [role=button]
  // P1：补抓。true = 对已有 URL 且实抓少于页面声称数的记录重抓合并（覆盖率告警的闭环动作）
  refill: false,
  // P2：详情页挑选顺序。index = 列表顺序（旧行为）；engage = 互动量降序；textLen = 正文长度降序
  sortBy: 'index'
});
const EXT_KEYS = Object.keys(EXT_DEFAULTS);

/**
 * 把 extract.comments 里的扩展键并到 normalizeCommentOpts 的结果上（契约 14 键不动）。
 * @param {object} opts normalizeCommentOpts 的返回值
 * @param {object} extract 任务 extract 段
 * @returns {object} 新对象（不改入参）
 */
function extendCommentOpts(opts, extract) {
  const src = (extract && typeof extract === 'object' && extract.comments) || {};
  const out = Object.assign({}, opts || {});
  for (const k of EXT_KEYS) if (src[k] !== undefined) out[k] = src[k];
  return out;
}

// ---------- 小工具 ----------

function num(v, dflt) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim())) return Number(v.trim());
  return dflt;
}

function bool(v, dflt) {
  if (v === undefined || v === null || v === '') return dflt;
  if (typeof v === 'boolean') return v;
  return String(v) === 'true' || String(v) === '1';
}

// 合并默认值：每次返回新对象，绝不改写 defaultOpts（共享实体，多任务并发调用安全）
function withDefaults(opts) {
  const o = Object.assign({}, defaultOpts, EXT_DEFAULTS, opts || {});
  o.dupStop = Object.assign({}, defaultOpts.dupStop, (opts && opts.dupStop) || {});
  return o;
}

function sleepOf(opts) {
  return (opts && typeof opts.sleep === 'function') ? opts.sleep : DEFAULT_SLEEP;
}

function loggerOf(log) {
  if (typeof log !== 'function') return function () {};
  return function (msg) { try { log(msg); } catch (e) { /* 日志失败不能影响采集 */ } };
}

function shortErr(e) {
  return String((e && e.message) || e || '').split('\n')[0].slice(0, 160);
}

function pct(x) {
  return Math.round(Number(x) * 1000) / 10;
}

// 字符串/数组 → RegExp；非法或空 → null（不抛）
function toRe(v) {
  let src = '';
  if (Array.isArray(v)) src = v.filter(s => typeof s === 'string' && s.trim()).join('|');
  else if (typeof v === 'string') src = v.trim();
  if (!src) return null;
  try { return new RegExp(src); } catch (e) { return null; }
}

// ---------- 1.1 normalizeCommentOpts ----------

/**
 * 从任务的 extract.comments 归一化出评论采集配置。
 * @param {object} extract 任务 extract 段（读 extract.comments）
 * @returns {object} 契约 §1.1 定义的 15 个键
 */
function normalizeCommentOpts(extract) {
  const src = (extract && typeof extract === 'object' && extract.comments) || {};
  const d = defaultOpts;
  const sel = Array.isArray(src.containerSelectors)
    ? src.containerSelectors.filter(s => typeof s === 'string' && s.trim())
    : [];
  const asPattern = v => {
    if (typeof v === 'string') return v;
    if (Array.isArray(v)) return v.filter(s => typeof s === 'string' && s.trim()).join('|');
    return '';
  };
  return {
    enabled: bool(src.enabled, d.enabled),
    maxPosts: num(src.maxPosts, d.maxPosts),
    delayMs: num(src.delayMs, d.delayMs),
    detailWaitMs: num(src.detailWaitMs, d.detailWaitMs),
    expandIdleRounds: num(src.expandIdleRounds, d.expandIdleRounds),
    expandMaxRounds: num(src.expandMaxRounds, d.expandMaxRounds),
    include: asPattern(src.include),
    exclude: asPattern(src.exclude),
    minText: num(src.minText, d.minText),
    maxText: num(src.maxText, d.maxText),
    maxCommentsPerPost: num(src.maxCommentsPerPost, d.maxCommentsPerPost),
    containerSelectors: sel,
    dupStop: {
      enabled: bool((src.dupStop || {}).enabled, d.dupStop.enabled),
      consecutive: num((src.dupStop || {}).consecutive, d.dupStop.consecutive),
      minNewRatio: num((src.dupStop || {}).minNewRatio, d.dupStop.minNewRatio)
    },
    appendExisting: bool(src.appendExisting, d.appendExisting)
  };
}

// ---------- P2：详情页挑选顺序（2026-11-09） ----------
// 问题：maxPosts 取的是「列表前 N 条」，而列表顺序 ≠ 价值顺序（脉脉/X 都是如此）。
// 现在可以按互动量或正文长度降序挑详情页；同分保持原顺序（稳定排序），默认 'index' 时完全不排序。
const ENGAGE_KEYS = {
  like: ['like', 'likes', '赞', '点赞', '喜欢', 'views_like'],
  repost: ['repost', 'retweet', '转发', '分享'],
  reply: ['reply', 'comment', '评论', '回复']
};
const TEXT_KEYS = ['正文', 'content', 'text', '_text'];

function pickNum(rec, names) {
  if (!rec) return 0;
  for (const n of names) {
    if (!(n in rec)) continue;
    const raw = rec[n];
    const v = typeof raw === 'string' ? Number(String(raw).replace(/[^\d.]/g, '')) : raw;
    if (Number.isFinite(v)) return v;
  }
  return 0;
}

function sortRecords(records, opts) {
  const o = withDefaults(opts);
  const mode = String(o.sortBy || 'index');
  const list = Array.isArray(records) ? records : [];
  if (mode !== 'engage' && mode !== 'textLen') return list.slice();
  const engage = rec => pickNum(rec, ENGAGE_KEYS.like) +
    2 * pickNum(rec, ENGAGE_KEYS.repost) + 1.5 * pickNum(rec, ENGAGE_KEYS.reply);
  const textLen = rec => {
    for (const k of TEXT_KEYS) if (rec && typeof rec[k] === 'string') return rec[k].length;
    return 0;
  };
  const key = mode === 'engage' ? engage : textLen;
  // 带原始下标做次键：同分时保持列表原序（排序稳定性不能靠 V8 保证，这里显式写死）
  return list.map((rec, i) => ({ rec: rec, i: i }))
    .sort((a, b) => (key(b.rec) - key(a.rec)) || (a.i - b.i))
    .map(x => x.rec);
}

// ---------- 1.2 collectDetailLinks ----------

/**
 * 从列表记录里取详情链接：去重保序 + include/exclude 过滤。
 * 只读 rec._link；相对路径**原样返回**（由调用方用 new URL(link, listUrl) 解析）。
 * @returns {string[]}
 */
function collectDetailLinks(records, opts) {
  const o = withDefaults(opts);
  const inc = toRe(o.include);
  const exc = toRe(o.exclude);
  // P2：先按 sortBy 重排（默认 'index' 原样返回副本，行为不变）→ 于是 maxPosts 截断的是"价值前 N"
  const list = sortRecords(records, o);
  const seen = new Set();
  const out = [];
  for (const rec of list) {
    if (!rec || typeof rec !== 'object') continue;
    const raw = rec._link;
    if (typeof raw !== 'string') continue;
    const u = raw.trim();
    if (!u) continue;                       // 空值
    if (/^javascript:/i.test(u)) continue;  // javascript:
    if (u.charAt(0) === '#') continue;      // # / #anchor
    if (exc && exc.test(u)) continue;
    if (inc && !inc.test(u)) continue;
    if (seen.has(u)) continue;
    seen.add(u);
    out.push(u);
  }
  return out;
}

// ---------- 1.3 expandComments（核心能力） ----------

/**
 * 在当前（详情）页上循环点击展开控件，直到 DOM 连续 expandIdleRounds 轮不再增长。
 * 任何 evaluate / 元素异常都 catch 并计入 stats.errors，**不抛出**。
 * clicks 只统计"click 确实送达目标元素"的点击；没送达的记入 errors/clickFails 且不打标记。
 * @returns {Promise<{rounds:number, clicks:number, grewBy:number, stoppedBy:string, errors:number, clickFails:number}>}
 *          grewBy = 累计正增长的内文字符数；stoppedBy = 'idle' | 'maxRounds'
 */
async function expandComments(page, opts, log) {
  const o = withDefaults(opts);
  const sleep = sleepOf(o);
  const info = loggerOf(log);
  const stats = { rounds: 0, clicks: 0, grewBy: 0, stoppedBy: 'idle', errors: 0, clickFails: 0 };

  if (!page || typeof page.evaluate !== 'function') {
    stats.errors++;
    info('  ⚠ expandComments: 未收到可用 page，跳过展开');
    return stats;
  }

  // 「DOM 规模」基线：正文长度 + 评论候选块数量，任一增长即算增长（契约 §1.3 步骤 1）
  const measure = () => page.evaluate(() => {
    const body = document.body;
    return {
      textLen: ((body && body.innerText) || '').length,
      blocks: document.querySelectorAll('li,[class*="comment"],[class*="reply"],[data-comment]').length
    };
  }).catch(() => null);

  // 单轮：点未点过的展开控件 + 滚到底（触发懒加载）
  // prevGrew：上一轮 DOM 是否增长。增长说明"还有内容可加载"（无限加载型的「加载更多」），
  //           此时把"状态没变"的旧标记清掉，允许再点一次；一旦某轮不再增长就不再重复点。
  const clickRound = (prevGrew) => page.evaluate(({ src, cap, exhaustedSrc, prevGrew }) => {
    let re, exRe;
    try { re = new RegExp(src); exRe = new RegExp(exhaustedSrc); }
    catch (e) { return { clicks: 0, candidates: 0, fails: 0, error: 1 }; }
    const MARK = 'dshCommentExpanded';       // = data-dsh-comment-expanded（存在即"此状态已点过"）
    const STATE = 'dshCommentExpandedState'; // = data-dsh-comment-expanded-state（记下点击时的文案）
    const norm = el => ((el.innerText || el.textContent) || '').replace(/\s+/g, ' ').trim();

    // 2026-11-09：穿透 open shadow root 收集候选。
    // 现代站（自定义元素 / Web Components）常把「展开 / 加载更多」放进影子树里，
    // document.querySelectorAll 看不见 → 候选恒 0 → 一句「DOM 未增长」就静默收敛，少抓且零告警。
    // 只穿 open shadowRoot：closed 影子树从页面上下文本来就取不到，属站点限制，不做绕过。
    let all = [];
    const SEL = 'a,button,span,div,[role="button"]';
    const walk = root => {
      let els;
      try { els = root.querySelectorAll(SEL); } catch (e) { return; }
      for (const el of els) {
        all.push(el);
        let sr = null;
        try { sr = el.shadowRoot; } catch (e) { sr = null; }
        if (sr) walk(sr);
      }
    };
    walk(document);

    // 上一轮有增长 → 清掉"状态未变"的旧标记（无限加载型控件需要能被再点）
    // 2026-11-09：改为遍历 all（含影子树）—— document.querySelectorAll 找不到影子树里的标记，
    // 会让影子内控件永远带着"已点过"标记 → 无限加载型按钮只生效一次。
    if (prevGrew) {
      for (const el of all) {
        let marked = false;
        try { marked = !!(el.dataset && el.dataset[MARK]); } catch (e) { marked = false; }
        if (!marked) continue;
        let s = '';
        try { s = el.dataset[STATE] || ''; } catch (e) { s = ''; }
        if (s && s === norm(el)) { try { delete el.dataset[MARK]; } catch (e) {} }
      }
    }

    // 1) 先收集所有"文案匹配"的元素（不看标记、不看可见性）——只用于确定最内层控件
    const matching = [];
    for (const el of all) {
      const t = norm(el);
      if (!t || t.length > 20) continue;                     // 必须短文本，避免点到正文
      if (!re.test(t)) continue;
      if (el.children.length > 4) continue;                  // 避免点到整块容器（probe_channel_comments.js:45）
      matching.push(el);
    }
    // 2) 只保留「最内层」：祖先命中时点它不会触发内部 handler（click 不向下冒泡）。
    //    ★ 关键：这里必须基于全部匹配元素判断，否则控件被标记排除后，包着它的祖先会被当成替身点击
    //      —— 那正是 task-7 里"自报点击成功但 click 未落元素"的第二个原因。
    //    ★ 2026-11-09：contains 不跨影子边界 —— 宿主的 shadowRoot 里的控件不算 hosted.contains(btn)，
    //      会让「宿主文案命中 + 影子按钮」两个都当成叶子；这里补一条影子树包含判定。
    const containsDeep = (host, node) => {
      try { if (host.contains(node)) return true; } catch (e) {}
      let sr = null;
      try { sr = host.shadowRoot; } catch (e) { sr = null; }
      if (!sr) return false;
      try { return sr.contains(node); } catch (e) { return false; }
    };
    const leaves = matching.filter(el => !matching.some(other => other !== el && containsDeep(el, other)));

    let clicks = 0, fails = 0;
    for (const el of leaves) {
      if (clicks >= cap) break;
      const t = norm(el);
      if (exRe.test(t)) continue;                            // 终态/收起文案，不点
      let state = '';
      try { state = (el.dataset && el.dataset[STATE]) || ''; } catch (e) { state = ''; }
      let marked = false;
      try { marked = !!(el.dataset && el.dataset[MARK] === '1'); } catch (e) { marked = false; }
      if (marked && state === t) continue;                   // 同一控件、同一文案 → 已点过（文案变了=新一级，重新可点）
      try { if (el.isConnected === false) { fails++; continue; } } catch (e) { /* 拿不到就当连着 */ }
      let rect = null;
      try { rect = el.getBoundingClientRect(); } catch (e) { rect = null; }
      if (rect && rect.width === 0 && rect.height === 0) continue;  // 不可见控件（懒加载隐藏按钮）跳过

      // 3) 点击 + 校验：click 是否真的送达这个元素（element.click() 是同步派发，捕获监听能立刻看到）
      let landed = false;
      const probe = ev => {
        if (!ev) return;
        if (ev.target === el) landed = true;
        else {
          try { if (el.contains && el.contains(ev.target)) landed = true; } catch (e) {}
          // 2026-11-09：影子树里的点击在 document 上被重定向（target 变成宿主）→ 用 composedPath 还原真实路径，
          // 否则会误判"未送达"（报 clickFails 且不打标记 → 每轮重复点同一个已生效的控件）。
          try {
            if (!landed && typeof ev.composedPath === 'function') {
              const p = ev.composedPath();
              if (p && p.indexOf(el) !== -1) landed = true;
            }
          } catch (e) {}
        }
      };
      try {
        document.addEventListener('click', probe, true);
        if (el.scrollIntoView) el.scrollIntoView({ block: 'center' });
        el.click();
      } catch (e) {
        landed = false;
      } finally {
        try { document.removeEventListener('click', probe, true); } catch (e) {}
      }
      if (!landed) { fails++; continue; }                     // ★ 没送达就不计数、绝不打标记（否则永久跳过可用控件）
      // 注：`el.disabled === true`、以及「在 <fieldset disabled> 里」的按钮，其 .click() 都不会派发事件
      // —— 一律走这条"没送达 → 报失败且不打标记"的路，不静默跳过：这样"有个控件点不动"会显式暴露出来，
      // 且该控件不会被标记，下一轮若变为可点（如被启用）仍会被点到。
      clicks++;
      try { el.dataset[MARK] = '1'; el.dataset[STATE] = t; } catch (e) {}
    }
    try { window.scrollTo(0, (document.body && document.body.scrollHeight) || 0); } catch (e) {}
    return { clicks, fails, candidates: leaves.length };
  }, { src: EXPANDER_SRC, cap: PER_ROUND_CLICK_CAP, exhaustedSrc: EXPANDER_EXHAUSTED_SRC, prevGrew: !!prevGrew })
    .catch(() => ({ clicks: 0, candidates: 0, fails: 0, error: 1 }));

  const maxRounds = Math.max(1, Math.round(num(o.expandMaxRounds, defaultOpts.expandMaxRounds)));
  const idleLimit = Math.max(1, Math.round(num(o.expandIdleRounds, defaultOpts.expandIdleRounds)));
  const halfDelay = Math.max(0, num(o.delayMs, defaultOpts.delayMs) / 2);
  let idle = 0;
  let prevGrew = false;

  for (let round = 1; round <= maxRounds; round++) {
    stats.rounds = round;
    const before = await measure();
    const res = await clickRound(prevGrew);
    if (res && res.error) stats.errors++;
    if (res && res.fails) { stats.errors += res.fails; stats.clickFails += res.fails; }
    stats.clicks += (res && res.clicks) || 0;
    await sleep(halfDelay);                       // 等异步追加的 DOM 落地
    const after = await measure();

    let grew = false;
    if (!before || !after) {
      stats.errors++;
    } else {
      const dText = after.textLen - before.textLen;
      grew = dText > 0 || after.blocks > before.blocks;
      if (dText > 0) stats.grewBy += dText;
    }
    if (grew) idle = 0; else idle++;
    prevGrew = grew;

    info('  · 展开第 ' + round + ' 轮：点击 ' + ((res && res.clicks) || 0) +
      ' 个（候选 ' + ((res && res.candidates) || 0) + '，点击未送达 ' + ((res && res.fails) || 0) + '），' +
      (grew ? 'DOM 增长 +' + ((after && before) ? (after.textLen - before.textLen) : 0) : 'DOM 未增长') +
      '，连续未增长 ' + idle + '/' + idleLimit);

    if (idle >= idleLimit) { stats.stoppedBy = 'idle'; break; }
    if (round === maxRounds) { stats.stoppedBy = 'maxRounds'; }
  }

  return stats;
}

// ---------- 1.4 scrapeComments ----------

/**
 * 抽取当前详情页的帖子正文 + 评论列表（显式选择器优先，其次时间密度法）。
 * 找不到评论容器时返回 comments: [] 且 stats.containerFound:false，不报错。
 * @returns {Promise<{url:string, title:string, post:string, comments:Array, stats:object}>}
 */
async function scrapeComments(page, opts) {
  const o = withDefaults(opts);
  const empty = {
    url: '', title: '', post: '', comments: [],
    stats: { containerFound: false, candidateCount: 0, textLength: 0, extractError: '', claimCount: 0 }
  };
  if (!page || typeof page.evaluate !== 'function') return empty;

  let r = null;
  try {
    r = await page.evaluate(cfg => {
      const out = {
        url: location.href,
        title: document.title || '',
        post: '',
        comments: [],
        stats: { containerFound: false, candidateCount: 0, textLength: 0, extractError: '', claimCount: 0 }
      };
      const comp = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
      let timeRe, timeTest, timeFieldRe, likeRes;
      try {
        timeRe = new RegExp(cfg.timeSrc);                       // 带捕获组，用于取 [0]
        timeTest = new RegExp(cfg.timeAlt);                     // 容器判定（契约正则）
        timeFieldRe = new RegExp(cfg.timeExtAlt);               // 字段抽取（补 秒/周/月/年）
        likeRes = (cfg.likePatterns || []).map(s => new RegExp(s, 'i'));
      } catch (e) {
        return out;
      }
      // 分隔符（昵称 · 时间 · 赞数 正文 这种单行块）
      const SEP = '[\\s·|｜•,，、:：\\-–—>»]*';
      // "只有元信息"的串（纯数字/分隔符/赞/时间单位）→ 不能当昵称
      const onlyMeta = s => !s || /^[\s\d·|｜•,，、:：\-–—_赞个likes万]+$/i.test(s);
      // 取赞数：逐条语序尝试，命中即返回数字（万→×10000）；都没有 → 空串（不编造）
      const parseLikes = s => {
        for (const re of likeRes) {
          const m = String(s || '').match(re);
          if (!m) continue;
          let v = Number(m[1]);
          if (!Number.isFinite(v)) continue;
          if (m[0].indexOf('万') !== -1) v = Math.round(v * 10000);
          return v;
        }
        return '';
      };

      // 1) 显式容器选择器优先
      let container = null;
      for (const s of cfg.containers || []) {
        try { const el = document.querySelector(s); if (el) { container = el; break; } } catch (e) {}
      }
      // 2) 时间密度法：子元素数 3~400 的 div/ul 中，子元素含相对时间最多者（阈值 ≥2）
      if (!container) {
        let best = null, bestN = 0;
        let nodes;
        try { nodes = document.querySelectorAll('div,ul'); } catch (e) { nodes = []; }
        for (const el of nodes) {
          const kids = Array.from(el.children);
          if (kids.length < 3 || kids.length > 400) continue;
          let n = 0;
          for (const k of kids) if (timeTest.test(comp(k.innerText || k.textContent))) n++;
          if (n > bestN) { bestN = n; best = el; }
        }
        if (best && bestN >= 2) container = best;
      }

      out.stats.containerFound = !!container;
      const blocks = container ? Array.from(container.children) : [];
      out.stats.candidateCount = blocks.length;
      out.stats.textLength = container ? comp(container.innerText || container.textContent).length : 0;

      // 3~4) 评论块解析：过滤长度，author/time/likes 尽力而为（取不到留空串，不编造）
      const comments = [];
      for (const el of blocks) {
        const inner = String(el.innerText || el.textContent || '');
        const raw = comp(inner);
        if (!(raw.length > cfg.minText) || !(raw.length < cfg.maxText)) continue;

        const lines = inner.split('\n').map(comp).filter(Boolean);
        const tm = raw.match(timeRe) || raw.match(timeFieldRe);  // 契约正则优先，扩展正则兜底（秒/周/月/年）
        const likes = parseLikes(raw);

        // 昵称（task-8：原来只认"首行"，单行块「昵称 · 时间 · 赞 N 正文」必然落空）
        // ① 多行结构：首行疑似昵称（要求 >1 行，避免把单行正文整句当昵称）
        // ② 单行结构：取"时间戳之前"的最后一段，再剥掉可能混进来的赞数
        // 整段包 try/catch：单个块的字段抽取失败不能影响其它块，更不能让整页返回空
        let author = '';
        let text = '';
        try {
          if (lines.length > 1 && lines[0].length <= 30 && !timeFieldRe.test(lines[0]) && !onlyMeta(lines[0])) {
            author = lines[0];
          }
          if (!author && tm) {
            const ti = raw.indexOf(tm[0]);
            if (ti > 0) {
              const parts = raw.slice(0, ti).split(/[·|｜•,，、:：]+/).map(comp).filter(Boolean);
              let cand = comp((parts.length ? parts[parts.length - 1] : raw.slice(0, ti))
                .replace(new RegExp('(?:' + cfg.likesStripSrc + ')', 'ig'), ' '));
              if (cand && cand.length <= 30 && !timeFieldRe.test(cand) && !onlyMeta(cand)) author = cand;
            }
          }

          // 正文：优先取块内最像正文的子元素（p / *content* / *text* / *body*）
          try {
            const be = el.querySelector('p,[class*="content"],[class*="text"],[class*="body"]');
            if (be) text = comp(be.innerText || be.textContent);
          } catch (e) { text = ''; }
          if (!text) {
            // 退化路径：从块全文按"昵称 / 时间 / 赞数 / 展开残留"逐段剥掉元信息
            let t = raw;
            if (author && t.indexOf(author) === 0) t = t.slice(author.length);
            t = t.replace(new RegExp('^' + SEP), '');                                        // 前导分隔符
            t = t.replace(new RegExp('^(?:' + cfg.timeExtAlt + ')' + SEP), '');               // 前导时间
            t = t.replace(new RegExp('^(?:' + cfg.likesStripSrc + ')' + SEP, 'i'), '');       // 前导赞数
            t = t.replace(new RegExp(SEP + '(?:' + cfg.timeExtAlt + ')' + SEP + '$'), '');     // 尾部时间
            t = t.replace(new RegExp(SEP + '(?:' + cfg.likesStripSrc + '|\\d+\\s*条回复|回复)' + SEP + '$', 'i'), '');
            t = t.replace(/\s*(?:查看|展开|加载|更多|收起|已展开|已加载)\s*[^\s]{0,10}\s*$/, '');
            text = comp(t);
          }
        } catch (e) { /* 单块失败：author 留空串、text 退回块全文 */ }
        if (!text) text = raw;

        const cls = (typeof el.className === 'string' ? el.className : '') + ' ' +
          (el.getAttribute && el.getAttribute('data-reply') === '1' ? ' data-reply ' : '');
        const isReply = /(^|\s|\W)(reply|sub-?comment|child|楼中楼)/i.test(cls) ||
          /^回复\s*@/.test(raw);

        comments.push({
          text: text,
          author: author,
          time: tm ? tm[0] : '',
          likes: likes,
          isReply: isReply
        });
        if (comments.length >= cfg.maxComments) break;
      }
      out.comments = comments;

      // 4b) 页面声称的评论总数（2026-11-09 新增）——覆盖率校验的分母。
      //     只认「短元素、整段基本就是 N 条评论」：评论正文里出现「这 3 条评论」不会被当成总数。
      //     取所有候选的最大值（详情页头部总数 / 「查看全部 N 条评论」按钮 / 「评论 12」标题）。
      let claim = 0;
      try {
        const cands = document.querySelectorAll('a,button,span,div,h1,h2,h3,h4,p,[role="button"]');
        for (const el of cands) {
          const t = comp(el.innerText || el.textContent);
          if (!t || t.length > 24) continue;
          const m = t.match(/(?:共|查看全部|全部|展开)?\s*(\d[\d,]*)\s*条(?:评论|回复)|评论\s*(\d[\d,]*)|(\d[\d,]*)\s*comments?/i);
          if (!m) continue;
          // 剥掉数字与已知计数词后必须什么都不剩（否则是"3 条评论都很精彩"这类正文）
          const rest = t.replace(/[\s\d,]/g, '')
            .replace(/条评论|条回复|comments?|查看全部|共|全部|评论|回复|展开/gi, '');
          if (rest.length) continue;
          const v = Number(String(m[1] || m[2] || m[3]).replace(/,/g, ''));
          if (Number.isFinite(v) && v > claim && v < 100000) claim = v;
        }
      } catch (e) { claim = 0; }
      out.stats.claimCount = claim;

      // 5) 帖子正文候选：排除评论容器（及其祖先）后文本最长的容器，≤800 字、已压缩空白
      let post = '';
      try {
        let bestLen = 0;
        for (const el of document.querySelectorAll('article,main,section,div')) {
          if (container && (el === container || el.contains(container))) continue;
          const t = comp(el.innerText || el.textContent);
          if (t.length < 40) continue;
          if (t.length > bestLen) { bestLen = t.length; post = t; }
        }
      } catch (e) { post = ''; }
      if (!post) post = comp(document.body ? document.body.innerText : '');
      out.post = post.slice(0, 800);
      return out;
    }, {
      containers: o.containerSelectors || [],
      minText: num(o.minText, defaultOpts.minText),
      maxText: num(o.maxText, defaultOpts.maxText),
      maxComments: Math.max(1, Math.round(num(o.maxCommentsPerPost, defaultOpts.maxCommentsPerPost))),
      timeAlt: TIME_ALT,
      timeSrc: TIME_SRC,
      timeExtAlt: TIME_EXT_ALT,
      likePatterns: LIKE_PATTERNS,
      likesStripSrc: LIKES_STRIP_SRC
    });
  } catch (e) {
    // 2026-10-25：以前这里直接 return empty —— 页面内任何异常都会变成"0 条评论且毫无信号"，
    // 排查时极难定位（我自己就踩过一次：正则括号不平衡 → 静默返回空）。现在留下原因。
    empty.stats.extractError = shortErr(e);
    return empty;
  }
  if (!r || typeof r !== 'object') return empty;
  r.url = r.url || '';
  r.title = r.title || '';
  r.post = r.post || '';
  if (!Array.isArray(r.comments)) r.comments = [];
  if (!r.stats) r.stats = { containerFound: false, candidateCount: 0, textLength: 0, extractError: '', claimCount: 0 };
  if (r.stats.extractError === undefined) r.stats.extractError = '';
  return r;
}

// ---------- 1.5 loadExisting ----------

/**
 * 读 outDir/posts_with_comments.json 的 .posts。
 * 不存在 → []；损坏（读失败/JSON 解析失败/.posts 不是数组）→ **先备份再返回 []**，绝不直接丢。
 */
function loadExisting(outDir) {
  const file = path.join(outDir || '.', 'posts_with_comments.json');
  let raw;
  try {
    if (!fs.existsSync(file)) return [];
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return [];
  }
  let data = null;
  try { data = JSON.parse(raw); } catch (e) { data = null; }
  if (!data || !Array.isArray(data.posts)) {
    try { fs.copyFileSync(file, file + '.bak.' + Date.now()); } catch (e) { /* 备份失败也要返回 [] */ }
    return [];
  }
  return data.posts.filter(p => p && typeof p === 'object');
}

// ---------- 覆盖率校验（2026-11-09 新增） ----------
// 背景：EXPERIENCE.md §十七 记着实测「大帖（80/49 评论）只能拿到 40%~60%」，
// 但引擎日志只报「评论 N 条」，没有分母 → 漏了一半也没人知道，属于静默失真。
// 现在把页面自己声称的总数当分母，低于阈值显式告警并计入 stats.lowCoverage。
const COVERAGE_MIN_RATIO = 0.7;   // 低于 70% 视为可能漏抓
const COVERAGE_MIN_CLAIM = 5;     // 页面声称 < 5 条时不校验（小帖噪声大，且分母常含楼中楼）

function coverageOf(post) {
  const got = (post && Array.isArray(post.comments)) ? post.comments.length : 0;
  const claim = Number((post && post.stats && post.stats.claimCount) || 0);
  if (!(claim >= COVERAGE_MIN_CLAIM)) return null;
  return { got: got, claim: claim, ratio: got / claim };
}

function coverageNote(post, stats) {
  const c = coverageOf(post);
  if (!c) return '';
  if (stats) stats.claimTotal += c.claim;
  const tag = '｜页面声称 ' + c.claim + ' 条，覆盖 ' + pct(c.ratio) + '%';
  if (c.ratio >= COVERAGE_MIN_RATIO) return tag;
  if (stats) stats.lowCoverage++;
  return tag + ' ⚠ 偏低（评论区懒加载/楼中楼没展开完）→ 把 expandIdleRounds 调到 4~5 重跑该帖；' +
    '仍不够就见 SKILL.md Phase 3.4「评论采集三档路径」，改用 browser-skill 手工补这几个大帖';
}

// ---------- P0：点卡片进详情的两个原子动作（2026-11-09） ----------

/**
 * 点列表页第 idx 张「可见且文本够长」的卡片。
 * 在页面上下文里按索引重新查一遍再点 —— 回退/重排后旧 handle 会失效，索引是唯一稳定身份。
 * @returns {Promise<{ok:boolean,count:number,error?:string}>} count = 当前可点卡片总数
 */
async function clickCardAt(page, sel, idx, minText) {
  if (!page || typeof page.evaluate !== 'function') return { ok: false, count: 0, error: 'no page' };
  try {
    return await page.evaluate(({ sel, idx, minText }) => {
      let els = [];
      if (sel) { try { els = Array.from(document.querySelectorAll(sel)); } catch (e) { els = []; } }
      if (!els.length) { try { els = Array.from(document.querySelectorAll('[role="button"]')); } catch (e) { els = []; } }
      const vis = els.filter(el => {
        let r;
        try { r = el.getBoundingClientRect(); } catch (e) { return false; }
        if (!r || r.width === 0 || r.height === 0) return false;
        const t = ((el.innerText || el.textContent) || '').trim();
        return t.length >= (minText || 10);
      });
      const el = vis[idx];
      if (!el) return { ok: false, count: vis.length };
      try { el.scrollIntoView({ block: 'center' }); } catch (e) { /* 不可滚动也照点 */ }
      el.click();
      return { ok: true, count: vis.length };
    }, { sel: sel || '', idx: idx, minText: minText });
  } catch (e) {
    return { ok: false, count: 0, error: String((e && e.message) || e).split('\n')[0].slice(0, 120) };
  }
}

/** 等 URL 从 before 变成「像详情页」（SPA 改 history 也算），超时返回 false */
async function waitUrlChange(page, before, re, timeoutMs, sleep) {
  const t0 = Date.now();
  const step = 200;
  const wait = typeof sleep === 'function' ? sleep : DEFAULT_SLEEP;
  while (Date.now() - t0 < timeoutMs) {
    await wait(step);
    let u = '';
    try { u = page.url(); } catch (e) { u = ''; }
    if (u && u !== before && re.test(u)) return true;
  }
  return false;
}

// ---------- 1.6 harvestComments ----------

/**
 * 串行采集多条详情页的评论区。
 * 逐条追加 .jsonl（中断不丢）；每 5 条 + 结束各写一次全量 .json。
 * @param {{page:object, opts:object, links:string[], outDir:string, log:Function}} args
 * @returns {Promise<{posts:Array, files:{json:string,jsonl:string}, stats:object}>}
 */
async function harvestComments(args) {
  const a = args || {};
  const o = withDefaults(a.opts);
  const info = loggerOf(a.log);
  const sleep = sleepOf(o);
  const outDir = a.outDir || process.cwd();
  const links = (Array.isArray(a.links) ? a.links : []).filter(u => typeof u === 'string' && u.trim());
  const page = a.page;

  const jsonPath = path.join(outDir, 'posts_with_comments.json');
  const jsonlPath = path.join(outDir, 'posts_with_comments.jsonl');
  const files = { json: jsonPath, jsonl: jsonlPath };
  const stats = {
    attempted: 0, added: 0, duplicated: 0,
    comments: 0, expandClicks: 0, stoppedBy: 'linksExhausted',
    // 2026-11-09：覆盖率校验（页面声称 N 条 vs 实抓 M 条）。不属于契约固定键，纯统计附加。
    claimTotal: 0, lowCoverage: 0,
    // 2026-11-09 P0/P1：点卡片入口与补抓
    refilled: 0, refillGained: 0, clickEntryFails: 0, cardCount: 0
  };
  const maxPosts = Math.max(0, Math.round(num(o.maxPosts, defaultOpts.maxPosts)));
  const dupCfg = o.dupStop;

  try { fs.mkdirSync(outDir, { recursive: true }); } catch (e) {}
  if (!fs.existsSync(jsonlPath)) { try { fs.writeFileSync(jsonlPath, ''); } catch (e) {} }

  // appendExisting=true → 载入已有产物续抓（并据此跳过已抓 URL）；false → 本次从空开始
  let posts = o.appendExisting ? loadExisting(outDir) : [];
  // 未续抓时旧产物会被 writeAll 覆盖 → 先备份，沿用引擎对 data.json 的同一纪律（pipeline.js:812-817）
  if (!o.appendExisting) {
    try {
      if (fs.existsSync(jsonPath)) {
        const bak = jsonPath + '.bak.' + Date.now();
        fs.copyFileSync(jsonPath, bak);
        info('· 未开 appendExisting → 已备份旧产物: ' + path.basename(bak));
      }
    } catch (e) { info('  ⚠ 旧产物备份失败: ' + shortErr(e)); }
  }
  // 2026-11-09：Set → Map（url → posts 下标），补抓时要按 URL 找回已有记录原地更新
  const seen = new Map();
  posts.forEach((p, i) => { if (p && p.url) seen.set(p.url, i); });
  if (posts.length) info('· 已载入既有产物 ' + posts.length + ' 篇（appendExisting=true），按 URL 增量续抓');

  const writeAll = () => {
    try {
      fs.writeFileSync(jsonPath, JSON.stringify({
        source: String(o.source || ''),
        fetchedAt: new Date().toISOString(),
        posts: posts
      }, null, 2), 'utf8');
      return true;
    } catch (e) {
      info('  ⚠ 写 ' + path.basename(jsonPath) + ' 失败: ' + shortErr(e));
      return false;
    }
  };

  let consecDup = 0;

  // ---------- 共用：展开 + 抽取当前详情页 ----------
  const capture = async (url) => {
    let exp = { clicks: 0, stoppedBy: '', rounds: 0, errors: 0 };
    try { exp = await expandComments(page, o, info); } catch (e) { info('  ⚠ 展开失败: ' + shortErr(e)); }
    stats.expandClicks += exp.clicks || 0;

    let post = null;
    try { post = await scrapeComments(page, o); } catch (e) { info('  ⚠ 解析失败: ' + shortErr(e)); }
    if (!post || !post.url) {
      const why = (post && post.stats && post.stats.extractError)
        ? '抽取异常（' + post.stats.extractError + '）'
        : '解析为空';
      info('  ⚠ [' + stats.attempted + '] 详情页' + why + '，跳过: ' + String(url || '').slice(0, 120));
      return null;
    }
    return { post: post, exp: exp };
  };

  // ---------- 共用：去重 / 补抓(P1) / 落盘 ----------
  // 返回 'added' | 'refilled' | 'dup' | 'stop'
  const record = (post, exp) => {
    const idx = seen.get(post.url);
    if (idx !== undefined) {
      const old = posts[idx] || {};
      const oldN = Array.isArray(old.comments) ? old.comments.length : 0;
      const newN = Array.isArray(post.comments) ? post.comments.length : 0;
      // P1 补抓：只有「确实更全」才覆盖，避免把已有数据改坏
      if (o.refill && newN > oldN) {
        const now = new Date().toISOString();
        const rec = Object.assign({}, post, { fetchedAt: now, refilledAt: now, refillFrom: oldN });
        posts[idx] = rec;
        stats.refilled++;
        stats.refillGained += (newN - oldN);
        stats.comments += (newN - oldN);
        try { fs.appendFileSync(jsonlPath, JSON.stringify(rec) + '\n', 'utf8'); } catch (e) { /* 追加失败不影响内存态 */ }
        info('  ↻ [' + stats.attempted + '] 补抓 ' + post.url.slice(0, 100) + ' → 评论 ' + oldN + ' → ' + newN +
          '（页面声称 ' + ((post.stats && post.stats.claimCount) || 0) + '）');
        return 'refilled';
      }
      stats.duplicated++;
      consecDup++;
      info('  · [' + stats.attempted + '] 已抓过，跳过: ' + post.url.slice(0, 120) +
        (o.refill ? '（补抓后未见更全：' + oldN + ' → ' + newN + '）' : ''));
      if (dupCfg.enabled && consecDup >= dupCfg.consecutive) {
        stats.stoppedBy = 'dupStop';
        info('');
        info('[需向用户确认] 连续 ' + consecDup + ' 条详情都是已抓过 → 列表可能已循环/该频道已抓完。');
        info('  · 若要继续：换列表页或窗口重跑；若确认抓完：直接结束（已抓 ' + posts.length + ' 篇）。');
        return 'stop';
      }
      return 'dup';
    }
    seen.set(post.url, posts.length);
    consecDup = 0;

    const rec = Object.assign({}, post, { fetchedAt: new Date().toISOString() });
    posts.push(rec);
    stats.added++;
    stats.comments += (post.comments || []).length;

    // 逐条落盘：中断也不丢
    try { fs.appendFileSync(jsonlPath, JSON.stringify(rec) + '\n', 'utf8'); }
    catch (e) { info('  ⚠ 追加 jsonl 失败: ' + shortErr(e)); }

    info('  [' + stats.added + '] ' + post.url.slice(0, 110) + ' → 评论 ' + (post.comments || []).length +
      ' 条（展开点击 ' + (exp.clicks || 0) + ' 次/' + (exp.stoppedBy || '-') + '）' +
      coverageNote(post, stats));

    if (stats.added % 5 === 0) writeAll();
    return 'added';
  };

  // 重复率兜底（契约 §1.6 步骤 8）：连续多批都是已抓过 → 判定抓完
  const dupRatioStop = () => {
    if (!dupCfg.enabled || !(dupCfg.consecutive > 0) || stats.attempted < dupCfg.consecutive) return false;
    const newRatio = stats.attempted ? (stats.added + stats.refilled) / stats.attempted : 1;
    if (newRatio >= dupCfg.minNewRatio) return false;
    stats.stoppedBy = 'dupRatio';
    info('');
    info('[需向用户确认] 本次因「连续多批内容重复」提前停止：新增率 ' + pct(newRatio) + '% < 阈值 ' +
      pct(dupCfg.minNewRatio) + '%。');
    info('  · 已抓 ' + stats.added + ' 篇 / 访问 ' + stats.attempted + ' 篇；若确认抓完可直接结束。');
    return true;
  };

  // ---------- P0：入口判定 ----------
  // auto = 有 _link 走链接、没有就点卡片（脉脉频道页 _link 恒为 0，走的就是点卡片）
  const entryMode = String(o.detailEntry || EXT_DEFAULTS.detailEntry);
  const useClick = entryMode === 'click' || (entryMode === 'auto' && links.length === 0);

  if (useClick) {
    // ---------- 点卡片进详情 ----------
    let listUrl = '';
    try { listUrl = page.url(); } catch (e) { listUrl = ''; }
    let urlRe;
    try { urlRe = new RegExp(String(o.detailUrlPattern || EXT_DEFAULTS.detailUrlPattern)); }
    catch (e) { urlRe = /detail/i; }
    const cardSel = String(o.clickCardSelector ||
      (Array.isArray(o.containerSelectors) ? (o.containerSelectors[0] || '') : '') || '');
    const minTxt = num(o.minText, defaultOpts.minText);
    const waitMs = num(o.clickWaitMs, EXT_DEFAULTS.clickWaitMs);

    info('');
    info('[评论区·点卡片模式] 列表页 ' + String(listUrl).slice(0, 100) +
      '｜卡片选择器 ' + (cardSel || '[role=button]') + '｜等跳转 ' + waitMs + 'ms');
    info('  · 该站条目没有 href（_link 恒为空），按 SKILL.md §十七 的黄金路径：点卡片 → 等 URL → 抓 → 回退');

    let idx = 0;
    let fails = 0;
    const guard = Math.max(maxPosts * 3, maxPosts + 10);   // 防点不动时死循环
    while (stats.attempted < maxPosts && idx < guard) {
      if (dupRatioStop()) break;
      const before = (() => { try { return page.url(); } catch (e) { return ''; } })();
      const hit = await clickCardAt(page, cardSel, idx, minTxt);
      if (!hit || !hit.ok) {
        if (hit && hit.count !== undefined) { info('  · 可点卡片已到末尾（共 ' + hit.count + ' 张）'); stats.cardCount = hit.count; }
        else info('  ⚠ 定位卡片失败: ' + ((hit && hit.error) || '未知'));
        break;
      }
      stats.cardCount = hit.count;

      const nav = await waitUrlChange(page, before, urlRe, waitMs, sleep);
      if (!nav) {
        stats.clickEntryFails++;
        fails++;
        info('  ⚠ [卡片 ' + (idx + 1) + '/' + hit.count + '] 点击后 ' + waitMs +
          'ms 内 URL 未跳到详情页（可能点在折叠区/加载中），换下一张');
        idx++;
        if (fails >= 5) {
          info('  ⚠ 连续 ' + fails + ' 张卡片都点不动 → 停止，检查 clickCardSelector / detailUrlPattern');
          break;
        }
        continue;
      }
      fails = 0;
      stats.attempted++;
      await sleep(Math.max(0, num(o.detailWaitMs, defaultOpts.detailWaitMs)));

      const cap = await capture((() => { try { return page.url(); } catch (e) { return ''; } })());
      let r = 'skip';
      if (cap) r = record(cap.post, cap.exp);

      // 回列表：优先 goBack（保留原列表状态），失败则重新 goto 列表页
      try { await page.goBack({ waitUntil: 'domcontentloaded', timeout: 20000 }); }
      catch (e) {
        info('  ⚠ 回退列表失败（' + shortErr(e) + '），改为重新打开列表页');
        try { if (listUrl) await page.goto(listUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }); } catch (e2) { /* 下一轮会暴露 */ }
      }
      await sleep(Math.max(200, num(o.delayMs, defaultOpts.delayMs) / 2));

      if (r === 'stop') break;
      idx++;
    }
    info('  · 点卡片模式结束：可点卡片 ' + stats.cardCount + ' 张｜进入详情 ' + stats.attempted +
      ' 次｜点不动 ' + stats.clickEntryFails + ' 次');
  } else {
    // ---------- 走链接（旧行为） ----------
    for (const link of links) {
      if (stats.attempted >= maxPosts) { stats.stoppedBy = 'maxPosts'; break; }
      if (dupRatioStop()) break;

      stats.attempted++;
      try {
        await page.goto(link, { waitUntil: 'domcontentloaded', timeout: num(o.gotoTimeoutMs, 30000) });
      } catch (e) {
        info('  ⚠ [' + stats.attempted + '] 打开失败，跳过: ' + String(link).slice(0, 120) + '（' + shortErr(e) + '）');
        continue;
      }
      await sleep(Math.max(0, num(o.detailWaitMs, defaultOpts.detailWaitMs)));

      const cap = await capture(link);
      if (!cap) continue;
      if (record(cap.post, cap.exp) === 'stop') break;
    }
  }

  writeAll();
  info('✓ 评论区落盘: ' + path.basename(jsonPath) + '（' + posts.length + ' 篇） + ' +
    path.basename(jsonlPath) + '（逐条追加）｜访问 ' + stats.attempted + ' / 新增 ' + stats.added +
    ' / 重复 ' + stats.duplicated + ' / 评论 ' + stats.comments + ' 条 / 展开点击 ' + stats.expandClicks + ' 次' +
    '｜停止原因 ' + stats.stoppedBy);
  // 覆盖率汇总：只统计「页面给了分母」的帖子，避免拿估算值冒充绝对值
  if (stats.claimTotal > 0) {
    stats.coveragePct = pct(stats.comments / stats.claimTotal);
    info('  覆盖率: 实抓 ' + stats.comments + ' / 页面声称合计 ' + stats.claimTotal + ' → ' + stats.coveragePct + '%' +
      (stats.lowCoverage ? '（' + stats.lowCoverage + ' 篇低于 ' + pct(COVERAGE_MIN_RATIO) + '%，见上方 ⚠）' : ''));
  }
  if (stats.refilled > 0) {
    info('  补抓: ' + stats.refilled + ' 篇刷新（净增评论 ' + stats.refillGained + ' 条）');
  }

  return { posts: posts, files: files, stats: stats };
}

module.exports = {
  normalizeCommentOpts,
  extendCommentOpts,
  collectDetailLinks,
  sortRecords,
  expandComments,
  scrapeComments,
  loadExisting,
  harvestComments,
  defaultOpts,
  EXT_DEFAULTS,
  COMMENT_EXPANDERS
};
