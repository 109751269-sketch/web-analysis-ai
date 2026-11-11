'use strict';
/**
 * comments-selftest.js — lib/comments.js 离线自测（Playwright 打开本地 file:// fixture）
 *
 * 运行：node "C:/Users/sun/.agents/skills/web-analysis-ai/test/comments-selftest.js"
 * 约束：只访问本目录的 comments-fixture.html（file://），不联网、不登录、不读 cookie。
 * 退出码：全部 PASS = 0，任一 FAIL = 1。
 *
 * 说明：本测试文件允许 require('playwright')；被测的 lib/comments.js 严禁依赖 playwright（在第 1 条里静态断言）。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const SKILL_DIR = path.resolve(__dirname, '..');
const LIB_FILE = path.join(SKILL_DIR, 'lib', 'comments.js');
const FIXTURE_FILE = path.join(__dirname, 'comments-fixture.html');
const FIXTURE_URL = 'file:///' + FIXTURE_FILE.replace(/\\/g, '/');
const OUT_DIR = path.join(os.tmpdir(), 'dsh-comments-selftest');
const CORRUPT_DIR = path.join(OUT_DIR, 'corrupt-case');

// fixture 展开收敛后的真实评论条数（写死；与 scrapeComments 结果交叉核对）
const EXPECT_COMMENTS = 12;
const EXPECT_REPLIES = 2;

let pass = 0;
let fail = 0;
const failed = [];

function ok(name, fn) {
  try { fn(); pass++; console.log('PASS  ' + name); }
  catch (e) { fail++; failed.push(name); console.log('FAIL  ' + name + '  → ' + ((e && e.message) || e)); }
}
async function okAsync(name, fn) {
  try { await fn(); pass++; console.log('PASS  ' + name); }
  catch (e) { fail++; failed.push(name); console.log('FAIL  ' + name + '  → ' + ((e && e.message) || e)); }
}
function section(t) { console.log('\n=== ' + t + ' ==='); }

(async () => {
  console.log('web-analysis-ai · comments.js 自测');
  console.log('  技能目录 : ' + SKILL_DIR);
  console.log('  fixture  : ' + FIXTURE_URL);
  console.log('  产物目录 : ' + OUT_DIR);
  console.log('  node     : ' + process.version);

  // ---------- 0. 环境准备 ----------
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(CORRUPT_DIR, { recursive: true });

  // ---------- 1. 静态契约：不得依赖 playwright ----------
  section('1. 硬约束与导出面');
  const src = fs.readFileSync(LIB_FILE, 'utf8');
  // 只看代码、不看注释：文件头注释里为了说明约束，本身就写着 require('playwright')
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter(l => !/^\s*(\/\/|\*)/.test(l))
    .join('\n');
  ok('lib/comments.js 存在且非空', () => {
    assert.ok(fs.existsSync(LIB_FILE), '文件不存在');
    assert.ok(src.length > 1000, '文件异常短');
  });
  ok('lib/comments.js 代码中不含 require(\'playwright\')（契约 §0.1）', () => {
    assert.ok(!/require\(\s*['"]playwright['"]\s*\)/.test(code), '发现 playwright 依赖');
    assert.ok(!/from\s+['"]playwright['"]/.test(code), '发现 playwright import');
  });
  ok('lib/comments.js 只 require Node 内置模块', () => {
    const reqs = Array.from(code.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)).map(m => m[1]);
    const bad = reqs.filter(r => r.startsWith('.') ? false : !['fs', 'path', 'os', 'url', 'util'].includes(r));
    assert.deepStrictEqual(bad, [], '出现非内置依赖: ' + bad.join(','));
    assert.ok(reqs.length > 0, '未解析到 require');
  });

  const cm = require(LIB_FILE);   // 无 playwright 也能 require 成功
  ok('require comments.js 未把 playwright 拉进模块缓存（运行时证明：此刻 playwright 尚未被本测试加载）', () => {
    const hit = Object.keys(require.cache).filter(k => /[\\/]playwright[\\/]/.test(k));
    assert.deepStrictEqual(hit, [], 'comments.js 间接依赖了 playwright: ' + hit.join(','));
  });
  ok('require 成功且 8 个导出齐全', () => {
    const want = ['normalizeCommentOpts', 'collectDetailLinks', 'expandComments',
      'scrapeComments', 'loadExisting', 'harvestComments', 'defaultOpts', 'COMMENT_EXPANDERS'];
    for (const k of want) assert.ok(cm[k] !== undefined, '缺少导出 ' + k);
    assert.strictEqual(typeof cm.expandComments, 'function');
    assert.strictEqual(typeof cm.harvestComments, 'function');
    assert.ok(cm.COMMENT_EXPANDERS instanceof RegExp, 'COMMENT_EXPANDERS 应为 RegExp');
  });
  ok('COMMENT_EXPANDERS 命中四处已验证文案', () => {
    for (const t of ['查看全部 12 条评论', '全部评论', '查看 3 条回复', '加载更多', '更多评论', '展开', '7 条评论']) {
      assert.ok(cm.COMMENT_EXPANDERS.test(t), '未命中: ' + t);
    }
  });
  ok('正则本身会命中长正文（故实现必须靠 ≤20 字守卫拦截，fixture 里已埋诱饵）', () => {
    assert.ok(cm.COMMENT_EXPANDERS.test('本段是较长的正文段落，其中也出现了「展开」二字，但整段明显超过二十个字'),
      '若正则不命中该长文本，则本条的守卫测试无意义');
  });

  // ---------- 2. normalizeCommentOpts ----------
  section('2. normalizeCommentOpts');
  const D = cm.normalizeCommentOpts({});
  ok('默认值全部正确（契约 §1.1）', () => {
    assert.deepStrictEqual(D, {
      enabled: false, maxPosts: 50, delayMs: 1800, detailWaitMs: 2500,
      expandIdleRounds: 3, expandMaxRounds: 20, include: '', exclude: '',
      minText: 4, maxText: 600, maxCommentsPerPost: 60, containerSelectors: [],
      dupStop: { enabled: true, consecutive: 2, minNewRatio: 0.1 }, appendExisting: false
    });
  });
  ok('键集合恰好等于契约（不多不少）', () => {
    const want = ['enabled', 'maxPosts', 'delayMs', 'detailWaitMs', 'expandIdleRounds', 'expandMaxRounds',
      'include', 'exclude', 'minText', 'maxText', 'maxCommentsPerPost', 'containerSelectors', 'dupStop', 'appendExisting'];
    assert.deepStrictEqual(Object.keys(D).sort(), want.slice().sort());
  });
  ok('{comments:{maxPosts:3}} 覆盖生效、其余保持默认', () => {
    const o = cm.normalizeCommentOpts({ comments: { maxPosts: 3 } });
    assert.strictEqual(o.maxPosts, 3);
    assert.strictEqual(o.delayMs, 1800);
    assert.strictEqual(o.enabled, false);
  });
  ok('默认值对象被冻结（防共享实体被误改）', () => {
    assert.ok(Object.isFrozen(cm.defaultOpts));
    assert.strictEqual(cm.defaultOpts.maxPosts, 50);
  });

  // ---------- 3. collectDetailLinks ----------
  section('3. collectDetailLinks');
  const recs = [
    { _link: '/job/1' }, { _link: '/job/1' }, { _link: '/job/2' },
    { _link: '' }, { _link: 'javascript:void(0)' }, { _link: '#' }, { _link: '#anchor' },
    { _link: '/job/3' }, { _link: '/other/9' }, { _idx: 1, _text: '无链接' }, null, 'bad'
  ];
  ok('去重保序 + 跳过空/javascript:/# + 相对路径原样返回', () => {
    assert.deepStrictEqual(cm.collectDetailLinks(recs, D), ['/job/1', '/job/2', '/job/3', '/other/9']);
  });
  ok('include 白名单生效', () => {
    const o = Object.assign({}, D, { include: '/job/' });
    assert.deepStrictEqual(cm.collectDetailLinks(recs, o), ['/job/1', '/job/2', '/job/3']);
  });
  ok('exclude 黑名单生效', () => {
    const o = Object.assign({}, D, { exclude: '/job/' });
    assert.deepStrictEqual(cm.collectDetailLinks(recs, o), ['/other/9']);
  });
  ok('无 _link / 空数组 → []（契约 §1.2 末条）', () => {
    assert.deepStrictEqual(cm.collectDetailLinks([{ _idx: 1 }, { _idx: 2 }], D), []);
    assert.deepStrictEqual(cm.collectDetailLinks([], D), []);
    assert.deepStrictEqual(cm.collectDetailLinks(null, D), []);
  });
  ok('非法正则不抛异常（安全降级）', () => {
    const o = Object.assign({}, D, { include: '([' });
    assert.deepStrictEqual(cm.collectDetailLinks(recs, o), ['/job/1', '/job/2', '/job/3', '/other/9']);
  });

  // ---------- 4. 浏览器（只开 file:// fixture） ----------
  section('4. expandComments（真跑浏览器，核心能力）');
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  const opts = cm.normalizeCommentOpts({
    comments: { enabled: true, maxPosts: 5, delayMs: 40, detailWaitMs: 30 }
  });
  const expandLog = [];
  let exp = null;
  let beforeLen = 0, afterLen = 0, domCount = 0, post = null;

  await okAsync('打开 file:// fixture 成功', async () => {
    const resp = await page.goto(FIXTURE_URL, { waitUntil: 'domcontentloaded' });
    assert.ok(resp === null || resp.ok() || /file:/.test(page.url()), 'goto 失败: ' + page.url());
    assert.ok(/comments-fixture\.html$/.test(page.url()), 'URL 不符: ' + page.url());
  });

  await okAsync('fixture 初始 5 条评论', async () => {
    const n = await page.evaluate(() => document.querySelectorAll('#comment-list > li').length);
    assert.strictEqual(n, 5, '初始评论数应为 5，实际 ' + n);
  });

  beforeLen = await page.evaluate(() => document.body.innerText.length);
  await okAsync('expandComments 执行（clicks ≥ 2 且 stoppedBy === "idle"）', async () => {
    exp = await cm.expandComments(page, opts, m => expandLog.push(String(m)));
    console.log('      → 实测 stats = ' + JSON.stringify(exp));
    assert.ok(exp.clicks >= 2, 'clicks 应 ≥2，实际 ' + exp.clicks);
    assert.strictEqual(exp.stoppedBy, 'idle', 'stoppedBy 应为 idle，实际 ' + exp.stoppedBy);
    assert.ok(exp.rounds >= 2, 'rounds 应 ≥2（跨轮才点到隐藏控件），实际 ' + exp.rounds);
    assert.strictEqual(exp.errors, 0, 'errors 应为 0，实际 ' + exp.errors);
  });
  afterLen = await page.evaluate(() => document.body.innerText.length);
  domCount = await page.evaluate(() => document.querySelectorAll('#comment-list > li').length);

  ok('展开后正文长度 > 展开前（DOM 真的增长了）', () => {
    assert.ok(afterLen > beforeLen, 'before=' + beforeLen + ' after=' + afterLen);
  });
  ok('展开后评论条数 === ' + EXPECT_COMMENTS + '（隐藏控件未被误点）', () => {
    assert.strictEqual(domCount, EXPECT_COMMENTS, '实际 ' + domCount);
  });
  await okAsync('长文本诱饵未被误点（≤20 字守卫生效）', async () => {
    const hit = await page.evaluate(() => Array.from(document.querySelectorAll('#comment-list > li'))
      .some(li => (li.innerText || '').includes('长文本被误点')));
    assert.strictEqual(hit, false, '含「展开」的长正文被当成控件点开了');
  });
  ok('expandLog 有逐轮记录（证明是循环而非一次扫平）', () => {
    assert.ok(expandLog.length >= 3, '日志行数 ' + expandLog.length);
    assert.ok(expandLog.join('\n').includes('展开第 2 轮'), '缺少第 2 轮记录');
  });

  // ---------- 5. scrapeComments ----------
  section('5. scrapeComments');
  await okAsync('comments.length === ' + EXPECT_COMMENTS + '（与 fixture 真实条数一致）', async () => {
    post = await cm.scrapeComments(page, opts);
    assert.strictEqual(post.comments.length, EXPECT_COMMENTS, '实际 ' + post.comments.length);
    assert.strictEqual(post.stats.containerFound, true, 'containerFound 应为 true');
    assert.strictEqual(post.stats.candidateCount, EXPECT_COMMENTS, 'candidateCount=' + post.stats.candidateCount);
  });
  ok('isReply 命中 2 条楼中楼', () => {
    assert.strictEqual(post.comments.filter(c => c.isReply).length, EXPECT_REPLIES,
      '实际 ' + post.comments.filter(c => c.isReply).length);
  });
  ok('字段齐全：text/author/time/likes/isReply', () => {
    for (const c of post.comments) {
      assert.strictEqual(typeof c.text, 'string');
      assert.strictEqual(typeof c.author, 'string');
      assert.strictEqual(typeof c.time, 'string');
      assert.ok(c.likes === '' || typeof c.likes === 'number', 'likes 类型异常: ' + JSON.stringify(c.likes));
      assert.strictEqual(typeof c.isReply, 'boolean');
      assert.ok(c.text.length > 4, '正文过短: ' + c.text);
    }
  });
  ok('首条评论字段正确（author/time/likes/text）', () => {
    const c0 = post.comments[0];
    assert.strictEqual(c0.author, '用户A');
    assert.strictEqual(c0.time, '刚刚');
    assert.strictEqual(c0.likes, 3);
    assert.ok(c0.text.includes('第一条评论'), 'text=' + c0.text);
  });
  ok('帖子正文/标题抓取正确（≤800 字、已压缩空白）', () => {
    assert.ok(post.post.includes('这是一个离线评论 fixture 的帖子正文'), 'post=' + post.post.slice(0, 120));
    assert.ok(post.post.length <= 800, 'post 长度 ' + post.post.length);
    assert.ok(post.title.includes('离线评论 fixture'), 'title=' + post.title);
    assert.ok(/^file:\/\//.test(post.url), 'url=' + post.url);
  });
  ok('未点到的隐藏控件文案不在结果里', () => {
    assert.ok(post.comments.every(c => !c.text.includes('不该被点到')), '隐藏控件被点了');
  });

  // ---------- 6. harvestComments ----------
  section('6. harvestComments');
  const links = [FIXTURE_URL, FIXTURE_URL + '?post=2'];
  let hr = null;
  await okAsync('跑 2 条链接 → 产出 posts_with_comments.json + .jsonl', async () => {
    hr = await cm.harvestComments({
      page: page, opts: opts, links: links, outDir: OUT_DIR,
      log: m => console.log('      [harvest] ' + m)
    });
    console.log('      → stats = ' + JSON.stringify(hr.stats));
    assert.ok(fs.existsSync(hr.files.json), '缺 json: ' + hr.files.json);
    assert.ok(fs.existsSync(hr.files.jsonl), '缺 jsonl: ' + hr.files.jsonl);
    assert.strictEqual(hr.stats.attempted, 2, 'attempted=' + hr.stats.attempted);
    assert.strictEqual(hr.stats.added, 2, 'added=' + hr.stats.added);
    assert.strictEqual(hr.stats.duplicated, 0, 'duplicated=' + hr.stats.duplicated);
    assert.strictEqual(hr.stats.comments, EXPECT_COMMENTS * 2, 'comments=' + hr.stats.comments);
    assert.strictEqual(hr.stats.expandClicks, 6, 'expandClicks=' + hr.stats.expandClicks);
    assert.strictEqual(hr.stats.stoppedBy, 'linksExhausted', 'stoppedBy=' + hr.stats.stoppedBy);
  });
  ok('json 结构 {source, fetchedAt, posts} 字段齐全且 2 篇', () => {
    const j = JSON.parse(fs.readFileSync(hr.files.json, 'utf8'));
    assert.strictEqual(typeof j.source, 'string');
    assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(j.fetchedAt), 'fetchedAt=' + j.fetchedAt);
    assert.ok(Array.isArray(j.posts), 'posts 不是数组');
    assert.strictEqual(j.posts.length, 2, 'posts=' + j.posts.length);
    for (const p of j.posts) {
      for (const k of ['url', 'title', 'post', 'comments', 'stats', 'fetchedAt']) {
        assert.ok(p[k] !== undefined, '缺字段 ' + k);
      }
      assert.strictEqual(p.comments.length, EXPECT_COMMENTS, p.url + ' comments=' + p.comments.length);
      assert.ok(p.stats.containerFound === true);
    }
    assert.notStrictEqual(j.posts[0].url, j.posts[1].url, '两条 URL 不应相同（去重逻辑前提）');
  });
  ok('jsonl 逐条追加、可逐行解析（2 行）', () => {
    const lines = fs.readFileSync(hr.files.jsonl, 'utf8').split('\n').filter(Boolean);
    assert.strictEqual(lines.length, 2, '行数 ' + lines.length);
    for (const l of lines) assert.ok(JSON.parse(l).url, '行不可解析: ' + l.slice(0, 80));
  });

  // ---------- 7. loadExisting ----------
  section('7. loadExisting');
  ok('读回 2 篇', () => {
    const posts = cm.loadExisting(OUT_DIR);
    assert.strictEqual(posts.length, 2, '实际 ' + posts.length);
  });
  ok('不存在 → []', () => {
    assert.deepStrictEqual(cm.loadExisting(path.join(OUT_DIR, 'no-such-dir')), []);
  });
  ok('损坏文件 → 先备份再返回 []', () => {
    const bad = path.join(CORRUPT_DIR, 'posts_with_comments.json');
    fs.writeFileSync(bad, '{ this is not json', 'utf8');
    const got = cm.loadExisting(CORRUPT_DIR);
    assert.deepStrictEqual(got, []);
    const baks = fs.readdirSync(CORRUPT_DIR).filter(f => f.includes('.bak.'));
    assert.strictEqual(baks.length, 1, '备份文件数 ' + baks.length);
    assert.strictEqual(fs.readFileSync(path.join(CORRUPT_DIR, baks[0]), 'utf8'), '{ this is not json');
  });
  ok('合法但 .posts 非数组 → 也算损坏并备份', () => {
    const dir2 = path.join(OUT_DIR, 'corrupt-case2');
    fs.mkdirSync(dir2, { recursive: true });
    fs.writeFileSync(path.join(dir2, 'posts_with_comments.json'), JSON.stringify({ posts: 'nope' }), 'utf8');
    assert.deepStrictEqual(cm.loadExisting(dir2), []);
    assert.strictEqual(fs.readdirSync(dir2).filter(f => f.includes('.bak.')).length, 1);
  });

  // ---------- 8. 边界：无展开控件 / 无限增长 / dupStop ----------
  section('8. 边界与停止条件');
  await okAsync('无展开控件的普通页面：clicks=0、stoppedBy=idle（不误点、不死循环）', async () => {
    const p2 = await ctx.newPage();
    // 注意：正文必须 >20 字且不含展开类关键词 —— 契约的 COMMENT_EXPANDERS 含裸 `展开`，
    // ≤20 字的含「展开」短文本按契约就是会被点的（详见汇报里的已知边界）。
    await p2.setContent('<html><body><div>这是一个没有任何可点击控件的普通详情页面正文，长度明显超过二十个字。</div></body></html>');
    const e2 = await cm.expandComments(p2, Object.assign({}, opts, { delayMs: 10, expandIdleRounds: 2 }), () => {});
    console.log('      → 空页面 stats = ' + JSON.stringify(e2));
    assert.strictEqual(e2.clicks, 0, 'clicks=' + e2.clicks);
    assert.strictEqual(e2.stoppedBy, 'idle', 'stoppedBy=' + e2.stoppedBy);
    assert.strictEqual(e2.rounds, 2, 'rounds=' + e2.rounds);
    await p2.close();
  });
  await okAsync('控件每轮自我重生（永不收敛）→ 被 expandMaxRounds 兜住，stoppedBy=maxRounds', async () => {
    const p3 = await ctx.newPage();
    await p3.setContent('<html><body><div id="host"><button id="b">加载更多</button></div>' +
      '<script>document.getElementById("host").addEventListener("click",function(){' +
      'var n=document.createElement("p");n.textContent="新增长文本行，用于模拟永不收敛的无限加载 "+Date.now();' +
      'document.body.appendChild(n);var o=document.getElementById("b");if(o)o.remove();' +
      'var b=document.createElement("button");b.id="b";b.textContent="加载更多";' +
      'document.getElementById("host").appendChild(b);});<\/script></body></html>');
    const e3 = await cm.expandComments(p3, Object.assign({}, opts, { delayMs: 10, expandMaxRounds: 4, expandIdleRounds: 3 }), () => {});
    console.log('      → 无限增长页 stats = ' + JSON.stringify(e3));
    assert.strictEqual(e3.stoppedBy, 'maxRounds', 'stoppedBy=' + e3.stoppedBy);
    assert.strictEqual(e3.rounds, 4, 'rounds=' + e3.rounds);
    assert.ok(e3.clicks >= 4, 'clicks=' + e3.clicks);
    await p3.close();
  });
  let hr2 = null;
  await okAsync('appendExisting 续抓：全重复 → dupStop + [需向用户确认]（契约 §1.6 步骤 5/8）', async () => {
    const logs = [];
    hr2 = await cm.harvestComments({
      page: page, opts: Object.assign({}, opts, { appendExisting: true }),
      links: links, outDir: OUT_DIR, log: m => logs.push(String(m))
    });
    console.log('      → stats = ' + JSON.stringify(hr2.stats));
    assert.strictEqual(hr2.stats.duplicated, 2, 'duplicated=' + hr2.stats.duplicated);
    assert.strictEqual(hr2.stats.added, 0, 'added=' + hr2.stats.added);
    assert.strictEqual(hr2.stats.stoppedBy, 'dupStop', 'stoppedBy=' + hr2.stats.stoppedBy);
    assert.strictEqual(hr2.posts.length, 2, 'posts=' + hr2.posts.length);
    assert.ok(logs.join('\n').includes('[需向用户确认]'), '缺少 [需向用户确认] 措辞');
  });
  ok('续抓后 jsonl 未被重复追加（仍 2 行）', () => {
    const lines = fs.readFileSync(hr2.files.jsonl, 'utf8').split('\n').filter(Boolean);
    assert.strictEqual(lines.length, 2, '行数 ' + lines.length);
  });

  // ---------- 9. 集成链路（复刻 pipeline.js:786-799 的调用顺序） ----------
  section('9. 集成链路（复刻 lib/pipeline.js 的调用方式）');
  await okAsync('records(_link 相对路径) → collectDetailLinks → new URL → harvestComments', async () => {
    const records = [
      { _idx: 1, _link: 'comments-fixture.html' },
      { _idx: 2, _link: 'comments-fixture.html?post=2' },
      { _idx: 3, _link: 'comments-fixture.html' },   // 重复 → 应被去重
      { _idx: 4, _link: 'other.html' }               // 不匹配 include → 应被过滤
    ];
    const copts = cm.normalizeCommentOpts({
      comments: { enabled: true, delayMs: 30, detailWaitMs: 20, maxPosts: 3, include: 'comments-fixture' }
    });
    assert.strictEqual(copts.enabled, true, 'enabled 应为 true');
    const rawLinks = cm.collectDetailLinks(records, copts);
    console.log('      → collectDetailLinks = ' + JSON.stringify(rawLinks));
    assert.deepStrictEqual(rawLinks, ['comments-fixture.html', 'comments-fixture.html?post=2']);
    // pipeline 原文：new URL(u, task.url) 把相对路径解析为绝对 URL
    const links2 = rawLinks.map(u => { try { return new URL(u, FIXTURE_URL).href; } catch (e) { return u; } });
    assert.ok(links2.every(u => /^file:\/\/\//.test(u)), '解析失败: ' + links2.join(','));
    const r2 = await cm.harvestComments({
      page: page, opts: copts, links: links2, outDir: path.join(OUT_DIR, 'integration'),
      log: m => console.log('      [integration] ' + m)
    });
    console.log('      → stats = ' + JSON.stringify(r2.stats));
    assert.strictEqual(r2.stats.added, 2, 'added=' + r2.stats.added);
    assert.strictEqual(r2.posts.length, 2, 'posts=' + r2.posts.length);
    assert.strictEqual(r2.posts.reduce((s, p) => s + ((p.comments || []).length), 0), EXPECT_COMMENTS * 2);
    assert.ok(fs.existsSync(r2.files.json) && fs.existsSync(r2.files.jsonl));
  });

  // ---------- 10. 覆盖前备份（沿用引擎对 data.json 的同一纪律） ----------
  section('10. 非续抓覆盖前先备份');
  await okAsync('appendExisting=false 重跑 → 旧产物先备份为 .bak.<ts>，不静默丢数据', async () => {
    const before = fs.readdirSync(OUT_DIR).filter(f => f.includes('.bak.')).length;
    const logs = [];
    const r3 = await cm.harvestComments({
      page: page, opts: opts, links: [links[0]], outDir: OUT_DIR, log: m => logs.push(String(m))
    });
    const after = fs.readdirSync(OUT_DIR).filter(f => f.includes('.bak.')).length;
    console.log('      → .bak 数量 ' + before + ' → ' + after + '；stats=' + JSON.stringify(r3.stats));
    assert.strictEqual(after, before + 1, '未生成备份文件');
    assert.strictEqual(r3.posts.length, 1, '非续抓应为本次 1 篇，实际 ' + r3.posts.length);
    assert.ok(logs.join('\n').includes('已备份旧产物'), '缺少备份日志');
    const baks = fs.readdirSync(OUT_DIR).filter(f => f.includes('.bak.')).sort();
    const last = JSON.parse(fs.readFileSync(path.join(OUT_DIR, baks[baks.length - 1]), 'utf8'));
    assert.strictEqual(last.posts.length, 2, '备份内容应是上一轮的 2 篇，实际 ' + last.posts.length);
  });

  // ---------- 11. 多级展开回归（task-7：同一节点换文案/id 后再点还能加载） ----------
  // 故障回顾：控件点一次后**原地变身**（查看全部12条评论 → 展开更多，id 也变），旧版按"元素身份"打标记
  // 把它永久跳过，改去点包着它的祖先 div（click 不向下冒泡）→ 自报点击成功但 click 未落元素 → 静默漏评论。
  section('11. 多级展开回归（task-7）');
  const MS_URL = FIXTURE_URL + '?case=multistage';
  const MS_EXPECT_COMMENTS = 8;
  const msPage = await ctx.newPage();
  let msExp = null, msPost = null;

  await msPage.addInitScript(() => {
    // 页面内"真实 click"计数器 + 记录引擎到底对哪些元素调用了 .click()
    window.__msRealClicks = 0;
    window.__msClickedTags = [];
    const orig = HTMLElement.prototype.click;
    HTMLElement.prototype.click = function () {
      window.__msClickedTags.push(this.tagName + '#' + (this.id || ''));
      return orig.apply(this, arguments);
    };
    document.addEventListener('click', e => {
      const b = e.target && e.target.closest ? e.target.closest('#ms-toolbar button') : null;
      if (b) window.__msRealClicks++;
    }, true);
  });

  await okAsync('多级展开 fixture 初始 3 条评论、控件为 ms-more1', async () => {
    await msPage.goto(MS_URL, { waitUntil: 'domcontentloaded' });
    const st = await msPage.evaluate(() => ({
      n: document.querySelectorAll('#ms-comments > .c').length,
      id: (document.querySelector('#ms-toolbar button') || {}).id || ''
    }));
    assert.strictEqual(st.n, 3, '初始评论数 ' + st.n);
    assert.strictEqual(st.id, 'ms-more1', '控件 id ' + st.id);
  });

  await okAsync('expandComments 点满两级：clicks=2、stoppedBy=idle、无失败', async () => {
    msExp = await cm.expandComments(msPage, opts, m => console.log('      [ms] ' + m));
    console.log('      → stats = ' + JSON.stringify(msExp));
    assert.strictEqual(msExp.clicks, 2, 'clicks 应为 2，实际 ' + msExp.clicks);
    assert.strictEqual(msExp.stoppedBy, 'idle', 'stoppedBy=' + msExp.stoppedBy);
    assert.strictEqual(msExp.errors, 0, 'errors=' + msExp.errors);
    assert.strictEqual(msExp.clickFails, 0, 'clickFails=' + msExp.clickFails);
  });

  const msState = await msPage.evaluate(() => ({
    comments: document.querySelectorAll('#ms-comments > .c').length,
    real: window.__msRealClicks,
    clickedTags: window.__msClickedTags,
    toolbarMarked: !!document.querySelector('#ms-toolbar[data-dsh-comment-expanded]'),
    toolbarDataset: Object.assign({}, document.getElementById('ms-toolbar').dataset),
    stage: (typeof stage !== 'undefined') ? stage : 'n/a'
  }));
  console.log('      → 页面态 = ' + JSON.stringify(msState));

  ok('展开后 DOM 评论数 === ' + MS_EXPECT_COMMENTS + '（真实总数，非"提前收敛"的 6）', () => {
    assert.strictEqual(msState.comments, MS_EXPECT_COMMENTS, '实际 ' + msState.comments);
  });
  ok('stats.clicks === 页面内真实 click 次数', () => {
    assert.strictEqual(msExp.clicks, msState.real, 'engine=' + msExp.clicks + ' 真实=' + msState.real);
  });
  ok('引擎只点过 BUTTON，从未点祖先容器（task-7 根因②回归守卫）', () => {
    assert.deepStrictEqual(msState.clickedTags, ['BUTTON#ms-more1', 'BUTTON#ms-more2']);
    assert.ok(msState.clickedTags.every(t => t.indexOf('BUTTON') === 0), '点到了非按钮: ' + msState.clickedTags.join(','));
  });
  ok('#ms-toolbar 祖先容器没有被误打 expanded 标记（根因②的直接守卫）', () => {
    assert.strictEqual(msState.toolbarMarked, false, '祖先容器被打了标记');
    assert.deepStrictEqual(msState.toolbarDataset, {}, '祖先容器 dataset 非空');
  });
  await okAsync('scrapeComments 在多级展开页取到 ' + MS_EXPECT_COMMENTS + ' 条', async () => {
    msPost = await cm.scrapeComments(msPage, opts);
    console.log('      → containerFound=' + msPost.stats.containerFound + ' comments=' + msPost.comments.length);
    console.log('      → c0=' + JSON.stringify(msPost.comments[0]));
    assert.strictEqual(msPost.stats.containerFound, true, 'containerFound=false');
    assert.strictEqual(msPost.comments.length, MS_EXPECT_COMMENTS, '实际 ' + msPost.comments.length);
  });
  // 单行块「昵称 · 时间 · 赞 N 正文」正是 Lead fixture 的形态：author/likes 都必须取到（task-8）
  ok('单行块（Lead fixture 形态）的 author/time/likes 都能取到', () => {
    const c0 = msPost.comments[0];
    assert.strictEqual(c0.author, '张三', 'author=' + JSON.stringify(c0.author));
    assert.strictEqual(c0.time, '2小时前', 'time=' + JSON.stringify(c0.time));
    assert.strictEqual(c0.likes, 3, 'likes=' + JSON.stringify(c0.likes));   // 「赞 3」前缀语序
    assert.strictEqual(c0.text, '这个问题我也遇到过，确实不好回答。', 'text=' + c0.text);
  });
  await msPage.close();

  // ---------- 12. 点击未送达 → 计入 errors/clickFails 且不打标记（task-7 要求②） ----------
  section('12. 点击未送达的如实上报（task-7 要求②）');
  const CF_URL = FIXTURE_URL + '?case=clickfail';
  const CF_EXPECT_COMMENTS = 5;
  const cfPage = await ctx.newPage();
  let cfExp = null;

  await okAsync('点击失败用例：初始 3 条静态评论', async () => {
    await cfPage.goto(CF_URL, { waitUntil: 'domcontentloaded' });
    const n = await cfPage.evaluate(() => document.querySelectorAll('#cf-comments > .c').length);
    assert.strictEqual(n, 3, '初始评论数 ' + n);
  });

  await okAsync('正常控件照常点开；点不动的控件被如实计入 clickFails/errors（不静默）', async () => {
    cfExp = await cm.expandComments(cfPage, Object.assign({}, opts, { expandIdleRounds: 2 }),
      m => console.log('      [cf] ' + m));
    console.log('      → stats = ' + JSON.stringify(cfExp));
    assert.strictEqual(cfExp.clicks, 1, 'clicks 应只算真送达的 1 次，实际 ' + cfExp.clicks);
    assert.ok(cfExp.clickFails >= 1, 'clickFails 应 >=1，实际 ' + cfExp.clickFails);
    assert.ok(cfExp.errors >= cfExp.clickFails, 'errors 应 >= clickFails，实际 ' + cfExp.errors);
  });

  const cfState = await cfPage.evaluate(() => ({
    comments: document.querySelectorAll('#cf-comments > .c').length,
    trapMarked: !!document.querySelector('#cf-trap[data-dsh-comment-expanded]'),
    trapOwnDisabled: document.getElementById('cf-trap').disabled,
    trapActuallyDisabled: document.getElementById('cf-trap').matches(':disabled'),
    moreMarked: !!document.querySelector('#cf-more[data-dsh-comment-expanded]'),
    moreText: (document.getElementById('cf-more') || {}).textContent || '',
    // hidden 子树里的按钮（innerText 会退化成 textContent 所以仍"匹配"）必须靠可见性守卫拦住
    hiddenMarked: !!document.querySelector('#ms-more1[data-dsh-comment-expanded]')
  }));
  console.log('      → 页面态 = ' + JSON.stringify(cfState));

  ok('点不动的控件没有被误打标记（下一轮仍可重试，不会被永久跳过）', () => {
    assert.strictEqual(cfState.trapMarked, false, '陷阱控件被打了标记');
  });
  ok('正常控件被打标记且评论数 === ' + CF_EXPECT_COMMENTS, () => {
    assert.strictEqual(cfState.moreMarked, true, '正常控件未打标记');
    assert.strictEqual(cfState.comments, CF_EXPECT_COMMENTS, '评论数 ' + cfState.comments);
  });
  ok('陷阱确实"能过预检但收不到 click"（IDL disabled=false、:disabled 为真）', () => {
    assert.strictEqual(cfState.trapOwnDisabled, false, 'el.disabled 应仍为 false');
    assert.strictEqual(cfState.trapActuallyDisabled, true, ':disabled 应为 true');
  });
  ok('hidden 子树里的控件没有被点、也没有被标记（可见性守卫生效）', () => {
    assert.strictEqual(cfState.hiddenMarked, false, '#ms-more1（隐藏）被打了标记');
  });
  await cfPage.close();

  // ---------- 13. 字段语序覆盖（task-8：likes / author / time 只认一种写法的毛病） ----------
  section('13. 字段语序覆盖（task-8）');
  const LK_URL = FIXTURE_URL + '?case=likes';
  const lkPage = await ctx.newPage();
  let lkPost = null;

  await okAsync('单行评论块：likes 多语序 / author / time 全部取到', async () => {
    await lkPage.goto(LK_URL, { waitUntil: 'domcontentloaded' });
    lkPost = await cm.scrapeComments(lkPage, opts);
    console.log('      → containerFound=' + lkPost.stats.containerFound + ' comments=' + lkPost.comments.length);
    for (const c of lkPost.comments) {
      console.log('        ' + JSON.stringify({ a: c.author, t: c.time, l: c.likes, x: c.text }));
    }
    assert.strictEqual(lkPost.stats.containerFound, true, 'containerFound=false');
    assert.strictEqual(lkPost.comments.length, 7, '条数 ' + lkPost.comments.length);
    assert.deepStrictEqual(lkPost.comments.map(c => c.likes), [3, 5, 12, '', 0, 12000, 999],
      'likes=' + JSON.stringify(lkPost.comments.map(c => c.likes)));
    assert.deepStrictEqual(lkPost.comments.map(c => c.author),
      ['张三', '李四', '王五', '赵六', '钱七', '孙八', '周九'],
      'author=' + JSON.stringify(lkPost.comments.map(c => c.author)));
    assert.deepStrictEqual(lkPost.comments.map(c => c.time),
      ['2小时前', '昨天', '3天前', '4小时前', '30秒前', '2周前', '刚刚'],
      'time=' + JSON.stringify(lkPost.comments.map(c => c.time)));
  });
  ok('likes 语序逐条命中：赞 3 / 5 赞 / 12 likes / 无 / 赞 0 / 1.2万 赞 / 赞 999', () => {
    const L = lkPost.comments.map(c => c.likes);
    assert.strictEqual(L[0], 3, '「赞 3」前缀语序');
    assert.strictEqual(L[1], 5, '「5 赞」后缀语序');
    assert.strictEqual(L[2], 12, '「12 likes」英文语序');
    assert.strictEqual(L[3], '', '无计数字样 → 必须空串（不编造）');
    assert.strictEqual(L[4], 0, '「赞 0」→ 数字 0（不能因假值退化成空串）');
    assert.strictEqual(L[5], 12000, '「1.2万 赞」→ 12000');
    assert.strictEqual(L[6], 999, '「赞 999」');
  });
  ok('time 补上契约遗漏的量级（30秒前 / 2周前）', () => {
    const T = lkPost.comments.map(c => c.time);
    assert.strictEqual(T[4], '30秒前', '秒级未取到');
    assert.strictEqual(T[5], '2周前', '周级未取到');
    assert.strictEqual(T[0], '2小时前', '契约覆盖的写法不受影响');
  });
  ok('author 单行块取到昵称（原实现此处必然落空）', () => {
    const A = lkPost.comments.map(c => c.author);
    assert.strictEqual(A.length, 7);
    assert.ok(A.every(a => a && a.length <= 30), 'author=' + JSON.stringify(A));
    assert.strictEqual(lkPost.comments[0].author, '张三');
    assert.strictEqual(lkPost.comments[5].author, '孙八');
  });
  ok('正文已剥净「· 时间 · 赞 N」元信息（两种语序都不残留）', () => {
    const want = [
      '前缀语序的数字应被识别。', '后缀语序的数字应被识别。', '英文后缀语序的数字应被识别。',
      '完全没有计数字样，应当留空串。', '计数为零时也要取到数字 0。',
      '万字换算应得到 12000。', '这一条只用于凑够容器的时间密度。'
    ];
    assert.deepStrictEqual(lkPost.comments.map(c => c.text), want,
      'text=' + JSON.stringify(lkPost.comments.map(c => c.text)));
    for (const c of lkPost.comments) {
      assert.ok(!/·/.test(c.text), '残留分隔符: ' + c.text);
      assert.ok(!/赞|likes/i.test(c.text), '残留赞数: ' + c.text);
    }
  });
  ok('多行结构（原始 fixture）的 author 取法未受影响', () => {
    const c0 = post.comments[0];   // 第 5 节里已抓好的默认 fixture 结果
    assert.strictEqual(c0.author, '用户A');
    assert.strictEqual(c0.likes, 3);
  });
  await okAsync('抽取异常不再静默：stats.extractError 带出原因（本轮踩过"静默返回空"）', async () => {
    const fakePage = { evaluate: async () => { throw new Error('boom-from-page'); } };
    const bad = await cm.scrapeComments(fakePage, opts);
    console.log('      → extractError = ' + JSON.stringify(bad.stats.extractError));
    assert.strictEqual(bad.comments.length, 0, 'comments 应为空');
    assert.ok(/boom-from-page/.test(bad.stats.extractError), 'extractError=' + JSON.stringify(bad.stats.extractError));
  });
  ok('正常抽取时 extractError 为空串', () => {
    assert.strictEqual(lkPost.stats.extractError, '', 'likes 用例: ' + lkPost.stats.extractError);
    assert.strictEqual(post.stats.extractError, '', '默认用例: ' + post.stats.extractError);
    assert.strictEqual(msPost.stats.extractError, '', '多级用例: ' + msPost.stats.extractError);
  });
  await lkPage.close();

  // ---------- 12. 覆盖率校验 + shadow DOM（2026-11-09 新增） ----------
  // 12a/12b：以前日志只报「评论 N 条」，没有分母 → 漏一半也没人知道（EXPERIENCE §十七 实测大帖只拿 40%~60%）。
  //          现在 scrapeComments 抽「页面声称总数」，harvest 算覆盖率并对低覆盖告警。
  // 12c：评论正文里出现「这 3 条评论」不能被当成总数（否则分母虚高、覆盖率虚低）。
  // 12d：展开控件在 open shadow root 里时，document.querySelectorAll 看不见 → 以前候选恒 0、静默不展开。
  section('12. 覆盖率校验与 shadow DOM 穿透（2026-11-09）');

  ok('12a 页面声称总数被抽出（fixture「查看全部12条评论」/「评论 12」）', () => {
    console.log('      → claimCount = ' + post.stats.claimCount + '，实抓 ' + post.comments.length);
    assert.strictEqual(post.stats.claimCount, EXPECT_COMMENTS, 'claimCount=' + post.stats.claimCount);
  });

  await okAsync('12b 覆盖率汇总：实抓/声称 = 100%，lowCoverage = 0', async () => {
    const cov = await cm.harvestComments({
      page: page, opts: Object.assign({}, opts, { detailWaitMs: 20, delayMs: 10 }),
      links: [links[0]], outDir: path.join(OUT_DIR, 'coverage'), log: () => {}
    });
    console.log('      → stats = ' + JSON.stringify(cov.stats));
    assert.strictEqual(cov.stats.claimTotal, EXPECT_COMMENTS, 'claimTotal=' + cov.stats.claimTotal);
    assert.strictEqual(cov.stats.coveragePct, 100, 'coveragePct=' + cov.stats.coveragePct);
    assert.strictEqual(cov.stats.lowCoverage, 0, 'lowCoverage=' + cov.stats.lowCoverage);
  });

  await okAsync('12c 正文里的「这 3 条评论」不会被当成总数（claimCount=0，不虚报分母）', async () => {
    const p4 = await ctx.newPage();
    await p4.setContent('<html><body><article><p>这 3 条评论都很精彩，值得一看，正文长度足够超过阈值。</p>' +
      '<ul><li>用户A · 1小时前 · 赞 1 第一条评论正文够长</li>' +
      '<li>用户B · 2小时前 · 赞 2 第二条评论正文够长</li>' +
      '<li>用户C · 3小时前 · 赞 3 第三条评论正文够长</li></ul></article></body></html>');
    const r = await cm.scrapeComments(p4, opts);
    console.log('      → claimCount = ' + r.stats.claimCount + '，comments = ' + r.comments.length);
    assert.strictEqual(r.stats.claimCount, 0, 'claimCount 应为 0，实际 ' + r.stats.claimCount);
    assert.ok(r.comments.length >= 3, 'comments=' + r.comments.length);
    await p4.close();
  });

  await okAsync('12d 展开控件在 open shadow root 内：能点到（clickFails=0）且 DOM 确实增长', async () => {
    const p5 = await ctx.newPage();
    await p5.setContent('<html><body>' +
      '<div id="light"><div class="c">初始评论一，正文长度足够超过阈值</div></div>' +
      '<div id="sd-host"></div>' +
      '<script>var host=document.getElementById("sd-host");var sr=host.attachShadow({mode:"open"});' +
      'sr.innerHTML="<button id=sd-more>加载更多</button>";var n=0;' +
      'sr.getElementById("sd-more").addEventListener("click",function(){n++;' +
      'var d=document.createElement("div");d.className="c";' +
      'd.textContent="影子按钮加载出来的第 "+n+" 条评论，正文长度足够超过阈值";' +
      'document.getElementById("light").appendChild(d);' +
      'if(n>=2){var b=sr.getElementById("sd-more");if(b)b.remove();}});<\/script></body></html>');
    const e5 = await cm.expandComments(p5, Object.assign({}, opts, { delayMs: 10, expandIdleRounds: 2 }), () => {});
    const n = await p5.evaluate(() => document.querySelectorAll('#light .c').length);
    console.log('      → shadow stats = ' + JSON.stringify(e5) + '，评论块 = ' + n);
    assert.ok(e5.clicks >= 1, '影子树里的按钮没被点到: clicks=' + e5.clicks);
    assert.strictEqual(e5.clickFails, 0, 'clickFails=' + e5.clickFails + '（composedPath 校验失效）');
    assert.ok(e5.grewBy > 0, 'grewBy=' + e5.grewBy);
    assert.strictEqual(n, 3, '应为 1 初始 + 2 加载，实际 ' + n);
    await p5.close();
  });

  // ---------- 13. P0 点卡片 / P1 补抓 / P2 排序（2026-11-09） ----------
  // 背景：脉脉频道页卡片是 div[role=button]、**没有 href**，实测 14,556 条记录 _link = 0，
  //       引擎的 collectDetailLinks 根本拿不到链接 → 评论区在脉脉上起不来。
  //       P0 用「点卡片 → 等 URL → 抓 → 回退」补上入口（EXPERIENCE §十七 的黄金路径）。
  section('13. P0 点卡片入场 / P1 补抓 / P2 排序（2026-11-09）');
  const CLICK_URL = 'file:///' + path.join(__dirname, 'comments-click-fixture.html').replace(/\\/g, '/');
  const CLICK_DETAIL_RE = 'comments-click-fixture\\.html\\?d=';

  ok('13a sortRecords：默认 index 保持原序，engage/textLen 稳定降序', () => {
    const recs = [
      { _idx: 1, 正文: '短', like: 1, repost: 0, reply: 0 },
      { _idx: 2, 正文: '这是一段中等长度的正文内容', like: 50, repost: 10, reply: 5 },
      { _idx: 3, 正文: '这是一段非常非常长的正文内容，明显长于其他两条', like: 10, repost: 0, reply: 0 }
    ];
    const byIndex = cm.sortRecords(recs, {}).map(r => r._idx);
    const byEngage = cm.sortRecords(recs, { sortBy: 'engage' }).map(r => r._idx);
    const byText = cm.sortRecords(recs, { sortBy: 'textLen' }).map(r => r._idx);
    console.log('      → index=' + JSON.stringify(byIndex) + ' engage=' + JSON.stringify(byEngage) +
      ' textLen=' + JSON.stringify(byText));
    assert.deepStrictEqual(byIndex, [1, 2, 3]);
    assert.deepStrictEqual(byEngage, [2, 3, 1]);   // 70 → 10 → 1
    assert.deepStrictEqual(byText, [3, 2, 1]);
    // 稳定性：同分保持原序
    const tie = [{ _idx: 1, like: 5 }, { _idx: 2, like: 5 }, { _idx: 3, like: 5 }];
    assert.deepStrictEqual(cm.sortRecords(tie, { sortBy: 'engage' }).map(r => r._idx), [1, 2, 3]);
  });

  ok('13b extendCommentOpts：扩展键白名单并到契约结果上，契约 14 键不被污染', () => {
    const base = cm.normalizeCommentOpts({ comments: { maxPosts: 3 } });
    const ext = cm.extendCommentOpts(base, { comments: { detailEntry: 'click', refill: true, sortBy: 'engage', 未知键: 1 } });
    console.log('      → detailEntry=' + ext.detailEntry + ' refill=' + ext.refill + ' sortBy=' + ext.sortBy +
      ' 未知键=' + ext.未知键);
    assert.strictEqual(ext.detailEntry, 'click');
    assert.strictEqual(ext.refill, true);
    assert.strictEqual(ext.sortBy, 'engage');
    assert.strictEqual(ext.maxPosts, 3);
    assert.strictEqual(ext['未知键'], undefined, '白名单外的键不应被带进来');
    // 不改入参、不污染契约键集合
    assert.strictEqual(base.detailEntry, undefined);
    assert.strictEqual(Object.keys(cm.normalizeCommentOpts({})).length, 14);
  });

  const clickDir = path.join(OUT_DIR, 'click');
  let clickRun = null;
  await okAsync('13c P0 点卡片进详情：links 为空也能抓到 3 篇（每篇含评论）', async () => {
    const p6 = await ctx.newPage();
    await p6.goto(CLICK_URL, { waitUntil: 'domcontentloaded' });
    const copts = Object.assign({}, opts, {
      detailEntry: 'click',
      clickCardSelector: 'div[role="button"]',
      detailUrlPattern: CLICK_DETAIL_RE,
      clickWaitMs: 5000,
      detailWaitMs: 60,
      delayMs: 60,
      maxPosts: 3
    });
    clickRun = await cm.harvestComments({ page: p6, opts: copts, links: [], outDir: clickDir, log: () => {} });
    console.log('      → stats = ' + JSON.stringify(clickRun.stats));
    assert.strictEqual(clickRun.stats.added, 3, 'added=' + clickRun.stats.added);
    assert.strictEqual(clickRun.posts.length, 3, 'posts=' + clickRun.posts.length);
    assert.ok(clickRun.posts.every(p => (p.comments || []).length === 3), '每篇应有 3 条评论: ' +
      JSON.stringify(clickRun.posts.map(p => (p.comments || []).length)));
    assert.ok(clickRun.stats.cardCount >= 3, 'cardCount=' + clickRun.stats.cardCount);
    assert.strictEqual(clickRun.stats.clickEntryFails, 0, 'clickEntryFails=' + clickRun.stats.clickEntryFails);
    await p6.close();
  });

  await okAsync('13d P1 补抓：已抓过但更全的记录被原地刷新，不再一律跳过', async () => {
    const p7 = await ctx.newPage();
    await p7.goto(CLICK_URL, { waitUntil: 'domcontentloaded' });
    // 先只留 1 条评论，制造"已有记录不完整"
    const thin = Object.assign({}, opts, {
      detailEntry: 'click', clickCardSelector: 'div[role="button"]',
      detailUrlPattern: CLICK_DETAIL_RE, clickWaitMs: 5000,
      detailWaitMs: 60, delayMs: 60, maxPosts: 2, maxCommentsPerPost: 1
    });
    const r1 = await cm.harvestComments({ page: p7, opts: thin, links: [], outDir: clickDir, log: () => {} });
    const thinCounts = r1.posts.map(p => p.comments.length);
    console.log('      → 首轮（maxCommentsPerPost=1）评论数 = ' + JSON.stringify(thinCounts));

    await p7.goto(CLICK_URL, { waitUntil: 'domcontentloaded' });
    const fat = Object.assign({}, thin, {
      maxCommentsPerPost: 60, appendExisting: true, refill: true
    });
    const r2 = await cm.harvestComments({ page: p7, opts: fat, links: [], outDir: clickDir, log: () => {} });
    console.log('      → 补抓 stats = ' + JSON.stringify(r2.stats));
    console.log('      → 补抓后评论数 = ' + JSON.stringify(r2.posts.map(p => p.comments.length)));
    assert.strictEqual(r2.stats.refilled, 2, 'refilled=' + r2.stats.refilled);
    assert.strictEqual(r2.stats.added, 0, '不该新增记录: added=' + r2.stats.added);
    assert.ok(r2.posts.every(p => p.comments.length > 1), '补抓后每篇应 >1 条');
    assert.ok(r2.posts.slice(0, 2).every(p => !!p.refilledAt), '应写入 refilledAt');
    assert.strictEqual(r2.stats.refillGained, 4, 'refillGained=' + r2.stats.refillGained);  // 2 篇 × (3-1)
    await p7.close();
  });

  // ---------- 收尾 ----------
  await ctx.close();
  await browser.close();

  console.log('\n=== 原始 expandComments 日志（fixture 展开过程） ===');
  console.log(expandLog.join('\n'));
  console.log('\n=== 汇总 ===');
  console.log('PASS ' + pass + ' / FAIL ' + fail + ' / 共 ' + (pass + fail) + ' 条');
  console.log('expandComments 实测: clicks=' + (exp && exp.clicks) + ' stoppedBy=' + (exp && exp.stoppedBy) +
    ' rounds=' + (exp && exp.rounds) + ' grewBy=' + (exp && exp.grewBy) + ' errors=' + (exp && exp.errors) +
    ' clickFails=' + (exp && exp.clickFails));
  console.log('多级展开实测(task-7): clicks=' + (msExp && msExp.clicks) + ' stoppedBy=' + (msExp && msExp.stoppedBy) +
    ' DOM评论=' + msState.comments + '/' + MS_EXPECT_COMMENTS + ' 真实click=' + msState.real +
    ' 引擎点过=' + JSON.stringify(msState.clickedTags));
  if (lkPost) {
    console.log('字段语序实测(task-8): likes=' + JSON.stringify(lkPost.comments.map(c => c.likes)) +
      ' author=' + JSON.stringify(lkPost.comments.map(c => c.author)) +
      ' time=' + JSON.stringify(lkPost.comments.map(c => c.time)));
  }
  console.log('scrapeComments 实测: comments=' + (post && post.comments.length) +
    ' replies=' + (post && post.comments.filter(c => c.isReply).length) +
    ' containerFound=' + (post && post.stats.containerFound));
  if (fail) console.log('未通过: ' + failed.join(' | '));
  console.log('产物目录: ' + OUT_DIR);
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.log('FATAL ' + ((e && e.stack) || e));
  process.exit(1);
});
