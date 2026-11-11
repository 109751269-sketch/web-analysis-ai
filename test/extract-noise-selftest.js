/**
 * extract-noise-selftest.js —— lib/extract.js 本轮新增能力的离线自测
 *
 * 覆盖 5 组场景（任务书 ①②③④⑤）：
 *   ① dropNoise:false（默认）不丢任何条目 —— 回归保护
 *   ② dropNoise:true 广告条目被丢、正常条目保留、dropped 统计正确
 *   ③ extract.noisePatterns 自定义生效（含非法正则不吞错）
 *   ④ 字段清洗：查看全文 / ⏰ 📍 emoji / 国旗 emoji / 值中间字符不被误伤
 *   ⑤ extract.tidyValues 开关行为
 *
 * 特点：**零浏览器依赖**。用 mock page 走 extractAll 真实代码路径
 * （locateModule 的显式容器选择器分支 → detectItems → extractFieldsFromItems → 过滤），
 * 不启动 Playwright、不联网、不写工作区文件。
 *
 * 用法：node test/extract-noise-selftest.js
 * 退出码：全 PASS → 0；任一 FAIL → 1
 */
'use strict';

const path = require('path');
const E = require(path.join(__dirname, '..', 'lib', 'extract.js'));

// ---------------- 测试脚手架 ----------------
let pass = 0, fail = 0;
const failures = [];

function ok(name, cond, got) {
  if (cond) { pass++; console.log('PASS | ' + name); }
  else {
    fail++; failures.push(name);
    console.log('FAIL | ' + name + (got === undefined ? '' : '  ← got: ' + JSON.stringify(got)));
  }
}
function eq(name, got, want) {
  ok(name + '（期望 ' + JSON.stringify(want) + '）', JSON.stringify(got) === JSON.stringify(want), got);
}

/**
 * mock page：
 *  第 1 次 evaluate = locateModule 清理 [data-dsh-module] 标记 → 返回 undefined
 *  第 2 次 evaluate（带容器选择器数组参数）= 显式容器命中分支 → 返回伪容器
 *  第 3 次 evaluate（无参数）= detectItems → 返回给定条目
 */
function mockPage(items) {
  let n = 0;
  return {
    async evaluate(fn, arg) {
      n++;
      if (n === 1) return undefined;
      if (Array.isArray(arg)) {
        return {
          found: true,
          container: { tag: 'div', id: '', cls: 'list', itemCount: items.length, text: 'mock-container' },
          mode: 'selector:mock'
        };
      }
      return items;
    }
  };
}

const it = (idx, text) => ({ idx, text, html: '', link: '' });
const H = (label, name) => [{ name: name || 'F', patterns: [label] }];
// 取值快捷方式：单条目 + 单 hint
function valueOf(text, label, opts) {
  const recs = E.extractFieldsFromItems([it(1, text)], H(label), opts);
  return recs[0].F;
}

// ---------------- 数据准备 ----------------
const NORMAL = [
  it(1, '招聘 高级前端工程师 20-35K'),
  it(3, '招聘 数据分析师 15-25K thread'),   // 含 "thread"：守住 `Ad\b` 误杀 read/thread 的坑
  it(5, '招聘 Java 开发工程师')
];
const NOISE = [
  it(2, '【广告】某某培训班 限时8折'),
  it(4, 'Sponsored 品牌推广位'),
  it(6, 'Promoted · 推荐内容')
];
// 交错排列，验证过滤后 idx 顺序与保留集合
const MIXED = [NORMAL[0], NOISE[0], NORMAL[1], NOISE[1], NORMAL[2], NOISE[2]];
const FIELDS = [{ name: '岗位', patterns: ['岗位'] }];
const SEL = ['.list'];

(async () => {
  console.log('=== extract.js 噪声过滤 + 字段清洗 自测 ===');
  console.log('node ' + process.version + ' | extract.js 已加载\n');

  // ============ ① dropNoise 默认 false：不丢任何条目（回归保护） ============
  console.log('--- ① dropNoise 默认关闭（回归保护）---');
  {
    const r0 = await E.extractAll(mockPage(MIXED), { module: 'm', fields: FIELDS, containerSelectors: SEL });
    const r1 = await E.extractAll(mockPage(MIXED), { module: 'm', fields: FIELDS, containerSelectors: SEL, dropNoise: false });
    eq('①-1 未传 dropNoise → 6 条全保留', r0.records.length, 6);
    eq('①-2 未传 dropNoise → items 6 条', r0.items.length, 6);
    eq('①-3 dropNoise:false → 6 条全保留', r1.records.length, 6);
    eq('①-4 dropNoise:false → dropped.noise=0', r1.dropped.noise, 0);
    eq('①-5 dropNoise:false → dropped.patterns 为空', r1.dropped.patterns, []);
    ok('①-6 返回值恒带 dropped 字段（不静默）', r1.dropped && Array.isArray(r1.dropped.invalidPatterns), r1.dropped);
    eq('①-7 默认路径与显式 false 路径产出完全一致', JSON.stringify(r0.records), JSON.stringify(r1.records));
    ok('①-8 仅给 noisePatterns、不给 dropNoise → 仍不过滤',
      (await E.extractAll(mockPage(MIXED), { module: 'm', fields: FIELDS, containerSelectors: SEL, noisePatterns: ['招聘'] })).records.length === 6);
    eq('①-9 默认路径保留全部 _idx', r1.records.map(r => r._idx), [1, 2, 3, 4, 5, 6]);
  }

  // ============ ② dropNoise:true：丢噪声、留正常、统计正确 ============
  console.log('\n--- ② dropNoise:true 条目级过滤 ---');
  {
    const logs = [];
    const r = await E.extractAll(mockPage(MIXED), {
      module: 'm', fields: FIELDS, containerSelectors: SEL, dropNoise: true, log: m => logs.push(m)
    });
    eq('②-1 正常条目全保留（3 条）', r.records.map(x => x._idx), [1, 3, 5]);
    eq('②-2 dropped.noise = 3', r.dropped.noise, 3);
    eq('②-3 items 与 records 同步剔除（idx 一致）', r.items.map(x => x.idx), [1, 3, 5]);
    ok('②-4 命中模式含「广告」', r.dropped.patterns.indexOf('广告') !== -1, r.dropped.patterns);
    ok('②-5 命中模式含「Promoted」', r.dropped.patterns.indexOf('Promoted') !== -1, r.dropped.patterns);
    ok('②-6 命中模式含「推广」（Sponsored 条目先命中中文词）',
      r.dropped.patterns.indexOf('推广') !== -1, r.dropped.patterns);
    eq('②-7 patterns 已去重', r.dropped.patterns.length, new Set(r.dropped.patterns).size);
    ok('②-8 含 "thread" 的正常帖子未被误杀（Ad\\b 误杀防护）',
      r.records.some(x => /数据分析师/.test(x._text)), r.records.map(x => x._text));
    ok('②-9 正常条目字段值未被污染', r.records.every(x => typeof x.岗位 === 'string'), r.records.map(x => x.岗位));
    ok('②-10 过滤统计已写日志（返回值 + 日志双通道）',
      logs.some(l => /噪声过滤\(dropNoise\): 丢弃 3\/6/.test(l)), logs);
    // extract.pages 多组：每组自身的 opts 走同一出口 extractAll
    const g = await E.extractAll(mockPage(MIXED), {
      module: 'm', fields: FIELDS, containerSelectors: SEL, dropNoise: true, limit: 4
    });
    eq('②-11 多组(pageDefs)风格 opts：limit 先切片再过滤 → 保留 2 条', g.records.map(x => x._idx), [1, 3]);
    eq('②-12 多组风格 opts：dropped.noise = 2', g.dropped.noise, 2);
  }

  // ============ ③ 自定义 noisePatterns ============
  console.log('\n--- ③ extract.noisePatterns 自定义 ---');
  {
    // 只用自定义词，隔离验证（不含任何内置噪声词）
    const items = [it(1, '招聘 前端工程师'), it(2, '限时优惠 秒杀活动'), it(3, '培训课程 报名中')];
    const base = { module: 'm', fields: FIELDS, containerSelectors: SEL, dropNoise: true };
    const a = await E.extractAll(mockPage(items), Object.assign({}, base, { noisePatterns: ['限时优惠'] }));
    eq('③-1 自定义模式命中被丢 → 保留 2 条', a.records.map(x => x._idx), [1, 3]);
    eq('③-2 自定义模式计入 dropped.patterns', a.dropped.patterns, ['限时优惠']);
    eq('③-3 自定义模式丢弃计数正确', a.dropped.noise, 1);

    const b = await E.extractAll(mockPage(items), Object.assign({}, base, { noisePatterns: ['限时\\s*优惠'] }));
    eq('③-4 自定义支持正则语法（\\s*）', b.records.map(x => x._idx), [1, 3]);

    // 自定义 + 内置并存（本条含内置词「广告」）
    const mix = [it(1, '招聘 前端工程师'), it(2, '限时优惠 秒杀活动'), it(3, '【广告】培训')];
    const co = await E.extractAll(mockPage(mix), Object.assign({}, base, { noisePatterns: ['限时优惠'] }));
    eq('③-5 自定义与内置并存：仅第 1 条正常内容保留', co.records.map(x => x._idx), [1]);
    eq('③-6 并存时两种模式都被记入 patterns',
      co.dropped.patterns.slice().sort(), ['广告', '限时优惠'].sort());
    eq('③-7 并存时丢弃计数 = 2', co.dropped.noise, 2);

    const c = await E.extractAll(mockPage(items), Object.assign({}, base, { noisePatterns: ['(', '限时优惠'] }));
    eq('③-8 非法正则不吞错：记入 invalidPatterns', c.dropped.invalidPatterns, ['(']);
    eq('③-9 非法正则不影响其余模式生效', c.records.map(x => x._idx), [1, 3]);
    ok('③-10 非法正则不抛异常且结果可用', c.records.length === 2 && c.dropped.noise === 1, c.dropped);

    const d = E.filterNoiseRecords([{ _idx: 1, _text: 'ads 位' }, { _idx: 2, _text: '正常内容' }], []);
    eq('③-11 内置 \\bAds?\\b 命中独立 "ads"，但不误伤 "loads/reads"',
      [d.records.map(x => x._idx), E.filterNoiseRecords([{ _idx: 9, _text: 'loads of reads' }], []).dropped.noise],
      [[2], 0]);
  }

  // ============ ④ 字段清洗补强 ============
  console.log('\n--- ④ 字段清洗（查看全文 / emoji / 值中间字符）---');
  {
    const cases = [
      ['岗位：招聘 查看全文 赞12', '岗位', '招聘', 'A3 词表 查看全文 + 互动尾缀'],
      ['岗位：招聘 查看全文 赞12\n公司：字节跳动 ⏰', '公司', '字节跳动', '⏰(U+23F0) 尾部 emoji（新增 2300-23FF 区间）'],
      ['公司：字节跳动 ⏰', '公司', '字节跳动', '⏰ 前有空格'],
      ['地址：📍 北京市朝阳区', '地址', '北京市朝阳区', '📍(U+1F4CD) 前缀 emoji'],
      ['地区：🇨🇳 中国', '地区', '中国', '国旗 emoji 前缀'],
      ['地区：中国 🇨🇳', '地区', '中国', '国旗 emoji 后缀'],
      ['公司：✨字节跳动✨', '公司', '字节跳动', '装饰 emoji 首尾同时去掉'],
      ['公司：A⏰B 技术有限公司', '公司', 'A⏰B 技术有限公司', '值中间 emoji 不被误伤'],
      ['岗位：高级前端·工程师', '岗位', '高级前端·工程师', '值中间 · 不被误伤'],
      ['岗位：C++ 后端/Go 工程师', '岗位', 'C++ 后端/Go 工程师', '值中间符号不被误伤'],
      ['公司：Research and Development', '公司', 'Research and Development', '普通英文值不被误伤']
    ];
    for (const [text, label, want, why] of cases) {
      const got = valueOf(text, label);
      eq('④ ' + why, got, want);
    }
    // 装饰区间只作用于首尾 → 值中间的 ASCII/中文/标点原样
    eq('④-12 首尾锚定：值中间 "★" 保留', valueOf('公司：A★B', '公司'), 'A★B');
  }

  // ============ ⑤ tidyValues 开关 ============
  console.log('\n--- ⑤ extract.tidyValues（默认 false）---');
  {
    eq('⑤-1 默认（false）全角空格保留', valueOf('公司：字节跳动\u3000科技 ·', '公司'), '字节跳动\u3000科技 ·');
    eq('⑤-2 tidyValues:true 压全角空格并去尾部标点',
      valueOf('公司：字节跳动\u3000科技 ·', '公司', { tidyValues: true }), '字节跳动 科技');
    // 注：值捕获类为 `[^\n；;]`，故标点用例用「，、·」（；; 会被当作值终止符）
    eq('⑤-3 默认（false）值尾孤立标点保留', valueOf('岗位：前端 ，、·', '岗位'), '前端 ，、·');
    eq('⑤-4 tidyValues:true 清掉值尾孤立标点', valueOf('岗位：前端 ，、·', '岗位', { tidyValues: true }), '前端');
    eq('⑤-5 tidyValues:true 压连续空白', valueOf('公司：字节    跳动', '公司', { tidyValues: true }), '字节 跳动');
    eq('⑤-6 tidyValues:true 不误伤值中间标点', valueOf('岗位：高级前端·工程师', '岗位', { tidyValues: true }), '高级前端·工程师');
    eq('⑤-7 tidyValues:true 不误伤值中间冒号', valueOf('公司：Ratio 16:9 屏幕', '公司', { tidyValues: true }), 'Ratio 16:9 屏幕');
    eq('⑤-8 tidyValues:true 对干净值零副作用', valueOf('公司：字节跳动', '公司', { tidyValues: true }), '字节跳动');
    eq('⑤-9 tidyValue() 直接调用：尾部多轮标点', E.tidyValue('abc · ,'), 'abc');
    eq('⑤-10 tidyValue() 直接调用：保留中间全角空格为单空格', E.tidyValue('字节\u3000跳动'), '字节 跳动');
    // 经 extractAll 贯通
    const r = await E.extractAll(mockPage([it(1, '公司：字节跳动\u3000科技 ·')]),
      { module: 'm', fields: H('公司'), containerSelectors: SEL, tidyValues: true });
    eq('⑤-11 tidyValues 经 extractAll 贯通', r.records[0].F, '字节跳动 科技');
    const r0 = await E.extractAll(mockPage([it(1, '公司：字节跳动\u3000科技 ·')]),
      { module: 'm', fields: H('公司'), containerSelectors: SEL });
    eq('⑤-12 默认路径 tidyValues 未开启（回归保护）', r0.records[0].F, '字节跳动\u3000科技 ·');
  }

  // ============ 汇总 ============
  const total = pass + fail;
  console.log('\n=== 结果: ' + pass + '/' + total + ' PASS, ' + fail + ' FAIL ===');
  if (fail) {
    console.log('失败用例:');
    failures.forEach(f => console.log('  - ' + f));
    process.exit(1);
  }
  console.log('退出码 0');
  process.exit(0);
})().catch(e => {
  console.error('FAIL | 自测异常中断: ' + (e && e.stack || e));
  process.exit(1);
});
